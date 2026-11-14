/**
 * story-4-4-route-trace-wiring.test.ts — v1.16.0 Story 4.4 (R-3/R-4).
 *
 * Wpięcie zapisu rekordu `deferred_issuance_trace` w REALNY `POST` route'u
 * webhooka Path Y. Podstawiony jest wyłącznie silnik SQL (fixture) i funkcja
 * zapisu rekordu (szpieg) — bramka `link_unresolved && retryableLinkRace`
 * jest kodem produkcyjnym. Usunięcie wywołania z route'u czerwieni ten test.
 */
import { describe, it, expect, beforeEach } from "@jest/globals"
import { createHmac } from "node:crypto"

jest.mock("../../../../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))
jest.mock("../../../../../lib/recovery/deferred-issuance-trace-runtime", () => ({
  recordWebhookDeferredIssuanceTrace: jest.fn(async () => ({
    ok: true,
    created: true,
    market_id: "bonbeauty",
    trace_id: "x",
  })),
}))

import { LINK_UNRESOLVED_RETRY_WINDOW_SECONDS, POST } from "../route"
import { STRIPE_SIGNATURE_HEADER } from "../helpers"
import {
  RESOLVE_ORDER_BY_PAYMENT_LINK_SQL,
  RESOLVE_ORDER_MARKET_CONTEXT_SQL,
} from "../../../../../lib/payment/stripe-payment-intent-link"
import { recordWebhookDeferredIssuanceTrace } from "../../../../../lib/recovery/deferred-issuance-trace-runtime"
import { Modules } from "@medusajs/framework/utils"

process.env.GP_INSTANCE_ID = "gp-test"
const SECRET = "whsec_test_4_4"
const EVENT_ID = "evt_4_4_route_wiring"
const PAYMENT_INTENT_ID = "pi_4_4_route_wiring"
const SESSION_ID = "payses_4_4_route_wiring"

const recordSpy = recordWebhookDeferredIssuanceTrace as unknown as jest.Mock

function makePg(link: { orderIds: string[]; markets?: Record<string, string> }) {
  return {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      if (sql === RESOLVE_ORDER_BY_PAYMENT_LINK_SQL) {
        return { rows: link.orderIds.map((order_id) => ({ order_id })), rowCount: link.orderIds.length }
      }
      if (sql === RESOLVE_ORDER_MARKET_CONTEXT_SQL) {
        const id = String(values[0])
        return {
          rows: [
            {
              order_id: id,
              order_metadata: null,
              sales_channel_id: `sc_${id}`,
              sales_channel_market_id: link.markets?.[id] ?? "bonbeauty",
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
}

function event(createdOffsetSeconds = 0) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: EVENT_ID,
    type: "payment_intent.succeeded",
    created: now - createdOffsetSeconds,
    data: {
      object: {
        id: PAYMENT_INTENT_ID,
        amount: 25000,
        amount_received: 25000,
        currency: "pln",
        created: now,
        metadata: { session_id: SESSION_ID },
      },
    },
  }
}

async function post(evt: unknown, pg: ReturnType<typeof makePg>) {
  const raw = JSON.stringify(evt)
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac("sha256", SECRET).update(Buffer.from(`${ts}.${raw}`)).digest("hex")
  const req = {
    rawBody: Buffer.from(raw, "utf8"),
    headers: { [STRIPE_SIGNATURE_HEADER]: `t=${ts},v1=${sig}` },
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "__pg_pool__") return { connect: async () => pg }
        if (key === Modules.EVENT_BUS) return { emit: async () => undefined }
        throw new Error(`unresolved ${key}`)
      },
    },
  }
  const res = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = (body ?? {}) as Record<string, unknown>
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await POST(req as any, res as any)
  return res
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  recordSpy.mockClear()
})

describe("Story 4.4 R-3/R-4 — route webhooka zapisuje rekord śladu przy wyścigu linku", () => {
  it("link_unresolved w oknie ⇒ 503 i DOKŁADNIE jeden zapis rekordu z deliveryEventId", async () => {
    const res = await post(event(), makePg({ orderIds: [] }))
    expect(res.statusCode).toBe(503)
    expect(res.body.reason).toBe("link_unresolved")
    expect(recordSpy).toHaveBeenCalledTimes(1)
    const [, , , input] = recordSpy.mock.calls[0] as [unknown, unknown, unknown, Record<string, unknown>]
    expect(input).toMatchObject({
      stripe_event_id: EVENT_ID,
      payment_intent_id: PAYMENT_INTENT_ID,
      instance_id: "gp-test",
      session_id: SESSION_ID,
      metadata_market_id: null,
    })
    expect(typeof input.read_psp_occurred_at).toBe("function")
  })

  it("link_unresolved POZA oknem ⇒ 400 i zero zapisów rekordu", async () => {
    const res = await post(event(LINK_UNRESOLVED_RETRY_WINDOW_SECONDS + 5), makePg({ orderIds: [] }))
    expect(res.statusCode).toBe(400)
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it("link_ambiguous ⇒ 400 i zero zapisów rekordu", async () => {
    const res = await post(
      event(),
      makePg({ orderIds: ["order_a", "order_b"], markets: { order_a: "bonbeauty", order_b: "inny" } })
    )
    expect(res.body.reason).toBe("link_ambiguous")
    expect(res.statusCode).toBe(400)
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it("link rozwiązany ⇒ zero zapisów rekordu (rekord tylko dla śladu bez zamówienia)", async () => {
    const res = await post(event(), makePg({ orderIds: ["order_a"] }))
    // Fixture nie odwzorowuje rezerwacji transportu — status dalszych kroków
    // nie jest tu mierzony; mierzone jest wyłącznie: link rozwiązany ⇒ brak rekordu.
    expect(res.body.type).not.toBe("unresolved_link")
    expect(recordSpy).not.toHaveBeenCalled()
  })
})
