/**
 * story-4-4-deferred-trace-closure-wiring.unit.spec.ts — v1.16.0 Story 4.4
 * (R-3/R-4, R-5).
 *
 * Wpięcie DOMKNIĘCIA rekordu `deferred_issuance_trace` w realne subscribery:
 *  - `on-order-placed-stripe-retry` (pętla markera, closure_path=order_placed_retry),
 *  - `voucher-live-issue` (ponowienie Stripe z rozwiązanym linkiem,
 *    closure_path=webhook_live_issue — R-5).
 * Asercje na SQL-u FAKTYCZNIE wysłanym (`CLOSE_DEFERRED_ISSUANCE_TRACE_SQL`
 * z bindingami), nie na tekście pliku. Usunięcie wywołania domknięcia
 * w którymkolwiek subscriberze czerwieni ten plik.
 */
process.env.GP_INSTANCE_ID = "gp-test"

import { Modules } from "@medusajs/framework/utils"

import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"
import {
  CLOSE_DEFERRED_ISSUANCE_TRACE_SQL,
  DEFERRED_ISSUANCE_TRACE_CLOSING_PATHS,
} from "../../lib/recovery/deferred-issuance-trace"

jest.mock("../../workflows/entitlements/issue-entitlement", () => {
  class MissingEntitlementProfileError extends Error {}
  class VoucherIssuanceBlockedError extends Error {
    reason = "test_blocked"
    line_item_id: string | null = null
  }
  return {
    __esModule: true,
    issueEntitlementsForAllLineItems: jest.fn(async () => ({ results: [{}] })),
    MissingEntitlementProfileError,
    VoucherIssuanceBlockedError,
  }
})

jest.mock("../../workflows/entitlements/live-issue-from-payment-intent", () => ({
  __esModule: true,
  liveIssueEntitlementsWithinTx: jest.fn(),
}))

import { liveIssueEntitlementsWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"
import onOrderPlacedStripeRetry, {
  FIND_DEFERRED_CAPTURES_SQL,
} from "../../subscribers/on-order-placed-stripe-retry"
import voucherLiveIssueSubscriber, {
  stripeEventIdFromCausation,
} from "../../subscribers/voucher-live-issue"

type SentQuery = { sql: string; values: unknown[] }

function makeHarness(options: { rows?: unknown[]; closeFails?: boolean } = {}) {
  const sent: SentQuery[] = []
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      sent.push({ sql, values })
      if (sql === FIND_DEFERRED_CAPTURES_SQL) {
        const rows = options.rows ?? []
        return { rows, rowCount: rows.length }
      }
      if (sql === CLOSE_DEFERRED_ISSUANCE_TRACE_SQL) {
        if (options.closeFails) throw new Error('relation "deferred_issuance_trace" does not exist')
        return { rows: [{ version: 2 }], rowCount: 1 }
      }
      if (sql.includes("SET state = 'ACTIVE'")) return { rows: [{ id: values[0] }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: jest.fn(),
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
  const container = {
    logger,
    resolve: (key: string) => {
      if (key === "__pg_pool__") return { connect: async () => client }
      if (key === "logger") return logger
      if (key === Modules.EVENT_BUS) return eventBus
      throw new Error(`unexpected resolve(${key})`)
    },
  }
  return { sent, client, logger, container }
}

const pathYRow = {
  event_id: "evt_4_4_sub#deferred-issuance",
  provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
  market_id: "bonbeauty",
  envelope: {
    entitlement_issue_deferred_reason: "webhook_before_order",
    psp_occurred_at: "2026-11-14T10:00:00.000Z",
  },
  amount: 25000,
  currency_code: "pln",
  payment_id: "pay_1",
  payment_intent_id: "pi_4_4_sub",
}

function closes(sent: SentQuery[]) {
  return sent.filter((q) => q.sql === CLOSE_DEFERRED_ISSUANCE_TRACE_SQL)
}

beforeEach(() => {
  ;(liveIssueEntitlementsWithinTx as jest.Mock).mockReset()
  ;(liveIssueEntitlementsWithinTx as jest.Mock).mockResolvedValue({ event_processed: true, issued: [] })
})

describe("Story 4.4 — domknięcie rekordu w on-order-placed-stripe-retry", () => {
  it("odzysk Path Y wysyła UPDATE domknięcia: trace_id = row.event_id, order_placed_retry, evidence, rynek+instancja", async () => {
    const h = makeHarness({ rows: [pathYRow] })
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: "order_1" } },
      container: h.container,
    })
    const sent = closes(h.sent)
    expect(sent).toHaveLength(1)
    const [traceId, path, evidence, orderId, marketId, instanceId] = sent[0].values
    expect(traceId).toBe("evt_4_4_sub#deferred-issuance")
    expect(path).toBe("order_placed_retry")
    expect(JSON.parse(String(evidence))).toMatchObject({
      resolver: "subscriber:on-order-placed-stripe-retry",
      payment_intent_id: "pi_4_4_sub",
      orders: ["order_1"],
    })
    expect(orderId).toBe("order_1")
    expect(marketId).toBe("bonbeauty")
    expect(instanceId).toBe("gp-test")
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("domkniety (issued_after_link"))
  })

  it("porażka domknięcia: wystawienie zachowane (ROLLBACK TO SAVEPOINT, COMMIT), linia warn", async () => {
    const h = makeHarness({ rows: [pathYRow], closeFails: true })
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: "order_1" } },
      container: h.container,
    })
    const sqls = h.sent.map((q) => q.sql.trim())
    expect(sqls).toContain("ROLLBACK TO SAVEPOINT deferred_issuance_trace_close")
    expect(sqls).toContain("COMMIT")
    expect(sqls).not.toContain("ROLLBACK")
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("domkniecie rekordu deferred_issuance_trace NIEUDANE (wystawienie zachowane)")
    )
  })

  it("marker natywny (provider stripe, bez sufiksu śladu) nie wysyła domknięcia", async () => {
    const h = makeHarness({ rows: [{ ...pathYRow, event_id: "evt_native", provider: "stripe" }] })
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: "order_1" } },
      container: h.container,
    })
    expect(closes(h.sent)).toHaveLength(0)
  })
})

describe("Story 4.4 R-5 — domknięcie rekordu w voucher-live-issue (ponowienie Stripe)", () => {
  const envelope = {
    event_type: "gp.stripe.payment_intent_succeeded.v1",
    causation_id: "stripe:webhook:evt_4_4_live",
    scope: { instance_id: "gp-test", market_id: "bonbeauty" },
    payload: {
      payment_intent_id: "pi_4_4_live",
      order_id: "order_live",
      currency: "PLN",
      amount_minor: 25000,
      psp_occurred_at: "2026-11-14T10:00:00.000Z",
    },
  }

  async function runLive(h: ReturnType<typeof makeHarness>, data: unknown) {
    await (voucherLiveIssueSubscriber as unknown as (a: unknown) => Promise<void>)({
      event: { name: "gp.stripe.payment_intent_succeeded.v1", data },
      container: h.container,
    })
  }

  it("wystawienie z rozwiązanego linku domyka rekord śladu tej dostawy (webhook_live_issue)", async () => {
    const h = makeHarness()
    await runLive(h, envelope)
    const sent = closes(h.sent)
    expect(sent).toHaveLength(1)
    const [traceId, path, evidence, orderId, marketId, instanceId] = sent[0].values
    expect(traceId).toBe("evt_4_4_live#deferred-issuance")
    expect(path).toBe("webhook_live_issue")
    expect(JSON.parse(String(evidence))).toMatchObject({
      resolver: "subscriber:voucher-live-issue",
      orders: ["order_live"],
    })
    expect([orderId, marketId, instanceId]).toEqual(["order_live", "bonbeauty", "gp-test"])
  })

  it("replay (event_processed=false) nie domyka; porażka domknięcia zostawia warn i nie rzuca", async () => {
    ;(liveIssueEntitlementsWithinTx as jest.Mock).mockResolvedValueOnce({ event_processed: false, issued: [] })
    const replay = makeHarness()
    await runLive(replay, envelope)
    expect(closes(replay.sent)).toHaveLength(0)

    const failing = makeHarness({ closeFails: true })
    await runLive(failing, envelope)
    expect(failing.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("domkniecie rekordu deferred_issuance_trace NIEUDANE")
    )
  })

  it("kontrakt ścieżek domykających + odczyt event.id z causation_id", () => {
    expect(DEFERRED_ISSUANCE_TRACE_CLOSING_PATHS).toEqual(["order_placed_retry", "webhook_live_issue"])
    expect(stripeEventIdFromCausation("stripe:webhook:evt_1")).toBe("evt_1")
    expect(stripeEventIdFromCausation("stripe:webhook:")).toBeNull()
    expect(stripeEventIdFromCausation("stripe:webhook:evt_1#deferred-issuance")).toBeNull()
    expect(stripeEventIdFromCausation("other:evt_1")).toBeNull()
    expect(stripeEventIdFromCausation(undefined)).toBeNull()
  })
})
