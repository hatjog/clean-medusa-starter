/**
 * cc-4 F-03 regression tests for resolveAdminMarketContext.
 *
 * The helper turns the previously-trusted `x-gp-market-id` client header
 * into a server-verified value. Tests assert:
 *   - 401 when no admin auth_context
 *   - 401 when non-user actor_type
 *   - 403 when non-super-admin requests a market they do not hold a
 *     grant for
 *   - 200/ok with market_id from header when super-admin
 *   - 200/ok with market_id from header when non-super-admin holds an
 *     active grant
 *   - 200/ok with market_id=null when no header AND no intrinsic
 *   - fail-closed when DB is unavailable AND actor is non-super-admin
 */
import type { Knex } from "knex"
import {
  __setKnexForAdminMarketTests,
  resolveAdminMarketContext,
  readMarketIdHeader,
} from "../../lib/admin-market-context"
import {
  __resetCapabilityCache,
  SUPER_ADMIN_CAPABILITY,
} from "../../lib/capability-check"

type CombinedKnexOpts = {
  superAdmins?: Set<string>
  marketGrants?: Record<string, Set<string>>
  marketGrantsTableMissing?: boolean
}

function makeCombinedKnex(opts: CombinedKnexOpts): Knex {
  function capabilityGrantsTable() {
    const state = { actor: "", caps: [] as string[] }
    const chain = {
      select: jest.fn(() => chain),
      where: jest.fn((col: string, val: string) => {
        if (col === "actor_id") state.actor = val
        return chain
      }),
      whereIn: jest.fn((col: string, vals: string[]) => {
        if (col === "capability") state.caps = vals
        return chain
      }),
      whereNull: jest.fn(() => chain),
      limit: jest.fn(async () => {
        if (
          opts.superAdmins?.has(state.actor) &&
          state.caps.includes(SUPER_ADMIN_CAPABILITY)
        ) {
          return [{ capability: SUPER_ADMIN_CAPABILITY }]
        }
        return []
      }),
    }
    return chain
  }

  function marketGrantsTable() {
    if (opts.marketGrantsTableMissing) {
      const chain = {
        select: jest.fn(() => chain),
        where: jest.fn(() => chain),
        whereNull: jest.fn(() => chain),
        limit: jest.fn(async () => {
          throw new Error("relation admin_market_grants does not exist")
        }),
      }
      return chain
    }
    const state = { actor: "", market: "" }
    const chain = {
      select: jest.fn(() => chain),
      where: jest.fn((col: string, val: string) => {
        if (col === "admin_user_id") state.actor = val
        if (col === "market_id") state.market = val
        return chain
      }),
      whereNull: jest.fn(() => chain),
      limit: jest.fn(async () => {
        const set = opts.marketGrants?.[state.actor]
        if (set && set.has(state.market)) {
          return [{ admin_user_id: state.actor }]
        }
        return []
      }),
    }
    return chain
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const knexFn = jest.fn((tableName: string): any => {
    if (tableName === "admin_capability_grants") return capabilityGrantsTable()
    if (tableName === "admin_market_grants") return marketGrantsTable()
    return {}
  })
  return knexFn as unknown as Knex
}

function makeReq(opts: {
  authContext?: { actor_id?: string; actor_type?: string }
  headers?: Record<string, string>
}): import("@medusajs/framework/http").MedusaRequest {
  return {
    auth_context: opts.authContext,
    headers: opts.headers ?? {},
    scope: { resolve: () => undefined },
  } as unknown as import("@medusajs/framework/http").MedusaRequest
}

describe("cc-4 F-03 resolveAdminMarketContext", () => {
  afterEach(() => {
    __setKnexForAdminMarketTests(undefined)
    __resetCapabilityCache()
  })

  it("returns 401 when auth_context is missing", async () => {
    const result = await resolveAdminMarketContext(makeReq({}))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.code).toBe("UNAUTHORIZED")
    }
  })

  it("returns 401 when actor_type is non-user", async () => {
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "vendor_1", actor_type: "vendor" },
        headers: { "x-gp-market-id": "mkt_bonbeauty" },
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("returns 403 when non-super-admin requests a market with no grant", async () => {
    __setKnexForAdminMarketTests(
      makeCombinedKnex({
        superAdmins: new Set(),
        marketGrants: { usr_a: new Set(["mkt_a"]) },
      }),
    )
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "usr_a", actor_type: "user" },
        headers: { "x-gp-market-id": "mkt_b" },
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.code).toBe("MARKET_FORBIDDEN")
    }
  })

  it("returns ok for super-admin requesting any market", async () => {
    __setKnexForAdminMarketTests(
      makeCombinedKnex({
        superAdmins: new Set(["usr_super"]),
        marketGrants: {},
      }),
    )
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "usr_super", actor_type: "user" },
        headers: { "x-gp-market-id": "mkt_anything" },
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.market_id).toBe("mkt_anything")
      expect(result.is_super_admin).toBe(true)
      expect(result.source).toBe("header")
    }
  })

  it("returns ok for non-super-admin holding matching grant", async () => {
    __setKnexForAdminMarketTests(
      makeCombinedKnex({
        superAdmins: new Set(),
        marketGrants: { usr_a: new Set(["mkt_a"]) },
      }),
    )
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "usr_a", actor_type: "user" },
        headers: { "x-gp-market-id": "mkt_a" },
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.market_id).toBe("mkt_a")
      expect(result.is_super_admin).toBe(false)
    }
  })

  it("returns ok market_id=null when no header AND no intrinsic", async () => {
    __setKnexForAdminMarketTests(
      makeCombinedKnex({
        superAdmins: new Set(),
        marketGrants: {},
      }),
    )
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "usr_a", actor_type: "user" },
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.market_id).toBeNull()
      expect(result.source).toBe("none")
    }
  })

  it("checks intrinsic market_id when header absent (fails for non-grant)", async () => {
    __setKnexForAdminMarketTests(
      makeCombinedKnex({
        superAdmins: new Set(),
        marketGrants: { usr_a: new Set(["mkt_a"]) },
      }),
    )
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "usr_a", actor_type: "user" },
      }),
      { intrinsicMarketId: "mkt_b" },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("fails closed for non-super-admin when admin_market_grants table missing", async () => {
    __setKnexForAdminMarketTests(
      makeCombinedKnex({
        superAdmins: new Set(),
        marketGrants: {},
        marketGrantsTableMissing: true,
      }),
    )
    const result = await resolveAdminMarketContext(
      makeReq({
        authContext: { actor_id: "usr_a", actor_type: "user" },
        headers: { "x-gp-market-id": "mkt_anything" },
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })
})

describe("readMarketIdHeader", () => {
  it("returns trimmed value", () => {
    expect(
      readMarketIdHeader({
        headers: { "x-gp-market-id": "  mkt_x  " },
      } as unknown as import("@medusajs/framework/http").MedusaRequest),
    ).toBe("mkt_x")
  })

  it("returns null when missing", () => {
    expect(
      readMarketIdHeader({
        headers: {},
      } as unknown as import("@medusajs/framework/http").MedusaRequest),
    ).toBeNull()
  })

  it("accepts first value of an array header", () => {
    expect(
      readMarketIdHeader({
        headers: { "x-gp-market-id": ["mkt_z"] as unknown as string },
      } as unknown as import("@medusajs/framework/http").MedusaRequest),
    ).toBe("mkt_z")
  })
})
