/**
 * POST /webhooks/brevo — v1.7.0 transactional communication callback receiver
 *
 * Security contract (mirrors Stripe webhook pattern per Story 7.9 framework):
 *   1. Token verification: constant-time compare of `Authorization: Bearer <token>`
 *      against `BREVO_WEBHOOK_SECRET`. Missing/invalid token → 401, no state mutation.
 *      Brevo dashboard webhook configuration must include this custom header
 *      (Brevo supports custom headers; native HMAC body-signing is not available
 *      from Brevo outbound webhooks, so shared-secret-in-header is the canonical
 *      verified_callback pattern per specs/operator/brevo-webhook-runbook.md).
 *   2. Timestamp tolerance: Brevo payloads include a `date` field (ISO8601).
 *      Events older than TIMESTAMP_TOLERANCE_S (default 300s) → 400, no state mutation.
 *      Prevents replay of captured callbacks.
 *   3. Idempotency: dedup on Brevo `message-id` (rolling in-memory window of 1000
 *      events, TTL 10 min). Duplicate → 200 idempotent ACK, no double-handling.
 *      Single-replica deployments only; multi-replica must migrate to DB-backed dedup.
 *   4. Unknown event schema: payloads missing required fields are quarantined
 *      (returned 202 Accepted with quarantine_reason in log) — never silently dropped,
 *      never accepted for state mutation.
 *   5. Audit record per event: { actor, scope, request_id, outcome, timestamp }
 *      written to logger.info. Durable audit table deferred (same scope as Stripe webhook).
 *
 * Route placement:
 *   Route is at /webhooks/brevo (NOT /store/webhooks/brevo) — Brevo callbacks do
 *   not carry x-publishable-api-key. Register `https://your-domain/webhooks/brevo`
 *   in the Brevo dashboard (Transactional → Settings → Webhooks).
 *
 * Environment:
 *   BREVO_WEBHOOK_SECRET — pre-shared bearer token (Robert generates in Brevo
 *   dashboard webhook config + stores in env / secret manager). Missing secret →
 *   all events rejected (safe fail-closed default).
 *
 * Public access: no Medusa auth header required (Brevo calls this directly).
 * Security is provided solely by Bearer token verification.
 *
 * @see specs/operator/brevo-webhook-runbook.md (operator deployment guide)
 * @see _grow/tools/validate_provider_callback_security.py (Story 7.9 validator framework)
 */

import { timingSafeEqual } from "crypto"

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const AUTHENTICATE = false

/** Brevo timestamp tolerance in seconds (matches Stripe convention). */
const TIMESTAMP_TOLERANCE_S = 300

/** Rolling dedup window: message-id → received_at timestamp.
 * In-memory only — safe for single-replica deployments.
 * Multi-replica: migrate to DB unique constraint on message-id. */
const _seenMessageIds = new Map<string, number>()
const DEDUP_MAX = 1000
const DEDUP_TTL_MS = 10 * 60 * 1000

type LoggerLike = {
  info?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string) => void
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

function evictStaleDedupEntries(): void {
  const cutoff = Date.now() - DEDUP_TTL_MS
  for (const [id, ts] of _seenMessageIds) {
    if (ts < cutoff) {
      _seenMessageIds.delete(id)
    }
  }
  while (_seenMessageIds.size > DEDUP_MAX) {
    const firstKey = _seenMessageIds.keys().next().value
    if (firstKey !== undefined) {
      _seenMessageIds.delete(firstKey)
    } else {
      break
    }
  }
}

function isSeenMessage(messageId: string): boolean {
  evictStaleDedupEntries()
  return _seenMessageIds.has(messageId)
}

function markMessageSeen(messageId: string): void {
  _seenMessageIds.set(messageId, Date.now())
  if (_seenMessageIds.size > DEDUP_MAX) {
    evictStaleDedupEntries()
  }
}

/**
 * Verify Bearer token via constant-time comparison.
 *
 * Format expected: `Authorization: Bearer <BREVO_WEBHOOK_SECRET>`
 * Mismatch → no state mutation, return failure reason for audit log.
 */
function verifyBrevoBearer(
  authHeader: string | undefined,
  webhookSecret: string,
): { ok: boolean; reason?: string } {
  if (!authHeader) {
    return { ok: false, reason: "missing_authorization_header" }
  }
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, reason: "malformed_authorization_header" }
  }
  const providedToken = authHeader.slice("bearer ".length).trim()
  if (!providedToken) {
    return { ok: false, reason: "empty_token" }
  }
  const providedBuf = Buffer.from(providedToken, "utf8")
  const expectedBuf = Buffer.from(webhookSecret, "utf8")
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "token_mismatch" }
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: "token_mismatch" }
  }
  return { ok: true }
}

/**
 * Brevo transactional callback payload (selected fields per Brevo docs).
 * Other fields exist but are not validated here.
 *
 * Required for processing: `event`, `message-id`, `date`.
 */
type BrevoEventShape = {
  event?: string
  "message-id"?: string
  date?: string
  email?: string
  subject?: string
  tag?: string
  "X-Mailin-custom"?: string
  [key: string]: unknown
}

const ACCEPTED_EVENTS = new Set([
  "delivered",
  "opened",
  "clicked",
  "soft_bounce",
  "hard_bounce",
  "spam",
  "invalid_email",
  "blocked",
  "deferred",
  "unsubscribed",
  "complaint",
])

function resolveBrevoOutcome(eventName: string): {
  delivery_status: string
  outcome_label: string
} {
  switch (eventName) {
    case "delivered":
      return { delivery_status: "delivered", outcome_label: "email_delivered" }
    case "opened":
      return { delivery_status: "delivered", outcome_label: "email_opened" }
    case "clicked":
      return { delivery_status: "delivered", outcome_label: "email_clicked" }
    case "soft_bounce":
      return { delivery_status: "transient_failure", outcome_label: "soft_bounce_retry_pending" }
    case "deferred":
      return { delivery_status: "transient_failure", outcome_label: "deferred_retry_pending" }
    case "hard_bounce":
      return { delivery_status: "permanent_failure", outcome_label: "hard_bounce_dead_letter" }
    case "spam":
    case "complaint":
      return { delivery_status: "permanent_failure", outcome_label: "spam_complaint_dead_letter" }
    case "invalid_email":
      return { delivery_status: "permanent_failure", outcome_label: "invalid_recipient" }
    case "blocked":
      return { delivery_status: "permanent_failure", outcome_label: "provider_blocked" }
    case "unsubscribed":
      return { delivery_status: "delivered", outcome_label: "recipient_unsubscribed" }
    default:
      return { delivery_status: "unknown", outcome_label: `unhandled_event_${eventName}` }
  }
}

function parseTimestampSeconds(dateValue: string | undefined): number | null {
  if (!dateValue || typeof dateValue !== "string") {
    return null
  }
  const ms = Date.parse(dateValue)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = resolveLogger(req)
  const webhookSecret = process.env.BREVO_WEBHOOK_SECRET ?? ""

  if (!webhookSecret) {
    logger.warn?.("[brevo-webhook] BREVO_WEBHOOK_SECRET not configured — rejecting event")
    res.status(401).json({ type: "configuration_error", message: "Webhook secret not configured" })
    return
  }

  const authHeader = req.headers?.authorization as string | undefined
  const { ok: authValid, reason: authReason } = verifyBrevoBearer(authHeader, webhookSecret)
  if (!authValid) {
    logger.warn?.(`[brevo-webhook] authorization failed: ${authReason}`)
    res.status(401).json({ type: "unauthorized", message: "Invalid webhook credentials" })
    return
  }

  const event = req.body as BrevoEventShape | undefined
  if (!event || typeof event !== "object") {
    res.status(400).json({ type: "invalid_request", message: "Event payload is required" })
    return
  }

  const messageId = event["message-id"]
  const eventName = event.event
  const dateValue = event.date

  if (!messageId || typeof messageId !== "string") {
    logger.warn?.("[brevo-webhook] event missing message-id — quarantining")
    logger.info?.(JSON.stringify({
      actor: "system",
      scope: "brevo_webhook",
      request_id: null,
      outcome: "quarantine_missing_message_id",
      timestamp: new Date().toISOString(),
    }))
    res.status(202).json({ received: true, quarantined: true, reason: "missing_message_id" })
    return
  }

  if (!eventName || typeof eventName !== "string" || !ACCEPTED_EVENTS.has(eventName)) {
    logger.warn?.(`[brevo-webhook] event '${eventName ?? "<missing>"}' not in accepted set — quarantining`)
    logger.info?.(JSON.stringify({
      actor: "system",
      scope: "brevo_webhook",
      request_id: messageId,
      outcome: `quarantine_unknown_event_${eventName ?? "missing"}`,
      timestamp: new Date().toISOString(),
    }))
    res.status(202).json({ received: true, quarantined: true, reason: "unknown_event_type" })
    return
  }

  const tsSeconds = parseTimestampSeconds(dateValue)
  if (tsSeconds === null) {
    logger.warn?.("[brevo-webhook] event missing/invalid date field — rejecting")
    res.status(400).json({ type: "invalid_request", message: "Event date is required" })
    return
  }
  if (Math.abs(Date.now() / 1000 - tsSeconds) > TIMESTAMP_TOLERANCE_S) {
    logger.warn?.(`[brevo-webhook] event timestamp out of tolerance (${dateValue}) — rejecting`)
    res.status(400).json({ type: "invalid_request", message: "Event timestamp out of tolerance" })
    return
  }

  if (isSeenMessage(messageId)) {
    logger.info?.(JSON.stringify({
      actor: "system",
      scope: "brevo_webhook",
      request_id: messageId,
      outcome: "deduplicated_idempotent_ack",
      event_type: eventName,
      timestamp: new Date().toISOString(),
    }))
    res.status(200).json({ received: true, deduplicated: true })
    return
  }

  markMessageSeen(messageId)

  const { delivery_status, outcome_label } = resolveBrevoOutcome(eventName)

  logger.info?.(JSON.stringify({
    actor: "system",
    scope: `brevo_message:${messageId}`,
    request_id: messageId,
    outcome: outcome_label,
    delivery_status,
    event_type: eventName,
    recipient_hint: typeof event.email === "string" ? event.email.split("@")[1] ?? null : null,
    timestamp: new Date().toISOString(),
  }))

  res.status(200).json({ received: true })
}
