/**
 * Story 3.3 (FR-6a, AD-16, ADR-190) — kontrakt budowniczego koperty na poziomie
 * jednostkowym: PIERWSZEŃSTWO wyniku rezolucji nad metadanymi oraz semantyka
 * `correlation_id`.
 *
 * Test integracyjny na realnym PG (`stripe-payment-intent-multi-order-pg`) dowodzi
 * skutku end-to-end; ten plik pilnuje samej reguły w miejscu, w którym mieszka —
 * żeby cofnięcie kolejności `??` pękało także bez podniesionej bazy.
 */
import { describe, expect, it } from "@jest/globals"

import { buildPaymentIntentSucceededEnvelope } from "../../../lib/payment/stripe-payment-intent-event"

const NOW = new Date("2026-06-02T10:15:30.000Z")

function event(metadata: Record<string, string>) {
  return {
    id: "evt_precedence",
    type: "payment_intent.succeeded",
    created: 1_780_395_328,
    data: {
      object: {
        id: "pi_precedence",
        amount: 42000,
        amount_received: 42000,
        currency: "pln",
        created: 1_780_395_328,
        metadata,
      },
    },
  }
}

describe("Story 3.3 — rezolucja linku ma pierwszeństwo nad metadanymi", () => {
  it("resolved.order_id WYGRYWA z metadata.order_id (inaczej N kopert dostaje ten sam klucz)", () => {
    const envelope = buildPaymentIntentSucceededEnvelope(
      event({ order_id: "order_a", market_id: "bonbeauty" }),
      NOW,
      { order_id: "order_b", market_id: "bonbeauty" }
    )
    expect(envelope.payload.order_id).toBe("order_b")
    expect(envelope.idempotency_key).toBe(
      "bonbeauty:pi_precedence:order_b:payment_intent_succeeded"
    )
  })

  it("resolved.market_id WYGRYWA z metadata.market_id", () => {
    const envelope = buildPaymentIntentSucceededEnvelope(
      event({ order_id: "order_a", market_id: "rynek_ze_stempla" }),
      NOW,
      { order_id: "order_a", market_id: "bonbeauty" }
    )
    expect(envelope.scope.market_id).toBe("bonbeauty")
  })

  it("metadata pozostają FALLBACKIEM, gdy wołający nie przekazał rezolucji", () => {
    const envelope = buildPaymentIntentSucceededEnvelope(
      event({ order_id: "order_a", market_id: "bonbeauty" }),
      NOW
    )
    expect(envelope.payload.order_id).toBe("order_a")
    expect(envelope.scope.market_id).toBe("bonbeauty")
  })

  it("dwie iteracje jednego zakupu dają RÓŻNE klucze idempotencji przy jednym stemplu metadata", () => {
    const stripeEvent = event({ order_id: "order_a", market_id: "bonbeauty" })
    const keys = ["order_a", "order_b"].map(
      (orderId) =>
        buildPaymentIntentSucceededEnvelope(stripeEvent, NOW, {
          order_id: orderId,
          market_id: "bonbeauty",
        }).idempotency_key
    )
    expect(new Set(keys).size).toBe(2)
  })

  it("correlation_id niesie payment_intent_id (AD-16), nie order_id", () => {
    const envelope = buildPaymentIntentSucceededEnvelope(
      event({ order_id: "order_a", market_id: "bonbeauty" }),
      NOW,
      { order_id: "order_b", market_id: "bonbeauty" }
    )
    expect(envelope.correlation_id).toBe("pi_precedence")
    expect(envelope.correlation_id).not.toBe(envelope.payload.order_id)
  })

  it("amount_minor każdej koperty to PEŁNA kwota PaymentIntenta (ADR-166 pkt 6)", () => {
    const stripeEvent = event({ market_id: "bonbeauty" })
    for (const orderId of ["order_a", "order_b"]) {
      const envelope = buildPaymentIntentSucceededEnvelope(stripeEvent, NOW, {
        order_id: orderId,
        market_id: "bonbeauty",
      })
      expect(envelope.payload.amount_minor).toBe(42000)
    }
  })
})
