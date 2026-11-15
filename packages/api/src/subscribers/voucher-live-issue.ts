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

import { runInSystemMarketContext } from "../lib/system-market-context"
import { requireRuntimeInstanceId } from "../lib/runtime-instance-identity"

import {
  liveIssueEntitlementsPerLineWithinTx,
  LiveIssuePartialFailureError,
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
import {
  DEFERRED_ISSUANCE_EVENT_SUFFIX,
  OWED_UNIT_RECOVERY_CONSUMER_SUCCESS,
  OWED_UNIT_RESERVATION_MISMATCH_ALARM,
  PATH_Y_CONSUMER_MAX_ATTEMPTS,
  resolveWebhookPgHandle,
  settleOwedUnitStamp,
  stampPathYConsumerFailure,
} from "../lib/payment/stripe-payment-intent-transport"
import { buildOwedBusinessUnitKey } from "../lib/payment/stripe-webhook-barrier-contract"
import { emitStructuredAlert } from "../lib/alert-emit"
import {
  closeDeferredIssuanceTraceGuarded,
  DEFERRED_ISSUANCE_TRACE_CLOSURE_WEBHOOK_LIVE_ISSUE,
} from "../lib/recovery/deferred-issuance-trace"

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
  causation_id?: string
}

/** Prefiks `causation_id` koperty Path Y (`stripe:webhook:<event.id>`). */
const STRIPE_WEBHOOK_CAUSATION_PREFIX = "stripe:webhook:"

/**
 * Story 4.4 (R-5): `event.id` Stripe z `causation_id` koperty — ta sama
 * wartość, którą route zapisał jako `stripe_event_id` rekordu śladu.
 */
export function stripeEventIdFromCausation(causationId: unknown): string | null {
  if (typeof causationId !== "string" || !causationId.startsWith(STRIPE_WEBHOOK_CAUSATION_PREFIX)) {
    return null
  }
  const eventId = causationId.slice(STRIPE_WEBHOOK_CAUSATION_PREFIX.length)
  if (!eventId || eventId.endsWith(DEFERRED_ISSUANCE_EVENT_SUFFIX)) return null
  return eventId
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
  const instanceId =
    typeof scope.instance_id === "string" ? scope.instance_id.trim() : ""
  if (!instanceId) missing.push("scope.instance_id")
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

/** Kod stempla porażki konsumenta, gdy w kontenerze nie ma dostępu do PG. */
export const CONSUMER_FAILURE_STAMP_PG_UNAVAILABLE = "consumer_failure_stamp_pg_unavailable" as const
/** Kod stempla porażki konsumenta, gdy zapis SQL rzucił. */
export const CONSUMER_FAILURE_STAMP_FAILED = "consumer_failure_stamp_failed" as const
/** Kod stempla porażki konsumenta, gdy rezerwacji tej dostawy nie ma. */
export const CONSUMER_FAILURE_STAMP_NO_RESERVATION = "consumer_failure_stamp_no_reservation" as const

/**
 * Story 3.4 fix (checkpoint PO, AC1/AC4, ADR-246 p.6): ścieżka porażki
 * konsumenta Path Y na REALNEJ ścieżce, bez redelivery.
 *
 * Route odpowiada Stripe'owi `200` po emisji, PRZED konsumpcją; Stripe po 200
 * nie ponawia, więc naprawa w gałęzi `reserved=false` route'u odpala tylko przy
 * ręcznym `stripe events resend`. Tu — w każdej nieudanej próbie busa — rezerwacja
 * dostawy (`webhook_event_processed`) dostaje stempel `owed_unit_settlement.state
 * = 'unsettled'` z jednostką, której konsumpcja padła, a operator dostaje alarm
 * strukturalny `owed_unit_reservation_mismatch` (kanał `lib/alert-emit`). Kolejna
 * dostawa (resend, trasa natywna `payment.captured`) albo odzysk rozlicza
 * jednostkę; wspólna bariera Story 3.3 chroni przed podwójnym skutkiem.
 *
 * Zapis biegnie POZA wycofaną tx skutku, na uchwycie route'u
 * (`resolveWebhookPgHandle` = rola bazowa połączenia `PG_CONNECTION`, poza
 * kontekstem rynku) — tym samym, którym route rezerwuje i stempluje; `medusa_store`
 * nie ma uprawnień do `webhook_event_processed`, więc nie potrzeba nowego grantu
 * ani migracji. Porażka stempla NIE maskuje porażki konsumenta (wołający i tak
 * rzuca), ale jest nazwana w alarmie i w logu ERROR (NFR-4).
 *
 * Koperty spoza route'u (odzysk `#deferred-issuance`, inni emitenci) nie mają
 * rezerwacji dostawy — `null`, bez stempla i bez alarmu tej klasy (mają własne
 * rejestry: `deferred_issuance_trace`, `money_path_compensation_failure`).
 */
export async function recordPathYConsumerFailure(
  scope: { resolve: (key: string) => unknown },
  logger: LoggerLike,
  input: { causation_id: unknown; payment_intent_id: string; order_id: string; error: Error }
): Promise<{
  stamped: boolean
  stamp_error_code: string | null
  unit_attempt: number | null
  final: boolean
} | null> {
  const stripeEventId = stripeEventIdFromCausation(input.causation_id)
  if (!stripeEventId) return null
  const owedUnit = buildOwedBusinessUnitKey({
    payment_intent_id: input.payment_intent_id,
    order_id: input.order_id,
  })

  let stamped = false
  let unitAttempt: number | null = null
  let stampErrorCode: string | null = null
  try {
    const handle = await resolveWebhookPgHandle(scope)
    if (!handle) {
      stampErrorCode = CONSUMER_FAILURE_STAMP_PG_UNAVAILABLE
    } else {
      try {
        ;({ stamped, unit_attempts: unitAttempt } = await stampPathYConsumerFailure(handle.client, {
          event_id: stripeEventId,
          owed_unit: owedUnit,
          error_name: input.error.name || "Error",
        }))
        if (!stamped) stampErrorCode = CONSUMER_FAILURE_STAMP_NO_RESERVATION
      } finally {
        handle.release()
      }
    }
  } catch (err) {
    stampErrorCode = CONSUMER_FAILURE_STAMP_FAILED
    logger.error?.(
      `[voucher-live-issue] stempel porazki konsumenta dla ${stripeEventId} ` +
        `(${owedUnit}) NIE zostal utrwalony: ${(err as Error).message}`
    )
  }

  // Runda fix 2 (R-9/R-11, ADR-246 p.6): bus nie podaje numeru próby, więc
  // numerem jest licznik prób TEJ jednostki w stemplu. Próba < max = porażka
  // przejściowa (WARN; bus ponowi, sukces zdejmie stempel). Próba >= max albo
  // licznik nieznany (stempel nieutrwalony) = porażka ostateczna (CRITICAL).
  const final = unitAttempt === null || unitAttempt >= PATH_Y_CONSUMER_MAX_ATTEMPTS
  emitStructuredAlert({
    severity: final ? "CRITICAL" : "WARN",
    code: OWED_UNIT_RESERVATION_MISMATCH_ALARM,
    message:
      `Konsumpcja Path Y nieudana po ACK transportu: rezerwacja ${stripeEventId} ` +
      `ma nierozliczona jednostke ${owedUnit}` +
      (final ? " (porazka ostateczna)" : ` (proba ${unitAttempt}/${PATH_Y_CONSUMER_MAX_ATTEMPTS}, bus ponowi)`),
    context: {
      stripe_event_id: stripeEventId,
      owed_unit: owedUnit,
      error_name: input.error.name || "Error",
      stamp_persisted: stamped,
      unit_attempt: unitAttempt,
      max_attempts: PATH_Y_CONSUMER_MAX_ATTEMPTS,
      final,
      ...(stampErrorCode ? { stamp_error_code: stampErrorCode } : {}),
    },
  })
  return { stamped, stamp_error_code: stampErrorCode, unit_attempt: unitAttempt, final }
}

/** Kod logu ERROR, gdy zdjęcie stempla po udanej konsumpcji padło. */
export const CONSUMER_RECOVERY_SETTLE_FAILED = "consumer_recovery_settle_failed" as const
/** Kod logu ERROR, gdy porażki konsumenta nie da się ostemplować (brak causation/payloadu). */
export const CONSUMER_FAILURE_UNSTAMPABLE = "consumer_failure_unstampable" as const

/**
 * Story 3.4 runda fix 2 (R-9, AC1/AC4, ADR-246 p.6): udana konsumpcja Path Y
 * (event_processed albo replay/no-op — skutek jednostki istnieje) zdejmuje
 * jednostkę ze stempla rezerwacji; pusty zbiór = `state: 'settled'` z
 * `consumer_recovered_at`, ślad prób zostaje. Zapis po commicie skutku, na
 * uchwycie route'u (jak stempel porażki). Porażka zapisu nie cofa skutku,
 * jest nazwana w logu ERROR (NFR-4); kolejna dostawa z PASS i tak rozlicza.
 */
export async function recordPathYConsumerRecovery(
  scope: { resolve: (key: string) => unknown },
  logger: LoggerLike,
  input: { causation_id: unknown; payment_intent_id: string; order_id: string }
): Promise<{ state: "settled" | "unsettled" | null; error_code: string | null } | null> {
  const stripeEventId = stripeEventIdFromCausation(input.causation_id)
  if (!stripeEventId) return null
  const owedUnit = buildOwedBusinessUnitKey({
    payment_intent_id: input.payment_intent_id,
    order_id: input.order_id,
  })
  try {
    const handle = await resolveWebhookPgHandle(scope)
    if (!handle) {
      logger.error?.(
        `[voucher-live-issue] ${CONSUMER_RECOVERY_SETTLE_FAILED}: brak PG dla ${stripeEventId} (${owedUnit})`
      )
      return { state: null, error_code: CONSUMER_RECOVERY_SETTLE_FAILED }
    }
    try {
      const state = await settleOwedUnitStamp(handle.client, {
        event_id: stripeEventId,
        settled_units: [owedUnit],
        recovered_by: OWED_UNIT_RECOVERY_CONSUMER_SUCCESS,
      })
      return { state, error_code: null }
    } finally {
      handle.release()
    }
  } catch (err) {
    logger.error?.(
      `[voucher-live-issue] ${CONSUMER_RECOVERY_SETTLE_FAILED}: ${stripeEventId} (${owedUnit}): ` +
        `${(err as Error).message}`
    )
    return { state: null, error_code: CONSUMER_RECOVERY_SETTLE_FAILED }
  }
}

/**
 * R-12: porażka PRZED głównym `try` (walidacja koperty, tożsamość instancji)
 * też stempluje rezerwację, gdy causation i identyfikatory są dostępne; inaczej
 * nazwany log ERROR `consumer_failure_unstampable`.
 */
async function recordEarlyConsumerFailure(
  scope: { resolve: (key: string) => unknown },
  logger: LoggerLike,
  data: unknown,
  error: Error
): Promise<void> {
  const envelope = (data ?? {}) as { causation_id?: unknown; payload?: Record<string, unknown> }
  const pi = envelope.payload?.payment_intent_id
  const order = envelope.payload?.order_id
  if (
    stripeEventIdFromCausation(envelope.causation_id) &&
    typeof pi === "string" && pi.length > 0 &&
    typeof order === "string" && order.length > 0
  ) {
    await recordPathYConsumerFailure(scope, logger, {
      causation_id: envelope.causation_id,
      payment_intent_id: pi,
      order_id: order,
      error,
    })
    return
  }
  if (typeof envelope.causation_id === "string" && envelope.causation_id.length > 0) {
    logger.error?.(
      `[voucher-live-issue] ${CONSUMER_FAILURE_UNSTAMPABLE}: causation=${envelope.causation_id} ` +
        `bez payment_intent_id/order_id albo spoza route'u — rezerwacji nie da sie ostemplowac`
    )
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
    // Story 3.4 runda fix 2 (R-12): także ta porażka stempluje rezerwację.
    await recordEarlyConsumerFailure(
      container as unknown as { resolve: (key: string) => unknown },
      logger,
      event.data,
      error
    )
    throw err
  }

  const scope = container as unknown as { resolve: (key: string) => unknown }
  const db = resolveDb(scope)
  const now = new Date()
  // M2: `scope.market_id` zwalidowany w `toLiveIssueInput` (niepusty) — bezpieczne
  // źródło scope audytu/eventu okablowania (spójne z market_id użytym do INSERT).
  const marketId = String(input.scope.market_id)
  const instanceId = String(input.scope.instance_id)
  // Story 11.2: tożsamość instancji producenta z autorytatywnego nośnika
  // (GP_INSTANCE_ID). Brak = odmowa PRZED otwarciem tx (zero issue, zero emisji).
  let runtimeInstanceId: string
  try {
    runtimeInstanceId = requireRuntimeInstanceId("voucher-live-issue")
  } catch (err) {
    logger.error?.(`[voucher-live-issue] ${(err as Error).message}`)
    // Story 3.4 runda fix 2 (R-12): błędny GP_INSTANCE_ID też stempluje rezerwację.
    await recordPathYConsumerFailure(scope, logger, {
      causation_id: event.data?.causation_id,
      payment_intent_id: input.payload.payment_intent_id,
      order_id: input.payload.order_id,
      error: err as Error,
    })
    throw err
  }

  try {
    // ── (A) issue + OKABLOWANIE GENEZY ISSUED w JEDNEJ DB-tx (atomicity) ──────
    // Audyt (append-only) + posting hook (bramkowany, inert przy
    // runtime_enabled=false) wykonywane W TEJ tx (atomowo ze zmianą stanu, AI-Review-3).
    // Eventy zbierane do emisji POST-COMMIT (kontrakt atomowości okablowania).
    const scopedResults = await runInSystemMarketContext(
      {
        markets: [marketId],
        instanceId,
        origin: { surface: "subscriber", name: "voucher-live-issue" },
        logger,
      },
      async () => withTransaction(db, async (client) => {
      // Story 8.4 (FR-16, AD-19): izolacja per linia — porażka jednej pozycji
      // prezentowej NIE cofa pozycji udanych; wynik jest jawny per pozycja.
      const result = await liveIssueEntitlementsPerLineWithinTx(client, input, now)
      // Story 4.4 (R-5): ponowienie Stripe z rozwiązanym linkiem domyka rekord
      // śladu tej dostawy w TEJ SAMEJ tx co wystawienie. Pod SAVEPOINT-em —
      // porażka rekordu nie wycofuje wystawienia, ale zostawia linię `warn`.
      const traceEventId = stripeEventIdFromCausation(event.data?.causation_id)
      if (traceEventId && result.event_processed) {
        const closed = await closeDeferredIssuanceTraceGuarded(client, {
          stripe_event_id: traceEventId,
          instance_id: instanceId,
          market_id: marketId,
          order_id: input.payload.order_id,
          closure_path: DEFERRED_ISSUANCE_TRACE_CLOSURE_WEBHOOK_LIVE_ISSUE,
          evidence: {
            resolver: "subscriber:voucher-live-issue",
            payment_intent_id: input.payload.payment_intent_id,
            entitlements_issued: result.issued.length,
            resolved_at: now.toISOString(),
          },
        })
        if (!closed.ok) {
          logger.warn?.(
            `[voucher-live-issue] order=${input.payload.order_id} trace=${traceEventId} ` +
              `domkniecie rekordu deferred_issuance_trace NIEUDANE (wystawienie zachowane): ${closed.error}`
          )
        }
      }
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
              // Story 11.2 (DW-15-183): instancja runtime, nie id uprawnienia.
              instance_id: runtimeInstanceId,
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
    )
    const wired = scopedResults[0]
    if (!wired) throw new Error("voucher-live-issue nie ustanowił scope systemowego")

    const partialFailure = wired.result.failed_lines.length > 0

    // ── (B) replay/no-op event-level — zero issue, zero okablowania ───────────
    if (!wired.result.event_processed && !partialFailure) {
      logger.info?.(
        `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
          `replay/no-op (event-level dedupe) — zero issue`
      )
      // Story 3.4 runda fix 2 (R-9): skutek jednostki istnieje ⇒ zdejmij stempel.
      await recordPathYConsumerRecovery(scope, logger, {
        causation_id: event.data?.causation_id,
        payment_intent_id: input.payload.payment_intent_id,
        order_id: input.payload.order_id,
      })
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

    // Story 3.4 runda fix 2 (R-9, ADR-246 p.6): udana konsumpcja (bez porażki
    // linii) zdejmuje jednostkę ze stempla — samonaprawa ≠ trwały brak w ZAPISIE.
    if (!partialFailure) {
      await recordPathYConsumerRecovery(scope, logger, {
        causation_id: event.data?.causation_id,
        payment_intent_id: input.payload.payment_intent_id,
        order_id: input.payload.order_id,
      })
    }

    // ── (D) częściowa porażka (Story 8.4) — fail-loud PO commicie linii udanych ─
    // Linie udane są zacommitowane i okablowane; event NIE został skonsumowany,
    // więc rzut przekazuje Medusie retry/DLQ dla linii nieudanych (retry linii
    // udanych = no-op `already_issued`). Wynik per pozycja w logu i w błędzie.
    if (partialFailure) {
      const failure = new LiveIssuePartialFailureError(
        input.payload.payment_intent_id,
        input.payload.order_id,
        wired.result
      )
      logger.error?.(
        `[voucher-live-issue] line_outcomes=${JSON.stringify(
          wired.result.line_outcomes.map((o) =>
            o.state === "failed"
              ? { line_item_id: o.line_item_id, state: o.state, reason: o.reason }
              : { line_item_id: o.line_item_id, state: o.state }
          )
        )}`
      )
      throw failure
    }
  } catch (err) {
    const error = err as Error
    logger.error?.(
      `[voucher-live-issue] payment_intent=${input.payload.payment_intent_id} ` +
        `failed: ${error.name}: ${error.message}`
    )
    await recordPathYConsumerFailure(scope, logger, {
      causation_id: event.data?.causation_id,
      payment_intent_id: input.payload.payment_intent_id,
      order_id: input.payload.order_id,
      error,
    })
    throw err
  }
}

export const config: SubscriberConfig = {
  event: PAYMENT_INTENT_SUCCEEDED_EVENT,
}
