/**
 * Story 8.3 AC1 (T2): "czy pobrano" z odczytu PSP po stronie backendu.
 * Błąd odczytu ⇒ `unknown`, nigdy domyślnie `not_charged`.
 */
import { describe, it, expect } from "@jest/globals"

import { handlePaymentChargeRead } from "../../../api/store/carts/[id]/payment-charge/route"
import { classifyPaymentCharge, inFlightPaymentIntentIds } from "../payment-charge-fact"

describe("Story 8.3 — classifyPaymentCharge", () => {
  it.each([
    [["succeeded"], "charged"],
    [["requires_capture"], "charged"],
    [["succeeded", "requires_capture"], "charged"],
    [["requires_payment_method"], "not_charged"],
    [["requires_action"], "not_charged"],
    [["canceled", "requires_confirmation"], "not_charged"],
    [["processing"], "unknown"],
    [["succeeded", "requires_action"], "unknown"],
    [["some_future_status"], "unknown"],
    [[], "unknown"],
  ])("%j ⇒ %s", (statuses, charge) => {
    expect(classifyPaymentCharge(statuses as string[]).charge).toBe(charge)
  })

  it("awaria odczytu PSP (null) ⇒ unknown/psp_status_unavailable, nie not_charged", () => {
    expect(classifyPaymentCharge(null)).toEqual({ charge: "unknown", reason: "psp_status_unavailable" })
  })

  it("inFlightPaymentIntentIds obejmuje processing i stany obciążone", () => {
    expect(
      inFlightPaymentIntentIds(["pi_a", "pi_b", "pi_c", "pi_d"], ["succeeded", "processing", "requires_action", "requires_capture"])
    ).toEqual(["pi_a", "pi_b", "pi_d"])
  })
})

function res() {
  const r: { statusCode: number; body: Record<string, unknown> | null; status: (c: number) => typeof r; json: (b: Record<string, unknown>) => typeof r } = {
    statusCode: 200,
    body: null,
    status: c => ((r.statusCode = c), r),
    json: b => ((r.body = b), r),
  }
  return r
}

describe("Story 8.3 — GET /store/carts/:id/payment-charge", () => {
  const rows = (intents: string[], order = false) => async (_s: unknown, sql: string) =>
    sql.includes("order_cart") ? (order ? [{ "?column?": 1 }] : []) : intents.map(payment_intent_id => ({ payment_intent_id }))

  it("PSP succeeded ⇒ charged, z identyfikatorem intencji", async () => {
    const r = res()
    await handlePaymentChargeRead({ params: { id: "cart_1" }, scope: {} } as never, r as never, {
      readQuery: rows(["pi_1"]),
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    expect(r.statusCode).toBe(200)
    expect(r.body).toMatchObject({ charge: "charged", payment_intent_ids: ["pi_1"], order_exists: false })
  })

  it("awaria Stripe ⇒ 200 charge=unknown (nazwany powód), nie not_charged", async () => {
    const r = res()
    await handlePaymentChargeRead({ params: { id: "cart_1" }, scope: {} } as never, r as never, {
      readQuery: rows(["pi_1"]),
      retrievePaymentIntentStatus: async () => {
        throw new Error("down")
      },
    })
    expect(r.body).toMatchObject({ charge: "unknown", reason: "psp_status_unavailable" })
  })

  it("awaria odczytu DB ⇒ 503 charge=unknown", async () => {
    const r = res()
    await handlePaymentChargeRead({ params: { id: "cart_1" }, scope: {} } as never, r as never, {
      readQuery: async () => {
        throw new Error("pg down")
      },
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    expect(r.statusCode).toBe(503)
    expect(r.body).toMatchObject({ charge: "unknown", code: "charge_read_failed" })
  })

  it("identyfikator spoza dziedziny ⇒ 400", async () => {
    const r = res()
    await handlePaymentChargeRead({ params: { id: "order_1" }, scope: {} } as never, r as never, {
      readQuery: rows([]),
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    expect(r.statusCode).toBe(400)
  })
})
