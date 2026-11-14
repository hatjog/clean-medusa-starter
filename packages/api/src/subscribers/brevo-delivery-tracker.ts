import { createHash } from "node:crypto"

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { AuditProvider } from "@gp/audit"
import type {
  ConsentBasis,
  Locale,
  NotificationAuditEnvelope,
  NotificationDeliveryAuditOutcome,
  NotificationDeliveryCorrelationState,
  NotificationDeliveryEventType,
} from "@gp/messaging"
import {
  backoffDelayMs,
  classifyDeliveryEventName,
  errorCodeFor,
  nextAttemptNumber,
  reactionFor,
  UnknownDeliveryEventError,
  UNRECOGNIZED_DELIVERY_EVENT_METRIC,
  type DeliveryEventReaction,
} from "../lib/delivery-event-classification"
import { createMoneyPathBrakeReader } from "../lib/money-path-brakes"
import {
  createBrevoDeliveryEventVerifier,
  DELIVERY_EVENT_VERIFICATION_UNAVAILABLE_CODE,
  type BrevoDeliveryEventVerifier,
} from "../lib/brevo-event-verification"
import { VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT } from "../modules/voucher-delivery/attempt-policy"
import {
  requireMarketContext,
  runInSystemMarketContext,
} from "../lib/system-market-context"
import {
  PgDispatchLedger,
  type ApplyProviderDeliveryStateResult,
} from "../modules/voucher-delivery/dispatch-ledger"
import { DELIVERY_DISPATCH_STATES } from "../modules/voucher-delivery/delivery-state"

/**
 * Path Y Brevo delivery subscriber.
 *
 * Idempotencja callbacku nie jest stanem procesu. Powtórzenia i wyścigi dwóch
 * instancji rozstrzyga atomowy UPDATE w `voucher_delivery_dispatch`, a trwały
 * wiersz jest źródłem prawdy dla provider_event_id.
 *
 * - Audit sink nadal może ponownie zobaczyć deterministyczną kopertę po replayu;
 *   deduplikacja faktu odbywa się po stronie trwałego sinka, nie przez cache
 *   procesu.
 * - Multi-event subscription (Medusa 2.14.2 `config.event: string[]`):
 *   weryfikacja runtime live w follow-up smoke test (Story 5.9 lub Sprint 3
 *   integration suite). Jeśli array form NIE supported → split do 6 plików
 *   per event z shared handler.
 * - DB lookup error semantics: missing relation (Postgres `42P01`) jest
 *   traktowane jako clean orphan; pozostałe DB errors (outage, connection
 *   drop) → `error_code: "DISPATCH_LOOKUP_FAILED"` w audit envelope dla
 *   operator alert distinction.
 */

/**
 * ADR-192: `notification.bounced` ZNIKA z listy subskrypcji. Nazwa `bounced` nie
 * niesie rozroznienia trwale/chwilowe/zablokowane/niepoprawny-adres/opoznienie,
 * ktorego wymaga FR-9d, wiec przyjmowanie jej oznaczaloby przywrocenie zwiniecia
 * tylnymi drzwiami. Na jej miejsce wchodzi piec rozlacznych nazw kanalu.
 */
export const BREVO_NOTIFICATION_EVENTS = Object.freeze([
  "notification.delivered",
  "notification.opened",
  "notification.clicked",
  "notification.hard_bounce",
  "notification.soft_bounce",
  "notification.blocked",
  "notification.invalid_email",
  "notification.deferred",
  "notification.complaint",
  "notification.unsubscribed",
  "notification.failed",
] as const)

const NO_RECIPIENT_SENTINEL = "__no_recipient__"
const UNKNOWN_FIELD_SENTINEL = "unknown"
const DISPATCH_LOOKUP_FAILED_CODE = "DISPATCH_LOOKUP_FAILED"
/** Rozjazd rynku ladunek<->wiersz dostawy (AD-21) — odmowa, nie wybor jednej z wartosci. */
const MARKET_CONFLICT_CODE = "DELIVERY_EVENT_MARKET_CONFLICT"
const POSTGRES_UNDEFINED_TABLE = "42P01"

type BrevoDeliveryEventPayload = {
  provider_id?: "brevo"
  provider_event_id?: string
  "message-id"?: string
  message_id?: string
  messageId?: string
  event_uuid?: string
  dispatch_id?: string
  event_type?: string
  event?: string
  occurred_at?: string
  date?: string
  ts?: string | number
  recipient_hash?: string
  recipient_email?: string
  email?: string
  flow_id?: string
  market_id?: string
  template_key?: string
  locale?: Locale
  consent_basis?: ConsentBasis
  idempotency_key?: string
  // `bounce_type` USUNIETY (ADR-192): sluzyl do rozroznienia hard/soft ZA
  // zwinieciem. Rozroznienie niesie teraz sama nazwa zdarzenia, wiec pole bylo
  // martwym nosnikiem, ktory wyglada na znaczacy.
  reason?: string
  error_code?: string
  error_message?: string
  raw_provider_payload?: unknown
}

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type ResolveContainer = {
  logger?: LoggerLike
  resolve?: (key: string) => unknown
}

type DispatchRecord = {
  dispatch_id?: string
  id?: string
  flow_id?: string
  market_id?: string
  template_key?: string
  locale?: Locale
  consent_basis?: ConsentBasis
  idempotency_key?: string
  /** Liczba prob zarejestrowanych po stronie SYSTEMU (AD-23), nie z ladunku. */
  attempts?: number
  status?: (typeof DELIVERY_DISPATCH_STATES)[number]
  provider_message_id?: string | null
}

type DispatchLookup = {
  findByProviderMessageId?: (providerMessageId: string) => Promise<DispatchRecord | null>
  findOneByProviderMessageId?: (providerMessageId: string) => Promise<DispatchRecord | null>
  findOne?: (query: Record<string, unknown>) => Promise<DispatchRecord | null>
  find?: (query: Record<string, unknown>) => Promise<DispatchRecord[]>
}

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

type AuditSink = {
  record?: (auditEvent: NotificationAuditEnvelope) => Promise<void> | void
  write?: (auditEvent: NotificationAuditEnvelope) => Promise<void> | void
  append?: (auditEvent: NotificationAuditEnvelope) => Promise<void> | void
}

type NormalizedBrevoDeliveryEvent = {
  provider_event_id: string
  dispatch_id?: string
  event_type: NotificationDeliveryEventType
  occurred_at: string
  recipient_hash: string
  flow_id?: string
  market_id?: string
  template_key?: string
  locale?: Locale
  consent_basis?: ConsentBasis
  idempotency_key?: string
  error_code?: string
  error_message?: string
  source: BrevoDeliveryEventPayload
}

type CorrelatedDispatch = {
  correlation_id: string
  correlation_state: NotificationDeliveryCorrelationState
  dispatch_id: string
  dispatch?: DispatchRecord
  lookup_error_code?: string
}

export const DELIVERY_ORPHAN_METRIC = "gp_brevo_delivery_orphan_total"
export const DELIVERY_LOOKUP_FAILED_METRIC = "gp_brevo_delivery_lookup_failed_total"
export const DELIVERY_STATE_TRANSITION_METRIC =
  "gp_brevo_delivery_state_transition_total"
export const DELIVERY_STATE_NOT_APPLICABLE_METRIC =
  "gp_brevo_delivery_state_not_applicable_total"

export default async function brevoDeliveryTracker({
  event,
  container,
}: SubscriberArgs<BrevoDeliveryEventPayload>): Promise<void> {
  const runtimeContainer = container as unknown as ResolveContainer
  const logger = resolveLogger(runtimeContainer)

  let normalized: NormalizedBrevoDeliveryEvent | null
  try {
    normalized = normalizeDeliveryEvent(event.name, event.data)
  } catch (error) {
    if (error instanceof UnknownDeliveryEventError) {
      // AD-19: wartosc spoza dziedziny jest BLEDEM, nie wartoscia domyslna.
      // Do v1.15.0 ta sciezka konczyla sie `logger.warn` + cichym `return` —
      // zdarzenie znikalo bez bledu, bez metryki i bez zmiany stanu, a Medusa
      // uznawala je za obsluzone. Teraz odmowa jest GLOSNA: nazwany kod bledu,
      // przyrost licznika i propagacja wyjatku, wiec zdarzenie NIE jest
      // potwierdzone jako obsluzone. Ponowienie daje szyna zdarzen (opcje
      // zadania z trasy webhooka, R-4), nie dostawca — ten dostal juz 202.
      logger.error?.(
        `[brevo-delivery-tracker] error_code=${error.code} ` +
          `metric=${UNRECOGNIZED_DELIVERY_EVENT_METRIC} ` +
          `dictionary=${error.dictionary} raw_value=${JSON.stringify(error.rawValue)}`,
      )
    }
    throw error
  }

  if (!normalized) {
    // Ladunek bez identyfikatora zdarzenia dostawcy — nie da sie go ani
    // skorelowac, ani zdeduplikowac. To jest brak NOSNIKA tozsamosci, nie
    // nieznana klasa. Odmowa jest GLOSNA (nazwany kod + rzucenie), a nie cicha;
    // ponowienie dostawcy przyniesie ten sam ladunek i odbije sie tak samo,
    // wiec odrzucenie jest stabilne, ale NIE jest potwierdzeniem obslugi.
    logger.error?.(
      "[brevo-delivery-tracker] error_code=DELIVERY_EVENT_MALFORMED " +
        "brak provider_event_id — zdarzenie nieidentyfikowalne",
    )
    throw new Error(
      "DELIVERY_EVENT_MALFORMED: zdarzenie dostawy bez provider_event_id",
    )
  }

  try {
    // JEDEN odczyt wiersza dispatchu na zdarzenie. Do cyklu 1 review byly DWA
    // (raz dla rynku, raz dla korelacji) — podwojny round-trip do bazy i podwojny
    // alert `DISPATCH_LOOKUP_FAILED` z jednego zdarzenia. Wynik jest tu odczytany
    // raz i podany obu konsumentom.
    const lookup = await lookupDispatch(
      runtimeContainer,
      normalized.provider_event_id,
      logger,
    )

    // AD-21 / ADR-177: subscriber jest powierzchnia zapisu POZA HTTP, wiec
    // wykonanie musi niesc jawny kontekst rynku. Jego BRAK jest ODMOWA
    // (`SystemMarketContextError`), a nie zapisem dla wszystkich rynkow.
    const marketId = resolveMarketIdForContext(normalized, lookup, logger)
    const db = resolvePgConnection(runtimeContainer)
    const brakeReader = createMoneyPathBrakeReader(
      db ?? {
        async raw() {
          throw new Error("PG_CONNECTION unavailable")
        },
      },
      logger,
    )
    // R-8 (checkpoint 6.6): przeplyw hamulca jest ZASTANY — odczyt takze dla
    // zdarzenia bez rynku (`""`, fail-closed). Semantyka hamulca to kontrakt
    // 6.8 (PO D5/D8); 6.6 dodaje wylacznie jawny kod tam, gdzie hamulec jest
    // zaciagniety.
    const deliveryPathReleased = await brakeReader.isReleased(
      marketId ?? "",
      "fr_9_delivery_idempotency",
    )
    if (!deliveryPathReleased) {
      brakeSkippedCount += 1
      logger.warn?.(
        `[brevo-delivery-tracker] error_code=${DELIVERY_PATH_BRAKE_ENGAGED_CODE} ` +
          `metric=${DELIVERY_PATH_BRAKE_ENGAGED_METRIC} outcome=skipped_unclassified ` +
          `market_id=${marketId ?? "missing"} brake=fr_9_delivery_idempotency ` +
          `provider_event_id=${normalized.provider_event_id} event_type=${normalized.event_type}`,
      )
      logger.info?.(
        `[brevo-delivery-tracker] money path brake engaged market_id=${marketId ?? "missing"} brake=fr_9_delivery_idempotency`,
      )
      return
    }

    // ADR-213 wariant C: stan dostawy trafia do rejestru dopiero po
    // potwierdzeniu przez API dostawcy. Bez weryfikatora — odmowa glosna.
    if (marketId) {
      await verifyWithProvider(runtimeContainer, normalized, logger)
    }

    await runInSystemMarketContext(
      {
        markets: marketId ? [marketId] : [],
        origin: { surface: "subscriber", name: "brevo-delivery-tracker" },
        logger: logger as never,
      },
      async () => {
        const context = requireMarketContext("brevo delivery state write", {
          origin: { surface: "subscriber", name: "brevo-delivery-tracker" },
          logger: logger as never,
        })
        const correlated = correlateDispatch(normalized!, lookup, logger)
        const stateResult = await applyDeliveryState(
          runtimeContainer,
          normalized!,
          correlated,
          db,
          context.market_id,
          logger,
        )
        logDeliveryStateResult(normalized!, stateResult, logger)
        if (stateResult.outcome === "duplicate") {
          // R-5 (checkpoint 6.6): ledger zatwierdza stan PRZED koperta (bez
          // wspolnej transakcji), wiec `duplicate` nie dowodzi, ze koperta
          // dotarla — ponowienie po awarii sinka trafia wlasnie tutaj. Koperta
          // jest emitowana ponownie z TYM SAMYM deterministycznym `audit_id`
          // (F-08), a sink deduplikuje po nim. Idempotencja skutku (budzet,
          // eskalacja) siedzi w ledgerze: drugi UPDATE niczego nie zmienia,
          // a eskalacja idzie z predykatu wiersza (`escalated_at`), nie z koperty.
          logger.info?.(
            `[brevo-delivery-tracker] outcome=${DELIVERY_REPLAY_REEMITTED_OUTCOME} ` +
              `provider_event_id=${normalized!.provider_event_id}`,
          )
        }
        const auditEvent = buildAuditEnvelope(normalized!, correlated)

        await emitAuditEvent(runtimeContainer, auditEvent, logger)
      },
    )
  } catch (error) {
    throw error
  }
}

/**
 * Rynek dla kontekstu systemowego. Zwraca `undefined`, gdy nie da sie go ustalic —
 * wywolujacy przekazuje wtedy PUSTA liste rynkow, co `runInSystemMarketContext`
 * traktuje jako odmowe (`markets_empty`). Podstawienie tu wartosci zastepczej
 * byloby zapisem poza izolacja pod pozorem „zadeklarowanego" rynku.
 *
 * PIERWSZENSTWO MA STAN SYSTEMU. `market_id` z ladunku pochodzi od DOSTAWCY, wiec
 * przyjmowanie go bez konfrontacji ze stanem systemu pozwalaloby dostawcy wskazac
 * rynek, pod ktorym wykona sie zapis — nosnik AD-21 bylby obecny, ale karmiony
 * wartoscia spoza granicy zaufania. Gdy istnieje wiersz dispatchu z rynkiem, to
 * ON jest zrodlem; rozjazd z ladunkiem jest ODMOWA, nie cichym wyborem jednej
 * z dwoch wartosci. Ladunek rzadzi wylacznie tam, gdzie wiersza nie ma (sierota).
 */
function resolveMarketIdForContext(
  normalized: NormalizedBrevoDeliveryEvent,
  lookup: DispatchLookupResult,
  logger: LoggerLike,
): string | undefined {
  const systemMarketId = readString(lookup.dispatch?.market_id)
  const payloadMarketId = normalized.market_id

  if (systemMarketId && payloadMarketId && systemMarketId !== payloadMarketId) {
    logger.error?.(
      `[brevo-delivery-tracker] error_code=${MARKET_CONFLICT_CODE} ` +
        `provider_event_id=${normalized.provider_event_id} ` +
        `system=${systemMarketId} payload=${payloadMarketId}`,
    )
    throw new Error(
      `${MARKET_CONFLICT_CODE}: rynek z ladunku dostawcy (${payloadMarketId}) ` +
        `nie zgadza sie z rynkiem wiersza dostawy (${systemMarketId})`,
    )
  }

  return systemMarketId ?? payloadMarketId
}

type DeliveryStateResult = ApplyProviderDeliveryStateResult | {
  outcome: "state_not_applicable" | "state_writer_unavailable"
  dispatch_id: string | null
  previous_status: null
  status: null
}

function deliveryStateForEvent(
  eventType: NotificationDeliveryEventType,
): (typeof DELIVERY_DISPATCH_STATES)[number] | null {
  switch (eventType) {
    case "delivered":
      return DELIVERY_DISPATCH_STATES.find((state) => state === "delivered") ?? null
    case "bounced_permanent":
    case "bounced_transient":
    case "blocked":
    case "invalid_address":
    case "failed":
      return DELIVERY_DISPATCH_STATES.find((state) => state === "failed") ?? null
    case "deferred":
      return DELIVERY_DISPATCH_STATES.find((state) => state === "retrying") ?? null
    default:
      return null
  }
}

type DeliveryStateWriter = {
  applyProviderDeliveryState: (
    input: Parameters<PgDispatchLedger["applyProviderDeliveryState"]>[0],
  ) => Promise<ApplyProviderDeliveryStateResult>
}

function resolveDeliveryStateWriter(
  container: ResolveContainer,
  db: KnexLike | undefined,
): DeliveryStateWriter | null {
  const configured = resolveOptional<DeliveryStateWriter>(
    container,
    [
      "voucher_delivery_dispatch_ledger",
      "voucherDeliveryDispatchLedger",
      "deliveryDispatchLedger",
    ],
  )
  if (configured?.applyProviderDeliveryState) return configured

  // Test doubles and legacy lookup adapters may expose only a read port. Do
  // not accidentally treat those as the production writer.
  const legacyLookup = resolveOptional<DispatchLookup>(container, [
    "notification_dispatches",
    "notificationDispatches",
    "notification_dispatch_repository",
    "notificationDispatchRepository",
  ])
  return !legacyLookup && db
    ? new PgDispatchLedger(db)
    : null
}

async function applyDeliveryState(
  container: ResolveContainer,
  normalized: NormalizedBrevoDeliveryEvent,
  correlated: CorrelatedDispatch,
  db: KnexLike | undefined,
  marketId: string,
  logger: LoggerLike,
): Promise<DeliveryStateResult> {
  const status = deliveryStateForEvent(normalized.event_type)
  if (!status) {
    return {
      outcome: "state_not_applicable",
      dispatch_id: correlated.dispatch_id ?? null,
      previous_status: null,
      status: null,
    }
  }

  const writer = resolveDeliveryStateWriter(container, db)
  if (!writer) {
    logger.error?.(
      `[brevo-delivery-tracker] error_code=DELIVERY_STATE_WRITER_UNAVAILABLE ` +
        `metric=${DELIVERY_STATE_TRANSITION_METRIC} market_id=${marketId}`,
    )
    return {
      outcome: "state_writer_unavailable",
      dispatch_id: correlated.dispatch_id ?? null,
      previous_status: null,
      status: null,
    }
  }

  // AC4 / DW-15-120: trwale odbicie (terminalne + eskalujace) zamyka budzet
  // odbiorcy, wiec wiersz spelnia predykat parkowania i eskaluje TA SAMA droga
  // co wyczerpanie budzetu (`claimAttemptPolicyEscalations`, powod
  // `recipient_budget`); ponowienie jest odciete przez ten sam predykat.
  const reaction = reactionFor(normalized.event_type)
  return writer.applyProviderDeliveryState({
    provider_event_id: normalized.provider_event_id,
    status,
    provider: "brevo",
    error_code: normalized.error_code ?? null,
    occurred_at: normalized.occurred_at,
    ...(reaction.terminal && reaction.escalate && reaction.consumes_recipient_attempt
      ? { exhaust_recipient_budget: { max_attempt_count: VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT } }
      : {}),
  })
}

function logDeliveryStateResult(
  normalized: NormalizedBrevoDeliveryEvent,
  result: DeliveryStateResult,
  logger: LoggerLike,
): void {
  switch (result.outcome) {
    case "updated":
      logger.info?.(
        `[brevo-delivery-tracker] outcome=state_updated metric=${DELIVERY_STATE_TRANSITION_METRIC} ` +
          `provider_event_id=${normalized.provider_event_id} dispatch_id=${result.dispatch_id}`,
      )
      return
    case "duplicate":
      logger.info?.(
        `[brevo-delivery-tracker] outcome=duplicate metric=${DELIVERY_STATE_TRANSITION_METRIC} ` +
          `provider_event_id=${normalized.provider_event_id}`,
      )
      return
    case "orphan":
      logger.error?.(
        `[brevo-delivery-tracker] error_code=DELIVERY_DISPATCH_ORPHAN outcome=orphan ` +
          `metric=${DELIVERY_ORPHAN_METRIC} provider_event_id=${normalized.provider_event_id}`,
      )
      return
    case "state_transition_rejected":
      logger.error?.(
        `[brevo-delivery-tracker] error_code=DELIVERY_STATE_TRANSITION_REJECTED ` +
          `outcome=state_transition_rejected metric=${DELIVERY_STATE_TRANSITION_METRIC} ` +
          `provider_event_id=${normalized.provider_event_id}`,
      )
      return
    case "state_not_applicable":
      logger.info?.(
        `[brevo-delivery-tracker] outcome=state_not_applicable ` +
          `metric=${DELIVERY_STATE_NOT_APPLICABLE_METRIC} provider_event_id=${normalized.provider_event_id}`,
      )
      return
    case "state_writer_unavailable":
      return
    default:
      return assertNeverDeliveryStateResult(result)
  }
}

function assertNeverDeliveryStateResult(value: never): never {
  throw new Error(`nieobsluzony wynik zapisu stanu dostawy: ${String(value)}`)
}

export const config: SubscriberConfig = {
  event: [...BREVO_NOTIFICATION_EVENTS],
  context: { subscriberId: "brevo-delivery-tracker" },
}

export function __resetBrevoDeliveryTrackerForTests(): void {
  // Zachowane jako kompatybilny punkt resetu testów. Idempotencja nie jest już
  // stanem procesu — rozstrzyga ją trwały ledger.
  brakeSkippedCount = 0
}

export const DELIVERY_PATH_BRAKE_ENGAGED_CODE = "DELIVERY_PATH_BRAKE_ENGAGED"
export const DELIVERY_PATH_BRAKE_ENGAGED_METRIC =
  "gp_brevo_delivery_brake_skipped_total"
export const DELIVERY_REPLAY_REEMITTED_OUTCOME = "replay_reemitted"

let brakeSkippedCount = 0

/** Licznik zdarzen pominietych przy zaciagnietym hamulcu (obserwowalnosc, nie stan). */
export function getBrevoDeliveryBrakeSkippedTotal(): number {
  return brakeSkippedCount
}

const VERIFIER_KEYS = [
  "brevo_delivery_event_verifier",
  "brevoDeliveryEventVerifier",
] as const

function resolveVerifier(container: ResolveContainer): BrevoDeliveryEventVerifier | null {
  const configured = resolveOptional<BrevoDeliveryEventVerifier>(container, VERIFIER_KEYS)
  if (configured && typeof configured.verify === "function") return configured
  const apiKey = process.env.BREVO_API_KEY?.trim()
  return apiKey ? createBrevoDeliveryEventVerifier({ apiKey }) : null
}

async function verifyWithProvider(
  container: ResolveContainer,
  normalized: NormalizedBrevoDeliveryEvent,
  logger: LoggerLike,
): Promise<void> {
  const verifier = resolveVerifier(container)
  if (!verifier) {
    logger.error?.(
      `[brevo-delivery-tracker] error_code=${DELIVERY_EVENT_VERIFICATION_UNAVAILABLE_CODE} ` +
        `provider_event_id=${normalized.provider_event_id} — brak weryfikatora ADR-213 C`,
    )
    throw new Error(
      `${DELIVERY_EVENT_VERIFICATION_UNAVAILABLE_CODE}: brak weryfikacji zwrotnej Brevo (ADR-213 C)`,
    )
  }
  const result = await verifier.verify({
    provider_message_id: normalized.provider_event_id,
    event_type: normalized.event_type,
  })
  if (result.outcome === "confirmed") return
  logger.error?.(
    `[brevo-delivery-tracker] error_code=${result.error_code} outcome=${result.outcome} ` +
      `statistics_event=${result.statistics_event} provider_event_id=${normalized.provider_event_id}` +
      ("http_status" in result && result.http_status ? ` http_status=${result.http_status}` : ""),
  )
  throw new Error(
    `${result.error_code}: zdarzenie ${normalized.event_type} nie potwierdzone przez API Brevo`,
  )
}

function normalizeDeliveryEvent(
  eventName: string | undefined,
  payload: BrevoDeliveryEventPayload | undefined,
): NormalizedBrevoDeliveryEvent | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const providerEventId =
    readString(payload.provider_event_id) ??
    readString(payload["message-id"]) ??
    readString(payload.message_id) ??
    readString(payload.messageId) ??
    readString(payload.event_uuid)

  if (!providerEventId) {
    return null
  }

  // Klasyfikacja rzuca `UnknownDeliveryEventError` dla nazwy spoza dziedziny —
  // wyjatek propaguje do handlera i konczy sie GLOSNA odmowa (AD-19). Nazwa
  // pochodzi ze slownika PAYLOADU; slownik API rejestracji jest osobna dziedzina
  // i nie jest tu akceptowany (ADR-192).
  const eventType = classifyDeliveryEventName(
    "event_payload",
    readString(payload.event_type) ??
      readString(payload.event) ??
      eventName?.replace(/^notification\./, ""),
  )

  return {
    provider_event_id: providerEventId,
    dispatch_id: readString(payload.dispatch_id),
    event_type: eventType,
    occurred_at: normalizeOccurredAt(payload),
    recipient_hash: resolveRecipientHash(payload),
    flow_id: readString(payload.flow_id),
    market_id: readString(payload.market_id),
    template_key: readString(payload.template_key),
    locale: payload.locale,
    consent_basis: payload.consent_basis,
    idempotency_key: readString(payload.idempotency_key),
    error_code: resolveErrorCode(eventType),
    error_message: resolveErrorMessage(payload),
    source: payload,
  }
}

/**
 * Korelacja z wierszem dostawy.
 *
 * `dispatch_id` z ladunku moze nazwac wiersz, ale NIE ZASTEPUJE jego odczytu.
 * Do cyklu 1 review ta funkcja zwracala sie tu natychmiast, przez co wiersz nie
 * byl czytany wcale — a wraz z nim nie byla czytana liczba prob (`attempts`).
 * Skutek: `next_attempt_number` bylo trwale rowne 1, a backoff trwale rowny
 * wartosci bazowej dla KAZDEGO zdarzenia, ktorego ladunek niosl `dispatch_id`.
 * Poniewaz to pole podaje dostawca, dostawca mogl w ten sposob zerowac drabine
 * ponowien — dokladnie to, czego zabrania AD-23.
 */
function correlateDispatch(
  normalized: NormalizedBrevoDeliveryEvent,
  lookup: DispatchLookupResult,
  logger: LoggerLike,
): CorrelatedDispatch {
  if (normalized.dispatch_id) {
    return {
      correlation_id: normalized.dispatch_id,
      correlation_state: "matched",
      dispatch_id: normalized.dispatch_id,
      dispatch: lookup.dispatch ?? undefined,
    }
  }

  const dispatchId = lookup.dispatch?.dispatch_id ?? lookup.dispatch?.id
  if (dispatchId) {
    return {
      correlation_id: dispatchId,
      correlation_state: "matched",
      dispatch_id: dispatchId,
      dispatch: lookup.dispatch ?? undefined,
    }
  }

  logger.warn?.(
    `[brevo-delivery-tracker] orphan delivery event provider_event_id=${normalized.provider_event_id}`,
  )
  return {
    correlation_id: normalized.provider_event_id,
    correlation_state: "orphan",
    dispatch_id: normalized.provider_event_id,
    lookup_error_code: lookup.error_code,
  }
}

type DispatchLookupResult = {
  dispatch: DispatchRecord | null
  error_code?: string
}

async function lookupDispatch(
  container: ResolveContainer,
  providerEventId: string,
  logger: LoggerLike,
): Promise<DispatchLookupResult> {
  const service = resolveOptional<DispatchLookup>(container, [
    "notification_dispatches",
    "notificationDispatches",
    "notification_dispatch_repository",
    "notificationDispatchRepository",
  ])

  if (service?.findByProviderMessageId) {
    return { dispatch: await service.findByProviderMessageId(providerEventId) }
  }
  if (service?.findOneByProviderMessageId) {
    return { dispatch: await service.findOneByProviderMessageId(providerEventId) }
  }
  if (service?.findOne) {
    return { dispatch: await service.findOne({ provider_message_id: providerEventId }) }
  }
  if (service?.find) {
    const rows = await service.find({ provider_message_id: providerEventId })
    return { dispatch: rows[0] ?? null }
  }

  const db = resolvePgConnection(container)
  if (!db) {
    return { dispatch: null }
  }

  try {
    const result = await db.raw(
      `
        SELECT
          dispatch_id,
          flow_id,
          market_id,
          template_key,
          locale,
          -- R-2 (checkpoint 6.6): projekcja wylacznie z kolumn realnego
          -- schematu voucher_delivery_dispatch. consent_basis i
          -- idempotency_key tam nie istnieja (42703 => DISPATCH_LOOKUP_FAILED
          -- => dispatch=null); licznik prob to attempt_count.
          -- AD-23: numer proby pochodzi WYLACZNIE ze stanu systemu.
          attempt_count AS attempts
        FROM voucher_delivery_dispatch
        WHERE provider_message_id = ?
        LIMIT 1
      `,
      [providerEventId],
    )
    return { dispatch: (result.rows?.[0] as DispatchRecord | undefined) ?? null }
  } catch (error) {
    // F-06: differentiate missing relation (clean orphan) od DB outage (alert).
    const pgCode = typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code?: string }).code as string)
      : undefined
    if (pgCode === POSTGRES_UNDEFINED_TABLE) {
      logger.warn?.(
        `[brevo-delivery-tracker] notification_dispatches lookup unavailable provider_event_id=${providerEventId}`,
      )
      return { dispatch: null }
    }
    const err = error as Error
    logger.error?.(
      `[brevo-delivery-tracker] error_code=${DISPATCH_LOOKUP_FAILED_CODE} ` +
        `metric=${DELIVERY_LOOKUP_FAILED_METRIC} provider_event_id=${providerEventId} ` +
        `code=${pgCode ?? "unknown"}: ${err.message}`,
    )
    return { dispatch: null, error_code: DISPATCH_LOOKUP_FAILED_CODE }
  }
}

function buildAuditEnvelope(
  normalized: NormalizedBrevoDeliveryEvent,
  correlated: CorrelatedDispatch,
): NotificationAuditEnvelope {
  const outcome = resolveOutcome(normalized.event_type)
  const dispatch = correlated.dispatch

  return {
    // F-08: deterministic audit_id — retry przez Medusa produkuje identyczny
    // audit_id, downstream observability może deduplikować trace correlation.
    audit_id: deriveAuditId(normalized.provider_event_id, normalized.event_type),
    event_type: "notification.delivery",
    status: resolveDeliveryStatus(normalized.event_type),
    dispatch_id: correlated.dispatch_id,
    provider: AuditProvider.BREVO,
    provider_event_id: normalized.provider_event_id,
    correlation_id: correlated.correlation_id,
    correlation_state: correlated.correlation_state,
    outcome,
    flow_id: normalized.flow_id ?? dispatch?.flow_id ?? UNKNOWN_FIELD_SENTINEL,
    template_key: normalized.template_key ?? dispatch?.template_key ?? UNKNOWN_FIELD_SENTINEL,
    channel: "email",
    market_id: normalized.market_id ?? dispatch?.market_id ?? UNKNOWN_FIELD_SENTINEL,
    locale: normalized.locale ?? dispatch?.locale ?? "pl-PL",
    consent_basis:
      normalized.consent_basis ?? dispatch?.consent_basis ?? "transactional_supportive",
    idempotency_key:
      normalized.idempotency_key ?? dispatch?.idempotency_key ?? normalized.provider_event_id,
    hashed_recipient: normalized.recipient_hash,
    recipient_hash: normalized.recipient_hash,
    occurred_at: normalized.occurred_at,
    error_code: normalized.error_code ?? correlated.lookup_error_code,
    error_message: normalized.error_message,
    delivery_class: normalized.event_type,
    delivery_reaction: buildReaction(normalized, correlated),
  }
}

/**
 * Reakcja per klasa — czynnik, ktory czyni skutek KAZDEJ z klas obserwowalnie
 * rozny na realnej sciezce (AC4).
 *
 * AD-23: numer proby i backoff nadaje POLITYKA. Zrodlem `recordedAttempts` jest
 * wylacznie stan po stronie systemu (wiersz dispatchu); zadna wartosc z ladunku
 * dostawcy (`attempt`, `retry_count`, …) nie jest czytana — dostawca nie ma
 * wplywu na numeracje prob.
 */
function buildReaction(
  normalized: NormalizedBrevoDeliveryEvent,
  correlated: CorrelatedDispatch,
): NotificationAuditEnvelope["delivery_reaction"] {
  const reaction: DeliveryEventReaction = reactionFor(normalized.event_type)
  const recordedAttempts = readAttempts(correlated.dispatch)

  return {
    terminal: reaction.terminal,
    escalate: reaction.escalate,
    retryable: reaction.retryable,
    retry_policy: reaction.retry_policy,
    consumes_recipient_attempt: reaction.consumes_recipient_attempt,
    suppress_recipient: reaction.suppress_recipient,
    bounce_family: reaction.bounce_family,
    next_attempt_number: nextAttemptNumber(normalized.event_type, recordedAttempts),
    backoff_delay_ms: backoffDelayMs(normalized.event_type, recordedAttempts),
  }
}

function readAttempts(dispatch: DispatchRecord | undefined): number {
  const value = dispatch?.attempts
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function deriveAuditId(providerEventId: string, eventType: NotificationDeliveryEventType): string {
  return createHash("sha256")
    .update(`${providerEventId}:${eventType}`)
    .digest("hex")
    .slice(0, 32)
}

async function emitAuditEvent(
  container: ResolveContainer,
  auditEvent: NotificationAuditEnvelope,
  logger: LoggerLike,
): Promise<void> {
  const sink = resolveOptional<AuditSink | ((auditEvent: NotificationAuditEnvelope) => Promise<void> | void)>(
    container,
    [
      "notification_delivery_audit_sink",
      "notificationDeliveryAuditSink",
      "audit_sink",
      "auditSink",
    ],
  )

  try {
    if (typeof sink === "function") {
      await sink(auditEvent)
      return
    }
    if (sink?.record) {
      await sink.record(auditEvent)
      return
    }
    if (sink?.write) {
      await sink.write(auditEvent)
      return
    }
    if (sink?.append) {
      await sink.append(auditEvent)
      return
    }
  } catch (error) {
    const err = error as Error
    logger.error?.(
      `[brevo-delivery-tracker] audit sink failed provider_event_id=${auditEvent.provider_event_id}: ${err.message}`,
    )
    throw error
  }

  logger.info?.(
    `[brevo-delivery-tracker] audit_event=${JSON.stringify(auditEvent)}`,
  )
}

/**
 * UWAGA na pulapke pozornego PASS: ten `switch` byl wyczerpujacy juz wczesniej,
 * ale pracowal na typie, ktory ZGUBIL rozroznienie w `normalizeEventType`.
 * Wyczerpalnosc ZA zwinieciem nie chronila przed niczym. Teraz dziedzina jest
 * wielodzielna, wiec kazda klasa jest tu rozstrzygnieta osobno, a `assertNever`
 * lamie kompilacje po dodaniu klasy bez decyzji.
 *
 * `outcome` i `status` to slownik KOPERTY AUDYTOWEJ (weszej niz dziedzina klas) —
 * kilka klas mapuje sie na `failed` swiadomie. Rozroznienie klas nie ginie przy
 * tym rzutowaniu: niesie je `delivery_class` i `delivery_reaction` w kopercie.
 */
function resolveOutcome(
  eventType: NotificationDeliveryEventType,
): NotificationDeliveryAuditOutcome {
  switch (eventType) {
    case "delivered":
      return "delivered"
    case "opened":
      return "opened"
    case "clicked":
      return "engaged"
    case "bounced_permanent":
    case "bounced_transient":
    case "blocked":
    case "failed":
      return "failed"
    case "invalid_address":
      return "rejected"
    case "deferred":
      // Opoznienie NIE jest porazka dostawy — dostawa jest wciaz w toku.
      return "delivered"
    case "complaint":
      return "flagged"
    case "unsubscribed":
      return "opted_out"
    default:
      return assertNeverEventType(eventType, "resolveOutcome")
  }
}

function resolveDeliveryStatus(
  eventType: NotificationDeliveryEventType,
): NotificationAuditEnvelope["status"] {
  switch (eventType) {
    case "delivered":
      return "delivered"
    case "opened":
      return "opened"
    case "clicked":
      return "clicked"
    case "bounced_permanent":
    case "bounced_transient":
    case "blocked":
    case "invalid_address":
    case "failed":
      return "failed"
    case "deferred":
      // Opoznienie zostawia wiersz w stanie NIETERMINALNYM i wciaz ponawialnym.
      return "sent"
    case "complaint":
      return "complaint"
    case "unsubscribed":
      return "unsubscribed"
    default:
      return assertNeverEventType(eventType, "resolveDeliveryStatus")
  }
}

function assertNeverEventType(value: never, where: string): never {
  throw new Error(`${where}: nieobsluzona klasa zdarzenia dostawy: ${String(value)}`)
}

/**
 * Szczegol diagnostyczny dostawcy. Kod podany przez dostawce trafia TUTAJ,
 * a nie do `error_code` — `error_code` jest kanoniczna nazwa klasy i musi
 * pozostac rozlaczny miedzy klasami (AC2).
 */
function resolveErrorMessage(payload: BrevoDeliveryEventPayload): string | undefined {
  const providerCode = readString(payload.error_code)
  const message = readString(payload.error_message) ?? readString(payload.reason)
  if (providerCode && message) {
    return `${providerCode}: ${message}`
  }
  return providerCode ?? message
}

/**
 * Kod bledu pochodzi WYLACZNIE z klasy (tabela reakcji), nie z ladunku.
 *
 * Do v1.15.0 ta funkcja konczyla sie `return "BOUNCE"` — drugim catch-allem,
 * w przebraniu: `invalid_email` i `blocked` dostawaly ten sam kod co nierozpoznane
 * odbicie. Teraz kody sa rozlaczne per klasa. Kod podany przez dostawce NIE
 * nadpisuje kodu klasy (to zniszczyloby rozlacznosc, ktorej pilnuje AC2) —
 * trafia do `error_message` jako szczegol diagnostyczny.
 */
function resolveErrorCode(
  eventType: NotificationDeliveryEventType,
): string | undefined {
  return errorCodeFor(eventType) ?? undefined
}

function normalizeOccurredAt(payload: BrevoDeliveryEventPayload): string {
  const occurredAt = readString(payload.occurred_at) ?? readString(payload.date)
  if (occurredAt) {
    return toIsoStringOrNow(occurredAt)
  }

  if (typeof payload.ts === "number") {
    const milliseconds = payload.ts > 10_000_000_000 ? payload.ts : payload.ts * 1000
    return toIsoStringOrNow(milliseconds)
  }
  if (typeof payload.ts === "string" && payload.ts.trim()) {
    const numeric = Number(payload.ts)
    if (Number.isFinite(numeric)) {
      const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000
      return toIsoStringOrNow(milliseconds)
    }
    return toIsoStringOrNow(payload.ts)
  }

  return new Date().toISOString()
}

function toIsoStringOrNow(value: string | number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }
  return date.toISOString()
}

function resolveRecipientHash(payload: BrevoDeliveryEventPayload): string {
  const explicitHash = readString(payload.recipient_hash)
  if (explicitHash) {
    return explicitHash
  }

  const email = readString(payload.recipient_email) ?? readString(payload.email)
  if (email) {
    return createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
  }

  // F-09: non-collidable sentinel (sha256 hex output never contains `_` or `:`).
  return NO_RECIPIENT_SENTINEL
}

function resolveLogger(container: ResolveContainer): LoggerLike {
  if (container.logger) {
    return container.logger
  }
  const resolved = resolveOptional<LoggerLike>(container, ["logger"])
  return resolved ?? console
}

function resolveOptional<T>(container: ResolveContainer, keys: readonly string[]): T | undefined {
  if (!container.resolve) {
    return undefined
  }

  for (const key of keys) {
    try {
      return container.resolve(key) as T
    } catch {
      continue
    }
  }

  return undefined
}

function resolvePgConnection(container: ResolveContainer): KnexLike | undefined {
  if (!container.resolve) {
    return undefined
  }

  try {
    return container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  } catch {
    return undefined
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
