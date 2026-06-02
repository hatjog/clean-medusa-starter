import { createHmac, timingSafeEqual } from "node:crypto"

import {
  assertEventEnvelopeMatchesContract,
  type GpEventEnvelope,
} from "../../modules/gp-core/market-lifecycle-events"
import type { PaymentIntentSucceededPayload } from "../../workflows/entitlements/live-issue-from-payment-intent"

/**
 * stripe-payment-intent-event.ts — Story 3.3 (v1.11.0 Epic 3) — warstwa CIENKIEGO
 * webhooka Path Y (AC1): weryfikacja sygnatury Stripe + budowa/walidacja envelope
 * `gp.stripe.payment_intent_succeeded.v1` (kontrakt Story 3.1).
 *
 * ZERO biznes-logiki: ten moduł NIE tworzy entitlementu, NIE woła service'ów
 * domenowych, NIE czyta/zapisuje DB. Webhook = signature verify + emit; cała
 * logika issue jest w `@MedusaSubscriber` (`subscribers/voucher-live-issue.ts`),
 * Path Y (ADR-118, ADR-137 DEC pkt 2).
 *
 * NFR4: envelope jest walidowany WZGLĘDEM kontraktu Story 3.1
 * (`specs/contracts/events/schemas/payloads/gp.stripe.payment_intent_succeeded.v1.schema.json`
 * + `envelope.v1.schema.json`) przez `assertEventEnvelopeMatchesContract` — brak
 * referencji do schematu = blokada review; tu referencja jest egzekwowana w runtime.
 */

export const PAYMENT_INTENT_SUCCEEDED_EVENT =
  "gp.stripe.payment_intent_succeeded.v1" as const

/** Tolerancja znacznika czasu sygnatury Stripe (sekundy) — replay/skew guard. */
export const STRIPE_SIGNATURE_TIMESTAMP_TOLERANCE_S = 300

export type StripeSignatureResult = { ok: true } | { ok: false; reason: string }

/**
 * Weryfikuje sygnaturę webhooka Stripe (schemat `t=<ts>,v1=<hex-hmac>`):
 * HMAC-SHA256 nad `"<ts>.<rawBody>"` kluczem `webhookSecret`, porównanie
 * `timingSafeEqual`. Odrzuca brak/malformed nagłówek, timestamp poza tolerancją
 * oraz niezgodny podpis. Czysta funkcja (bez I/O, bez stanu).
 *
 * `nowMs` wstrzykiwalny dla determinizmu testów (domyślnie czas systemowy).
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  sigHeader: string | undefined,
  webhookSecret: string,
  nowMs: number = Date.now()
): StripeSignatureResult {
  if (!sigHeader) return { ok: false, reason: "missing_signature_header" }
  if (!webhookSecret) return { ok: false, reason: "webhook_secret_unset" }

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

  const tsNum = Number.parseInt(timestamp, 10)
  if (
    Number.isNaN(tsNum) ||
    Math.abs(nowMs / 1000 - tsNum) > STRIPE_SIGNATURE_TIMESTAMP_TOLERANCE_S
  ) {
    return { ok: false, reason: "timestamp_out_of_tolerance" }
  }

  const signedPayload = Buffer.from(`${timestamp}.${rawBody.toString("utf8")}`)
  const expectedHmac = createHmac("sha256", webhookSecret)
    .update(signedPayload)
    .digest()

  for (const sig of v1Sigs) {
    try {
      const sigBuf = Buffer.from(sig, "hex")
      if (sigBuf.length === expectedHmac.length && timingSafeEqual(sigBuf, expectedHmac)) {
        return { ok: true }
      }
    } catch {
      // nieprawidłowy hex — próbuj kolejnego v1
    }
  }
  return { ok: false, reason: "signature_mismatch" }
}

/** Minimalny kształt Stripe `payment_intent.succeeded` event (PSP-level). */
export type StripePaymentIntentEvent = {
  id?: string
  type?: string
  created?: number
  data?: {
    object?: {
      id?: string
      amount?: number
      amount_received?: number
      currency?: string
      created?: number
      metadata?: Record<string, unknown> | null
    }
  }
}

export class StripeEventMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StripeEventMappingError"
  }
}

/**
 * Buduje i WALIDUJE envelope `gp.stripe.payment_intent_succeeded.v1` z faktu
 * Stripe (kontrakt Story 3.1, envelope.v1). Mapowanie minimalne, audytowalne —
 * BEZ raw provider error / sekretów (zgodnie z payload-schema). `order_id`,
 * `market_id`, `instance_id` czytane z `payment_intent.metadata` (ustawione na
 * etapie checkout). Rzuca `StripeEventMappingError` przy brakach / złym typie.
 *
 * `now` wstrzykiwalny (determinizm testów). Walidacja kontraktu jest TWARDA:
 * niezgodny payload/envelope ⇒ wyjątek (NFR4), webhook zwróci 400 i NIE wyemituje.
 */
export function buildPaymentIntentSucceededEnvelope(
  event: StripePaymentIntentEvent,
  now: Date = new Date()
): GpEventEnvelope<PaymentIntentSucceededPayload> {
  if (event.type !== "payment_intent.succeeded") {
    throw new StripeEventMappingError(
      `nieobsługiwany typ Stripe event: ${event.type ?? "unknown"}`
    )
  }
  const pi = event.data?.object ?? {}
  const paymentIntentId = readString(pi.id)
  if (!paymentIntentId) {
    throw new StripeEventMappingError("payment_intent.id wymagany")
  }
  const metadata = (pi.metadata ?? {}) as Record<string, unknown>
  const orderId = readString(metadata.order_id) ?? readString(metadata.gp_order_id)
  if (!orderId) {
    throw new StripeEventMappingError(
      `payment_intent ${paymentIntentId} bez order_id w metadata (precondition live-issue)`
    )
  }
  const currency = readString(pi.currency)?.toUpperCase()
  if (!currency) {
    throw new StripeEventMappingError(`payment_intent ${paymentIntentId} bez currency`)
  }
  const amountMinor = readNonNegativeInt(pi.amount_received ?? pi.amount)
  if (amountMinor === null) {
    throw new StripeEventMappingError(
      `payment_intent ${paymentIntentId} bez nieujemnego amount`
    )
  }
  const instanceId = readString(metadata.instance_id) ?? "gp"
  const marketId = readString(metadata.market_id) ?? readString(metadata.gp_market_id)
  if (!marketId) {
    throw new StripeEventMappingError(
      `payment_intent ${paymentIntentId} bez market_id w metadata (ontologia 3.2)`
    )
  }

  const pspOccurredAt = new Date(
    (pi.created ?? event.created ?? Math.floor(now.getTime() / 1000)) * 1000
  ).toISOString()

  const payload: PaymentIntentSucceededPayload = {
    payment_intent_id: paymentIntentId,
    order_id: orderId,
    currency,
    amount_minor: amountMinor,
    psp_occurred_at: pspOccurredAt,
  }

  const envelope: GpEventEnvelope<PaymentIntentSucceededPayload> = {
    schema_version: "1",
    event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
    occurred_at: now.toISOString(),
    actor: "system",
    scope: {
      instance_id: instanceId,
      market_id: marketId,
      vendor_id: null,
      location_id: null,
    },
    idempotency_key: `${marketId}:${paymentIntentId}:payment_intent_succeeded`,
    correlation_id: orderId,
    payload,
  }
  if (event.id) {
    envelope.causation_id = `stripe:webhook:${event.id}`
  }

  // NFR4 — TWARDA walidacja względem kontraktu Story 3.1 (envelope.v1 + payload).
  assertEventEnvelopeMatchesContract<PaymentIntentSucceededPayload>(
    envelope,
    PAYMENT_INTENT_SUCCEEDED_EVENT
  )
  return envelope
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const rounded = Math.trunc(value)
  return rounded >= 0 ? rounded : null
}
