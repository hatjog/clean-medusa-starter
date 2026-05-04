/**
 * Regression test for @mercurjs/core@2.1.1 patch:
 *   GP Story v160-cleanup-2 / CRIT-1.2 — applySellerVisibilityFilter async rewrite
 *
 * ## Background
 * Sprint 1 (Story 1.10, Robert Opcja 1, 2026-05-02): The original synchronous
 * `applySellerVisibilityFilter` middleware injected `filterableFields.seller.status`
 * directly. When this filter reached MikroORM via `query.graph`, it crashed with a
 * CriteriaNode error because `Product.seller` is a module link (cross-module pivot),
 * NOT a direct ORM relation. Observed on 113-product bonbeauty SC.
 *
 * ## Patch fix
 * Rewrite to async: pre-fetch open seller IDs via `query.graph` (which handles module
 * link traversal), then apply `seller_id $in [...]` filter — a format the link layer
 * resolves without CriteriaNode crash.
 *
 * ## What this test covers
 * 1. 0 open sellers → `filterableFields.id = { $in: ["__no_open_sellers__"] }` (no crash)
 * 2. N≥2 open sellers → `filterableFields.seller_id = { $in: [...ids] }`
 * 3. `__no_open_sellers__` sentinel is a string that can never match a real product ID
 * 4. Async error in query.graph → calls next(err), does NOT throw synchronously
 * 5. Concurrent calls (≥5) with different market contexts resolve independently
 *
 * @see patches/@mercurjs__core@2.1.1.patch
 * @see _bmad-output/implementation-artifacts/v160/v160-cleanup-2-mercur-patch-regression-test.md
 */

import type { ContainerRegistrationKeys } from "@medusajs/framework/utils"

// ─────────────────────────────────────────────────────────────────────────────
// Inline re-implementation of the patched middleware for unit testing.
// The patch lives in .medusa/server/src/api/store/products/middlewares.js
// (compiled output). We replicate the logic here so the test is self-contained
// and will break visibly if someone reverts the patch to the synchronous form.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN = "open"
const NO_OPEN_SELLERS_SENTINEL = "__no_open_sellers__"

type SellerRow = { id: string }
type QueryGraph = { graph: (opts: unknown) => Promise<{ data: SellerRow[] }> }
type Scope = { resolve: (key: string) => QueryGraph }

/**
 * Exact replica of the patched applySellerVisibilityFilter.
 * Keep in sync with patches/@mercurjs__core@2.1.1.patch.
 */
async function applySellerVisibilityFilter(
  req: {
    scope: Scope
    filterableFields?: Record<string, unknown>
  },
  _res: unknown,
  next: (err?: unknown) => void,
) {
  try {
    const now = new Date()
    const query = req.scope.resolve("query" /* ContainerRegistrationKeys.QUERY */)
    const { data: openSellers } = await query.graph({
      entity: "seller",
      fields: ["id"],
      filters: {
        status: OPEN,
        $and: [
          { $or: [{ closed_from: null }, { closed_from: { $gt: now } }] },
          { $or: [{ closed_to: null }, { closed_to: { $lt: now } }] },
        ],
      },
      pagination: { take: null, skip: 0 },
    })

    const openSellerIds = openSellers.map((s: SellerRow) => s.id)
    const filterableFields = (req.filterableFields ??= {})

    if (openSellerIds.length === 0) {
      // No open sellers — guarantee empty product list without hitting
      // MikroORM with an unsatisfiable seller relation filter.
      filterableFields.id = { $in: [NO_OPEN_SELLERS_SENTINEL] }
    } else {
      filterableFields.seller_id = { $in: openSellerIds }
    }

    next()
  } catch (err) {
    next(err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeReq(sellers: SellerRow[] = [], fail = false) {
  const graph = fail
    ? jest.fn().mockRejectedValue(new Error("query.graph failed"))
    : jest.fn().mockResolvedValue({ data: sellers })
  const scope: Scope = { resolve: jest.fn().mockReturnValue({ graph }) }
  return { req: { scope, filterableFields: {} as Record<string, unknown> }, graph }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("@mercurjs/core@2.1.1 patch — applySellerVisibilityFilter (CRIT-1.2)", () => {
  describe("Scenario 1 — 0 open sellers", () => {
    it("sets filterableFields.id to sentinel when no open sellers exist", async () => {
      const { req } = makeReq([])
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      expect(next).toHaveBeenCalledWith() // no error
      expect(req.filterableFields).toEqual({
        id: { $in: [NO_OPEN_SELLERS_SENTINEL] },
      })
      // Must NOT set seller_id (avoids ORM link crash with empty array)
      expect(req.filterableFields.seller_id).toBeUndefined()
    })

    it("sentinel value is not a valid ULID / UUID (can never match real product)", () => {
      // Products use ULID/UUID IDs; the sentinel is a plain readable string
      expect(NO_OPEN_SELLERS_SENTINEL).toBe("__no_open_sellers__")
      expect(NO_OPEN_SELLERS_SENTINEL).not.toMatch(
        /^[0-9A-HJKMNP-TV-Z]{26}$/, // ULID pattern
      )
      expect(NO_OPEN_SELLERS_SENTINEL).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // UUID
      )
    })
  })

  describe("Scenario 2 — N≥2 open sellers", () => {
    it("sets filterableFields.seller_id with all open seller IDs", async () => {
      const sellers: SellerRow[] = [
        { id: "seller_01HXAAAA" },
        { id: "seller_01HXBBBB" },
        { id: "seller_01HXCCCC" },
      ]
      const { req } = makeReq(sellers)
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      expect(next).toHaveBeenCalledWith()
      expect(req.filterableFields).toEqual({
        seller_id: { $in: ["seller_01HXAAAA", "seller_01HXBBBB", "seller_01HXCCCC"] },
      })
      // Must NOT set the sentinel (would incorrectly block all products)
      expect(req.filterableFields.id).toBeUndefined()
    })

    it("does NOT inject filterableFields.seller.status (the original crash trigger)", async () => {
      const sellers: SellerRow[] = [{ id: "seller_01HX1234" }, { id: "seller_01HX5678" }]
      const { req } = makeReq(sellers)
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      // This is the critical regression guard: the original code set
      //   filterableFields.seller.status = SellerStatus.OPEN
      // which crashed MikroORM CriteriaNode on module links.
      const ff = req.filterableFields as Record<string, unknown>
      expect(ff.seller).toBeUndefined()
    })
  })

  describe("Scenario 3 — query.graph error handling", () => {
    it("passes error to next() instead of throwing synchronously", async () => {
      const { req } = makeReq([], true /* fail */)
      const next = jest.fn()

      // Must NOT throw — Express expects errors passed to next(err)
      await expect(
        applySellerVisibilityFilter(req, {}, next),
      ).resolves.toBeUndefined()

      expect(next).toHaveBeenCalledWith(expect.any(Error))
      expect(next.mock.calls[0][0]).toHaveProperty("message", "query.graph failed")
    })
  })

  describe("Scenario 4 — concurrent requests (≥5) resolve independently", () => {
    it("concurrent calls with different seller sets each resolve correctly", async () => {
      // Simulate 6 concurrent requests with different seller contexts
      const requests = Array.from({ length: 6 }, (_, i) => {
        const sellers =
          i % 2 === 0
            ? [] // even: no open sellers
            : [{ id: `seller_market_${i}` }] // odd: one open seller
        const { req } = makeReq(sellers)
        const next = jest.fn()
        return { req, next }
      })

      // Fire all concurrently
      await Promise.all(
        requests.map(({ req, next }) => applySellerVisibilityFilter(req, {}, next)),
      )

      requests.forEach(({ req, next }, i) => {
        expect(next).toHaveBeenCalledWith() // no errors
        if (i % 2 === 0) {
          expect(req.filterableFields?.id).toEqual({ $in: [NO_OPEN_SELLERS_SENTINEL] })
        } else {
          expect(req.filterableFields?.seller_id).toEqual({
            $in: [`seller_market_${i}`],
          })
        }
      })
    })
  })

  describe("Patch metadata guard", () => {
    it("patch file exists at expected path (guards against accidental removal)", () => {
      const fs = require("fs")
      const path = require("path")
      const patchPath = path.join(
        __dirname,
        "../../patches/@mercurjs__core@2.1.1.patch",
      )
      expect(fs.existsSync(patchPath)).toBe(true)
    })

    it("patch file contains async pre-fetch pattern (not original sync injection)", () => {
      const fs = require("fs")
      const path = require("path")
      const patchPath = path.join(
        __dirname,
        "../../patches/@mercurjs__core@2.1.1.patch",
      )
      const content = fs.readFileSync(patchPath, "utf-8")

      // Patched version must contain async pre-fetch
      expect(content).toContain("query.graph")
      expect(content).toContain("openSellerIds")
      expect(content).toContain("__no_open_sellers__")

      // Must NOT contain the original crash-inducing direct relation filter
      // (the removed lines start with "-" in the diff)
      expect(content).toContain("-    sellerFilter.status = types_1.SellerStatus.OPEN")
    })
  })
})
