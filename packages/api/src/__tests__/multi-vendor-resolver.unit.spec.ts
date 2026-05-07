/**
 * Unit tests for multi-vendor resolver (story v160-cleanup-12a)
 *
 * Tests:
 * T7 — AC1/AC2/AC3: 2-seller product yields vendor_count=2 + vendor_offers.length=2
 *     1-seller product yields vendor_count=1 + vendor_offers.length=1
 * AC3: vendor_offers sorted by (price_pln ASC, seller_id ASC)
 * AC4: isMultiVendorPricingEnabled reads MULTI_VENDOR_PRICING_ENABLED env var
 * Review F4: zero sellers → vendor_count=0, vendor_offers=[], lowest_price_pln=null
 */

// Isolate from real DB — all Knex calls are mocked.
import { resolveVendorMeta, augmentProductsWithVendorMeta, isMultiVendorPricingEnabled } from "../lib/multi-vendor-resolver"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal Knex mock that returns the provided rows for the chain. */
function makeKnexMock(rows: Record<string, unknown>[]) {
  const chain: Record<string, unknown> = {}
  const chainMethod = jest.fn().mockReturnValue(chain)
  chain.select = chainMethod
  chain.innerJoin = chainMethod
  chain.leftJoin = chainMethod
  chain.whereIn = chainMethod
  chain.where = chainMethod
  chain.whereNull = chainMethod
  chain.groupBy = jest.fn().mockResolvedValue(rows)

  const dbFn = jest.fn().mockReturnValue(chain) as unknown as {
    (table: string): typeof chain
    raw: jest.MockedFunction<(sql: string) => unknown>
  }
  dbFn.raw = jest.fn().mockImplementation((sql: string) => sql)
  return dbFn
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveVendorMeta
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveVendorMeta", () => {
  it("returns empty map for empty productIds", async () => {
    const db = makeKnexMock([])
    const result = await resolveVendorMeta(db as unknown as import("knex").Knex, [])
    expect(result.size).toBe(0)
  })

  it("T7 — 2-seller product yields vendor_count=2 + vendor_offers.length=2", async () => {
    const rows = [
      {
        product_id: "prod_1",
        seller_id: "seller_A",
        seller_name: "City Beauty",
        seller_handle: "city-beauty",
        min_price: "8000",
      },
      {
        product_id: "prod_1",
        seller_id: "seller_B",
        seller_name: "KremiDotyk",
        seller_handle: "kremidotyk",
        min_price: "6500",
      },
    ]
    const db = makeKnexMock(rows)
    const result = await resolveVendorMeta(db as unknown as import("knex").Knex, ["prod_1"])

    const meta = result.get("prod_1")
    expect(meta).toBeDefined()
    expect(meta!.vendor_count).toBe(2)
    expect(meta!.vendor_offers).toHaveLength(2)
  })

  it("T7 — 1-seller product yields vendor_count=1 + vendor_offers.length=1", async () => {
    const rows = [
      {
        product_id: "prod_2",
        seller_id: "seller_A",
        seller_name: "City Beauty",
        seller_handle: "city-beauty",
        min_price: "5000",
      },
    ]
    const db = makeKnexMock(rows)
    const result = await resolveVendorMeta(db as unknown as import("knex").Knex, ["prod_2"])

    const meta = result.get("prod_2")
    expect(meta).toBeDefined()
    expect(meta!.vendor_count).toBe(1)
    expect(meta!.vendor_offers).toHaveLength(1)
  })

  it("AC3 — vendor_offers sorted by price_pln ASC, seller_id ASC for ties", async () => {
    const rows = [
      {
        product_id: "prod_3",
        seller_id: "seller_Z",
        seller_name: "Seller Z",
        seller_handle: "seller-z",
        min_price: "5000",
      },
      {
        product_id: "prod_3",
        seller_id: "seller_A",
        seller_name: "Seller A",
        seller_handle: "seller-a",
        min_price: "5000", // Same price → tie-break by seller_id ASC
      },
      {
        product_id: "prod_3",
        seller_id: "seller_M",
        seller_name: "Seller M",
        seller_handle: "seller-m",
        min_price: "3000", // Lowest → first
      },
    ]
    const db = makeKnexMock(rows)
    const result = await resolveVendorMeta(db as unknown as import("knex").Knex, ["prod_3"])

    const meta = result.get("prod_3")!
    expect(meta.vendor_offers[0].seller_id).toBe("seller_M") // cheapest
    expect(meta.vendor_offers[1].seller_id).toBe("seller_A") // tie, A < Z
    expect(meta.vendor_offers[2].seller_id).toBe("seller_Z")
    expect(meta.lowest_price_pln).toBe(3000)
  })

  it("AC2 — lowest_price_pln = min of min_price across all sellers", async () => {
    const rows = [
      {
        product_id: "prod_4",
        seller_id: "seller_A",
        seller_name: "A",
        seller_handle: "a",
        min_price: "12000",
      },
      {
        product_id: "prod_4",
        seller_id: "seller_B",
        seller_name: "B",
        seller_handle: "b",
        min_price: "9900",
      },
    ]
    const db = makeKnexMock(rows)
    const result = await resolveVendorMeta(db as unknown as import("knex").Knex, ["prod_4"])

    const meta = result.get("prod_4")!
    expect(meta.lowest_price_pln).toBe(9900)
  })

  it("AC3 — vendor_offers include lat: null, lng: null when seller has no geo", async () => {
    const rows = [
      {
        product_id: "prod_5",
        seller_id: "seller_A",
        seller_name: "A",
        seller_handle: "a",
        min_price: "5000",
      },
    ]
    const db = makeKnexMock(rows)
    const result = await resolveVendorMeta(db as unknown as import("knex").Knex, ["prod_5"])

    const offer = result.get("prod_5")!.vendor_offers[0]
    expect(offer.lat).toBeNull()
    expect(offer.lng).toBeNull()
  })

  it("Review F4 — product not in result map has no sellers (zero open sellers)", async () => {
    // DB returns no rows for prod_no_sellers
    const db = makeKnexMock([])
    const result = await resolveVendorMeta(
      db as unknown as import("knex").Knex,
      ["prod_no_sellers"]
    )
    // Not in map → augmentProductsWithVendorMeta will apply zero-state defaults
    expect(result.has("prod_no_sellers")).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// augmentProductsWithVendorMeta
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentProductsWithVendorMeta", () => {
  it("augments product with vendor meta when sellers exist", async () => {
    const rows = [
      {
        product_id: "prod_1",
        seller_id: "seller_A",
        seller_name: "City Beauty",
        seller_handle: "city-beauty",
        min_price: "7500",
      },
      {
        product_id: "prod_1",
        seller_id: "seller_B",
        seller_name: "KremiDotyk",
        seller_handle: "kremidotyk",
        min_price: "9000",
      },
    ]
    const db = makeKnexMock(rows)
    const products: Array<Record<string, unknown>> = [{ id: "prod_1", title: "Test Product" }]

    await augmentProductsWithVendorMeta(products, db as unknown as import("knex").Knex)

    expect(products[0].vendor_count).toBe(2)
    expect(products[0].lowest_price_pln).toBe(7500)
    expect(Array.isArray(products[0].vendor_offers)).toBe(true)
    expect((products[0].vendor_offers as unknown[]).length).toBe(2)
  })

  it("Review F4 — sets vendor_count=0, lowest_price_pln=null, vendor_offers=[] when no sellers", async () => {
    const db = makeKnexMock([]) // no rows → no open sellers
    const products: Array<Record<string, unknown>> = [{ id: "prod_no_sellers", title: "Orphan" }]

    await augmentProductsWithVendorMeta(products, db as unknown as import("knex").Knex)

    expect(products[0].vendor_count).toBe(0)
    expect(products[0].lowest_price_pln).toBeNull()
    expect(products[0].vendor_offers).toEqual([])
  })

  it("handles empty products array gracefully", async () => {
    const db = makeKnexMock([])
    // Should not throw
    await expect(
      augmentProductsWithVendorMeta([], db as unknown as import("knex").Knex)
    ).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isMultiVendorPricingEnabled (AC4)
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiVendorPricingEnabled (AC4)", () => {
  const ORIGINAL_ENV = process.env.MULTI_VENDOR_PRICING_ENABLED

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MULTI_VENDOR_PRICING_ENABLED
    } else {
      process.env.MULTI_VENDOR_PRICING_ENABLED = ORIGINAL_ENV
    }
  })

  it("returns true when MULTI_VENDOR_PRICING_ENABLED=true", () => {
    process.env.MULTI_VENDOR_PRICING_ENABLED = "true"
    expect(isMultiVendorPricingEnabled()).toBe(true)
  })

  it("returns false when MULTI_VENDOR_PRICING_ENABLED=false", () => {
    process.env.MULTI_VENDOR_PRICING_ENABLED = "false"
    expect(isMultiVendorPricingEnabled()).toBe(false)
  })

  it("returns false when MULTI_VENDOR_PRICING_ENABLED is unset", () => {
    delete process.env.MULTI_VENDOR_PRICING_ENABLED
    expect(isMultiVendorPricingEnabled()).toBe(false)
  })

  it("returns false for truthy-but-not-exact values like '1' or 'yes'", () => {
    process.env.MULTI_VENDOR_PRICING_ENABLED = "1"
    expect(isMultiVendorPricingEnabled()).toBe(false)
    process.env.MULTI_VENDOR_PRICING_ENABLED = "yes"
    expect(isMultiVendorPricingEnabled()).toBe(false)
    process.env.MULTI_VENDOR_PRICING_ENABLED = "TRUE"
    expect(isMultiVendorPricingEnabled()).toBe(false)
  })
})
