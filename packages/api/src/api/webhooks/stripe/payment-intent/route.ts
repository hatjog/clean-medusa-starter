/**
 * POST /webhooks/stripe/payment-intent — CIENKI webhook Path Y (Story 3.3, AC1).
 *
 * Tryb TEST (Stripe TEST). Robi WYŁĄCZNIE dwie rzeczy (ADR-118, ADR-137 DEC pkt 2):
 *   1. weryfikuje sygnaturę Stripe (`stripe-signature`, HMAC-SHA256);
 *   2. buduje + waliduje envelope `gp.stripe.payment_intent_succeeded.v1` (kontrakt
 *      Story 3.1) i EMITUJE go na event bus.
 *
 * ZERO biznes-logiki: NIE tworzy entitlementu, NIE woła service'ów domenowych,
 * NIE czyta/zapisuje DB entitlement. Cała logika live-issue → ISSUED jest w
 * `@MedusaSubscriber` (`subscribers/voucher-live-issue.ts`), który konsumuje ten
 * event (Path Y, ADR-052/118 — zakaz custom route jako ścieżki issue).
 *
 * Uwaga: produkcyjna ścieżka płatności GP używa natywnego hooka Medusy
 * (`/hooks/payment/stripe`); root `/webhooks/stripe` jest RETIRED (410). Ten route
 * dostarcza TEST-owy, audytowalny most fakt-Stripe → event GP envelope dla rdzenia
 * live-issue (3.1/3.3), bez naruszania retired-invariantu root route.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

import {
  buildPaymentIntentSucceededEnvelope,
  PAYMENT_INTENT_SUCCEEDED_EVENT,
  StripeEventMappingError,
  verifyStripeSignature,
  type StripePaymentIntentEvent,
} from "../../../../lib/payment/stripe-payment-intent-event"
import {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_SECRET_ENV,
} from "./helpers"

export const AUTHENTICATE = false

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type EventBusLike = {
  emit: (event: { name: string; data: unknown }) => Promise<unknown> | unknown
}

type RawBodyRequest = MedusaRequest & {
  rawBody?: Buffer | string
  headers: Record<string, string | string[] | undefined>
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike) ?? console
  } catch {
    return console
  }
}

function readRawBody(req: RawBodyRequest): Buffer | null {
  const raw = req.rawBody
  if (Buffer.isBuffer(raw)) return raw
  if (typeof raw === "string") return Buffer.from(raw, "utf8")
  // Fallback: niektóre konfiguracje dostarczają sparsowane body — re-serializacja
  // jest NIEDOPUSZCZALNA dla weryfikacji sygnatury (musi być bajt-w-bajt), więc
  // brak rawBody = twarde odrzucenie (fail-closed), nie ciche obejście.
  return null
}

function headerValue(
  req: RawBodyRequest,
  name: string
): string | undefined {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = resolveLogger(req)
  const rawReq = req as RawBodyRequest

  const rawBody = readRawBody(rawReq)
  if (!rawBody) {
    logger.warn?.("[stripe/payment-intent] raw body niedostępne — odrzucono")
    res.status(400).json({ type: "invalid", reason: "raw_body_unavailable" })
    return
  }

  const secret = process.env[STRIPE_WEBHOOK_SECRET_ENV] ?? ""
  const signature = verifyStripeSignature(
    rawBody,
    headerValue(rawReq, STRIPE_SIGNATURE_HEADER),
    secret
  )
  if (!signature.ok) {
    logger.warn?.(`[stripe/payment-intent] sygnatura odrzucona: ${signature.reason}`)
    res.status(400).json({ type: "invalid_signature", reason: signature.reason })
    return
  }

  let stripeEvent: StripePaymentIntentEvent
  try {
    stripeEvent = JSON.parse(rawBody.toString("utf8")) as StripePaymentIntentEvent
  } catch {
    res.status(400).json({ type: "invalid", reason: "unparseable_body" })
    return
  }

  // Webhook obsługuje WYŁĄCZNIE payment_intent.succeeded; inne typy = ACK 200
  // bez emisji (Stripe nie ponawia), zero biznes-logiki.
  if (stripeEvent.type !== "payment_intent.succeeded") {
    res.status(200).json({ received: true, ignored: stripeEvent.type ?? "unknown" })
    return
  }

  let envelope
  try {
    envelope = buildPaymentIntentSucceededEnvelope(stripeEvent)
  } catch (err) {
    const error = err as Error
    if (error instanceof StripeEventMappingError) {
      logger.warn?.(`[stripe/payment-intent] mapowanie odrzucone: ${error.message}`)
      res.status(400).json({ type: "invalid", reason: error.message })
      return
    }
    // Walidacja kontraktu (NFR4) lub inny błąd — fail-loud 400.
    logger.error?.(`[stripe/payment-intent] envelope invalid: ${error.message}`)
    res.status(400).json({ type: "invalid_contract", reason: error.message })
    return
  }

  // EMIT — jedyny side-effect webhooka. Biznes-logika żyje w subscriberze.
  try {
    const eventBus = req.scope.resolve(Modules.EVENT_BUS) as EventBusLike
    await eventBus.emit({ name: PAYMENT_INTENT_SUCCEEDED_EVENT, data: envelope })
  } catch (err) {
    const error = err as Error
    logger.error?.(`[stripe/payment-intent] emit failed: ${error.message}`)
    res.status(500).json({ type: "emit_failed", reason: error.message })
    return
  }

  logger.info?.(
    `[stripe/payment-intent] emitted ${PAYMENT_INTENT_SUCCEEDED_EVENT} ` +
      `payment_intent=${envelope.payload.payment_intent_id} order=${envelope.payload.order_id}`
  )
  res.status(200).json({ received: true, emitted: PAYMENT_INTENT_SUCCEEDED_EVENT })
}
