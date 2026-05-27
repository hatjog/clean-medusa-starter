import { createHash, randomUUID } from "node:crypto"

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

export const BREVO_NOTIFICATION_EVENTS = [
  "notification.delivered",
  "notification.opened",
  "notification.clicked",
  "notification.bounced",
  "notification.complaint",
  "notification.unsubscribed",
] as const

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

  const correlated = await correlateDispatch(runtimeContainer, normalized, logger)
  const auditEvent = buildAuditEnvelope(normalized, correlated)

  await emitAuditEvent(runtimeContainer, auditEvent, logger)
  markProviderEventSeen(normalized.provider_event_id)
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
): Promise<{
  correlation_id: string
  correlation_state: NotificationDeliveryCorrelationState
  dispatch_id: string
  dispatch?: DispatchRecord
}> {
  if (normalized.dispatch_id) {
    return {
      correlation_id: normalized.dispatch_id,
      correlation_state: "matched",
      dispatch_id: normalized.dispatch_id,
    }
  }

  const dispatch = await lookupDispatch(container, normalized.provider_event_id, logger)
  const dispatchId = dispatch?.dispatch_id ?? dispatch?.id
  if (dispatchId) {
    return {
      correlation_id: dispatchId,
      correlation_state: "matched",
      dispatch_id: dispatchId,
      dispatch: dispatch ?? undefined,
    }
  }

  logger.warn?.(
    `[brevo-delivery-tracker] orphan delivery event provider_event_id=${normalized.provider_event_id}`,
  )
  return {
    correlation_id: normalized.provider_event_id,
    correlation_state: "orphan",
    dispatch_id: normalized.provider_event_id,
  }
}

async function lookupDispatch(
  container: ResolveContainer,
  providerEventId: string,
  logger: LoggerLike,
): Promise<DispatchRecord | null> {
  const service = resolveOptional<DispatchLookup>(container, [
    "notification_dispatches",
    "notificationDispatches",
    "notification_dispatch_repository",
    "notificationDispatchRepository",
  ])

  if (service?.findByProviderMessageId) {
    return service.findByProviderMessageId(providerEventId)
  }
  if (service?.findOneByProviderMessageId) {
    return service.findOneByProviderMessageId(providerEventId)
  }
  if (service?.findOne) {
    return service.findOne({ provider_message_id: providerEventId })
  }
  if (service?.find) {
    return (await service.find({ provider_message_id: providerEventId }))[0] ?? null
  }

  const db = resolvePgConnection(container)
  if (!db) {
    return null
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
    return (result.rows?.[0] as DispatchRecord | undefined) ?? null
  } catch (error) {
    logger.warn?.(
      `[brevo-delivery-tracker] notification_dispatches lookup unavailable provider_event_id=${providerEventId}`,
    )
    return null
  }
}

function buildAuditEnvelope(
  normalized: NormalizedBrevoDeliveryEvent,
  correlated: {
    correlation_id: string
    correlation_state: NotificationDeliveryCorrelationState
    dispatch_id: string
    dispatch?: DispatchRecord
  },
): AuditEnvelope {
  const outcome = resolveOutcome(normalized.event_type)
  const dispatch = correlated.dispatch

  return {
    audit_id: randomUUID(),
    event_type: "notification.delivery",
    status: resolveDeliveryStatus(normalized.event_type),
    dispatch_id: correlated.dispatch_id,
    provider: "brevo",
    provider_event_id: normalized.provider_event_id,
    correlation_id: correlated.correlation_id,
    correlation_state: correlated.correlation_state,
    outcome,
    flow_id: normalized.flow_id ?? dispatch?.flow_id ?? "unknown",
    template_key: normalized.template_key ?? dispatch?.template_key ?? "unknown",
    channel: "email",
    market_id: normalized.market_id ?? dispatch?.market_id ?? "unknown",
    locale: normalized.locale ?? dispatch?.locale ?? "pl-PL",
    consent_basis:
      normalized.consent_basis ?? dispatch?.consent_basis ?? "transactional_supportive",
    idempotency_key:
      normalized.idempotency_key ?? dispatch?.idempotency_key ?? normalized.provider_event_id,
    hashed_recipient: normalized.recipient_hash,
    recipient_hash: normalized.recipient_hash,
    occurred_at: normalized.occurred_at,
    error_code: normalized.error_code,
    error_message: normalized.error_message,
  }
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

  return "unknown"
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
