/**
 * Unit tests for GET /v1/admin/entitlements route (Story 8.1 — AC-1, 2, 4, 5, 7).
 *
 * Covers:
 *   - happy path: email search → { entitlements: [...] }
 *   - happy path: voucher_code search → { entitlements: [...] }
 *   - happy path: order_id exact match → { entitlements: [...] }
 *   - empty result: no matches → { entitlements: [] } (not 404)
 *   - validation: q < 3 chars → 400 VALIDATION_ERROR
 *   - validation: q missing → 400
 *   - service unavailable → 503
 *
 * Note: Auth (401/403) is tested in with-operator-auth.unit.spec.ts and middleware tests.
 */

import { GET } from "../../../api/v1/admin/entitlements/route"
import { __setKnexForAdminMarketTests } from "../../../lib/admin-market-context"
import { __resetCapabilityCache } from "../../../lib/capability-grants-repo"

const mockEntitlement = {
  id: "ent_01",
  status: "active",
  voucher_code: "VOUCHER123",
  claim_token: "ct_abc",
  order_id: "order_xyz",
  face_value_minor: 10000,
  remaining_minor: 10000,
  currency: "PLN",
  product_name: "Test Product",
  vendor_name: "Test Vendor",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2027-01-01T00:00:00.000Z",
  claimed_at: null,
  last_redeemed_at: null,
  redemptions: [],
  audit_log: [],
}

function createReq(query: Record<string, string> = {}) {
  const mockGpCore = {
    adminSearchEntitlements: jest.fn().mockResolvedValue([mockEntitlement]),
  }

  return {
    query,
    headers: { "x-gp-market-id": "market-a" },
    auth_context: { actor_id: "admin-1", actor_type: "user" },
    scope: {
      resolve: jest.fn().mockReturnValue(mockGpCore),
    },
    _gpCore: mockGpCore,
  } as any
}

function createRes() {
  return {
    body: null as any,
    statusCode: 0,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

function makeSuperAdminKnex() {
  return ((table: string) => {
    const rows =
      table === "admin_capability_grants"
        ? [{ capability: "__super_admin__" }]
        : []
    const chain = {
      select: jest.fn(() => chain),
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve(rows)),
    }
    return chain
  }) as any
}

// Non-super-admin with NO admin_market_grants row → fails closed (L2/L1).
function makeNonSuperAdminKnex() {
  return ((_table: string) => {
    const chain = {
      select: jest.fn(() => chain),
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve([])),
    }
    return chain
  }) as any
}

describe("GET /v1/admin/entitlements", () => {
  beforeEach(() => {
    __resetCapabilityCache()
    __setKnexForAdminMarketTests(makeSuperAdminKnex())
  })

  afterEach(() => {
    __setKnexForAdminMarketTests(undefined)
    __resetCapabilityCache()
  })

  describe("happy path — email search", () => {
    it("returns entitlements array for email query", async () => {
      const req = createReq({ q: "buyer@example.com" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ data: { entitlements: [mockEntitlement] } })
      expect(req._gpCore.adminSearchEntitlements).toHaveBeenCalledWith("buyer@example.com", {
        market_id: "market-a",
        allow_cross_market: false,
      })
    })
  })

  describe("happy path — voucher_code search", () => {
    it("returns entitlements for voucher_code query", async () => {
      const req = createReq({ q: "VOUCHER123" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.body).toEqual({ data: { entitlements: [mockEntitlement] } })
      expect(req._gpCore.adminSearchEntitlements).toHaveBeenCalledWith("VOUCHER123", {
        market_id: "market-a",
        allow_cross_market: false,
      })
    })
  })

  describe("happy path — order_id search", () => {
    it("returns entitlements for order_id query", async () => {
      const req = createReq({ q: "order_xyz" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.body).toEqual({ data: { entitlements: [mockEntitlement] } })
    })
  })

  describe("empty result", () => {
    it("returns 200 with empty array (not 404) when no matches", async () => {
      const gpCore = {
        adminSearchEntitlements: jest.fn().mockResolvedValue([]),
      }
      const req = {
        query: { q: "nonexistent" },
        headers: { "x-gp-market-id": "market-a" },
        auth_context: { actor_id: "admin-1", actor_type: "user" },
        scope: { resolve: jest.fn().mockReturnValue(gpCore) },
      } as any
      const res = createRes()

      await GET(req, res as any)

      expect(res.body).toEqual({ data: { entitlements: [] } })
    })
  })

  describe("validation", () => {
    it("returns 400 when q is missing", async () => {
      const req = createReq({})
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(400)
      expect(res.body).toMatchObject({ error: { message: "VALIDATION_ERROR" } })
    })

    it("returns 400 when q is less than 3 chars", async () => {
      const req = createReq({ q: "ab" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(400)
      expect(res.body).toMatchObject({ error: { message: "VALIDATION_ERROR" } })
    })

    it("returns 400 when q is empty string", async () => {
      const req = createReq({ q: "" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(400)
    })
  })

  describe("service unavailable", () => {
    it("returns 503 when GpCoreService cannot be resolved", async () => {
      const req = {
        query: { q: "testquery" },
        headers: { "x-gp-market-id": "market-a" },
        auth_context: { actor_id: "admin-1", actor_type: "user" },
        scope: { resolve: jest.fn().mockImplementation(() => { throw new Error("not found") }) },
      } as any
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(503)
    })
  })

  it("fails closed when a non-super-admin omits market context (L1/L2)", async () => {
    __setKnexForAdminMarketTests(makeNonSuperAdminKnex())
    const req = {
      query: { q: "buyer@example.com" },
      headers: {},
      auth_context: { actor_id: "admin-1", actor_type: "user" },
      scope: { resolve: jest.fn() },
    } as any
    const res = createRes()

    await GET(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ code: "MARKET_REQUIRED" })
    expect(req.scope.resolve).not.toHaveBeenCalled()
  })

  it("super-admin without market context performs cross-market global search (L2)", async () => {
    // beforeEach already wired makeSuperAdminKnex(); no x-gp-market-id header.
    const mockGpCore = {
      adminSearchEntitlements: jest.fn().mockResolvedValue([mockEntitlement]),
    }
    const req = {
      query: { q: "buyer@example.com" },
      headers: {},
      auth_context: { actor_id: "admin-1", actor_type: "user" },
      scope: { resolve: jest.fn().mockReturnValue(mockGpCore) },
    } as any
    const res = createRes()

    await GET(req, res as any)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ data: { entitlements: [mockEntitlement] } })
    // Cross-market read is EXPLICIT opt-in (allow_cross_market), market_id null.
    expect(mockGpCore.adminSearchEntitlements).toHaveBeenCalledWith("buyer@example.com", {
      market_id: null,
      allow_cross_market: true,
    })
  })
})
