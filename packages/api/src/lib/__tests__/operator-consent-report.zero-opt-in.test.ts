/**
 * Story v160-cleanup-45: countOptedInVendors — AC3 unit tests.
 *
 * Covers:
 *  (a) 5 vendors, 3 opted-in → count=3 (AC3 happy path)
 *  (b) 0 vendors in cohort → count=0 (AC3a edge case — no throw)
 *  (c) all 5 vendors opted-in (5/5) → count=5 (AC3b edge case)
 *  (d) 0 vendors opted-in (0/5) → count=0 (AC3c edge case)
 *  (e) SellerModule unavailable → SellerModuleUnavailableError (AC3d)
 *
 * STAGING-FREE (UX-DR108/ADR-066): deterministic in-process mocks only — no
 * docker-compose or DB dependency (AC4).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSeller(
  id: string,
  decisionStatus: "opted_in" | "opted_out" | "pending",
) {
  return {
    id,
    handle: `vendor-${id}`,
    email: `${id}@example.com`,
    status: "open",
    metadata: {
      gp: { decision_status: decisionStatus },
    },
  }
}

// Deterministic decision-list-entry mirror of real vendor-decision-store logic.
function fakeDecisionEntry(seller: Record<string, unknown>) {
  const metadata = (seller.metadata ?? {}) as Record<string, unknown>
  const gp = (
    metadata.gp !== null && typeof metadata.gp === "object" ? metadata.gp : {}
  ) as Record<string, unknown>
  const ds = gp.decision_status
  return {
    id: seller.id as string,
    handle: (seller.handle ?? seller.id) as string,
    email: (seller.email ?? "") as string,
    lifecycle_status: "active" as const,
    decision_status:
      ds === "opted_in" || ds === "opted_out" ? (ds as "opted_in" | "opted_out") : "pending",
    last_action_at: null,
  }
}

// ---------------------------------------------------------------------------
// Tests: countOptedInVendors via mocked listSellers scope.
//
// Strategy: Instead of mocking the module (which can have hoisting issues),
// we mock the DI scope so that resolveSellerModuleService finds a seller
// service with the test data — this exercises countOptedInVendors end-to-end
// through listSellers and buildDecisionListEntry without touching the DB.
// ---------------------------------------------------------------------------

// We DO need the real `buildDecisionListEntry` for the filter logic.
// We stub `listNotificationLog` and `getKickoffState` to avoid further deps.
jest.mock("../vendor-notification-log", () => ({
  listNotificationLog: jest.fn(async () => []),
}))
jest.mock("../../workflows/operator/trigger-t30-kickoff", () => ({
  getKickoffState: jest.fn(async () => null),
}))

import {
  countOptedInVendors,
  SellerModuleUnavailableError,
} from "../operator-consent-report"

/**
 * Build a minimal DI scope whose seller service returns the given sellers.
 * Matches the SELLER_SERVICE_KEYS fallback chain in vendor-decision-store:
 * ["sellerModuleService", "sellerService", "ISellerModuleService"].
 */
function buildScope(sellers: ReturnType<typeof buildSeller>[]) {
  const sellerService = {
    list: async () => sellers,
  }
  return {
    resolve: (key: string) => {
      if (key === "sellerModuleService") return sellerService
      throw new Error(`missing: ${key}`)
    },
  }
}

/**
 * Build a scope that throws for all seller service keys to simulate
 * SellerModule unavailability.
 */
function buildUnavailableScope() {
  return {
    resolve: (key: string) => {
      throw new Error(
        `Seller module service is not available in the request scope (key=${key})`,
      )
    },
  }
}

describe("countOptedInVendors", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("(a) returns 3 when cohort has 5 vendors — 3 opted-in, 2 not (AC3 happy path)", async () => {
    const scope = buildScope([
      buildSeller("v1", "opted_in"),
      buildSeller("v2", "opted_out"),
      buildSeller("v3", "opted_in"),
      buildSeller("v4", "pending"),
      buildSeller("v5", "opted_in"),
    ])

    const count = await countOptedInVendors(scope)
    expect(count).toBe(3)
  })

  it("(b) returns 0 when cohort is empty — zero vendors, no throw (AC3a)", async () => {
    const scope = buildScope([])

    const count = await countOptedInVendors(scope)
    expect(count).toBe(0)
  })

  it("(c) returns 5 when all 5 vendors opted-in (AC3b)", async () => {
    const scope = buildScope([
      buildSeller("v1", "opted_in"),
      buildSeller("v2", "opted_in"),
      buildSeller("v3", "opted_in"),
      buildSeller("v4", "opted_in"),
      buildSeller("v5", "opted_in"),
    ])

    const count = await countOptedInVendors(scope)
    expect(count).toBe(5)
  })

  it("(d) returns 0 when 0 out of 5 vendors opted-in (AC3c)", async () => {
    const scope = buildScope([
      buildSeller("v1", "opted_out"),
      buildSeller("v2", "pending"),
      buildSeller("v3", "opted_out"),
      buildSeller("v4", "pending"),
      buildSeller("v5", "opted_out"),
    ])

    const count = await countOptedInVendors(scope)
    expect(count).toBe(0)
  })

  it("(e) throws SellerModuleUnavailableError when module cannot be resolved (AC3d)", async () => {
    const scope = buildUnavailableScope()

    await expect(countOptedInVendors(scope)).rejects.toBeInstanceOf(
      SellerModuleUnavailableError,
    )
  })

  it("(e2) SellerModuleUnavailableError carries correct code property (AC3d)", async () => {
    const scope = buildUnavailableScope()

    const err = await countOptedInVendors(scope).catch((e) => e)
    expect(err).toBeInstanceOf(SellerModuleUnavailableError)
    expect((err as SellerModuleUnavailableError).code).toBe(
      "SELLER_MODULE_UNAVAILABLE",
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: cascade route handler — 503 on SellerModuleUnavailableError (AC3d)
// ---------------------------------------------------------------------------

// Stub getCurrentState and computeZeroOptInCascade for route-level test.
jest.mock("../feature-flag-tri-state", () => ({
  getCurrentState: jest.fn(async () => "off" as const),
}))
jest.mock("../cohort-metrics-aggregator", () => ({
  computeZeroOptInCascade: jest.fn(
    async (count: number, _state: string) =>
      ({
        opted_in_count: count,
        cascade_active: false,
        current_step: "none",
        recommended_action: "No action required.",
        remediation_url: "",
      }) as const,
  ),
}))

// PG_CONNECTION real key from @medusajs/framework/utils ContainerRegistrationKeys
const PG_CONNECTION_KEY = "__pg_connection__"

function buildRouteScope(
  sellers: ReturnType<typeof buildSeller>[] | "unavailable",
) {
  const mockDb = {}
  return {
    resolve: (key: string) => {
      if (key === PG_CONNECTION_KEY) return mockDb
      if (sellers === "unavailable") {
        throw new Error(
          `Seller module service is not available in the request scope (key=${key})`,
        )
      }
      if (key === "sellerModuleService") {
        return { list: async () => sellers }
      }
      throw new Error(`missing: ${key}`)
    },
  }
}

function buildRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      res._status = code
      return res
    },
    json(body: unknown) {
      res._body = body
      return res
    },
  }
  return res
}

describe("zero-opt-in-cascade route — SellerModule 503 path (AC3d / AC6)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns HTTP 503 with SELLER_MODULE_UNAVAILABLE when module unavailable", async () => {
    const { GET } = await import(
      "../../api/admin/operator/zero-opt-in-cascade/route"
    )

    const mockReq = { scope: buildRouteScope("unavailable") }
    const mockRes = buildRes()

    await GET(mockReq as never, mockRes as never)

    expect(mockRes._status).toBe(503)
    expect(mockRes._body).toMatchObject({
      code: "SELLER_MODULE_UNAVAILABLE",
    })
  })

  it("returns cascade JSON (AC6 contract) when module is available", async () => {
    const { GET } = await import(
      "../../api/admin/operator/zero-opt-in-cascade/route"
    )

    const mockReq = {
      scope: buildRouteScope([
        buildSeller("v1", "opted_in"),
        buildSeller("v2", "opted_out"),
        buildSeller("v3", "opted_in"),
      ]),
    }
    const mockRes = buildRes()

    await GET(mockReq as never, mockRes as never)

    expect(mockRes._status).toBe(200)
    // Response should include cascade decision tree fields (AC6 contract).
    // opted_in_count must reflect the real count from buildDecisionListEntry
    // applied to the seeded sellers (2 of 3 are opted_in).
    expect(mockRes._body).toMatchObject({
      opted_in_count: 2,
      cascade_active: expect.anything() as boolean,
      current_step: expect.anything() as string,
      recommended_action: expect.anything() as string,
    })
  })
})
