/**
 * voucher-live-issue.ts — Story 3.3 (v1.11.0 Epic 3) — Path Y `@MedusaSubscriber`
 * dla live-issue L4 ISSUED (ADR-118 / ADR-137 DEC pkt 2).
 *
 * Konsumuje `gp.stripe.payment_intent_succeeded.v1` (kontrakt Story 3.1, envelope.v1,
 * emitowany przez cienki webhook — `api/webhooks/stripe/payment-intent`) i deleguje
 * CAŁĄ biznes-logikę do rdzenia `liveIssueEntitlementsWithinTx` (issue → ISSUED,
 * dwupoziomowa idempotencja DEC-5). To JEDYNA droga do ISSUED (Path Y, ADR-052/118).
 *
 * Atomicity (ADR-137 DEC pkt 3): `event_processed` + INSERT-y entitlementów +
 * OKABLOWANIE GENEZY ISSUED (audit append-only + posting hook) w JEDNEJ DB-tx
 * (BEGIN/COMMIT tutaj); EVENT okablowania emitowany PO commit (best-effort,
 * AI-Review-3 kontrakt post-COMMIT). Rollback ⇒ brak phantom-eventu.
 *
 * OKABLOWANIE (Story 3.4): geneza ISSUED każdego nowo utworzonego wiersza
 * przechodzi przez JEDNOLITY punkt `wireEntitlementTransitionPersisted`
 * (`from = ENTITLEMENT_GENESIS`, `to = ISSUED`) → (1) event envelope.v1 +
 * (2) append-only audit + (3) posting hook. To realizuje AC1 w runtime (Path Y
 * ISSUED audytowalna + księgowalna przez ten sam punkt; pozostałe tranzycje = E4
 * przez TEN SAM punkt, egzekwowane checkerem `entitlement-transition-routing.ts`).
 *
 * GRANICA (E3 — hook ≠ aktywacja): posting hook jest WYWOŁANY ale `runtime_enabled`
 * = `false` ⇒ persystencja ledgera INERT (writer NIE wołany, zero zapisu
 * `voucher_ledger_*`; flip = E6/P6). Hook NIE dostaje fabrykowanego payloadu
 * finansowego (rozpoznanie liability ISSUED = money-ledger / E4). NIE rusza
 * hard-gate'ów MPV_MULTI_VENDOR/SUBSCRIPTION_B2C.
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import {
  liveIssueEntitlementsWithinTx,
  type LiveIssueInput,
  type LiveIssuePgClient,
  type LiveIssueScope,
  type PaymentIntentSucceededPayload,
} from "../workflows/entitlements/live-issue-from-payment-intent"
import {
  wireEntitlementTransitionPersisted,
  emitTransitionEventAfterCommit,
  buildGenesisIssuedTransition,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type TransitionEventEnvelope,
  type TransitionAuditEnvelope,
} from "../modules/voucher/entitlement-transition-wiring"

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

type EventBusLike = { emit: (event: { name: string; data: unknown }) => Promise<unknown> }

/** Resolve Medusa event bus (best-effort); `null` gdy niedostępny (emit no-op). */
function resolveEventBus(
  scope: { resolve: (key: string) => unknown } | undefined
): EventBusLike | null {
  const resolver = scope?.resolve
  if (typeof resolver !== "function") return null
  try {
    const bus = resolver.call(scope, Modules.EVENT_BUS) as EventBusLike | undefined
    return bus && typeof bus.emit === "function" ? bus : null
  } catch {
    return null
  }
}

/**
 * Append-only sink audytu tranzycji (Story 3.4). W tej fazie (`runtime_enabled=false`,
 * side-effecty issue jeszcze nie persystowane w dedykowanej tabeli) audyt jest
 * strukturalnym, append-only logiem (spójnie z deklaracją 3.3 „strukturalne,
 * audytowalne logowanie"). KONTRAKT FORWARD (E4/E6): durable audit-table / outbox
 * podmienia TEN sink BEZ zmiany kontraktu okablowania (envelope niezmienny).
 */
function makeTransitionAuditSink(
  logger: LoggerLike
): (audit: TransitionAuditEnvelope) => Promise<void> {
  return async (audit) => {
    logger.info?.(`[entitlement-transition-audit] ${JSON.stringify(audit)}`)
  }
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
  const scope = data?.scope ?? {}
  const missing: string[] = []
  if (!payload.payment_intent_id) missing.push("payment_intent_id")
  if (!payload.order_id) missing.push("order_id")
  if (!payload.currency) missing.push("currency")
  if (typeof payload.amount_minor !== "number") missing.push("amount_minor")
  if (!payload.psp_occurred_at) missing.push("psp_occurred_at")
  // M2: `scope.market_id` wymagany w envelope (kontrakt 3.1, ontologia 3.2) —
  // fail-loud PRZED otwarciem DB-tx. Subscriber jest granicą zaufania dla
  // event-busa (inni emitenci / replay / testy); bez tej walidacji brak
  // `market_id` degraduje do naruszenia `market_scope_chk` w pętli writera ⇒
  // tx abort ⇒ `event_processed` rollback ⇒ poison-retry zamiast czytelnego błędu.
  const marketId =
    typeof scope.market_id === "string" ? scope.market_id.trim() : ""
  if (!marketId) missing.push("scope.market_id")
  if (missing.length > 0) {
    throw new Error(
      `[voucher-live-issue] envelope niekompletny: brak ${missing.join(",")} ` +
        `(kontrakt Story 3.1 gp.stripe.payment_intent_succeeded.v1)`
    )
  }

  return {
    event_type: data?.event_type ?? eventName,
    scope,
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
  const now = new Date()
  // M2: `scope.market_id` zwalidowany w `toLiveIssueInput` (niepusty) — bezpieczne
  // źródło scope audytu/eventu okablowania (spójne z market_id użytym do INSERT).
  const marketId = String(input.scope.market_id)

  try {
    // ── (A) issue + OKABLOWANIE GENEZY ISSUED w JEDNEJ DB-tx (atomicity) ──────
    // Audyt (append-only) + posting hook (bramkowany, inert przy
    // runtime_enabled=false) wykonywane W TEJ tx (atomowo ze zmianą stanu, AI-Review-3).
    // Eventy zbierane do emisji POST-COMMIT (kontrakt atomowości okablowania).
    const wired = await withTransaction(db, async (client) => {
      const result = await liveIssueEntitlementsWithinTx(client, input, now)
      const events: TransitionEventEnvelope[] = []
      const appendAudit = makeTransitionAuditSink(logger)
      // Okabluj WYŁĄCZNIE nowo utworzone wiersze (`created=true`). Replay
      // (`created=false`, event-level/per-entitlement dedupe) NIE re-audytuje
      // / NIE re-emituje (idempotencja). Posting hook NIE dostaje payloadu
      // finansowego (rozpoznanie liability ISSUED = money-ledger / E4) — hook
      // jest WYWOŁANY (no-op udokumentowany), NIE fabrykuje kwot na ścieżce
      // finansowej. AC1: ISSUED przechodzi przez JEDNOLITY punkt okablowania.
      for (const issuedRow of result.issued) {
        if (!issuedRow.created) continue
        const { event } = await wireEntitlementTransitionPersisted(
          { appendAudit, clock: () => now },
          buildGenesisIssuedTransition({
            entitlement_id: issuedRow.entitlement_id,
            scope: {
              instance_id: issuedRow.entitlement_id,
              market_id: marketId,
              sales_channel_id: null,
              vendor_id: input.scope.vendor_id ?? null,
              location_id: input.scope.location_id ?? null,
            },
            actor: "system",
            actor_hint: "subscriber:path-y:live-issue",
            occurred_at: input.payload.psp_occurred_at,
            // Cykl-safe dyskryminator wystąpienia (AI-Review-2): per-entitlement
            // klucz dedupe (unikatowy, stabilny przy replay).
            transition_seq: issuedRow.entitlement_dedupe_key,
          })
        )
        events.push(event)
      }
      return { result, events }
    })

    // ── (B) replay/no-op event-level — zero issue, zero okablowania ───────────
    if (!wired.result.event_processed) {
      logger.info?.(
        `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
          `replay/no-op (event-level dedupe) — zero issue`
      )
      return
    }

    // ── (C) EVENT best-effort POST-COMMIT (AI-Review-3 kontrakt atomowości) ───
    // Emit DOPIERO po commicie tranzycji: rollback (B) ⇒ brak phantom-eventu.
    // Fail emitu NIE blokuje (best-effort); kompletność = reconciliation 2.6
    // (ADR-139 D2). Idempotencja powiadomień (finding L-3 z 3.3): outbox/event
    // bus prowadzi własny dedupe — emit NIE polega na ponownym przejściu ścieżki.
    const eventBus = resolveEventBus(scope)
    const emit = async (event: TransitionEventEnvelope): Promise<void> => {
      if (!eventBus) {
        throw new Error("event bus niedostępny (emit best-effort — reconciliation 2.6)")
      }
      await eventBus.emit({ name: ENTITLEMENT_STATE_CHANGED_EVENT_TYPE, data: event })
    }
    let emitFailures = 0
    for (const event of wired.events) {
      const failed = await emitTransitionEventAfterCommit(emit, event)
      if (failed) emitFailures += 1
    }

    const created = wired.result.issued.filter((e) => e.created).length
    const noop = wired.result.issued.length - created
    logger.info?.(
      `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
        `order=${input.payload.order_id} ISSUED created=${created} noop=${noop} ` +
        `total=${wired.result.issued.length} wired=${wired.events.length} ` +
        `emit_failed=${emitFailures}`
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
