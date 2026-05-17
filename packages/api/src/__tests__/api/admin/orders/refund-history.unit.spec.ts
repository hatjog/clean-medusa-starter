// AC4: admin panel order detail — refund history API route unit tests
import { GET } from "../../../../api/admin/orders/[id]/refund-history/route"

type FakeRow = {
  event_id: string
  refund_id: string | null
  refund_amount: number | null
  refund_reason: string | null
  currency: string | null
  received_at: string
  payment_intent_id: string | null
}

function buildFakeDeps(rows: FakeRow[]) {
  const db = {
    raw: jest.fn().mockResolvedValue({ rows }),
  }
  const scope = {
    resolve: jest.fn().mockReturnValue(db),
  }
  return { db, scope }
}

// C6 regression: the route MUST source currency from the audit envelope
// (real currency code), NOT from `wep.market_id` (a market id like
// "bonbeauty" → wrong currency / RangeError in the widget).
describe("refund-history SQL — currency from envelope, not market_id (C6)", () => {
  it("selects envelope->>'currency' and never aliases market_id AS currency", async () => {
    const { db, scope } = buildFakeDeps([])
    await GET(buildReq("ord_1", scope) as never, buildRes() as never)
    const sql = String(db.raw.mock.calls[0][0])
    expect(sql).toContain("envelope->>'currency'")
    expect(sql).not.toMatch(/market_id\s+AS\s+currency/i)
  })
})

function buildReq(orderId: string, scope: object) {
  return {
    params: { id: orderId },
    scope,
  }
}

function buildRes() {
  const state = { body: null as unknown }
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockImplementation((body: unknown) => {
      state.body = body
    }),
    getBody: () => state.body,
  }
  return res
}

describe("GET /admin/gp/orders/:id/refund-history (AC4)", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns empty refunds array when no refunds exist", async () => {
    const { scope } = buildFakeDeps([])
    const req = buildReq("ord_1", scope)
    const res = buildRes()

    await GET(req as never, res as never)

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: "ord_1", refunds: [] })
    )
  })

  it("maps DB rows to refund entries with all fields (single refund)", async () => {
    const row: FakeRow = {
      event_id: "evt_ref_1",
      refund_id: "re_abc123",
      refund_amount: 9900,
      refund_reason: "customer_request",
      currency: "PLN",
      received_at: "2026-05-17T10:00:00Z",
      payment_intent_id: "pi_test_1",
    }
    const { scope } = buildFakeDeps([row])
    const req = buildReq("ord_1", scope)
    const res = buildRes()

    await GET(req as never, res as never)

    const body = res.getBody() as { refunds: FakeRow[] }
    expect(body.refunds).toHaveLength(1)
    expect(body.refunds[0]).toMatchObject({
      event_id: "evt_ref_1",
      refund_id: "re_abc123",
      refund_amount: 9900,
      refund_reason: "customer_request",
      currency: "PLN",
      payment_intent_id: "pi_test_1",
    })
  })

  it("returns multiple refund entries in order for partial refunds", async () => {
    const rows: FakeRow[] = [
      {
        event_id: "evt_partial_1",
        refund_id: "re_p1",
        refund_amount: 5000,
        refund_reason: "partial_refund",
        currency: "PLN",
        received_at: "2026-05-17T10:00:00Z",
        payment_intent_id: "pi_1",
      },
      {
        event_id: "evt_partial_2",
        refund_id: "re_p2",
        refund_amount: 4900,
        refund_reason: "customer_request",
        currency: "PLN",
        received_at: "2026-05-17T11:00:00Z",
        payment_intent_id: "pi_1",
      },
    ]
    const { scope } = buildFakeDeps(rows)
    const req = buildReq("ord_1", scope)
    const res = buildRes()

    await GET(req as never, res as never)

    const body = res.getBody() as { refunds: FakeRow[] }
    expect(body.refunds).toHaveLength(2)
    expect(body.refunds[0].event_id).toBe("evt_partial_1")
    expect(body.refunds[1].event_id).toBe("evt_partial_2")
  })

  it("defaults refund_reason to 'unspecified' when null in DB row", async () => {
    const row: FakeRow = {
      event_id: "evt_no_reason",
      refund_id: null,
      refund_amount: 9900,
      refund_reason: null,
      currency: null,
      received_at: "2026-05-17T10:00:00Z",
      payment_intent_id: null,
    }
    const { scope } = buildFakeDeps([row])
    const req = buildReq("ord_2", scope)
    const res = buildRes()

    await GET(req as never, res as never)

    const body = res.getBody() as { refunds: FakeRow[] }
    expect(body.refunds[0].refund_reason).toBe("unspecified")
  })
})
