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

describe("GET /v1/admin/entitlements", () => {
  describe("happy path — email search", () => {
    it("returns entitlements array for email query", async () => {
      const req = createReq({ q: "buyer@example.com" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ data: { entitlements: [mockEntitlement] } })
      expect(req._gpCore.adminSearchEntitlements).toHaveBeenCalledWith("buyer@example.com")
    })
  })

  describe("happy path — voucher_code search", () => {
    it("returns entitlements for voucher_code query", async () => {
      const req = createReq({ q: "VOUCHER123" })
      const res = createRes()

      await GET(req, res as any)

      expect(res.body).toEqual({ data: { entitlements: [mockEntitlement] } })
      expect(req._gpCore.adminSearchEntitlements).toHaveBeenCalledWith("VOUCHER123")
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
        scope: { resolve: jest.fn().mockImplementation(() => { throw new Error("not found") }) },
      } as any
      const res = createRes()

      await GET(req, res as any)

      expect(res.statusCode).toBe(503)
    })
  })
})
