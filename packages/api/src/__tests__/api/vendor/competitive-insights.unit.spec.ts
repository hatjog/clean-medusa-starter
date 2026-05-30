/**
 * Story v160-cleanup-38-jwt-vendor-scope — route unit tests
 * (refactored in Story 6.2 / F-14 to drive the REAL exported `GET` handler).
 *
 * Test cases (7 required cases):
 *   C1  — Missing seller_context → 401, no audit row, handler cannot proceed
 *   C2  — HMAC-only request without seller_context → 401, no audit row
 *   C3  — Valid seller_context (vendor A), no body vendor scope → 200 + audit row sent
 *   C4  — Valid seller_context (vendor A), body carries vendor_id = B → 403 cross_vendor_scope_mismatch + audit rejected
 *   C5  — Caller sets x-vendor-id: B AND uses vendor A's seller_context → 200 scoped to A (header IGNORED)
 *   C6  — Aggregator invoked with snapshots from real Mercur 2 query path (data_source = mercur_query)
 *   C7  — Cross-vendor scope check is the FIRST guard after auth (regression guard)
 *
 * Strategy: ALL cases invoke the real `GET` handler via `route.ts`.
 * `resolveInsightSnapshots` and `appendNotificationLog` are mocked via
 * `jest.mock`; the gp_core service (resolveVendorId) is provided through
 * the request scope. No parallel simulator is used (F-02 closed).
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals"

// ---------------------------------------------------------------------------
// Module mocks — must precede the route import.
// ---------------------------------------------------------------------------

jest.mock("../../../../src/lib/competitive-insights-source", () => ({
  resolveInsightSnapshots: jest.fn(),
}))
jest.mock("../../../../src/lib/vendor-notification-log", () => ({
  appendNotificationLog: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GET } = require("../../../../src/api/vendor/competitive-insights/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  resolveInsightSnapshots: mockResolveSnapshots,
} = require("../../../../src/lib/competitive-insights-source") as {
  resolveInsightSnapshots: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  appendNotificationLog: mockAppendLog,
} = require("../../../../src/lib/vendor-notification-log") as {
  appendNotificationLog: jest.Mock
}

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------

type CapturedResponse = {
  statusCode: number
  body: unknown
}

function createScope(opts?: {
  sellerIdToVendorId?: Record<string, string>
}) {
  const map = opts?.sellerIdToVendorId ?? { seller_A: "vendor_A" }
  return {
    resolve: (key: string) => {
      if (key === "gp_core") {
        return {
          resolveVendorId: async (sellerId: string) => {
            const vendorId = map[sellerId]
            if (!vendorId) {
              throw new Error(`unknown seller_id ${sellerId}`)
            }
            return vendorId
          },
        }
      }
      if (key === "logger") return console
      return undefined
    },
  }
}

function createRequest(opts: {
  sellerId?: string
  bodyVendorId?: string
  queryVendorId?: string
  extraHeaders?: Record<string, string>
  hmacSignature?: string
}) {
  const headers: Record<string, string> = {
    authorization: "Bearer seller.jwt",
    "x-publishable-api-key": "pk_test",
    ...(opts.extraHeaders ?? {}),
  }
  if (opts.hmacSignature) {
    headers["x-vendor-signature"] = opts.hmacSignature
  }
  return {
    headers,
    seller_context: opts.sellerId ? { seller_id: opts.sellerId } : undefined,
    body: opts.bodyVendorId ? { vendor_id: opts.bodyVendorId } : undefined,
    query: opts.queryVendorId ? { vendor_id: opts.queryVendorId } : {},
    scope: createScope(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function createResponseCapture(): { res: unknown; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined }
  const res = {
    status(code: number) {
      captured.statusCode = code
      return this
    },
    json(body: unknown) {
      captured.body = body
      return this
    },
  }
  return { res, captured }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SNAPSHOT_VENDOR_A_CAT1 = {
  vendor_id: "vendor_A",
  category_id: "cat_1",
  category_name: "Skincare",
  price: 10000,
}
const SNAPSHOT_VENDOR_B_CAT1 = {
  vendor_id: "vendor_B",
  category_id: "cat_1",
  category_name: "Skincare",
  price: 12000,
}

// ---------------------------------------------------------------------------
// Tests — every case drives the real GET handler.
// ---------------------------------------------------------------------------

describe("GET /vendor/competitive-insights — real route handler", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAppendLog.mockImplementation(async (_scope, input) => ({
      id: "audit-row",
      ...(input as Record<string, unknown>),
    }))
    mockResolveSnapshots.mockResolvedValue({
      snapshots: [SNAPSHOT_VENDOR_A_CAT1, SNAPSHOT_VENDOR_B_CAT1],
      data_source: "mercur_query",
    } as never)
  })

  // C1 — Missing seller_context → 401, no audit row.
  it("C1: missing seller_context → 401, no audit row written", async () => {
    const req = createRequest({})
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(401)
    expect(mockAppendLog).not.toHaveBeenCalled()
  })

  // C2 — HMAC-only request remains rejected because this route is JWT/seller-context only.
  it("C2: HMAC-only request without seller_context → 401, no audit row written", async () => {
    const req = createRequest({ hmacSignature: "v1:legacy-hmac-material" })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(401)
    expect(mockAppendLog).not.toHaveBeenCalled()
  })

  // C3 — Valid seller_context, no body/query vendor scope → 200 + audit row sent
  it("C3: valid seller_context, no body scope → 200, audit row status=sent", async () => {
    const req = createRequest({ sellerId: "seller_A" })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(200)
    const body = captured.body as Record<string, unknown>
    expect(body["vendor_id"]).toBe("vendor_A")
    expect(Array.isArray(body["categories"])).toBe(true)
    expect(body["data_source"]).toBe("mercur_query")

    expect(mockAppendLog).toHaveBeenCalledTimes(1)
    const auditRow = mockAppendLog.mock.calls[0]?.[1] as Record<string, unknown>
    expect(auditRow["status"]).toBe("sent")
    expect(auditRow["notification_type"]).toBe("competitive_insights_query")
    expect(auditRow["vendor_id"]).toBe("vendor_A")
    const metadata = auditRow["metadata"] as Record<string, unknown>
    expect(typeof metadata["category_count"]).toBe("number")
  })

  // C4 — Valid token (vendor A), body vendor_id = B → 403 + audit rejected
  it("C4: token=vendor_A, body vendor_id=vendor_B → 403 cross_vendor_scope_mismatch", async () => {
    const req = createRequest({ sellerId: "seller_A", bodyVendorId: "vendor_B" })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(403)
    expect((captured.body as Record<string, unknown>)["code"]).toBe(
      "cross_vendor_scope_mismatch",
    )

    expect(mockAppendLog).toHaveBeenCalledTimes(1)
    const auditRow = mockAppendLog.mock.calls[0]?.[1] as Record<string, unknown>
    expect(auditRow["status"]).toBe("rejected")
    expect(auditRow["error_message"]).toBe("cross_vendor_scope_mismatch")
    expect(auditRow["vendor_id"]).toBe("vendor_A")
    const metadata = auditRow["metadata"] as Record<string, unknown>
    expect(metadata["requested_vendor_id"]).toBe("vendor_B")
  })

  // C5 — x-vendor-id: B header + vendor A seller_context → 200 scoped to A (header IGNORED).
  // The real route handler never reads x-vendor-id.
  it("C5: x-vendor-id:vendor_B header with seller_A context → 200 scoped to vendor_A (header ignored)", async () => {
    const req = createRequest({
      sellerId: "seller_A",
      extraHeaders: { "x-vendor-id": "vendor_B" },
    })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(200)
    const body = captured.body as Record<string, unknown>
    expect(body["vendor_id"]).toBe("vendor_A")
    expect(body["data_source"]).toBe("mercur_query")
  })

  // C6 — AC3 path A: aggregator invoked with snapshots from mercur_query path;
  // response carries data_source: "mercur_query", non-empty categories when
  // multi-vendor overlap is present.
  it("C6: mercur_query path — non-empty categories when multi-vendor overlap present", async () => {
    mockResolveSnapshots.mockResolvedValueOnce({
      snapshots: [SNAPSHOT_VENDOR_A_CAT1, SNAPSHOT_VENDOR_B_CAT1],
      data_source: "mercur_query",
    } as never)
    const req = createRequest({ sellerId: "seller_A" })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(200)
    const body = captured.body as Record<string, unknown>
    expect(body["data_source"]).toBe("mercur_query")

    const categories = body["categories"] as Array<Record<string, unknown>>
    expect(categories.length).toBeGreaterThan(0)
    const cat = categories[0]
    expect(cat["category_id"]).toBe("cat_1")
    expect(typeof cat["market_avg_price"]).toBe("number")
    expect(typeof cat["vendor_avg_price"]).toBe("number")
    expect(cat["percentile"]).not.toBeNull()
  })

  // C7 — Cross-vendor scope check is FIRST guard after auth (regression guard).
  // Even when resolveInsightSnapshots would succeed, the 403 must be returned
  // BEFORE the aggregator is invoked — no timing side-channel, no data leak.
  it("C7: cross-vendor scope check runs BEFORE aggregator (no data leak timing)", async () => {
    const callOrder: string[] = []
    mockAppendLog.mockImplementationOnce(async (_scope, input) => {
      const typed = input as Record<string, unknown>
      callOrder.push(`audit:${typed["status"]}`)
      return { id: "audit-row", ...typed }
    })
    mockResolveSnapshots.mockImplementationOnce(async () => {
      callOrder.push("resolveSnapshots")
      return { snapshots: [], data_source: "mercur_query" }
    })

    const req = createRequest({ sellerId: "seller_A", bodyVendorId: "vendor_B" })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(403)
    expect(callOrder).toContain("audit:rejected")
    expect(callOrder).not.toContain("resolveSnapshots")
  })
})

// ---------------------------------------------------------------------------
// AC5 contract: 401 outcomes are NOT logged via vendor channel
// ---------------------------------------------------------------------------

describe("AC5 contract: 401 outcomes never produce audit rows", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("401 path produces no audit row (missing seller_context simulates auth failure)", async () => {
    const req = createRequest({})
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(401)
    expect(mockAppendLog).not.toHaveBeenCalled()
  })
})
