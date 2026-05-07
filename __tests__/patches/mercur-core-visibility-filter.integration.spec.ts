/**
 * Regression test for @mercurjs/core@2.1.1 patch:
 *   GP Story v160-cleanup-2 / CRIT-1.2 — applySellerVisibilityFilter async rewrite
 *   GP Story v160-cleanup-11 / Story 8.8 AC6 — link-traversal refinement
 *
 * ## Background
 * Sprint 1 (Story 1.10, Robert Opcja 1, 2026-05-02): The original synchronous
 * `applySellerVisibilityFilter` middleware injected `filterableFields.seller.status`
 * directly. When this filter reached MikroORM via `query.graph`, it crashed with a
 * CriteriaNode error because `Product.seller` is a module link (cross-module pivot),
 * NOT a direct ORM relation. Observed on 113-product bonbeauty SC.
 *
 * ## Patch fix (cleanup-11 refined version — current shape)
 * Rewrite to async: pre-fetch open sellers AND their products via `query.graph`
 * (which handles module link traversal), collect the visible product IDs, then
 * apply `Product.id $in [...]` filter — a format that the link layer resolves
 * without CriteriaNode crash.
 *
 * Earlier cleanup-2 attempt filtered by `seller_id $in [...]`; that ALSO crashed
 * MikroORM CriteriaNode because Mercur 2 stores the link in
 * `product_product_seller_seller` pivot, not as a direct ORM column. cleanup-11
 * (Story 8.8 AC6) flipped the filter to `Product.id $in [...visibleProductIds]`.
 *
 * ## What this test covers
 * 1. 0 open sellers → `filterableFields.id = { $in: ["__no_visible_products__"] }` (no crash)
 * 2. N≥2 open sellers with products → `filterableFields.id = { $in: [...productIds] }`
 * 3. Sentinel string can never match a real product ID
 * 4. `seller_id` is NEVER injected (the cleanup-2 crash trigger)
 * 5. `seller.status` is NEVER injected (the original Mercur 1.x crash trigger)
 * 6. Async error in query.graph → calls next(err), does NOT throw synchronously
 * 7. Concurrent calls (≥5) with different market contexts resolve independently
 * 8. Sellers with empty `products` arrays contribute zero ids (do NOT widen the set)
 *
 * @see patches/@mercurjs__core@2.1.1.patch
 * @see _bmad-output/implementation-artifacts/v160/v160-cleanup-2-mercur-patch-regression-test.md
 * @see _bmad-output/implementation-artifacts/v160/v160-8-8-ac-mv-flag-on-e2e-pre-promote-smoke.md
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inline re-implementation of the patched middleware for unit testing.
// The patch lives in .medusa/server/src/api/store/products/middlewares.js
// (compiled output). We replicate the logic here so the test is self-contained
// and will break visibly if someone reverts the patch to the synchronous form
// or to the cleanup-2 `seller_id`-filter shape.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN = "open"
const NO_VISIBLE_PRODUCTS_SENTINEL = "__no_visible_products__"

type ProductRow = { id: string }
type SellerRow = { id: string; products?: ProductRow[] }
type QueryGraph = { graph: (opts: unknown) => Promise<{ data: SellerRow[] }> }
type Scope = { resolve: (key: string) => QueryGraph }

/**
 * Exact replica of the cleanup-11-refined applySellerVisibilityFilter.
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
      fields: ["id", "products.id"],
      filters: {
        status: OPEN,
        $and: [
          { $or: [{ closed_from: null }, { closed_from: { $gt: now } }] },
          { $or: [{ closed_to: null }, { closed_to: { $lt: now } }] },
        ],
      },
      // Explicit large take — keep in sync with the patch (B-2 fix).
      pagination: { take: 10000, skip: 0 },
    })

    const visibleProductIds = new Set<string>()
    for (const s of openSellers) {
      for (const p of s.products || []) {
        if (p && p.id) visibleProductIds.add(p.id)
      }
    }

    const filterableFields = (req.filterableFields ??= {})
    if (visibleProductIds.size === 0) {
      filterableFields.id = { $in: [NO_VISIBLE_PRODUCTS_SENTINEL] }
    } else {
      filterableFields.id = { $in: Array.from(visibleProductIds) }
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

describe("@mercurjs/core@2.1.1 patch — applySellerVisibilityFilter (cleanup-11 refined)", () => {
  describe("Scenario 1 — 0 open sellers", () => {
    it("sets filterableFields.id to sentinel when no open sellers exist", async () => {
      const { req } = makeReq([])
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      expect(next).toHaveBeenCalledWith() // no error
      expect(req.filterableFields).toEqual({
        id: { $in: [NO_VISIBLE_PRODUCTS_SENTINEL] },
      })
      // Must NOT set seller_id (cleanup-2 crash trigger)
      expect(req.filterableFields.seller_id).toBeUndefined()
      // Must NOT set seller.status (original Mercur 1.x crash trigger)
      expect(req.filterableFields.seller).toBeUndefined()
    })

    it("sentinel value is not a valid ULID / UUID (can never match a real product)", () => {
      expect(NO_VISIBLE_PRODUCTS_SENTINEL).toBe("__no_visible_products__")
      expect(NO_VISIBLE_PRODUCTS_SENTINEL).not.toMatch(
        /^[0-9A-HJKMNP-TV-Z]{26}$/, // ULID pattern
      )
      expect(NO_VISIBLE_PRODUCTS_SENTINEL).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // UUID
      )
    })
  })

  describe("Scenario 2 — N≥2 open sellers with linked products", () => {
    it("sets filterableFields.id with the union of visible product IDs", async () => {
      const sellers: SellerRow[] = [
        {
          id: "seller_01HXAAAA",
          products: [{ id: "prod_01" }, { id: "prod_02" }],
        },
        {
          id: "seller_01HXBBBB",
          products: [{ id: "prod_03" }],
        },
        {
          id: "seller_01HXCCCC",
          products: [{ id: "prod_02" }, { id: "prod_04" }], // overlap on prod_02
        },
      ]
      const { req } = makeReq(sellers)
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      expect(next).toHaveBeenCalledWith()
      const idFilter = req.filterableFields.id as { $in: string[] }
      expect(idFilter).toBeDefined()
      // Order is insertion order from Set; assert as multiset.
      expect(new Set(idFilter.$in)).toEqual(
        new Set(["prod_01", "prod_02", "prod_03", "prod_04"]),
      )
      // Sentinel must NOT be present.
      expect(idFilter.$in).not.toContain(NO_VISIBLE_PRODUCTS_SENTINEL)
      // Must NOT set seller_id (cleanup-2 crash trigger)
      expect(req.filterableFields.seller_id).toBeUndefined()
      // Must NOT set seller.status (original Mercur 1.x crash trigger)
      expect(req.filterableFields.seller).toBeUndefined()
    })

    it("does NOT inject filterableFields.seller (Mercur 1.x crash guard)", async () => {
      const sellers: SellerRow[] = [
        { id: "seller_01HX1234", products: [{ id: "p1" }] },
        { id: "seller_01HX5678", products: [{ id: "p2" }] },
      ]
      const { req } = makeReq(sellers)
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      const ff = req.filterableFields as Record<string, unknown>
      expect(ff.seller).toBeUndefined()
      expect(ff.seller_id).toBeUndefined()
    })

    it("sellers with empty products arrays do NOT widen the visible set", async () => {
      const sellers: SellerRow[] = [
        { id: "seller_a", products: [] },
        { id: "seller_b", products: [{ id: "only_one" }] },
        { id: "seller_c" }, // no products field at all
      ]
      const { req } = makeReq(sellers)
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      expect(req.filterableFields.id).toEqual({ $in: ["only_one"] })
    })

    it("when ALL open sellers have zero products, falls back to sentinel", async () => {
      const sellers: SellerRow[] = [
        { id: "seller_a", products: [] },
        { id: "seller_b" },
      ]
      const { req } = makeReq(sellers)
      const next = jest.fn()

      await applySellerVisibilityFilter(req, {}, next)

      expect(req.filterableFields.id).toEqual({
        $in: [NO_VISIBLE_PRODUCTS_SENTINEL],
      })
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
        const sellers: SellerRow[] =
          i % 2 === 0
            ? [] // even: no open sellers
            : [{ id: `seller_market_${i}`, products: [{ id: `p_${i}` }] }] // odd: one open seller, one product
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
          expect(req.filterableFields?.id).toEqual({
            $in: [NO_VISIBLE_PRODUCTS_SENTINEL],
          })
        } else {
          expect(req.filterableFields?.id).toEqual({ $in: [`p_${i}`] })
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

    it("patch file contains cleanup-11 link-traversal pattern (not earlier shapes)", () => {
      const fs = require("fs")
      const path = require("path")
      const patchPath = path.join(
        __dirname,
        "../../patches/@mercurjs__core@2.1.1.patch",
      )
      const content = fs.readFileSync(patchPath, "utf-8")

      // Patched version must contain async pre-fetch + link traversal + visible-product set.
      expect(content).toContain("query.graph")
      expect(content).toContain("visibleProductIds")
      expect(content).toContain("__no_visible_products__")
      expect(content).toContain('"products.id"')

      // Must NOT contain the original Mercur 1.x crash-inducing direct relation filter
      // (the removed lines start with "-" in the diff).
      expect(content).toContain("-    sellerFilter.status = types_1.SellerStatus.OPEN")

      // Must NOT contain the cleanup-2 seller_id-filter shape (the second known crash).
      // The patch must NOT inject filterableFields.seller_id at all.
      expect(content).not.toMatch(/^\+\s*filterableFields\.seller_id\s*=/m)

      // Explicit pagination take — guards B-2 latent scaling bug.
      expect(content).toContain("take: 10000")
    })
  })
})
