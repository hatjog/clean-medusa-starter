/**
 * Story 6.2 browser-shape guard for /vendor/competitive-insights.
 *
 * Drives the REAL exported `GET` handler from
 * `src/api/vendor/competitive-insights/route.ts` with a request object
 * shaped like the browser bearer-token flow (Mercur
 * `ensureSellerMiddleware` already populated `seller_context`). This
 * closes the F-14 anti-regression gate: any drift in route auth, scope
 * guard, snapshot source, aggregation, or audit envelope is caught here
 * — no parallel simulator copy.
 *
 * Mocked dependencies (closest to the real handler):
 *   - `../../../lib/competitive-insights-source.resolveInsightSnapshots`
 *   - `../../../lib/vendor-notification-log.appendNotificationLog`
 * The aggregator (`competitive-insights-aggregator`) runs unmocked
 * because it is pure computation.
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
  resolveInsightSnapshots: mockResolveInsightSnapshots,
} = require("../../../../src/lib/competitive-insights-source") as {
  resolveInsightSnapshots: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  appendNotificationLog: mockAppendNotificationLog,
} = require("../../../../src/lib/vendor-notification-log") as {
  appendNotificationLog: jest.Mock
}

// ---------------------------------------------------------------------------
// Request / response builders mirroring Mercur browser bearer transport.
// ---------------------------------------------------------------------------

type CapturedResponse = {
  statusCode: number
  body: unknown
}

function createGpCoreScope() {
  return {
    resolve: (key: string) => {
      if (key === "gp_core") {
        return {
          resolveVendorId: async (sellerId: string) => {
            expect(sellerId).toBe("sel_browser_1")
            return "ven_browser_1"
          },
        }
      }
      if (key === "logger") return console
      return undefined
    },
  }
}

function createBrowserRequest(options?: {
  bodyVendorId?: string
  noSeller?: boolean
}) {
  const sellerId = options?.noSeller ? undefined : "sel_browser_1"
  return {
    headers: {
      authorization: "Bearer seller-session.jwt",
      "x-publishable-api-key": "pk_test",
      "x-seller-id": "sel_browser_1",
    },
    seller_context: sellerId ? { seller_id: sellerId } : undefined,
    auth_context: { actor_id: "member_browser_1" },
    body: options?.bodyVendorId ? { vendor_id: options.bodyVendorId } : undefined,
    query: {},
    scope: createGpCoreScope(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function createResponseCapture(): { res: unknown; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined }
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
// Tests — drive the real GET handler.
// ---------------------------------------------------------------------------

describe("GET /vendor/competitive-insights — browser JWT bearer shape (real route)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAppendNotificationLog.mockImplementation(async (_scope, input) => ({
      id: "audit_1",
      ...(input as Record<string, unknown>),
    }))
    mockResolveInsightSnapshots.mockResolvedValue({
      data_source: "mercur_query",
      snapshots: [
        {
          vendor_id: "ven_browser_1",
          category_id: "cat_skin",
          category_name: "Skin",
          price: 10000,
        },
        {
          vendor_id: "ven_other",
          category_id: "cat_skin",
          category_name: "Skin",
          price: 12000,
        },
      ],
    } as never)
  })

  it("accepts bearer + publishable key + x-seller-id without x-vendor-signature", async () => {
    const req = createBrowserRequest()
    const { res, captured } = createResponseCapture()
    captured.statusCode = 200 // default for res.json() without explicit status

    await GET(req, res)

    expect(req.headers["x-vendor-signature"]).toBeUndefined()
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toMatchObject({
      vendor_id: "ven_browser_1",
      data_source: "mercur_query",
    })
    expect(
      Array.isArray((captured.body as { categories?: unknown[] }).categories),
    ).toBe(true)
    expect(
      (captured.body as { categories: unknown[] }).categories.length,
    ).toBeGreaterThan(0)
    expect(mockResolveInsightSnapshots).toHaveBeenCalledWith(req.scope, [
      "sel_browser_1",
    ])
    const auditCall = mockAppendNotificationLog.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined
    expect(auditCall).toMatchObject({
      vendor_id: "ven_browser_1",
      notification_type: "competitive_insights_query",
      status: "sent",
    })
  })

  it("rejects cross-vendor body scope before querying snapshots and writes rejected audit", async () => {
    const req = createBrowserRequest({ bodyVendorId: "ven_other" })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(403)
    expect(captured.body).toMatchObject({ code: "cross_vendor_scope_mismatch" })
    expect(mockResolveInsightSnapshots).not.toHaveBeenCalled()
    const auditCall = mockAppendNotificationLog.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined
    expect(auditCall).toMatchObject({
      vendor_id: "ven_browser_1",
      status: "rejected",
      error_message: "cross_vendor_scope_mismatch",
      metadata: { requested_vendor_id: "ven_other" },
    })
  })

  it("returns 401 when seller_context is missing (Mercur middleware did not populate it)", async () => {
    const req = createBrowserRequest({ noSeller: true })
    const { res, captured } = createResponseCapture()

    await GET(req, res)

    expect(captured.statusCode).toBe(401)
    expect(mockResolveInsightSnapshots).not.toHaveBeenCalled()
    expect(mockAppendNotificationLog).not.toHaveBeenCalled()
  })
})
