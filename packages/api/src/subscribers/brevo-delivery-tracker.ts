import { createHash } from "node:crypto"

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type {
  AuditEnvelope,
  ConsentBasis,
  Locale,
  NotificationDeliveryAuditOutcome,
  NotificationDeliveryCorrelationState,
  NotificationDeliveryEventType,
} from "@gp/messaging"

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

export const BREVO_NOTIFICATION_EVENTS = Object.freeze([
  "notification.delivered",
  "notification.opened",
  "notification.clicked",
  "notification.bounced",
  "notification.complaint",
  "notification.unsubscribed",
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
  bounce_type?: string
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
  record?: (auditEvent: AuditEnvelope) => Promise<void> | void
  write?: (auditEvent: AuditEnvelope) => Promise<void> | void
  append?: (auditEvent: AuditEnvelope) => Promise<void> | void
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
  const normalized = normalizeDeliveryEvent(event.name, event.data)

  if (!normalized) {
    logger.warn?.("[brevo-delivery-tracker] dropped malformed delivery event")
    return
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
    const correlated = await correlateDispatch(runtimeContainer, normalized, logger)
    const auditEvent = buildAuditEnvelope(normalized, correlated)

    await emitAuditEvent(runtimeContainer, auditEvent, logger)
  } catch (error) {
    seenProviderEventIds.delete(normalized.provider_event_id)
    throw error
  }
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

  const eventType = normalizeEventType(
    readString(payload.event_type) ??
      readString(payload.event) ??
      eventName?.replace(/^notification\./, ""),
  )

  if (!eventType) {
    return null
  }

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
    error_code: resolveErrorCode(eventType, payload),
    error_message: readString(payload.error_message) ?? readString(payload.reason),
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
): AuditEnvelope {
  const outcome = resolveOutcome(normalized.event_type)
  const dispatch = correlated.dispatch

  return {
    // F-08: deterministic audit_id — retry przez Medusa produkuje identyczny
    // audit_id, downstream observability może deduplikować trace correlation.
    audit_id: deriveAuditId(normalized.provider_event_id, normalized.event_type),
    event_type: "notification.delivery",
    status: resolveDeliveryStatus(normalized.event_type),
    dispatch_id: correlated.dispatch_id,
    provider: "brevo",
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
  }
}

function deriveAuditId(providerEventId: string, eventType: NotificationDeliveryEventType): string {
  return createHash("sha256")
    .update(`${providerEventId}:${eventType}`)
    .digest("hex")
    .slice(0, 32)
}

async function emitAuditEvent(
  container: ResolveContainer,
  auditEvent: AuditEnvelope,
  logger: LoggerLike,
): Promise<void> {
  const sink = resolveOptional<AuditSink | ((auditEvent: AuditEnvelope) => Promise<void> | void)>(
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
    case "bounced":
    case "failed":
      return "failed"
    case "complaint":
      return "flagged"
    case "unsubscribed":
      return "opted_out"
  }
}

function resolveDeliveryStatus(
  eventType: NotificationDeliveryEventType,
): AuditEnvelope["status"] {
  switch (eventType) {
    case "delivered":
      return "delivered"
    case "opened":
      return "opened"
    case "clicked":
      return "clicked"
    case "bounced":
    case "failed":
      return "failed"
    case "complaint":
      return "complaint"
    case "unsubscribed":
      return "unsubscribed"
  }
}

function resolveErrorCode(
  eventType: NotificationDeliveryEventType,
  payload: BrevoDeliveryEventPayload,
): string | undefined {
  const explicit = readString(payload.error_code)
  if (explicit) {
    return explicit
  }

  if (eventType === "bounced") {
    const bounceType = readString(payload.bounce_type)?.toLowerCase()
    if (bounceType === "hard" || readString(payload.event) === "hard_bounce") {
      return "HARD_BOUNCE"
    }
    if (bounceType === "soft" || readString(payload.event) === "soft_bounce") {
      return "SOFT_BOUNCE"
    }
    return "BOUNCE"
  }

  if (eventType === "complaint") {
    return "SPAM_COMPLAINT"
  }

  if (eventType === "failed") {
    return "BREVO_DELIVERY_FAILED"
  }

  return undefined
}

function normalizeEventType(value: string | undefined): NotificationDeliveryEventType | null {
  switch (value) {
    case "delivered":
      return "delivered"
    case "opened":
      return "opened"
    case "clicked":
      return "clicked"
    case "bounced":
    case "soft_bounce":
    case "hard_bounce":
    case "invalid_email":
    case "blocked":
    case "deferred":
      return "bounced"
    case "complaint":
    case "spam":
      return "complaint"
    case "unsubscribed":
      return "unsubscribed"
    case "failed":
      return "failed"
    default:
      return null
  }
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

