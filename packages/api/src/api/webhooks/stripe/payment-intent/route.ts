/**
 * POST /webhooks/stripe/payment-intent — CIENKI webhook Path Y (Story 3.3 AC1,
 * naprawiony w Story 5.1 AC4).
 *
 * Tryb TEST (Stripe TEST). Route robi dokładnie tyle, ile trzeba, żeby fakt
 * Stripe stał się faktem GP (ADR-118, ADR-137 DEC pkt 2):
 *   1. weryfikuje sygnaturę Stripe (`stripe-signature`, HMAC-SHA256);
 *   2. USTALA listę `order_id` + wspólny `market_id` — z metadata, a gdy ich
 *      tam nie ma, z istniejącego powiązania płatność→zamówienia;
 *   3. buduje + waliduje N envelope'ów `gp.stripe.payment_intent_succeeded.v1`,
 *      po jednym na zamówienie (kontrakt Story 3.1 + ADR-166);
 *   4. rezerwuje dostawę w `webhook_event_processed` (idempotencja transportu);
 *   5. EMITUJE kopertę na event bus.
 *
 * ZERO biznes-logiki nadal obowiązuje: route NIE tworzy entitlementu, NIE woła
 * service'ów domenowych, NIE otwiera transakcji biznesowej i NIE dotyka tabel
 * entitlementów. Cała logika live-issue → ISSUED jest w `@MedusaSubscriber`
 * (`subscribers/voucher-live-issue.ts`), Path Y (ADR-052/118).
 *
 * ── Dlaczego krok 2 musiał powstać (Story 5.1 AC4) ──────────────────────────
 * Realny zakup 2026-07-28 (250 PLN, `order_01KYMN7XQX06FKHSWFT0QV2NNY`,
 * PI `pi_3TyCqiHG9Rf5NslT0vAfkVtW` = `succeeded`) dostał tu **HTTP 400**:
 * metadata PaymentIntenta niosła wyłącznie `{ session_id }`, bo sesja płatności
 * powstaje ZANIM zamówienie zaczyna istnieć. Efekt: `webhook_event_processed`,
 * `event_processed`, `entitlement_instance` = 0 / 0 / 0 — klientka zapłaciła,
 * zobaczyła potwierdzenie i nie dostała vouchera.
 *
 * „Cienki" nigdy nie znaczyło „ślepy na własne dane". Route czyta z bazy
 * WYŁĄCZNIE powiązanie płatności z zamówieniem i rezerwację dostawy — bez tego
 * nie da się zbudować koperty, której wymaga kontrakt.
 *
 * ── Rozłączne klasy odrzucenia (operator ma wiedzieć, co jest zepsute) ──────
 *   400 `invalid_signature`  — zły podpis / brak nagłówka / skew  → KONFIG sekretu
 *   503 `unresolved_link`    — zamówienie może jeszcze powstawać   → retry Stripe
 *   400 `link_ambiguous`     — strukturalnie niejednoznaczne dane  → DANE
 *   400 `invalid_contract`   — koperta niezgodna z kontraktem      → KOD
 *   500 `db_unavailable`     — brak dostępu do bazy                → INFRA (retry)
 *   500 `emit_failed`        — event bus odmówił                   → INFRA (retry)
 *   200 `duplicate`          — dostawa już przyjęta                → OK, no-op
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

import {
  buildPaymentIntentSucceededEnvelope,
  PAYMENT_INTENT_SUCCEEDED_EVENT,
  readPaymentIntentIdentifiers,
  StripeEventMappingError,
  verifyStripeSignature,
  type StripePaymentIntentEvent,
} from "../../../../lib/payment/stripe-payment-intent-event"
import {
  resolvePaymentIntentLink,
  type PaymentIntentLinkResolution,
} from "../../../../lib/payment/stripe-payment-intent-link"
import { stampPaymentIntentOrderFacts } from "../../../../lib/payment/stripe-payment-intent-metadata-stamp"
import {
  releaseWebhookDelivery,
  reserveWebhookDelivery,
  resolveWebhookPgHandle,
  type WebhookPgHandle,
} from "../../../../lib/payment/stripe-payment-intent-transport"
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

  const identifiers = readPaymentIntentIdentifiers(stripeEvent)
  if (!identifiers.payment_intent_id) {
    logger.warn?.("[stripe/payment-intent] zdarzenie bez payment_intent.id — odrzucono")
    res.status(400).json({ type: "invalid", reason: "payment_intent_id_missing" })
    return
  }
  const paymentIntentId = identifiers.payment_intent_id

  // Klucz idempotencji transportu. Zdarzenie bez `id` (poza realnym Stripe'em)
  // dostaje klucz wyprowadzony z PI — dedupe nie może zależeć od pola opcjonalnego.
  const deliveryEventId = stripeEvent.id ?? `stripe:pi:${paymentIntentId}`

  let handle: WebhookPgHandle | null
  try {
    handle = await resolveWebhookPgHandle(req.scope)
  } catch (err) {
    logger.error?.(
      `[stripe/payment-intent] brak połączenia z bazą: ${(err as Error).message}`
    )
    res.status(500).json({ type: "db_unavailable", reason: "pg_connect_failed" })
    return
  }
  if (!handle) {
    // Fail-closed z kodem RETRIABLE: 400 wyglądałoby jak defekt danych i Stripe
    // przestałby ponawiać, gubiąc opłaconą transakcję na awarii infrastruktury.
    logger.error?.("[stripe/payment-intent] brak dostępu do PG w kontenerze")
    res.status(500).json({ type: "db_unavailable", reason: "pg_not_registered" })
    return
  }

  try {
    // ── krok 2: ustal order_id + market_id ────────────────────────────────────
    // Link płatności jest źródłem prawdy dla kardynalności także, gdy metadata są
    // kompletne: pojedyncze metadata.order_id nie może ucinać batcha multi-seller.
    let resolution: PaymentIntentLinkResolution
    let resolvedFromLink = false
    try {
      resolution = await resolvePaymentIntentLink(handle.client, {
        payment_intent_id: paymentIntentId,
        order_id: identifiers.order_id,
        market_id: identifiers.market_id,
        session_id: identifiers.session_id,
      })
    } catch (err) {
      logger.error?.(
        `[stripe/payment-intent] rozwiązanie powiązania nieudane dla ` +
          `${paymentIntentId}: ${(err as Error).message}`
      )
      res.status(500).json({ type: "db_unavailable", reason: "link_query_failed" })
      return
    }
    resolvedFromLink = resolution.ok && resolution.orders.some(
      (order) => order.source.order_id === "payment_session_link"
    )

    if (!resolution.ok) {
      // `link_unresolved` jest stanem przejściowym: payment_intent.succeeded
      // może wyprzedzić `completeCart`. 4xx zatrzymuje retry Stripe i zostawia
      // opłacony voucher bez issuance. `link_ambiguous` oraz pozostałe klasy
      // są trwałe i pozostają 400, więc nie zacieramy rozróżnienia operatorowi.
      logger.warn?.(
        `[stripe/payment-intent] ${resolution.reason}: ${resolution.detail}`
      )
      res.status(resolution.reason === "link_unresolved" ? 503 : 400).json({
        type: "unresolved_link",
        reason: resolution.reason,
        detail: resolution.detail,
      })
      return
    }

    // ── krok 3: N kopert po jednej na zamówienie (ADR-166, NFR4) ──────────────
    let envelopes
    try {
      const occurredAt = new Date()
      envelopes = resolution.orders.map((order) =>
        buildPaymentIntentSucceededEnvelope(stripeEvent, occurredAt, {
          order_id: order.order_id,
          market_id: order.market_id,
        })
      )
    } catch (err) {
      const error = err as Error
      if (error instanceof StripeEventMappingError) {
        logger.warn?.(`[stripe/payment-intent] mapowanie odrzucone: ${error.message}`)
        res.status(400).json({ type: "invalid", reason: error.message })
        return
      }
      logger.error?.(`[stripe/payment-intent] envelope invalid: ${error.message}`)
      res.status(400).json({ type: "invalid_contract", reason: error.message })
      return
    }
    const marketId = resolution.orders[0].market_id
    const storedEnvelope =
      envelopes.length === 1
        ? envelopes[0]
        : {
            event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
            envelope_count: envelopes.length,
            envelopes,
          }

    // ── krok 4: idempotencja transportu ───────────────────────────────────────
    let reserved: boolean
    try {
      reserved = await reserveWebhookDelivery(handle.client, {
        event_id: deliveryEventId,
        market_id: marketId,
        envelope: storedEnvelope,
      })
    } catch (err) {
      logger.error?.(
        `[stripe/payment-intent] rezerwacja dostawy nieudana: ${(err as Error).message}`
      )
      res.status(500).json({ type: "db_unavailable", reason: "dedupe_insert_failed" })
      return
    }

    if (!reserved) {
      // Ta sama dostawa już przyjęta (np. `stripe events resend`). ACK bez emisji.
      // Druga warstwa (`event_processed` po payment_intent_id + order_id) i tak
      // nie dopuści drugiego kompletu voucherów, ale zatrzymanie tutaj oszczędza
      // cały przebieg.
      logger.info?.(
        `[stripe/payment-intent] dostawa ${deliveryEventId} już przyjęta — ACK bez emisji`
      )
      res.status(200).json({
        received: true,
        duplicate: true,
        reason: "delivery_already_processed",
      })
      return
    }

    // ── krok 5: EMIT — jedyny side-effect domenowy webhooka ───────────────────
    try {
      const eventBus = req.scope.resolve(Modules.EVENT_BUS) as EventBusLike
      for (const envelope of envelopes) {
        await eventBus.emit({ name: PAYMENT_INTENT_SUCCEEDED_EVENT, data: envelope })
      }
    } catch (err) {
      const error = err as Error
      // Kompensacja rezerwacji: bez niej nieudana emisja wyciszyłaby ponowienia
      // Stripe'a na zawsze — opłacony zakup bez vouchera, a transport raportujący
      // „przyjęte". Zwolnienie przywraca ponawialność.
      try {
        await releaseWebhookDelivery(handle.client, deliveryEventId)
      } catch (releaseErr) {
        logger.error?.(
          `[stripe/payment-intent] KOMPENSACJA rezerwacji ${deliveryEventId} ` +
            `nieudana: ${(releaseErr as Error).message} — ponowna dostawa zostanie ` +
            "zdeduplikowana mimo braku emisji; wymaga ręcznego usunięcia wiersza"
        )
      }
      logger.error?.(`[stripe/payment-intent] emit failed: ${error.message}`)
      res.status(500).json({ type: "emit_failed", reason: error.message })
      return
    }

    logger.info?.(
      `[stripe/payment-intent] emitted ${PAYMENT_INTENT_SUCCEEDED_EVENT} ` +
        `payment_intent=${paymentIntentId} envelopes=${envelopes.length} ` +
        `orders=${resolution.orders.map((order) => order.order_id).join(",")} ` +
        `market=${marketId}`
    )
    res.status(200).json({
      received: true,
      emitted: PAYMENT_INTENT_SUCCEEDED_EVENT,
      ...(envelopes.length > 1
        ? {
            emitted_count: envelopes.length,
            order_ids: resolution.orders.map((order) => order.order_id),
          }
        : {}),
    })

    // ── wariant A (uzupełnienie): stempel metadata PO odpowiedzi ──────────────
    // Best-effort i celowo PO `res` — kolejne zdarzenia tego PI poniosą fakty
    // wprost, ale awaria Stripe API nie może opóźnić ani wywrócić dostawy.
    if (resolvedFromLink && resolution.orders.length === 1) {
      const [order] = resolution.orders
      await stampPaymentIntentOrderFacts({
        payment_intent_id: paymentIntentId,
        order_id: order.order_id,
        market_id: order.market_id,
        logger,
      })
    }
  } finally {
    handle.release()
  }
}
