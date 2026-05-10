/**
 * POST /store/webhooks/stripe — Story 6.1: Payment Hardening
 *
 * Stripe webhook handler. Security contract:
 *   1. Signature verification (NFR24): HMAC-SHA256 of `timestamp.rawBody`
 *      against `STRIPE_WEBHOOK_SECRET`. Requests with missing/invalid
 *      signatures are rejected with 401 — NO state mutation on failure.
 *   2. Timestamp replay guard: reject events older than 300s (Stripe's own
 *      tolerance; prevents replay attacks on captured requests).
 *   3. Event deduplication by `event.id` (in-memory rolling window of 1000
 *      events, TTL 10 min). Duplicate → 200 idempotent ACK, no action.
 *   4. Lifecycle state resolution: maps Stripe event types to GP shared
 *      lifecycle state ids (payment + order domains). No local aliases.
 *   5. Audit record per event: { actor, scope, request_id, outcome, timestamp }
 *      written to logger per AC 3 / T4 audit contract.
 *
 * Raw body requirement:
 *   Stripe signature verification REQUIRES the unmodified raw request body.
 *   This handler reads `req` as a Node.js stream when `req.body` is not
 *   pre-parsed as a Buffer. The middleware must register this route with
 *   `bodyParser: false` (see middlewares.ts registration below).
 *
 * Environment:
 *   STRIPE_WEBHOOK_SECRET — Stripe CLI `whsec_...` or dashboard secret.
 *   Missing secret → all events rejected (safe fail-closed default).
 *
 * Public access: no auth header required (Stripe calls this directly).
 * Security is provided solely by signature verification.
 *
 * @see GP/backend/src/api/store/orders/[id]/payment-status/route.ts (polling endpoint)
 * @see specs/contracts/governance/examples/lifecycle-state-machine.v1.example.json
 * @see specs/constitution/upstream-policy.md (no upstream issue reporting)
 */

import { createHmac, timingSafeEqual } from "crypto"

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const AUTHENTICATE = false

/** Stripe signature timestamp tolerance in seconds (matches Stripe default). */
const TIMESTAMP_TOLERANCE_S = 300

/** Rolling dedup window: event.id → received_at timestamp. */
const _seenEventIds = new Map<string, number>()
/** Max dedup window size before LRU eviction. */
const DEDUP_MAX = 1000
/** TTL for dedup entries in ms. */
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
  for (const [id, ts] of _seenEventIds) {
    if (ts < cutoff) {
      _seenEventIds.delete(id)
    }
    if (_seenEventIds.size <= DEDUP_MAX) break
  }
}

function isSeenEvent(eventId: string): boolean {
  evictStaleDedupEntries()
  return _seenEventIds.has(eventId)
}

function markEventSeen(eventId: string): void {
  if (_seenEventIds.size >= DEDUP_MAX) {
    // Evict oldest entry (Map preserves insertion order).
    const firstKey = _seenEventIds.keys().next().value
    if (firstKey !== undefined) _seenEventIds.delete(firstKey)
  }
  _seenEventIds.set(eventId, Date.now())
}

/**
 * Verify Stripe webhook signature.
 *
 * Stripe v1 signature scheme:
 *   stripe-signature: t=<timestamp>,v1=<hmac_hex>[,v1=...]
 *   signed_payload = `${t}.${rawBody}`
 *   expected = HMAC-SHA256(webhookSecret, signed_payload)
 *
 * Uses timingSafeEqual to prevent timing oracle attacks.
 */
function verifyStripeSignature(
  rawBody: Buffer,
  sigHeader: string | undefined,
  webhookSecret: string,
): { ok: boolean; reason?: string } {
  if (!sigHeader) {
    return { ok: false, reason: "missing_signature_header" }
  }

  const parts: Record<string, string[]> = {}
  for (const part of sigHeader.split(",")) {
    const eqIdx = part.indexOf("=")
    if (eqIdx === -1) continue
    const k = part.slice(0, eqIdx)
    const v = part.slice(eqIdx + 1)
    parts[k] = [...(parts[k] ?? []), v]
  }

  const timestamp = parts["t"]?.[0]
  const v1Sigs = parts["v1"] ?? []

  if (!timestamp || v1Sigs.length === 0) {
    return { ok: false, reason: "malformed_signature_header" }
  }

  // Replay guard: reject events older than tolerance window.
  const tsNum = parseInt(timestamp, 10)
  if (isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > TIMESTAMP_TOLERANCE_S) {
    return { ok: false, reason: "timestamp_out_of_tolerance" }
  }

  const signedPayload = Buffer.from(`${timestamp}.${rawBody.toString("utf8")}`)
  const expectedHmac = createHmac("sha256", webhookSecret).update(signedPayload).digest()

  // Check all v1 sigs (Stripe may rotate secrets and send multiple).
  for (const sig of v1Sigs) {
    try {
      const sigBuf = Buffer.from(sig, "hex")
      if (sigBuf.length === expectedHmac.length && timingSafeEqual(sigBuf, expectedHmac)) {
        return { ok: true }
      }
    } catch {
      // Invalid hex — continue to next sig.
    }
  }

  return { ok: false, reason: "signature_mismatch" }
}

/**
 * Read raw body from request stream.
 * Used when bodyParser middleware has been disabled for this route.
 */
async function readRawBody(req: MedusaRequest): Promise<Buffer> {
  // If Medusa/Express already parsed the body as a Buffer, use it directly.
  if (Buffer.isBuffer(req.body)) {
    return req.body
  }
  if (typeof req.body === "string") {
    return Buffer.from(req.body, "utf8")
  }

  // Stream not yet consumed — read manually.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    ;(req as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => chunks.push(chunk))
    ;(req as unknown as NodeJS.ReadableStream).on("end", () => resolve(Buffer.concat(chunks)))
    ;(req as unknown as NodeJS.ReadableStream).on("error", reject)
  })
}

/**
 * Map Stripe event type → GP lifecycle outcome label (for audit log).
 * Only order/payment domain lifecycle state ids — no local aliases.
 */
function resolveEventOutcome(eventType: string): {
  lifecycle_status: string
  outcome_label: string
} {
  switch (eventType) {
    case "payment_intent.succeeded":
      return { lifecycle_status: "paid", outcome_label: "payment_succeeded" }
    case "payment_intent.payment_failed":
      return { lifecycle_status: "failed", outcome_label: "payment_failed" }
    case "payment_intent.canceled":
      return { lifecycle_status: "expired", outcome_label: "payment_canceled" }
    case "payment_intent.requires_action":
      return { lifecycle_status: "pending_psp_confirmation", outcome_label: "requires_action" }
    case "charge.dispute.created":
      return { lifecycle_status: "support_required", outcome_label: "dispute_created" }
    default:
      return { lifecycle_status: "pending_psp_confirmation", outcome_label: `unhandled_event_${eventType}` }
  }
}

type StripeEventShape = {
  id?: string
  type?: string
  data?: {
    object?: {
      id?: string
      metadata?: Record<string, string | undefined>
      payment_intent?: string
    }
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = resolveLogger(req)
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? ""

  // Fail-closed: if secret is not configured, reject all events.
  if (!webhookSecret) {
    logger.warn?.("[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured — rejecting event")
    res.status(401).json({ type: "configuration_error", message: "Webhook secret not configured" })
    return
  }

  // Step 1: Read raw body (required for HMAC verification).
  let rawBody: Buffer
  try {
    rawBody = await readRawBody(req)
  } catch (err) {
    logger.error?.(`[stripe-webhook] failed to read request body: ${String(err)}`)
    res.status(400).json({ type: "invalid_request", message: "Could not read request body" })
    return
  }

  // Step 2: Verify Stripe signature (NFR24).
  const sigHeader = req.headers?.["stripe-signature"] as string | undefined
  const { ok: sigValid, reason: sigReason } = verifyStripeSignature(rawBody, sigHeader, webhookSecret)
  if (!sigValid) {
    logger.warn?.(`[stripe-webhook] signature verification failed: ${sigReason}`)
    res.status(401).json({ type: "unauthorized", message: "Invalid webhook signature" })
    return
  }

  // Step 3: Parse event payload.
  let event: StripeEventShape
  try {
    event = JSON.parse(rawBody.toString("utf8")) as StripeEventShape
  } catch {
    res.status(400).json({ type: "invalid_request", message: "Invalid JSON payload" })
    return
  }

  const eventId = event.id
  const eventType = event.type ?? "unknown"

  if (!eventId) {
    logger.warn?.("[stripe-webhook] event missing id — rejecting")
    res.status(400).json({ type: "invalid_request", message: "Event ID is required" })
    return
  }

  // Step 4: Dedup by event.id.
  if (isSeenEvent(eventId)) {
    logger.info?.(JSON.stringify({
      actor: "system",
      scope: "stripe_webhook",
      request_id: eventId,
      outcome: "deduplicated_idempotent_ack",
      timestamp: new Date().toISOString(),
    }))
    // Idempotent ACK — Stripe expects 2xx for dedup.
    res.status(200).json({ received: true, deduplicated: true })
    return
  }

  markEventSeen(eventId)

  // Step 5: Resolve to GP lifecycle outcome.
  const { lifecycle_status, outcome_label } = resolveEventOutcome(eventType)

  // Extract order/payment context from event metadata.
  const metadataOrderId = event.data?.object?.metadata?.order_id
  const paymentIntentId = event.data?.object?.id ?? event.data?.object?.payment_intent

  // Step 6: Emit audit record (AC 3 / T4 contract).
  // Format: { actor, scope, request_id, outcome, timestamp }
  // No secrets, no PII in audit record per T4 requirement.
  logger.info?.(JSON.stringify({
    actor: "system",
    scope: metadataOrderId ? `order:${metadataOrderId}` : `payment_intent:${paymentIntentId ?? "unknown"}`,
    request_id: eventId,
    outcome: outcome_label,
    lifecycle_status,
    event_type: eventType,
    timestamp: new Date().toISOString(),
  }))

  // Step 7: ACK to Stripe (no state mutation in this handler).
  // Actual order status updates are driven by Medusa's payment module
  // processing the same Stripe events via its own webhook registration.
  // This handler adds GP-level dedup + audit on top.
  res.status(200).json({ received: true })
}
