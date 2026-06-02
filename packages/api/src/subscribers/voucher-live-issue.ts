/**
 * voucher-live-issue.ts — Story 3.3 (v1.11.0 Epic 3) — Path Y `@MedusaSubscriber`
 * dla live-issue L4 ISSUED (ADR-118 / ADR-137 DEC pkt 2).
 *
 * Konsumuje `gp.stripe.payment_intent_succeeded.v1` (kontrakt Story 3.1, envelope.v1,
 * emitowany przez cienki webhook — `api/webhooks/stripe/payment-intent`) i deleguje
 * CAŁĄ biznes-logikę do rdzenia `liveIssueEntitlementsWithinTx` (issue → ISSUED,
 * dwupoziomowa idempotencja DEC-5). To JEDYNA droga do ISSUED (Path Y, ADR-052/118).
 *
 * Atomicity (ADR-137 DEC pkt 3): `event_processed` + INSERT-y entitlementów w JEDNEJ
 * DB-tx (BEGIN/COMMIT tutaj); side-effecty (email/.ics/MinIO) PO commit jako
 * compensation step. W tej story side-effecty są jeszcze nieaktywne (3.4+) — po
 * commit wykonujemy wyłącznie strukturalne logowanie wyniku.
 *
 * GRANICA (E3 — issue ≠ posting): stan = ISSUED, NIE okablowuje maszyny stanów
 * (3.4), NIE woła `ledger-writer.ts` (2.6), NIE aktywuje postingu (`runtime_enabled`
 * = `false`, flip = E6/P6), NIE rusza hard-gate'ów MPV_MULTI_VENDOR/SUBSCRIPTION_B2C.
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  liveIssueEntitlementsWithinTx,
  type LiveIssueInput,
  type LiveIssuePgClient,
  type LiveIssueScope,
  type PaymentIntentSucceededPayload,
} from "../workflows/entitlements/live-issue-from-payment-intent"

/** event_type kontraktu Story 3.1 (AR-EVENTS). */
export const PAYMENT_INTENT_SUCCEEDED_EVENT =
  "gp.stripe.payment_intent_succeeded.v1" as const

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = LiveIssuePgClient & { release?: () => void }
type PgPool = { connect: () => Promise<PgClient> }
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

/**
 * Kształt envelope.v1 dostarczany przez event bus. Subscriber czyta TYLKO payload
 * (kontrakt 3.1) + scope (market_id, ontologia 3.2). Walidacja schematu jest po
 * stronie webhooka (emit) — tu jest defensywny odczyt pól wymaganych.
 */
type PaymentIntentEnvelope = {
  event_type?: string
  scope?: LiveIssueScope
  payload?: Partial<PaymentIntentSucceededPayload>
}

function resolveLogger(container: Record<string, unknown> | undefined): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined
  if (direct) return direct
  const resolver = container?.resolve as ((key: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console
    } catch {
      return console
    }
  }
  return console
}

function resolveDb(scope: { resolve: (key: string) => unknown }): PgPool | KnexLike {
  try {
    return scope.resolve("__pg_pool__") as PgPool
  } catch {
    return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  }
}

function isPgPool(value: PgPool | KnexLike): value is PgPool {
  return typeof (value as PgPool).connect === "function"
}

function createKnexPgClient(db: KnexLike): PgClient {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values: ReadonlyArray<unknown> = []
    ): QueryResult<T> => {
      const bindings: unknown[] = []
      const sql = text.replace(/\$(\d+)/g, (_m, idx: string) => {
        bindings.push(values[Number(idx) - 1])
        return "?"
      })
      const result = await db.raw(sql, bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = ((result as { rows?: unknown[] }).rows ?? []) as T[]
      return {
        rows,
        rowCount: (result as { rowCount?: number | null }).rowCount ?? rows.length,
      }
    },
  }
}

async function withTransaction<T>(
  db: PgPool | KnexLike,
  handler: (client: PgClient) => Promise<T>
): Promise<T> {
  if (isPgPool(db)) {
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const result = await handler(client)
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw err
    } finally {
      client.release?.()
    }
  }
  return db.transaction(async (trx) => handler(createKnexPgClient(trx)))
}

/** Mapuje envelope.v1 na wejście rdzenia; fail-loud na brak pól wymaganych. */
export function toLiveIssueInput(
  eventName: string,
  data: PaymentIntentEnvelope | undefined
): LiveIssueInput {
  const payload = data?.payload ?? {}
  const missing: string[] = []
  if (!payload.payment_intent_id) missing.push("payment_intent_id")
  if (!payload.order_id) missing.push("order_id")
  if (!payload.currency) missing.push("currency")
  if (typeof payload.amount_minor !== "number") missing.push("amount_minor")
  if (!payload.psp_occurred_at) missing.push("psp_occurred_at")
  if (missing.length > 0) {
    throw new Error(
      `[voucher-live-issue] envelope payload niekompletny: brak ${missing.join(",")} ` +
        `(kontrakt Story 3.1 gp.stripe.payment_intent_succeeded.v1)`
    )
  }

  return {
    event_type: data?.event_type ?? eventName,
    scope: data?.scope ?? {},
    payload: payload as PaymentIntentSucceededPayload,
  }
}

export default async function voucherLiveIssueSubscriber({
  event,
  container,
}: SubscriberArgs<PaymentIntentEnvelope>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>)
  const eventName = event.name

  let input: LiveIssueInput
  try {
    input = toLiveIssueInput(eventName, event.data)
  } catch (err) {
    const error = err as Error
    // Fail-loud: rzucamy, by Medusa zarządziła retry/DLQ (NIE silent-swallow).
    logger.error?.(`[voucher-live-issue] ${error.message}`)
    throw err
  }

  const scope = container as unknown as { resolve: (key: string) => unknown }
  const db = resolveDb(scope)

  try {
    const result = await withTransaction(db, (client) =>
      liveIssueEntitlementsWithinTx(client, input, new Date())
    )

    // ── side-effecty PO commit (compensation step) ──────────────────────────
    // Story 3.3: side-effecty (email/.ics/MinIO) jeszcze nieaktywne (3.4+).
    // Tu wyłącznie strukturalne, audytowalne logowanie — NIE I/O domenowe.
    if (!result.event_processed) {
      logger.info?.(
        `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
          `replay/no-op (event-level dedupe) — zero issue`
      )
      return
    }

    const created = result.issued.filter((e) => e.created).length
    const noop = result.issued.length - created
    logger.info?.(
      `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
        `order=${input.payload.order_id} ISSUED created=${created} noop=${noop} ` +
        `total=${result.issued.length}`
    )
  } catch (err) {
    const error = err as Error
    logger.error?.(
      `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
        `failed: ${error.name}: ${error.message}`
    )
    throw err
  }
}

export const config: SubscriberConfig = {
  event: PAYMENT_INTENT_SUCCEEDED_EVENT,
}
