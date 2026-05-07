/**
 * capability-check.test.ts — Unit tests for AC5 (all 7 scenarios) + AC6 smoke.
 *
 * Story v160-cleanup-42 / TF-102.
 *
 * Test framework: Jest + @swc/jest (see jest.config.js TEST_TYPE=unit).
 * All tests are DB-free: they inject a mock Knex via `__setKnexForTests`.
 * Cache is reset before each test via `__resetCapabilityCache`.
 */

import { describe, expect, it, beforeEach, jest } from "@jest/globals"
import type { MedusaRequest } from "@medusajs/framework/http"
import type { Knex } from "knex"

import {
  checkCapability,
  requireCapability,
  __resetCapabilityCache,
  __setKnexForTests,
  CAPABILITY_MANIFEST,
  SUPER_ADMIN_CAPABILITY,
} from "../capability-check"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal MedusaRequest stub with auth_context injected. */
function makeReq(actor_id?: string, actor_type = "user"): MedusaRequest {
  return {
    auth_context: actor_id ? { actor_id, actor_type } : undefined,
    // The test Knex is injected via __setKnexForTests — no container needed.
    scope: undefined,
    __container__: undefined,
  } as unknown as MedusaRequest
}

/**
 * Build a mock Knex that returns `rows` when queried against
 * `admin_capability_grants`. Tracks query call count via `spy`.
 */
function makeMockKnex(
  rows: Array<{ capability: string }>,
  spy?: ReturnType<typeof jest.fn>
): Knex {
  const chain = {
    select: () => chain,
    where: () => chain,
    whereIn: () => chain,
    whereNull: () => chain,
    limit: () => Promise.resolve(rows),
  }

  // If a spy is provided, wrap the limit call to record invocations.
  if (spy) {
    chain.limit = () => {
      spy()
      return Promise.resolve(rows)
    }
  }

  const db = jest.fn().mockReturnValue(chain) as unknown as Knex
  return db
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetCapabilityCache()
  __setKnexForTests(undefined)
})

// ---------------------------------------------------------------------------
// AC5-1: Granted — actor with active grant returns ok:true
// ---------------------------------------------------------------------------
describe("AC5-1: Granted capability", () => {
  it("returns ok:true when actor has an active grant for the capability", async () => {
    const db = makeMockKnex([{ capability: "vendor.lifecycle.override_training_cert" }])
    __setKnexForTests(db)

    const req = makeReq("admin-1")
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result).toEqual({ ok: true })
  })

  it("checkCapability returns true when active grant exists", async () => {
    const db = makeMockKnex([{ capability: "alerts.read" }])
    __setKnexForTests(db)

    const req = makeReq("admin-1")
    const granted = await checkCapability(req, "alerts.read")
    expect(granted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC5-2: Revoked — row exists but revoked_at IS NOT NULL → returns 403
// (The mock DB only returns rows for active grants — revoked rows are
//  filtered by whereNull("revoked_at"). Returning empty rows simulates revoke.)
// ---------------------------------------------------------------------------
describe("AC5-2: Revoked capability", () => {
  it("returns 403 CAPABILITY_REQUIRED when grant is revoked (no active row)", async () => {
    const db = makeMockKnex([]) // no rows = grant revoked or filtered out
    __setKnexForTests(db)

    const req = makeReq("admin-revoked")
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result).toEqual({
      ok: false,
      status: 403,
      body: {
        code: "CAPABILITY_REQUIRED",
        capability: "vendor.lifecycle.override_training_cert",
        message: "Caller does not hold the required capability: vendor.lifecycle.override_training_cert",
      },
    })
  })
})

// ---------------------------------------------------------------------------
// AC5-3: Missing — no row for the specific capability → 403
// ---------------------------------------------------------------------------
describe("AC5-3: Missing capability", () => {
  it("returns 403 when actor has other grants but not the required one", async () => {
    // The mock returns no rows for the queried capability
    const db = makeMockKnex([])
    __setKnexForTests(db)

    const req = makeReq("admin-partial")
    const result = await requireCapability(req, "policy.bypass")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.body.code).toBe("CAPABILITY_REQUIRED")
      expect(result.body.capability).toBe("policy.bypass")
    }
  })
})

// ---------------------------------------------------------------------------
// AC5-4: Super-admin bypass
// The __super_admin__ row grants all capabilities implicitly.
// Our mock returns a row for SUPER_ADMIN_CAPABILITY to simulate this.
// ---------------------------------------------------------------------------
describe("AC5-4: Super-admin bypass", () => {
  it("grants capability when actor holds __super_admin__ grant", async () => {
    const db = makeMockKnex([{ capability: SUPER_ADMIN_CAPABILITY }])
    __setKnexForTests(db)

    // Actor does NOT have a direct capability row for "policy.bypass"
    // but the query returns __super_admin__ → granted
    const req = makeReq("admin-super")
    const result = await requireCapability(req, "policy.bypass")
    expect(result).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// AC5-5: Cache hit — second call within TTL does not hit DB
// ---------------------------------------------------------------------------
describe("AC5-5: Cache hit", () => {
  it("uses cached result on second call without hitting DB again", async () => {
    const dbSpy = jest.fn()
    const db = makeMockKnex([{ capability: "alerts.read" }], dbSpy)
    __setKnexForTests(db)

    const req = makeReq("admin-cache")

    // First call — should hit DB
    await checkCapability(req, "alerts.read")
    expect(dbSpy).toHaveBeenCalledTimes(1)

    // Second call within TTL — should NOT hit DB (cache serves result)
    await checkCapability(req, "alerts.read")
    expect(dbSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// AC5-6: Cache invalidation on revoke
// (We test that __resetCapabilityCache clears entries so the next call re-queries DB)
// ---------------------------------------------------------------------------
describe("AC5-6: Cache invalidation", () => {
  it("invalidates cache on reset so next call re-queries DB", async () => {
    const dbSpy = jest.fn()
    const db = makeMockKnex([{ capability: "alerts.read" }], dbSpy)
    __setKnexForTests(db)

    const req = makeReq("admin-invalidate")

    // First call — populates cache
    await checkCapability(req, "alerts.read")
    expect(dbSpy).toHaveBeenCalledTimes(1)

    // Simulate revoke → invalidate cache
    __resetCapabilityCache()

    // Third call — cache miss, DB re-queried
    await checkCapability(req, "alerts.read")
    expect(dbSpy).toHaveBeenCalledTimes(2)
  })

  it("bounds worst-case stale grant exposure within CACHE_TTL_MS", async () => {
    // Document: worst-case stale grant after cache population = CACHE_TTL_MS ms.
    // Tests above confirm explicit invalidation works immediately.
    // TTL is 30_000 ms (exported from capability-grants-repo.ts).
    const { CACHE_TTL_MS } = await import("../capability-grants-repo.js")
    expect(CACHE_TTL_MS).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// AC5: No actor_id — short-circuits to false without DB lookup
// ---------------------------------------------------------------------------
describe("Auth context: missing actor_id", () => {
  it("returns false (and no DB call) when actor_id is absent", async () => {
    const dbSpy = jest.fn()
    const db = makeMockKnex([], dbSpy)
    __setKnexForTests(db)

    const req = makeReq(undefined) // no auth_context
    const granted = await checkCapability(req, "lifecycle.override")
    expect(granted).toBe(false)
    // DB must not be touched for unauthenticated requests
    expect(dbSpy).toHaveBeenCalledTimes(0)
  })

  it("requireCapability returns ok:false (no DB hit) for missing auth", async () => {
    const dbSpy = jest.fn()
    __setKnexForTests(makeMockKnex([], dbSpy))

    const req = makeReq(undefined)
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result.ok).toBe(false)
    expect(dbSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC5-7 / AC6: Backwards compat — cleanup-37 capability path
// Actors seeded by migration with __super_admin__ grant can still pass the
// vendor.lifecycle.override_training_cert capability check used by
// POST /admin/sellers/:id/pause (override=true path).
// ---------------------------------------------------------------------------
describe("AC5-7 / AC6: Backwards compat — cleanup-37 capability", () => {
  it("grants vendor.lifecycle.override_training_cert via __super_admin__ row (migration-seeded actor)", async () => {
    // Simulate: actor has __super_admin__ row (migration-seeded), not a direct row.
    const db = makeMockKnex([{ capability: SUPER_ADMIN_CAPABILITY }])
    __setKnexForTests(db)

    const req = makeReq("admin-seeded-by-migration")
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result).toEqual({ ok: true })
  })

  it("requireCapability still returns { ok: true } for direct vendor.lifecycle.override_training_cert grant", async () => {
    // Simulate: actor has a direct per-capability row (v1.7.0 style, not super-admin)
    const db = makeMockKnex([{ capability: "vendor.lifecycle.override_training_cert" }])
    __setKnexForTests(db)

    const req = makeReq("admin-direct-cap")
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Review F1: no insecure Knex-unavailable fallback — fail-closed when DB absent
// ---------------------------------------------------------------------------
describe("Review F1: fail-closed when Knex is unavailable", () => {
  it("returns false when no Knex is registered (no fallback to actor_type)", async () => {
    // Deliberately do NOT inject a mock Knex; req.scope is undefined.
    __setKnexForTests(undefined)

    const req = makeReq("admin-no-db")
    const granted = await checkCapability(req, "lifecycle.override")
    expect(granted).toBe(false)
  })

  it("requireCapability returns 403 CAPABILITY_REQUIRED when no Knex is registered", async () => {
    __setKnexForTests(undefined)

    const req = makeReq("admin-no-db")
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.body.code).toBe("CAPABILITY_REQUIRED")
    }
  })
})

// ---------------------------------------------------------------------------
// Review F2: defence in depth — actor_type !== "user" denied without DB hit
// ---------------------------------------------------------------------------
describe("Review F2: actor_type filter (admin-only grants table)", () => {
  it("denies non-user actor types without touching the DB", async () => {
    const dbSpy = jest.fn()
    __setKnexForTests(makeMockKnex([{ capability: SUPER_ADMIN_CAPABILITY }], dbSpy))

    const req = makeReq("cust-1", "customer")
    const granted = await checkCapability(req, "lifecycle.override")
    expect(granted).toBe(false)
    expect(dbSpy).not.toHaveBeenCalled()
  })

  it("denies vendor actor type even with super_admin row in mock", async () => {
    const dbSpy = jest.fn()
    __setKnexForTests(makeMockKnex([{ capability: SUPER_ADMIN_CAPABILITY }], dbSpy))

    const req = makeReq("vend-1", "vendor")
    const result = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    expect(result.ok).toBe(false)
    expect(dbSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Review F7: DB error -> fail-closed false, no cache poisoning
// ---------------------------------------------------------------------------
describe("Review F7: DB error fail-closed without caching the failure", () => {
  it("returns false on DB error and does NOT cache the failure", async () => {
    let calls = 0
    const flakyDb = (() => {
      const buildChain = (failOnce: boolean) => ({
        select: () => buildChain(failOnce),
        where: () => buildChain(failOnce),
        whereIn: () => buildChain(failOnce),
        whereNull: () => buildChain(failOnce),
        limit: () =>
          failOnce
            ? Promise.reject(new Error("boom"))
            : Promise.resolve([{ capability: "alerts.read" }]),
      })
      return jest.fn(() => {
        calls += 1
        return buildChain(calls === 1) as unknown as Knex
      }) as unknown as Knex
    })()

    __setKnexForTests(flakyDb)

    const req = makeReq("admin-flaky")
    // First call hits the DB error path
    const first = await checkCapability(req, "alerts.read")
    expect(first).toBe(false)

    // Second call must re-query (failure was NOT cached) and now succeed
    const second = await checkCapability(req, "alerts.read")
    expect(second).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Manifest completeness — capability type must include all AC1 entries
// ---------------------------------------------------------------------------
describe("AC1: Capability manifest completeness", () => {
  it("manifest includes all legacy capabilities", () => {
    // Use `in` to avoid Jest dot-path interpretation for dot-delimited keys
    expect("lifecycle.override" in CAPABILITY_MANIFEST).toBe(true)
    expect("alerts.read" in CAPABILITY_MANIFEST).toBe(true)
    expect("policy.bypass" in CAPABILITY_MANIFEST).toBe(true)
    expect("vendor.lifecycle.override_training_cert" in CAPABILITY_MANIFEST).toBe(true)
  })

  it("manifest includes v1.7.0 extension hooks", () => {
    expect("vendor.lifecycle.pause" in CAPABILITY_MANIFEST).toBe(true)
    expect("vendor.lifecycle.unpause" in CAPABILITY_MANIFEST).toBe(true)
    expect("vendor.lifecycle.suspend" in CAPABILITY_MANIFEST).toBe(true)
    expect("admin.capability_grants.read" in CAPABILITY_MANIFEST).toBe(true)
    expect("admin.capability_grants.write" in CAPABILITY_MANIFEST).toBe(true)
  })

  it("manifest includes __super_admin__ distinguished capability", () => {
    expect(SUPER_ADMIN_CAPABILITY in CAPABILITY_MANIFEST).toBe(true)
  })

  it("manifest is frozen (cannot be mutated)", () => {
    expect(Object.isFrozen(CAPABILITY_MANIFEST)).toBe(true)
  })
})
