/**
 * on-order-placed-stripe-retry.ts — ODZYSK wystawienia po przegranym wyścigu
 * `payment_intent.succeeded` × `completeCart`.
 *
 * ── Co odzyskujemy ──────────────────────────────────────────────────────────
 * Przy natychmiastowych metodach płatności (BLIK, P24, Apple/Google Pay) Stripe
 * potrafi dostarczyć `payment_intent.succeeded` ZANIM storefront domknie
 * `/store/carts/:id/complete`. W tym momencie zamówienia jeszcze nie ma, więc
 * ścieżka wystawienia nie ma czego wystawić. Bez odzysku klientka płaci, widzi
 * potwierdzenie i nie dostaje vouchera — cisza po stronie systemu.
 *
 * ── DWA pokolenia piszą ślad; oba tu obsługujemy ────────────────────────────
 *  1. v1.9.0 — `workflows/payment/stripe-payment-audit.ts` (natywny hook
 *     `payment.captured`) stempluje wiersz dedupu
 *     `envelope.entitlement_issue_deferred_reason = 'webhook_before_order'`,
 *     `provider = 'stripe'`.
 *  2. v1.15.0 — cienki route Path Y
 *     (`api/webhooks/stripe/payment-intent/route.ts`) przy przegranym wyścigu
 *     odpowiada `503` i zostawia WŁASNY ślad przez
 *     `persistDeferredIssuanceMarker`, z `provider =
 *     STRIPE_PATH_Y_WEBHOOK_PROVIDER` i kluczem `<event_id>#deferred-issuance`.
 *     Ta wartość `provider` jest celowo różna: kompensacja ścieżki natywnej
 *     kasuje po `provider = 'stripe'` i nie wolno jej dosięgnąć wierszy Path Y.
 *
 * Ten subscriber słucha `order.placed`, znajduje ślady dopięte do płatności
 * TEGO zamówienia i retroaktywnie woła `issueEntitlementsForAllLineItems`.
 *
 * ── Niezmienniki, których nie wolno stracić ─────────────────────────────────
 *  - Wspólna brama (ADR-107 §Etap-2): wystawienie wymaga OBU faktów
 *    (`payment.captured` + `order.placed`); ten plik realizuje wariant
 *    „captured pierwszy".
 *  - Idempotencja: UNIQUE per `(order_id, line_item_id)` na
 *    `entitlement_instance` czyni ponowne wystawienie no-opem.
 *  - `market_id` NIE jest zgadywany. Ślad Path Y niesie `wep.market_id = NULL`,
 *    bo metadata PaymentIntenta w wyścigu mają tylko `session_id`. Rynek
 *    wyprowadzamy z zamówienia w TEJ SAMEJ kolejności pierwszeństwa co
 *    `lib/payment/stripe-payment-intent-link.ts`: `order.metadata->gp->market_id`
 *    → `order.metadata->market_id` → `sales_channel.metadata->>'gp_market_id'`.
 *    Bez tego konsument (fail-closed) rzucał `MissingVoucherIssuanceMarketError`
 *    przy KAŻDYM przebiegu i ślad nigdy nie był domykany.
 *  - Domknięcie jest PER PARA `(event_id, order_id)`. Jeden PaymentIntent może
 *    dać N zamówień (Mercur dzieli checkout per seller, ADR-166), a ślad jest
 *    JEDEN — skalarne domknięcie zabierało wystawienie drugiemu i każdemu
 *    kolejnemu sprzedawcy.
 *  - Odzysk NIE wystawia kodu bez pokrycia: płatność musi być nieusunięta,
 *    nieanulowana i bez zwrotu.
 *
 * NOTE: `order.placed` słucha także `on-order-completed.ts`. Współistnieją:
 * tutaj jest ścieżka odzysku Stripe, tam no-op breadcrumb po rewersie Wave-B
 * (H-8).
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { toKnexPositionalSql } from "../lib/knex-positional-sql"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../lib/payment/stripe-payment-intent-event"
import {
  DEFERRED_ISSUANCE_EVENT_SUFFIX,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../lib/payment/stripe-payment-intent-transport"
import {
  closeDeferredIssuanceTraceGuarded,
  DEFERRED_ISSUANCE_TRACE_CLOSURE_ORDER_PLACED,
} from "../lib/recovery/deferred-issuance-trace"
import { resolveRuntimeInstanceId } from "../lib/market-context"
import {
  isRuntimeInstanceIdentityError,
  requireRuntimeInstanceId,
  RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE,
} from "../lib/runtime-instance-identity"
import {
  buildGenesisActiveTransition,
  buildGenesisIssuedTransition,
  emitTransitionEventAfterCommit,
  wireEntitlementTransitionPersisted,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
} from "../modules/voucher/entitlement-transition-wiring"
import { activateIssuedEntitlement } from "../modules/voucher/workflows/activate-issued-entitlement"
import {
  issueEntitlementsForAllLineItems,
  MissingEntitlementProfileError,
  VoucherIssuanceBlockedError,
} from "../workflows/entitlements/issue-entitlement"
import {
  liveIssueEntitlementsPerLineWithinTx,
  PATH_Y_RECOVERY_PATH,
} from "../workflows/entitlements/live-issue-from-payment-intent"
import {
  numericMinorStringToSafeInteger,
  readNumericMinorString,
} from "../lib/payment/numeric-minor"
import {
  classifyEventFailure,
  type EventFailureClassification,
} from "../lib/events/event-failure-classification"
import { DeadLetterRefusedError, recordEventDeadLetter } from "../lib/events/event-dead-letter"

/** `source_job` wierszy DLQ z tego konsumenta (Story 4.6, ADR-239). */
export const STRIPE_RETRY_DLQ_SOURCE = "subscriber:on-order-placed-stripe-retry"

/**
 * Nazwany kod kanału fail-loud: zapis wiersza DLQ się NIE udał (odmowa
 * `scope_missing` albo błąd bazy). Subskrybent NIE rzuca (ponowienie trwałej
 * wady niczego nie naprawia i przerwałoby odzysk pozostałych zamówień) —
 * zamiast tego `logger.error` z tym kodem per porażka, `logger.error` z kodem
 * `dlq_write_failed_summary` na końcu przebiegu i `dlq_write_failures`
 * w wyniku subskrybenta (Story 4.6, runda fix 1, R-1/R-2/R-6).
 */
export const DLQ_WRITE_FAILED_CODE = "dlq_write_failed" as const

export type DlqWriteFailure = {
  order_id: string
  event_id: string
  event_class: EventFailureClassification["event_class"]
  /** Odmowa writera (`DeadLetterRefusedError.refusal`) albo `db_error`. */
  cause: DeadLetterRefusedError["refusal"] | "db_error"
  message: string
}

export type StripeRetryRunResult = { dlq_write_failures: DlqWriteFailure[] }

function dlqWriteFailure(
  orderId: string,
  eventId: string,
  classification: EventFailureClassification,
  dlqErr: unknown
): DlqWriteFailure {
  return {
    order_id: orderId,
    event_id: eventId,
    event_class: classification.event_class,
    cause: dlqErr instanceof DeadLetterRefusedError ? dlqErr.refusal : "db_error",
    message: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
  }
}

function logDlqWriteFailure(logger: { error?: (msg: string) => void }, f: DlqWriteFailure): void {
  logger.error?.(
    `[on-order-placed-stripe-retry] code=${DLQ_WRITE_FAILED_CODE} order_id=${f.order_id} ` +
      `event_id=${f.event_id} cause=${f.cause} class=${f.event_class}: ${f.message}`
  )
}

/**
 * Porażka wiersza, której klasa idzie do DLQ, a której NIE da się zapisać
 * w bieżącej transakcji (błąd PG ją przerwał). Niesie scope wiersza do
 * zewnętrznego `catch`, który zapisuje DLQ w NOWEJ transakcji.
 */
export class DeadLetterPendingError extends Error {
  constructor(
    readonly row: { event_id: string; market_id: string | null },
    readonly order_id: string,
    readonly classification: EventFailureClassification,
    readonly original: unknown
  ) {
    super(classification.reason)
    this.name = "DeadLetterPendingError"
  }
}

/**
 * Wartości `webhook_event_processed.provider`, które mogą nieść ślad deferral.
 *
 * DWA POKOLENIA mechanizmu piszą ten ślad i każde ma własną wartość — celowo,
 * bo kompensacja ścieżki natywnej kasuje po `provider = 'stripe'` i nie wolno
 * jej dosięgnąć wierszy Path Y (patrz nagłówek `stripe-payment-intent-transport.ts`):
 *
 *   - `stripe`                        — `workflows/payment/stripe-payment-audit.ts` (v1.9.0),
 *   - `stripe_payment_intent_webhook` — route Path Y przy przegranym wyścigu (v1.15.0).
 *
 * Do 2026-08-10 ten subscriber znał tylko pierwszą, a produkcję ruchu przejęła
 * druga — więc odzysk nie miał czego dopasować i przegrany wyścig zostawał
 * nieodwracalny mimo istniejącej maszynerii. SELECT i UPDATE MUSZĄ używać TEJ
 * SAMEJ listy: gdyby UPDATE został przy węższej, ślad byłby odzyskiwany i nigdy
 * oznaczany, więc każdy kolejny `order.placed` wołałby wystawienie ponownie.
 *
 * Stała leży w bloku na GÓRZE pliku, bo oba zapytania generują z jej DŁUGOŚCI
 * listę placeholderów w czasie inicjalizacji modułu — deklaracja między
 * funkcjami dawałaby TDZ.
 */
export const DEFERRAL_MARKER_PROVIDERS = ["stripe", STRIPE_PATH_Y_WEBHOOK_PROVIDER]

/**
 * Lista JAWNYCH placeholderów `$n, $n+1, …` o długości `DEFERRAL_MARKER_PROVIDERS`.
 *
 * Dlaczego nie `= ANY($n)` z bindingiem tablicowym: produkcyjną gałęzią dostępu
 * do PG jest Knex (`__pg_pool__` nie jest w tym repo nigdzie rejestrowany), a
 * `lib/knex-positional-sql.ts` RZUCA `SqlDialectError` na każdym bindingu będącym
 * tablicą — Knex rozwinąłby ją w `?, ?` i rozjechał licznik bindingów. Wariant
 * `ANY(...)` rzucał więc ZAWSZE, wywracając także odzysk pokolenia v1.9.0, który
 * wcześniej działał.
 */
function providerPlaceholders(firstIndex: number): string {
  return DEFERRAL_MARKER_PROVIDERS.map(
    (_provider, offset) => `$${firstIndex + offset}`
  ).join(", ")
}

/**
 * Ślady deferral dopięte do płatności TEGO zamówienia.
 *
 * Bindingi: `$1` = order_id, `$2..` = `DEFERRAL_MARKER_PROVIDERS` (spread, każda
 * wartość skalarnie). Buduje je `buildFindDeferredCapturesBindings`.
 *
 * Trzy własności, których utrata jest cicha i kosztowna:
 *  1. `market_id` z COALESCE po zamówieniu — ślad Path Y niesie NULL, a konsument
 *     jest fail-closed. Kolejność pierwszeństwa JEST TA SAMA co w
 *     `lib/payment/stripe-payment-intent-link.ts` (`order.metadata->gp->market_id`,
 *     `order.metadata->market_id`, `sales_channel.metadata->>'gp_market_id'`),
 *     żeby odzysk nigdy nie wystawił na innym rynku niż ścieżka główna.
 *  2. Płatność musi być realizowalna: nieusunięta, NIEANULOWANA i BEZ zwrotu.
 *     Bez tego odzysk wystawia kod bez pokrycia.
 *  3. Wykluczenie domkniętych jest PER PARA `(event_id, order_id)` — patrz
 *     `MARK_DEFERRED_RESOLVED_SQL`. Ostatni człon (`resolved_at` bez
 *     `resolved_orders`) trzyma zgodność wstecz ze śladami domkniętymi pod
 *     starą, skalarną semantyką.
 *
 * `jsonb_exists(...)` zamiast operatora `?`: znak zapytania jest placeholderem
 * bindingu Knexa, więc wersja operatorowa nigdy nie doszła do bazy
 * (`Expected 1 bindings, saw 3`).
 */
export const FIND_DEFERRED_CAPTURES_SQL = `
      SELECT
        wep.event_id,
        wep.provider,
        COALESCE(
          wep.market_id,
          o.metadata->'gp'->>'market_id',
          o.metadata->>'market_id',
          sc.metadata->>'gp_market_id'
        ) AS market_id,
        wep.envelope,
        p.amount,
        p.currency_code,
        p.id AS payment_id,
        SUBSTRING(wep.envelope->>'scope' FROM 'payment_intent:(.+)') AS payment_intent_id
      FROM webhook_event_processed wep
      JOIN payment p
        ON wep.envelope->>'scope' = 'payment_intent:' || (p.data->>'id')
        AND p.deleted_at IS NULL
        AND p.canceled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM refund r
           WHERE r.payment_id = p.id
             AND r.deleted_at IS NULL
        )
      JOIN order_payment_collection opc
        ON opc.payment_collection_id = p.payment_collection_id
        AND opc.deleted_at IS NULL
      LEFT JOIN "order" o
        ON o.id = opc.order_id
        AND o.deleted_at IS NULL
      LEFT JOIN sales_channel sc
        ON sc.id = o.sales_channel_id
        AND sc.deleted_at IS NULL
      WHERE opc.order_id = $1
        AND wep.provider IN (${providerPlaceholders(2)})
        AND wep.envelope->>'event_type' = 'payment.captured'
        AND jsonb_exists(wep.envelope, 'entitlement_issue_deferred_reason')
        AND NOT jsonb_exists(
          COALESCE(wep.envelope->'entitlement_issue_resolved_orders', '[]'::jsonb),
          $1
        )
        AND NOT (
          jsonb_exists(wep.envelope, 'entitlement_issue_resolved_at')
          AND NOT jsonb_exists(wep.envelope, 'entitlement_issue_resolved_orders')
        )
    `

/**
 * Domknięcie śladu PER PARA `(event_id, order_id)`.
 *
 * Bindingi: `$1` = event_id, `$2` = znacznik czasu, `$3` = order_id,
 * `$4..` = `DEFERRAL_MARKER_PROVIDERS`. Buduje je
 * `buildMarkDeferredResolvedBindings`.
 *
 *  - `entitlement_issue_resolved_orders` (TABLICA) jest nośnikiem domknięcia.
 *    Skalarny stempel gubił wystawienie drugiemu i każdemu kolejnemu sprzedawcy:
 *    jeden PaymentIntent → N zamówień, ale ślad jest JEDEN (ADR-166).
 *  - Skalarne `entitlement_issue_resolved_at` / `_reason` ZOSTAJĄ (ostatnie
 *    domknięcie) dla zgodności wstecz z zapytaniami operatorskimi.
 *  - `jsonb_exists(envelope, 'entitlement_issue_deferred_reason')` w WHERE jest
 *    warunkiem poprawności, nie ozdobą: rezerwacja transportu Path Y ma TO SAMO
 *    `event_id` i tę samą wartość `provider`, więc bez tego predykatu UPDATE
 *    stemplował CUDZY wiersz.
 */
export const MARK_DEFERRED_RESOLVED_SQL = `UPDATE webhook_event_processed
        SET envelope = envelope || jsonb_build_object(
              'entitlement_issue_resolved_at', $2::text,
              'entitlement_issue_resolved_reason', 'order.placed_retry',
              'entitlement_issue_resolved_orders',
                COALESCE(envelope->'entitlement_issue_resolved_orders', '[]'::jsonb)
                  || to_jsonb($3::text)
            )
      WHERE event_id = $1
        AND provider IN (${providerPlaceholders(4)})
        AND jsonb_exists(envelope, 'entitlement_issue_deferred_reason')`

/** Bindingi `FIND_DEFERRED_CAPTURES_SQL` — spread, żadna wartość nie jest tablicą. */
export function buildFindDeferredCapturesBindings(orderId: string): unknown[] {
  return [orderId, ...DEFERRAL_MARKER_PROVIDERS]
}

/** Bindingi `MARK_DEFERRED_RESOLVED_SQL` — spread, żadna wartość nie jest tablicą. */
export function buildMarkDeferredResolvedBindings(
  eventId: string,
  resolvedAtIso: string,
  orderId: string
): unknown[] {
  return [eventId, resolvedAtIso, orderId, ...DEFERRAL_MARKER_PROVIDERS]
}

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type OrderPlacedPayload = {
  id?: string
  order_id?: string
  order_ids?: string[]
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release?: () => void
}
type PgPool = { connect: () => Promise<PgClient> }
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

function resolveLogger(
  container: Record<string, unknown> | undefined
): LoggerLike {
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

function extractOrderIds(data: OrderPlacedPayload): string[] {
  if (Array.isArray(data.order_ids) && data.order_ids.length > 0) {
    return data.order_ids
  }
  if (typeof data.order_id === "string" && data.order_id.length > 0) {
    return [data.order_id]
  }
  if (typeof data.id === "string" && data.id.length > 0) {
    return [data.id]
  }
  return []
}

function resolveDb(scope: {
  resolve: (key: string) => unknown
}): PgPool | KnexLike {
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
    ) => {
      // Kanoniczna konwersja `$N` → `?` zamiast lokalnej kopii. Lokalna wersja
      // nie miała guardu na SQL zawierający już `?`, więc jsonb-owy operator
      // istnienia klucza (`envelope ? 'klucz'`) przechodził jako placeholder
      // Knexa i cały subscriber padał na `Expected 1 bindings, saw 3` — cicho,
      // przy każdym `order.placed`. Guard zamienia tę klasę błędu w wyjątek
      // przy pierwszym wywołaniu zamiast w produkcyjną ciszę.
      const { text: sql, bindings } = toKnexPositionalSql(text, values)
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

export type DeferredCaptureRow = {
  event_id: string
  provider: string
  market_id: string | null
  payment_intent_id: string | null
  envelope: Record<string, unknown>
  /**
   * Story 3.5 (DW-15-134): `payment.amount` jest NUMERIC, node-pg zwraca go
   * jako STRING — wartość zostaje łańcuchem (jednostki minor), bez `Number()`.
   */
  amount_minor: string | null
  currency: string | null
  payment_id: string | null
}

/**
 * Ślady deferral do odzyskania dla TEGO zamówienia — wiersze
 * `webhook_event_processed`, które:
 *   - noszą `entitlement_issue_deferred_reason` (dowolne z dwóch pokoleń),
 *   - NIE zostały jeszcze domknięte dla tego `order_id`,
 *   - są dopięte przez `envelope->>'scope'` do REALIZOWALNEJ płatności tego
 *     zamówienia (nieusuniętej, nieanulowanej, bez zwrotu).
 *
 * Kontrakt zapytania (SQL, bindingi, powody) trzyma `FIND_DEFERRED_CAPTURES_SQL`.
 * Wiele dopasowań jest dopuszczalne.
 */
async function findDeferredCapturesForOrder(
  client: PgClient,
  orderId: string
): Promise<DeferredCaptureRow[]> {
  const result = await client.query<{
    event_id: string
    provider: string
    market_id: string | null
    envelope: Record<string, unknown>
    amount: string | number | null
    currency_code: string | null
    payment_id: string | null
    payment_intent_id: string | null
  }>(
    FIND_DEFERRED_CAPTURES_SQL,
    buildFindDeferredCapturesBindings(orderId)
  )

  return result.rows.map((r) => ({
    event_id: r.event_id,
    provider: r.provider,
    market_id: r.market_id,
    payment_intent_id: r.payment_intent_id,
    envelope: r.envelope,
    // C2-L-3: `?? 0` czyniło gałąź `null` w `buildPathYRecoveryInput` MARTWĄ —
    // brak kwoty stawał się kwotą zerową już tutaj, o jeden poziom przed
    // walidacją. Brak wartości zostaje `null` i jest odrzucany tam, gdzie
    // odrzucane są pozostałe nieczytelne pola.
    //
    // Story 3.5 (DW-15-134): bez `Number(r.amount)` — NUMERIC zostaje
    // łańcuchem; nieczytelny ⇒ `null` (odmowa niżej, nie zero).
    amount_minor: readNumericMinorString(r.amount),
    currency: r.currency_code?.toUpperCase() ?? null,
    payment_id: r.payment_id,
  }))
}

/**
 * Domyka ślad dla PARY `(event_id, order_id)`. Kontrakt zapytania trzyma
 * `MARK_DEFERRED_RESOLVED_SQL`.
 */
async function markDeferredResolved(
  client: PgClient,
  eventId: string,
  orderId: string,
  resolvedAt: Date
): Promise<void> {
  await client.query(
    MARK_DEFERRED_RESOLVED_SQL,
    buildMarkDeferredResolvedBindings(eventId, resolvedAt.toISOString(), orderId)
  )
}

/**
 * Marker Path Y nie nadaje się do odtworzenia — WŁASNA klasa, nie goły `Error`
 * (v1.15.0 Story 6.3, review-fix cyklu 1, F-1).
 *
 * Klasa istnieje po to, żeby `catch` pętli mógł ją odróżnić od awarii
 * nieznanego pochodzenia. Goły `Error` uciekał z `for (const row of deferred)`,
 * uciekał z `withTransaction`, a ROLLBACK obejmował CAŁY wsad zamówienia —
 * łącznie z markerami, które dały się odzyskać. Skutek na produkcji: opłacony
 * zakup bez ani jednego vouchera, `markDeferredResolved` niewykonane, jedyny
 * sygnał to jedna linia `logger.error`.
 *
 * ZMIERZONE na `gp_mercur` 2026-08-12: 19 markerów Path Y, z czego tylko 2
 * niosą `psp_occurred_at` (pole doszło dopiero z `99039ae`, bez backfillu),
 * a 4 są wciąż nierozwiązane. To nie jest hipoteza — to policzone wejście.
 *
 * To jest DOKŁADNIE ten regres, który review-fix cyklu 3 story 5.9 usunął dla
 * `VoucherIssuanceBlockedError` (patrz komentarz przy `catch` niżej).
 */
export class PathYRecoveryInputError extends Error {
  constructor(
    readonly event_id: string,
    readonly field: string,
    message: string
  ) {
    super(message)
    this.name = "PathYRecoveryInputError"
  }
}

export function buildPathYRecoveryInput(
  row: DeferredCaptureRow,
  orderId: string
) {
  // Story 11.1 REG-C5-001 (spójnie z 3.1 C3-SEC-002): business dedupe wymaga obu
  // osi scope. Instancja WYŁĄCZNIE z `GP_INSTANCE_ID` — bez fallbacku "gp"
  // i bez odczytu z metadata/envelope. Brak = nazwana odmowa, wiersz zostaje
  // nierozwiązany (ten sam kanał co pozostałe pola wejścia).
  const instanceId = resolveRuntimeInstanceId()
  if (!instanceId) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "instance_id",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id}: GP_INSTANCE_ID ` +
        "nie jest skonfigurowany — odmowa fail-closed (instance_unconfigured)"
    )
  }
  const pspOccurredAt = row.envelope.psp_occurred_at
  const amountMinor = row.amount_minor
  if (typeof pspOccurredAt !== "string" || !pspOccurredAt.trim()) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "psp_occurred_at",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id} nie niesie psp_occurred_at`
    )
  }
  if (!row.payment_intent_id) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "payment_intent_id",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id} nie niesie payment_intent_id`
    )
  }
  if (!row.market_id) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "market_id",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id} nie ma market_id po rezolucji zamówienia`
    )
  }
  if (!row.currency) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "currency",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id} nie ma currency płatności`
    )
  }
  // L-1 (review cyklu 1): `amount_minor` NIE jest czytane przez
  // `liveIssueEntitlementsWithinTx` — kwota entitlementu bierze się ze
  // snapshotu linii, co `live-issue-from-payment-intent.ts` deklaruje wprost
  // („`amount_minor` jest wartością finansową entitlementu, nie faktem PSP").
  // Jedyne użycie payloadu poza identyfikatorami to `profile.currency ??
  // payload.currency`. Fail-closed na tym polu odmawiał więc odzysku
  // z powodu wartości, która nie wpływa na wystawiony voucher — a kolumna
  // `payment.amount` jest `numeric`, więc pierwszy wiersz z częścią ułamkową
  // (`Number(r.amount)`) blokowałby wystawienie. Ryzyko bez zysku.
  //
  // Zostaje granica, która COŚ znaczy: kwota ujemna to nie zaokrąglenie,
  // tylko wiersz płatności, którego nie umiemy przeczytać. Wartość
  // niecałkowita jest normalizowana w dół do grosza, bo taką właśnie
  // precyzję niesie jednostka minor.
  //
  // C2-L-3 (review cyklu 2): `null`/`NaN` NIE schodzi już po cichu do `0`.
  // Bezpieczeństwo tamtej linii opierało się na fakcie ZEWNĘTRZNYM wobec tego
  // pliku — `live-issue-from-payment-intent.ts` dziś nie czyta
  // `payload.amount_minor` (jedyne odczyty payloadu to identyfikatory
  // i `payload.currency`). Pierwszy konsument, który zacznie tę wartość
  // czytać, dostałby wtedy wyzerowaną kwotę bez żadnego śladu. `0` jest
  // legalną kwotą, więc cicha domyślna jest tu nieodróżnialna od pomiaru;
  // odmowa jest odróżnialna i ląduje w tym samym kanale, co pozostałe pola
  // (wiersz zostaje NIEROZWIĄZANY, `logger.warn` niesie `field`).
  // Story 3.5: zamiana łańcucha na liczbę kontraktu koperty jest DOKŁADNA
  // (BigInt) — wartość poza bezpiecznym zakresem jest odmową, nie zaokrągleniem.
  const normalizedAmountMinor = numericMinorStringToSafeInteger(amountMinor)
  if (normalizedAmountMinor === null) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "amount_minor",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id} nie niesie ` +
        `czytelnego amount_minor (${String(amountMinor)}) — odmowa fail-closed ` +
        "zamiast cichego zera"
    )
  }
  if (normalizedAmountMinor < 0) {
    throw new PathYRecoveryInputError(
      row.event_id,
      "amount_minor",
      `[on-order-placed-stripe-retry] Path Y marker ${row.event_id} ma ujemne ` +
        `amount_minor (${amountMinor})`
    )
  }

  return {
    event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
    payload: {
      payment_intent_id: row.payment_intent_id,
      order_id: orderId,
      currency: row.currency,
      amount_minor: normalizedAmountMinor,
      psp_occurred_at: pspOccurredAt,
    },
    scope: { instance_id: instanceId, market_id: row.market_id },
    // Story 3.4 (DW-15-331 p.3): bariera zapisuje rzeczywistą trasę — odzysk,
    // nie subscriber `voucher-live-issue`.
    claimed_by_path: PATH_Y_RECOVERY_PATH,
  }
}

export default async function onOrderPlacedStripeRetry({
  event,
  container,
}: SubscriberArgs<OrderPlacedPayload>): Promise<StripeRetryRunResult> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>)
  const dlqWriteFailures: DlqWriteFailure[] = []
  const orderIds = extractOrderIds(event.data)
  if (orderIds.length === 0) {
    return { dlq_write_failures: dlqWriteFailures }
  }

  const scope = container as unknown as { resolve: (key: string) => unknown }
  const db = resolveDb(scope)

  const eventBus = resolveEventBus(scope)

  for (const orderId of orderIds) {
    // Zdarzenia zbierane W transakcji, emitowane DOPIERO po commicie —
    // wewnętrzny emit zostawiłby phantom-event przy rollbacku (KONTRAKT
    // ATOMOWOŚCI w `entitlement-transition-wiring`).
    const transitionEvents: TransitionEventEnvelope[] = []
    try {
      await withTransaction(db, async (client) => {
        const deferred = await findDeferredCapturesForOrder(client, orderId)
        if (deferred.length === 0) {
          return
        }

        for (const row of deferred) {
          try {
            if (row.provider === STRIPE_PATH_Y_WEBHOOK_PROVIDER) {
              const input = buildPathYRecoveryInput(row, orderId)
              // Story 8.4 fix (checkpoint PO): odzysk Path Y jest ścieżką
              // NORMALNĄ (wyścig payment_intent.succeeded × completeCart), więc
              // idzie trybem izolacji per linia, nie all-or-nothing — porażka
              // jednej pozycji nie cofa pozycji udanych.
              const result = await liveIssueEntitlementsPerLineWithinTx(
                client,
                input,
                new Date()
              )
              const partialFailure = result.failed_lines.length > 0
              if (partialFailure) {
                // Marker ZOSTAJE nierozwiązany (bez `markDeferredResolved`):
                // to on jest nośnikiem populacji odzysku linii nieudanych
                // (kontrakt gift-line-issue-outcome.v1 §Semantyka p.5). Linie
                // udane są okablowane poniżej i commitują się z tą transakcją.
                logger.error?.(
                  `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                    `event_id=${row.event_id} Path Y częściowa porażka ` +
                    `failed=${result.failed_lines.length}/${result.line_outcomes.length} ` +
                    `— marker odroczony zostaje NIEROZWIĄZANY (populacja odzysku): ` +
                    `line_outcomes=${JSON.stringify(
                      result.line_outcomes.map((o) =>
                        o.state === "failed"
                          ? { line_item_id: o.line_item_id, state: o.state, reason: o.reason }
                          : { line_item_id: o.line_item_id, state: o.state }
                      )
                    )}`
                )
              } else {
                await markDeferredResolved(client, row.event_id, orderId, new Date())
              }

              // Story 4.4 (AC2): domknięcie TRWAŁEGO rekordu śladu w tej samej
              // transakcji co wystawienie — stan terminalny z zapisaną ścieżką
              // i evidence; wiersz zostaje (historia czytelna). Marker
              // Path Y ma klucz `<evt>#deferred-issuance` = `trace_id`.
              const stripeEventId = row.event_id.endsWith(DEFERRED_ISSUANCE_EVENT_SUFFIX)
                ? row.event_id.slice(0, -DEFERRED_ISSUANCE_EVENT_SUFFIX.length)
                : null
              if (stripeEventId) {
                const closed = await closeDeferredIssuanceTraceGuarded(client, {
                  stripe_event_id: stripeEventId,
                  instance_id: input.scope.instance_id,
                  market_id: input.scope.market_id,
                  order_id: orderId,
                  closure_path: DEFERRED_ISSUANCE_TRACE_CLOSURE_ORDER_PLACED,
                  evidence: {
                    resolver: "subscriber:on-order-placed-stripe-retry",
                    payment_intent_id: input.payload.payment_intent_id,
                    entitlements_issued: result.issued.length,
                    resolved_at: new Date().toISOString(),
                  },
                })
                if (!closed.ok) {
                  logger.warn?.(
                    `[on-order-placed-stripe-retry] order_id=${orderId} trace=${row.event_id} ` +
                      `domkniecie rekordu deferred_issuance_trace NIEUDANE (wystawienie zachowane): ${closed.error}`
                  )
                } else {
                  logger.info?.(
                    `[on-order-placed-stripe-retry] order_id=${orderId} trace=${row.event_id} ` +
                      (closed.version === null
                        ? "rekord deferred_issuance_trace nieobecny albo juz domkniety dla tego zamowienia"
                        : `rekord deferred_issuance_trace domkniety (issued_after_link, version=${closed.version})`)
                  )
                }
              }

              const appendAudit = makeTransitionAuditSink(logger)
              const issuedAt = new Date()
              for (const issued of result.issued) {
                if (!issued.created) continue
                const { event } = await wireEntitlementTransitionPersisted(
                  { appendAudit, clock: () => issuedAt },
                  buildGenesisIssuedTransition({
                    entitlement_id: issued.entitlement_id,
                    scope: {
                      // Story 11.2 (DW-15-183/DW-15-298 p.4): instancja runtime
                      // z `buildPathYRecoveryInput` (GP_INSTANCE_ID), nie id uprawnienia.
                      instance_id: input.scope.instance_id,
                      market_id: input.scope.market_id,
                      sales_channel_id: null,
                      vendor_id: null,
                      location_id: null,
                    },
                    actor: "system",
                    actor_hint:
                      "subscriber:on-order-placed-stripe-retry:path-y-deferred-issuance",
                    occurred_at: input.payload.psp_occurred_at,
                    transition_seq: issued.entitlement_dedupe_key,
                  })
                )
                transitionEvents.push(event)

                // Krawędź ISSUED → ACTIVE jest RZECZYWISTA (wiersz wstawiony
                // jako ISSUED), więc emitujemy ją dopiero po udanym UPDATE —
                // event bez zmiany stanu byłby fałszywym śladem w dzienniku.
                // AD-7: subscriber dostawy konsumuje obie genezy i deduplikuje
                // po `template_key` + `recipient_hash`, więc drugi event NIE
                // wysyła drugiego maila.
                if (!(await activateIssuedEntitlement(client, issued.entitlement_id))) {
                  continue
                }
                const { event: activatedEvent } =
                  await wireEntitlementTransitionPersisted(
                    { appendAudit, clock: () => issuedAt },
                    buildGenesisActiveTransition({
                      entitlement_id: issued.entitlement_id,
                      scope: {
                        instance_id: input.scope.instance_id,
                        market_id: input.scope.market_id,
                        sales_channel_id: null,
                        vendor_id: null,
                        location_id: null,
                      },
                      actor: "system",
                      actor_hint:
                        "subscriber:on-order-placed-stripe-retry:path-y-auto-activation",
                      occurred_at: input.payload.psp_occurred_at,
                      transition_seq: issued.entitlement_dedupe_key,
                    })
                  )
                transitionEvents.push(activatedEvent)
              }

              logger.info?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} Path Y ISSUED->ACTIVE ` +
                  `${result.issued.length} entitlement(s)`
              )
              continue
            }

            // Story 11.2 (ADR-240, review R-5): tożsamość instancji ustalana
            // PRZED wystawieniem — brak GP_INSTANCE_ID odmawia temu wierszowi,
            // zanim cokolwiek zostanie zapisane (obsługa w `catch` niżej).
            const runtimeInstanceId = requireRuntimeInstanceId(
              "on-order-placed-stripe-retry"
            )
            const result = await issueEntitlementsForAllLineItems(
              client,
              {
                event_id: row.event_id,
                order_id: orderId,
                payment_id: row.payment_id ?? undefined,
                payment_intent_id: row.payment_intent_id ?? undefined,
                market_id: row.market_id,
                // Story 3.5: kwota PI nie jest kwotą vouchera — wystawienie
                // bierze kwotę z linii; tu tylko dokładna liczba albo `null`.
                amount_minor: numericMinorStringToSafeInteger(row.amount_minor),
                currency: row.currency,
                entitlement_profile: null,
              },
              new Date()
            )
            await markDeferredResolved(client, row.event_id, orderId, new Date())

            // AD-7 — geneza ACTIVE przez TEN SAM punkt okablowania co ścieżka
            // webhooka (`stripe-payment-audit`). Bez tego odzysk wystawiał
            // uprawnienia i NIE ZAWIADAMIAŁ nikogo: `voucher-purchase-delivery`
            // słucha wyłącznie `entitlement_state_changed`, więc mail czekał na
            // sweep rekonsyliacyjny — 30 min karencji plus kwadransowa kadencja.
            //
            // A ta ścieżka NIE jest wyjątkiem: webhook Stripe'a kończy się 503
            // (`link_unresolved` — payment intent nie niesie `order_id`
            // w metadanych) przy KAŻDYM zakupie kartą, zmierzone dwa razy
            // 2026-08-11. Odzysk jest więc ścieżką normalną, a nie awaryjną.
            //
            // Wiring wołany WYŁĄCZNIE dla nowo utworzonych wierszy
            // (`idempotent=false`) — powtórka nie re-audytuje i nie re-emituje.
            const appendAudit = makeTransitionAuditSink(logger)
            const issuedAt = new Date()
            for (const issued of result.results) {
              if (issued.idempotent) continue
              const { event } = await wireEntitlementTransitionPersisted(
                { appendAudit, clock: () => issuedAt },
                buildGenesisActiveTransition({
                  entitlement_id: issued.entitlement_id,
                  scope: {
                    instance_id: runtimeInstanceId,
                    // Ten sam precedens defensywny co w ścieżce webhooka: brak
                    // market_id nie może wywrócić transakcji biznesowej.
                    market_id: row.market_id ?? "unknown",
                    sales_channel_id: null,
                    vendor_id: null,
                    location_id: null,
                  },
                  actor: "system",
                  actor_hint:
                    "subscriber:on-order-placed-stripe-retry:deferred-issuance",
                  occurred_at: issuedAt.toISOString(),
                  transition_seq: issued.entitlement_id,
                })
              )
              transitionEvents.push(event)
            }

            logger.info?.(
              `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                `event_id=${row.event_id} retroactively issued ` +
                `${result.results.length} entitlement(s)`
            )
          } catch (err) {
            if (err instanceof MissingEntitlementProfileError) {
              logger.warn?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} still missing entitlement_profile ` +
                  `after order.placed — operator action required: ${err.message}`
              )
              continue
            }
            // v1.15.0 Story 5.9 review-fix cyklu 3 (REG-HIGH-2): wystawienie
            // ZABLOKOWANE danymi obsługiwane tak samo jak brak profilu.
            //
            // Cykl 2 dołożył na tej ścieżce fail-loud na brakującym dowiązaniu
            // salonu, a ten `catch` przepuszczał dalej wszystko poza brakiem
            // profilu. Skutek: wyjątek uciekał z `withTransaction`,
            // `markDeferredResolved` nigdy się nie wykonywało, więc odroczone
            // przechwycenie zostawało w kolejce i było odtwarzane BEZ KOŃCA —
            // przy każdym `order.placed`, z identycznym wynikiem.
            //
            // Wiersz odroczony ZOSTAJE nierozwiązany celowo (nie wołamy
            // `markDeferredResolved`): dane katalogu mogą zostać naprawione
            // i wtedy kolejny przebieg wystawi kod. Zmienia się to, że
            // pozostałe wiersze tej samej paczki są przetwarzane dalej, zamiast
            // wywracać się razem z tym jednym.
            if (err instanceof VoucherIssuanceBlockedError) {
              logger.warn?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} voucher issuance blocked ` +
                  `(reason=${err.reason}, line_item_id=${err.line_item_id ?? "brak"}) ` +
                  `— uprawnienie NIE wystawione (fail-closed, SM-7), wiersz odroczony ` +
                  `zostaje do ponowienia po naprawie danych: ${err.message}`
              )
              continue
            }
            // F-1 (review-fix cyklu 1 story 6.3): marker Path Y, którego NIE DA
            // SIĘ przeczytać, jest odmową TEGO WIERSZA — nie awarią paczki.
            //
            // Wiersz ZOSTAJE nierozwiązany celowo (nie wołamy
            // `markDeferredResolved`), dokładnie jak przy
            // `VoucherIssuanceBlockedError`: marker legacy może dostać backfill,
            // a wtedy kolejny `order.placed` go odzyska. Zmienia się to, że
            // pozostałe markery tej samej paczki — w tym markery pokolenia
            // v1.9.0, które odzyskują się poprawnie — są przetwarzane dalej,
            // zamiast wywracać się razem z tym jednym.
            // Story 11.2 (review R-5): brak GP_INSTANCE_ID — nazwana odmowa
            // PRZED wystawieniem. Wiersz zostaje nierozwiązany (bez
            // `markDeferredResolved`) do ponowienia po konfiguracji instancji;
            // pozostałe wiersze paczki przetwarzane dalej.
            if (isRuntimeInstanceIdentityError(err)) {
              logger.error?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} RuntimeInstanceIdentityError ` +
                  `(${RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE}) — uprawnienie NIE ` +
                  `wystawione, zero zapisów, wiersz odroczony zostaje do ponowienia: ` +
                  `${err.message}`
              )
              continue
            }
            if (err instanceof PathYRecoveryInputError) {
              // Story 4.6 (AD-32): trwała wada danych markera → wiersz DLQ w TEJ
              // transakcji (pod savepointem, żeby porażka zapisu nie wywróciła
              // odzyskanych sąsiadów). Marker zostaje nierozwiązany (backfill
              // nadal możliwy), ale powtórka nie mnoży wpisów: DLQ jest idempotentny.
              // Brak instance_id/market_id = brak scope'u nośnika pod RLS —
              // wtedy jedynym skutkiem jest głośny log (DW, populacja globalna).
              if (err.field !== "instance_id" && err.field !== "market_id") {
                const classification = classifyEventFailure(err, {
                  permanentDefectCode: (e) =>
                    e instanceof PathYRecoveryInputError ? `path_y_marker_${e.field}` : null,
                })
                await client.query("SAVEPOINT gp_dlq_entry")
                try {
                  const written = await recordEventDeadLetter(client, {
                    instance_id: resolveRuntimeInstanceId(),
                    market_id: row.market_id,
                    source_job: STRIPE_RETRY_DLQ_SOURCE,
                    event_id: row.event_id,
                    subject_id: orderId,
                    classification,
                    occurred_at: new Date(),
                  })
                  await client.query("RELEASE SAVEPOINT gp_dlq_entry")
                  logger.warn?.(
                    `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                      `event_id=${row.event_id} marker Path Y nieodtwarzalny ` +
                      `(brakujące/niepoprawne pole: ${err.field}) — ten marker POMINIĘTY, ` +
                      `class=${classification.event_class} ` +
                      `dlq_entry_id=${written.dlq_entry_id} inserted=${written.inserted}: ${err.message}`
                  )
                } catch (dlqErr) {
                  const failure = dlqWriteFailure(orderId, row.event_id, classification, dlqErr)
                  dlqWriteFailures.push(failure)
                  logDlqWriteFailure(logger, failure)
                  await client.query("ROLLBACK TO SAVEPOINT gp_dlq_entry")
                }
                continue
              }
              logger.error?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} class=permanent_data_defect ` +
                  `dlq_unscoped (field=${err.field}) — brak scope'u nośnika DLQ`
              )
              logger.warn?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} marker Path Y nieodtwarzalny ` +
                  `(brakujące/niepoprawne pole: ${err.field}) — ten marker ` +
                  `POMINIĘTY, pozostałe wiersze paczki przetwarzane dalej; ` +
                  `wiersz zostaje nierozwiązany do ponowienia: ${err.message}`
              )
              continue
            }
            // Story 4.6: brak klasy domyślnej „spróbuj jeszcze raz”. Przejściowa
            // → rethrow (ROLLBACK, marker nierozwiązany = nośnik ponowienia);
            // trwała / nieznana → DLQ w nowej transakcji (ta jest przerwana).
            const classification = classifyEventFailure(err)
            if (classification.event_class === "transient_retry") throw err
            throw new DeadLetterPendingError(row, orderId, classification, err)
          }
        }
      })
    } catch (err) {
      if (err instanceof DeadLetterPendingError) {
        try {
          const written = await withTransaction(db, (client) =>
            recordEventDeadLetter(client, {
              instance_id: resolveRuntimeInstanceId(),
              market_id: err.row.market_id,
              source_job: STRIPE_RETRY_DLQ_SOURCE,
              event_id: err.row.event_id,
              subject_id: err.order_id,
              classification: err.classification,
              occurred_at: new Date(),
            })
          )
          logger.error?.(
            `[on-order-placed-stripe-retry] order_id=${orderId} ` +
              `event_id=${err.row.event_id} class=${err.classification.event_class} ` +
              `dlq_entry_id=${written.dlq_entry_id} inserted=${written.inserted}: ${err.message}`
          )
        } catch (dlqErr) {
          // Utrata nośnika DLQ nie może być cicha (NFR-4): fail-loud NAZWANYM
          // kanałem, bez rethrow — rethrow ponawiałby trwałą wadę i przerywał
          // odzysk pozostałych zamówień (runda fix 1, R-1/R-2).
          const failure = dlqWriteFailure(err.order_id, err.row.event_id, err.classification, dlqErr)
          dlqWriteFailures.push(failure)
          logDlqWriteFailure(logger, failure)
        }
        continue
      }
      if (classifyEventFailure(err).event_class === "transient_retry") {
        logger.warn?.(
          `[on-order-placed-stripe-retry] order_id=${orderId} class=transient_retry ` +
            `— marker zostaje nierozwiązany do ponowienia: ${(err as Error).message}`
        )
        continue
      }
      const error = err as Error
      logger.error?.(
        `[on-order-placed-stripe-retry] order_id=${orderId} failed: ` +
          `${error.name}: ${error.message}`
      )
      // Do NOT re-throw: a recovery-side failure must not crash the order.placed
      // event delivery and block other subscribers. The deferred row stays
      // marked, an operator can investigate via the audit envelope.
      continue
    }

    // POST-COMMIT. Emit jest best-effort i NIGDY nie failuje transakcji
    // biznesowej (AD-7) — kompletność domyka sweep rekonsyliacyjny. Zysk jest
    // w CZASIE: mail idzie od razu, zamiast czekać do ~45 minut na siatkę.
    if (transitionEvents.length === 0) continue
    let emitFailures = 0
    for (const event of transitionEvents) {
      const failed = await emitTransitionEventAfterCommit(async (envelope) => {
        if (!eventBus) {
          throw new Error(
            "event bus niedostępny (emit best-effort — dogonienie: reconciliation sweep)"
          )
        }
        await eventBus.emit({
          name: ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
          data: envelope,
        })
      }, event)
      if (failed) emitFailures += 1
    }
    if (emitFailures > 0) {
      logger.warn?.(
        `[on-order-placed-stripe-retry] order_id=${orderId} ` +
          `entitlement_state_changed emit_failed=${emitFailures}/${transitionEvents.length} ` +
          `(best-effort; dogonienie = reconciliation sweep)`
      )
    }
  }

  if (dlqWriteFailures.length > 0) {
    logger.error?.(
      `[on-order-placed-stripe-retry] code=${DLQ_WRITE_FAILED_CODE}_summary ` +
        `count=${dlqWriteFailures.length} ` +
        `order_ids=${[...new Set(dlqWriteFailures.map((f) => f.order_id))].join(",")}`
    )
  }
  return { dlq_write_failures: dlqWriteFailures }
}

type EventBusLike = {
  emit: (event: { name: string; data: unknown }) => Promise<unknown>
}

/** Szyna zdarzeń (best-effort); `null`, gdy niedostępna — emit staje się no-opem. */
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

/** Append-only sink audytu tranzycji — ten sam kształt co w `stripe-payment-audit`. */
function makeTransitionAuditSink(
  logger: LoggerLike
): (audit: TransitionAuditEnvelope) => Promise<void> {
  return async (audit) => {
    logger.info?.(`[entitlement-transition-audit] ${JSON.stringify(audit)}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
