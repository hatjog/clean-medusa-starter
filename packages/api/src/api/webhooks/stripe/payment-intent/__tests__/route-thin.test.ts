/**
 * route-thin.test.ts — Story 3.3 AC1 (cienki webhook Path Y).
 *
 * Dowodzi: webhook (1) weryfikuje sygnaturę Stripe, (2) buduje+waliduje envelope
 * kontraktu Story 3.1 i EMITUJE go — i NIC WIĘCEJ: NIE tworzy entitlementu, NIE
 * woła service'ów domenowych, NIE dotyka DB (brak resolve PG). Niepoprawna
 * sygnatura ⇒ 400 + brak emit. (ADR-118, ADR-137 DEC pkt 2, NFR4.)
 */
import { describe, it, expect } from "@jest/globals"
import { createHmac } from "node:crypto"

import { POST } from "../route"
import { STRIPE_SIGNATURE_HEADER } from "../helpers"
import {
  buildPaymentIntentSucceededEnvelope,
  verifyStripeSignature,
  PAYMENT_INTENT_SUCCEEDED_EVENT,
  StripeEventMappingError,
} from "../../../../../lib/payment/stripe-payment-intent-event"
import { Modules } from "@medusajs/framework/utils"

const SECRET = "whsec_test_123"

function signedHeader(rawBody: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(Buffer.from(`${ts}.${rawBody}`)).digest("hex")
  return `t=${ts},v1=${sig}`
}

function stripePiEvent() {
  return {
    id: "evt_123",
    type: "payment_intent.succeeded",
    created: 1_780_000_000,
    data: {
      object: {
        id: "pi_3Pabc1234567890",
        amount: 24900,
        currency: "pln",
        created: 1_780_000_000,
        metadata: { order_id: "order_4421", market_id: "bonbeauty", instance_id: "gp-dev" },
      },
    },
  }
}

describe("Story 3.3 AC1 — verifyStripeSignature", () => {
  it("akceptuje poprawny podpis", () => {
    const raw = JSON.stringify(stripePiEvent())
    expect(verifyStripeSignature(Buffer.from(raw), signedHeader(raw), SECRET).ok).toBe(true)
  })
  it("odrzuca brak nagłówka / zły sekret / malformed", () => {
    const raw = "{}"
    expect(verifyStripeSignature(Buffer.from(raw), undefined, SECRET).ok).toBe(false)
    expect(verifyStripeSignature(Buffer.from(raw), signedHeader(raw, "inny"), SECRET).ok).toBe(false)
    expect(verifyStripeSignature(Buffer.from(raw), "garbage", SECRET).ok).toBe(false)
  })
  it("odrzuca timestamp poza tolerancją (replay guard)", () => {
    const raw = "{}"
    const old = Math.floor(Date.now() / 1000) - 10_000
    const result = verifyStripeSignature(Buffer.from(raw), signedHeader(raw, SECRET, old), SECRET)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("timestamp_out_of_tolerance")
  })
})

describe("Story 3.3 AC1 — buildPaymentIntentSucceededEnvelope (kontrakt 3.1, NFR4)", () => {
  it("buduje poprawny envelope.v1 zgodny z kontraktem", () => {
    const env = buildPaymentIntentSucceededEnvelope(stripePiEvent(), new Date("2026-06-02T10:15:30Z"))
    expect(env.event_type).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
    expect(env.schema_version).toBe("1")
    expect(env.payload.payment_intent_id).toBe("pi_3Pabc1234567890")
    expect(env.payload.order_id).toBe("order_4421")
    expect(env.payload.currency).toBe("PLN")
    expect(env.payload.amount_minor).toBe(24900)
    expect(env.scope.market_id).toBe("bonbeauty")
    expect(env.causation_id).toBe("stripe:webhook:evt_123")
  })
  it("rzuca StripeEventMappingError przy braku order_id/market_id/currency", () => {
    const noOrder = stripePiEvent()
    delete (noOrder.data.object.metadata as Record<string, unknown>).order_id
    expect(() => buildPaymentIntentSucceededEnvelope(noOrder)).toThrow(StripeEventMappingError)
  })
  it("rzuca na nieobsługiwany typ eventu", () => {
    const wrong = { ...stripePiEvent(), type: "payment_intent.payment_failed" }
    expect(() => buildPaymentIntentSucceededEnvelope(wrong)).toThrow(/nieobsługiwany typ/)
  })
})

type FakeRes = {
  statusCode: number
  body: unknown
  status: (c: number) => FakeRes
  json: (b: unknown) => void
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
    },
  }
  return res
}

function makeReq(rawBody: string, sigHeader: string | undefined) {
  const emitted: { name: string; data: unknown }[] = []
  const resolved: string[] = []
  const req = {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: sigHeader ? { [STRIPE_SIGNATURE_HEADER]: sigHeader } : {},
    scope: {
      resolve: (key: string) => {
        resolved.push(key)
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === Modules.EVENT_BUS) {
          return { emit: async (e: { name: string; data: unknown }) => emitted.push(e) }
        }
        throw new Error(`unresolved ${key}`)
      },
    },
  }
  return { req, emitted, resolved }
}

describe("Story 3.3 AC1 — POST route cienki (verify + emit, ZERO biznes-logiki)", () => {
  it("poprawna sygnatura ⇒ 200 + emit eventu kontraktu 3.1, BEZ resolve PG", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    const raw = JSON.stringify(stripePiEvent())
    const { req, emitted, resolved } = makeReq(raw, signedHeader(raw))
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, res as any)
    expect(res.statusCode).toBe(200)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
    // ZERO biznes-logiki: webhook NIE resolve'uje PG/connection/service domenowego
    expect(resolved).not.toContain("__pg_pool__")
    expect(resolved.some((k) => /pg|connection|entitlement|voucher/i.test(k))).toBe(false)
  })

  it("niepoprawna sygnatura ⇒ 400 + BRAK emit", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    const raw = JSON.stringify(stripePiEvent())
    const { req, emitted } = makeReq(raw, signedHeader(raw, "zly_sekret"))
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, res as any)
    expect(res.statusCode).toBe(400)
    expect(emitted).toHaveLength(0)
  })

  it("inny typ eventu (poprawna sygnatura) ⇒ 200 ACK bez emit", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    const raw = JSON.stringify({ ...stripePiEvent(), type: "payment_intent.created" })
    const { req, emitted } = makeReq(raw, signedHeader(raw))
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, res as any)
    expect(res.statusCode).toBe(200)
    expect(emitted).toHaveLength(0)
  })

  it("brak rawBody ⇒ 400 (fail-closed, NIE re-serializacja)", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    const { req, emitted } = makeReq("{}", signedHeader("{}"))
    // usuń rawBody
    ;(req as { rawBody?: unknown }).rawBody = undefined
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, res as any)
    expect(res.statusCode).toBe(400)
    expect(emitted).toHaveLength(0)
  })
})
