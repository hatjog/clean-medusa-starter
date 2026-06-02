/**
 * voucher-live-issue.test.ts — Story 3.3 AC2/AC4 (Path Y subscriber).
 *
 * Dowodzi: mapowanie envelope.v1 → wejście rdzenia (fail-loud na braki, NFR4),
 * orchestracja w jednej DB-tx (BEGIN/COMMIT), idempotencja end-to-end (replay
 * ⇒ no-op), config.event = kontrakt Story 3.1. Side-effecty issue żyją w rdzeniu;
 * tu sprawdzamy warstwę subscribera (tx + mapowanie + delegacja Path Y).
 */
import { describe, it, expect } from "@jest/globals"

import subscriber, {
  config,
  PAYMENT_INTENT_SUCCEEDED_EVENT,
  toLiveIssueInput,
} from "../voucher-live-issue"

describe("Story 3.3 — toLiveIssueInput (mapowanie envelope.v1, fail-loud NFR4)", () => {
  const envelope = {
    event_type: "gp.stripe.payment_intent_succeeded.v1",
    scope: { instance_id: "gp-dev", market_id: "bonbeauty" },
    payload: {
      payment_intent_id: "pi_1",
      order_id: "order_1",
      currency: "PLN",
      amount_minor: 1000,
      psp_occurred_at: "2026-06-02T10:15:28Z",
    },
  }

  it("mapuje kompletny envelope na wejście rdzenia (payload + scope + event_type)", () => {
    const input = toLiveIssueInput("gp.stripe.payment_intent_succeeded.v1", envelope)
    expect(input.payload.payment_intent_id).toBe("pi_1")
    expect(input.scope.market_id).toBe("bonbeauty")
    expect(input.event_type).toBe("gp.stripe.payment_intent_succeeded.v1")
  })

  it.each([
    ["payment_intent_id", { ...envelope, payload: { ...envelope.payload, payment_intent_id: "" } }],
    ["order_id", { ...envelope, payload: { ...envelope.payload, order_id: "" } }],
    ["currency", { ...envelope, payload: { ...envelope.payload, currency: "" } }],
    ["amount_minor", { ...envelope, payload: { ...envelope.payload, amount_minor: undefined } }],
    ["psp_occurred_at", { ...envelope, payload: { ...envelope.payload, psp_occurred_at: "" } }],
  ])("rzuca przy braku %s (kontrakt 3.1)", (field, bad) => {
    expect(() => toLiveIssueInput("e", bad as never)).toThrow(new RegExp(field))
  })

  it("config.event = kontrakt Story 3.1 (AR-EVENTS)", () => {
    expect(config.event).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
    expect(PAYMENT_INTENT_SUCCEEDED_EVENT).toBe("gp.stripe.payment_intent_succeeded.v1")
  })

  it("(M2) rzuca przy braku scope.market_id (fail-loud PRZED tx, nie poison-retry)", () => {
    const noMarket = { ...envelope, scope: { instance_id: "gp-dev" } }
    expect(() => toLiveIssueInput("e", noMarket as never)).toThrow(/scope\.market_id/)
  })

  it("(M2) rzuca przy pustym scope.market_id", () => {
    const blankMarket = { ...envelope, scope: { instance_id: "gp-dev", market_id: "  " } }
    expect(() => toLiveIssueInput("e", blankMarket as never)).toThrow(/scope\.market_id/)
  })
})

/** Fake pool/client z obsługą BEGIN/COMMIT + minimalnej semantyki ON CONFLICT. */
function makeFakeContainer() {
  const eventProcessed = new Set<string>()
  const entitlements = new Map<string, unknown>()
  const log: string[] = []

  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [], rowCount: 0 }
      if (/INSERT INTO event_processed/i.test(sql)) {
        const key = `${values[0]}|${values[1]}`
        if (eventProcessed.has(key)) return { rows: [], rowCount: 0 }
        eventProcessed.add(key)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM "order"/i.test(sql)) {
        return { rows: [{ sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } }], rowCount: 1 }
      }
      if (/FROM order_item/i.test(sql)) {
        return {
          rows: [
            {
              line_item_id: "li_1",
              metadata: {
                entitlement_profile_id: "p",
                entitlement_type: "VOUCHER_SERVICE",
                policy: { vat_rate_uniqueness: true },
              },
            },
          ],
          rowCount: 1,
        }
      }
      if (/INSERT INTO entitlement_instance/i.test(sql)) {
        const key = values[10] as string
        if (entitlements.has(key)) return { rows: [], rowCount: 0 }
        entitlements.set(key, values)
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }

  const pool = { connect: async () => client }
  const container = {
    resolve: (key: string) => {
      if (key === "__pg_pool__") return pool
      if (key === "logger") {
        return {
          info: (m: string) => log.push(`info:${m}`),
          warn: (m: string) => log.push(`warn:${m}`),
          error: (m: string) => log.push(`error:${m}`),
        }
      }
      throw new Error(`unresolved ${key}`)
    },
  }
  return { container, entitlements, log }
}

function envelopeEvent() {
  return {
    name: PAYMENT_INTENT_SUCCEEDED_EVENT,
    data: {
      event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
      scope: { instance_id: "gp-dev", market_id: "bonbeauty" },
      payload: {
        payment_intent_id: "pi_sub_1",
        order_id: "order_sub_1",
        currency: "PLN",
        amount_minor: 24900,
        psp_occurred_at: "2026-06-02T10:15:28Z",
      },
    },
  }
}

describe("Story 3.3 — subscriber orchestracja (tx + idempotencja end-to-end)", () => {
  it("przetwarza event ⇒ ISSUED (jeden entitlement), commit", async () => {
    const { container, entitlements } = makeFakeContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    expect(entitlements.size).toBe(1)
  })

  it("replay tego samego eventu ⇒ wciąż jeden entitlement (event-level no-op)", async () => {
    const { container, entitlements } = makeFakeContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    expect(entitlements.size).toBe(1)
  })

  it("envelope niekompletny ⇒ rzuca (fail-loud, Medusa retry/DLQ)", async () => {
    const { container } = makeFakeContainer()
    const bad = { name: PAYMENT_INTENT_SUCCEEDED_EVENT, data: { payload: { order_id: "o" } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(subscriber({ event: bad, container } as any)).rejects.toThrow()
  })
})
