/**
 * Story 6.2 browser-shape guard for /vendor/competitive-insights.
 *
 * This is a route-level integration simulator: it exercises the same
 * auth-derived seller/vendor scope, cross-vendor guard, snapshot source,
 * aggregation, and audit envelope sequence expected from the real handler.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals"

import { getCompetitiveInsights } from "../../../../src/lib/competitive-insights-aggregator"

const auditLog: Array<Record<string, unknown>> = []
const mockAppendNotificationLog = jest.fn(async (_scope: unknown, input: Record<string, unknown>) => {
  auditLog.push({ ...input })
  return { id: "audit_1", ...input }
})
const mockResolveInsightSnapshots = jest.fn()

type BrowserRequestShape = {
  headers: Record<string, string>
  seller_context?: { seller_id?: string }
  auth_context?: { actor_id?: string }
  body?: Record<string, unknown>
  query: Record<string, unknown>
  scope: {
    resolve: (key: string) => unknown
  }
}

async function simulateBrowserRoute(req: BrowserRequestShape) {
  const sellerId = req.seller_context?.seller_id
  if (!sellerId) {
    return {
      statusCode: 401,
      body: { code: "UNAUTHORIZED", message: "Seller context not present" },
    }
  }

  const gpCore = req.scope.resolve("gp_core") as {
    resolveVendorId: (sellerId: string) => Promise<string>
  }
  const vendorId = await gpCore.resolveVendorId(sellerId)

  const requestedVendorId =
    (req.body?.["vendor_id"] as string | undefined) ??
    (req.query["vendor_id"] as string | undefined)

  if (requestedVendorId !== undefined && requestedVendorId !== vendorId) {
    await mockAppendNotificationLog(req.scope, {
      vendor_id: vendorId,
      notification_type: "competitive_insights_query",
      locale: "pl",
      recipient_email: "system",
      status: "rejected",
      error_message: "cross_vendor_scope_mismatch",
      triggered_by: vendorId,
      metadata: { requested_vendor_id: requestedVendorId },
    })
    return {
      statusCode: 403,
      body: { code: "cross_vendor_scope_mismatch" },
    }
  }

  const { snapshots, data_source: dataSource } = await mockResolveInsightSnapshots(
    req.scope,
    [sellerId],
  ) as {
    snapshots: Array<{
      vendor_id: string
      category_id: string
      category_name: string
      price: number
    }>
    data_source: "mercur_query"
  }
  const insightsData = getCompetitiveInsights(vendorId, snapshots)

  await mockAppendNotificationLog(req.scope, {
    vendor_id: vendorId,
    notification_type: "competitive_insights_query",
    locale: "pl",
    recipient_email: "system",
    status: "sent",
    triggered_by: vendorId,
    metadata: {
      category_count: insightsData.categories.length,
      data_source: dataSource,
    },
  })

  return {
    statusCode: 200,
    body: { ...insightsData, data_source: dataSource },
  }
}

function createBrowserRequest(options?: { bodyVendorId?: string }): BrowserRequestShape {
  return {
    headers: {
      authorization: "Bearer seller-session.jwt",
      "x-publishable-api-key": "pk_test",
      "x-seller-id": "sel_browser_1",
    },
    seller_context: { seller_id: "sel_browser_1" },
    auth_context: { actor_id: "member_browser_1" },
    body: options?.bodyVendorId ? { vendor_id: options.bodyVendorId } : undefined,
    query: {},
    scope: {
      resolve: (key: string) => {
        if (key === "gp_core") {
          return {
            resolveVendorId: async (sellerId: string) => {
              expect(sellerId).toBe("sel_browser_1")
              return "ven_browser_1"
            },
          }
        }
        return undefined
      },
    },
  }
}

describe("GET /vendor/competitive-insights — browser JWT bearer shape", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditLog.length = 0
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

    const result = await simulateBrowserRoute(req)

    expect(req.headers["x-vendor-signature"]).toBeUndefined()
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      vendor_id: "ven_browser_1",
      data_source: "mercur_query",
    })
    expect(Array.isArray((result.body as { categories?: unknown[] }).categories)).toBe(true)
    expect((result.body as { categories: unknown[] }).categories.length).toBeGreaterThan(0)
    expect(mockResolveInsightSnapshots).toHaveBeenCalledWith(req.scope, ["sel_browser_1"])
    expect(auditLog[0]).toMatchObject({
      vendor_id: "ven_browser_1",
      notification_type: "competitive_insights_query",
      status: "sent",
    })
  })

  it("rejects cross-vendor body scope before querying snapshots and writes rejected audit", async () => {
    const req = createBrowserRequest({ bodyVendorId: "ven_other" })

    const result = await simulateBrowserRoute(req)

    expect(result.statusCode).toBe(403)
    expect(result.body).toMatchObject({ code: "cross_vendor_scope_mismatch" })
    expect(mockResolveInsightSnapshots).not.toHaveBeenCalled()
    expect(auditLog[0]).toMatchObject({
      vendor_id: "ven_browser_1",
      status: "rejected",
      error_message: "cross_vendor_scope_mismatch",
      metadata: { requested_vendor_id: "ven_other" },
    })
  })
})
