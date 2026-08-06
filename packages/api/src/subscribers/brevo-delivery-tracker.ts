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
import { runInSystemMarketContext } from "../lib/system-market-context"

/**
 * Path Y Brevo delivery subscriber.
 *
 * Limitations (Story 5.5 — follow-up scoped do v1.11.0+ messaging persistence story):
 * - Dedupe cache jest module-level Map → single-process semantics. Multi-instance
 *   deployment (N replicas) NIE deduplikuje cross-replica; cold restart traci
 *   cache → Brevo retry replay (do 7 dni) może wygenerować duplicate audit
 *   envelopes. Pełna idempotency wymaga persistencji w
 *   `notification_delivery_events` z UNIQUE constraint na `provider_event_id`
 *   (follow-up story: v1.11.0-messaging-delivery-persistence — utworzyć w
 *   Sprint 5 backlog).
 * - Race-safety: `mark-before-emit` ordering eliminuje in-process race między
 *   dwoma concurrent handle() calls dla tego samego `provider_event_id`, oraz
 *   eliminuje double-emit gdy `emitAuditEvent` propaguje błąd sinka (rollback
 *   dedupe entry w catch → next Medusa retry przejdzie jak fresh event).
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

const DELIVERY_DEDUP_TTL_MS = 24 * 60 * 60 * 1000
const DELIVERY_DEDUP_MAX = 10000
const seenProviderEventIds = new Map<string, number>()

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
      // potwierdzone jako obsluzone i wraca w ponowieniu dostawcy.
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
    // nieznana klasa; ponowienie nie zmieni ladunku, wiec odmowa jest
    // terminalna i jawna, a nie cicha.
    logger.error?.(
      "[brevo-delivery-tracker] error_code=DELIVERY_EVENT_MALFORMED " +
        "brak provider_event_id — zdarzenie nieidentyfikowalne",
    )
    throw new Error(
      "DELIVERY_EVENT_MALFORMED: zdarzenie dostawy bez provider_event_id",
    )
  }

  pruneSeenProviderEventIds()
  if (seenProviderEventIds.has(normalized.provider_event_id)) {
    logger.info?.(
      `[brevo-delivery-tracker] duplicate delivery event skipped provider_event_id=${normalized.provider_event_id}`,
    )
    return
  }

  // F-03/F-07: mark BEFORE await — eliminuje in-process race + double-emit
  // przy sink failure (compensating rollback w catch przywraca eligibility
  // dla Medusa retry).
  markProviderEventSeen(normalized.provider_event_id)

  try {
    // AD-21 / ADR-177: subscriber jest powierzchnia zapisu POZA HTTP, wiec
    // wykonanie musi niesc jawny kontekst rynku. Rynek pochodzi z ladunku albo
    // z wiersza dispatchu; jego BRAK jest ODMOWA (`SystemMarketContextError`),
    // a nie zapisem dla wszystkich rynkow. Nosnik jest ten sam co dla `/store/*`.
    const marketId = await resolveMarketIdForContext(runtimeContainer, normalized, logger)

    await runInSystemMarketContext(
      {
        markets: marketId ? [marketId] : [],
        origin: { surface: "subscriber", name: "brevo-delivery-tracker" },
        logger: logger as never,
      },
      async () => {
        const correlated = await correlateDispatch(runtimeContainer, normalized!, logger)
        const auditEvent = buildAuditEnvelope(normalized!, correlated)

        await emitAuditEvent(runtimeContainer, auditEvent, logger)
      },
    )
  } catch (error) {
    seenProviderEventIds.delete(normalized.provider_event_id)
    throw error
  }
}

/**
 * Rynek dla kontekstu systemowego. Zwraca `undefined`, gdy nie da sie go ustalic —
 * wywolujacy przekazuje wtedy PUSTA liste rynkow, co `runInSystemMarketContext`
 * traktuje jako odmowe (`markets_empty`). Podstawienie tu wartosci zastepczej
 * byloby zapisem poza izolacja pod pozorem „zadeklarowanego" rynku.
 */
async function resolveMarketIdForContext(
  container: ResolveContainer,
  normalized: NormalizedBrevoDeliveryEvent,
  logger: LoggerLike,
): Promise<string | undefined> {
  if (normalized.market_id) {
    return normalized.market_id
  }

  const lookup = await lookupDispatch(container, normalized.provider_event_id, logger)
  return readString(lookup.dispatch?.market_id)
}

export const config: SubscriberConfig = {
  event: [...BREVO_NOTIFICATION_EVENTS],
  context: { subscriberId: "brevo-delivery-tracker" },
}

export function __resetBrevoDeliveryTrackerForTests(): void {
  seenProviderEventIds.clear()
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

async function correlateDispatch(
  container: ResolveContainer,
  normalized: NormalizedBrevoDeliveryEvent,
  logger: LoggerLike,
): Promise<CorrelatedDispatch> {
  if (normalized.dispatch_id) {
    return {
      correlation_id: normalized.dispatch_id,
      correlation_state: "matched",
      dispatch_id: normalized.dispatch_id,
    }
  }

  const lookup = await lookupDispatch(container, normalized.provider_event_id, logger)
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
          consent_basis,
          idempotency_key
        FROM notification_dispatches
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
      `[brevo-delivery-tracker] notification_dispatches lookup failed provider_event_id=${providerEventId} code=${pgCode ?? "unknown"}: ${err.message}`,
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

function pruneSeenProviderEventIds(): void {
  const cutoff = Date.now() - DELIVERY_DEDUP_TTL_MS
  for (const [providerEventId, seenAt] of seenProviderEventIds) {
    if (seenAt < cutoff) {
      seenProviderEventIds.delete(providerEventId)
    }
  }

  while (seenProviderEventIds.size > DELIVERY_DEDUP_MAX) {
    const oldestKey = seenProviderEventIds.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    seenProviderEventIds.delete(oldestKey)
  }
}

function markProviderEventSeen(providerEventId: string): void {
  seenProviderEventIds.set(providerEventId, Date.now())
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
