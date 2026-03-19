/**
 * Unit tests for gp-config-sync-catalog.ts
 *
 * Tests cover:
 * - parseArgs: argument parsing from args array and env vars
 * - normalizeHandle: handle normalization (lowercase, hyphens)
 * - validatePrerequisites: fail-fast on missing sales channel / shipping profile
 * - syncCategories: cross-market guard, inactive filtering, duplicate handles, parent refs
 * - syncCollections: cross-market guard, inactive filtering, missing handle
 * - syncProducts: runtime validation (H-8), cross-market guard (H-3), H-7 partial assignment
 * - evaluateQualityGate: quality gate criteria (description, price, image)
 * - isPlaceholderUrl: placeholder URL detection
 * - enforceVendorStatusGate: vendor status enforcement via vendor product files
 */

import {
  parseArgs,
  normalizeHandle,
  validatePrerequisites,
  syncCategories,
  syncCollections,
  syncProducts,
  evaluateQualityGate,
  isPlaceholderUrl,
  enforceVendorStatusGate,
  buildVendorPricingMap,
} from "../../scripts/gp-config-sync-catalog"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Map from DI key fragments → service mock name
const KEY_MAP: Record<string, string> = {
  saleschannel: "salesChannel",
  sales_channel: "salesChannel",
  fulfillment: "fulfillment",
  stocklocation: "stockLocation",
  stock_location: "stockLocation",
  region: "region",
  apikey: "apiKey",
  api_key: "apiKey",
}

function makeContainer(serviceOverrides: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    salesChannel: {
      listSalesChannels: jest.fn().mockResolvedValue([
        { id: "sc-bonbeauty", metadata: { gp_market_id: "bonbeauty" } },
      ]),
    },
    fulfillment: {
      listShippingProfiles: jest.fn().mockResolvedValue([{ id: "sp-default" }]),
    },
    stockLocation: {
      listStockLocations: jest.fn().mockResolvedValue([{ id: "sl-default" }]),
    },
    region: {
      listRegions: jest.fn().mockResolvedValue([{ id: "region-pl", currency_code: "PLN" }]),
    },
    apiKey: {
      listApiKeys: jest.fn().mockResolvedValue([{ id: "pak-1", type: "publishable" }]),
    },
  }

  const services = { ...defaults, ...serviceOverrides }

  return {
    resolve: jest.fn((key: string) => {
      const lowerKey = key.toLowerCase().replace(/-/g, "_")
      for (const [fragment, name] of Object.entries(KEY_MAP)) {
        if (lowerKey.includes(fragment)) {
          const svc = services[name]
          if (svc) return svc
        }
      }
      throw new Error(`Cannot resolve service: ${key}`)
    }),
    _services: services,
  }
}

function makeProductModuleService(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    // Categories — plural form as used in Medusa v2
    listProductCategories: jest.fn().mockResolvedValue([]),
    createProductCategories: jest.fn().mockImplementation(async (data: any) => ({
      id: `medusa-cat-${data.handle}`,
      handle: data.handle,
      metadata: data.metadata,
    })),
    updateProductCategories: jest.fn().mockResolvedValue({}),
    // Collections
    listProductCollections: jest.fn().mockResolvedValue([]),
    createProductCollections: jest.fn().mockImplementation(async (data: any) => ({
      id: `medusa-col-${data.handle}`,
      handle: data.handle,
      metadata: data.metadata,
    })),
    updateProductCollections: jest.fn().mockResolvedValue({}),
    // Products
    listProducts: jest.fn().mockResolvedValue([]),
    updateProducts: jest.fn().mockResolvedValue({}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_INSTANCE_ID
    delete process.env.GP_MARKET_ID
    delete process.env.GP_CONFIG_ROOT
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("parses instanceId, marketId from args array", () => {
    const result = parseArgs(["gp-dev", "bonbeauty"])
    expect(result.instanceId).toBe("gp-dev")
    expect(result.marketId).toBe("bonbeauty")
  })

  it("falls back to env vars when args are empty", () => {
    process.env.GP_INSTANCE_ID = "gp-prod"
    process.env.GP_MARKET_ID = "mercur"
    process.env.GP_CONFIG_ROOT = "/config"
    const result = parseArgs([])
    expect(result.instanceId).toBe("gp-prod")
    expect(result.marketId).toBe("mercur")
  })

  it("uses defaults when args and env are both missing", () => {
    process.env.GP_CONFIG_ROOT = "/config"
    const result = parseArgs(undefined)
    expect(result.instanceId).toBe("gp-dev")
    expect(result.marketId).toBe("bonbeauty")
  })
})

// ---------------------------------------------------------------------------
// normalizeHandle
// ---------------------------------------------------------------------------

describe("normalizeHandle", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(normalizeHandle("Twarz i Szyja")).toBe("twarz-i-szyja")
  })

  it("strips special characters and collapses consecutive hyphens", () => {
    // "Hair & Care!" → lowercase → "hair-&-care!" → strip special → "hair--care" → collapse → "hair-care"
    expect(normalizeHandle("Hair & Care!")).toBe("hair-care")
  })

  it("collapses multiple spaces to single hyphen", () => {
    expect(normalizeHandle("a  b  c")).toBe("a-b-c")
  })

  it("handles already-normalized handle", () => {
    expect(normalizeHandle("premium-core")).toBe("premium-core")
  })

  it("returns empty string for empty input", () => {
    expect(normalizeHandle("")).toBe("")
  })

  it("trims leading and trailing hyphens", () => {
    expect(normalizeHandle("---test---")).toBe("test")
  })
})

// ---------------------------------------------------------------------------
// validatePrerequisites
// ---------------------------------------------------------------------------

describe("validatePrerequisites", () => {
  it("returns salesChannelId and shippingProfileId on happy path", async () => {
    const container = makeContainer()
    const warnings: string[] = []
    const result = await validatePrerequisites(container, "bonbeauty", "PLN", warnings)
    expect(result.salesChannelId).toBe("sc-bonbeauty")
    expect(result.shippingProfileId).toBeDefined()
  })

  it("throws when no sales channel found for market", async () => {
    // Default mock has "bonbeauty" channel only — "unknown-market" won't match any
    const container = makeContainer()
    const warnings: string[] = []
    await expect(validatePrerequisites(container, "unknown-market", "PLN", warnings)).rejects.toThrow(
      /Sales channel not found for market 'unknown-market'/
    )
  })

  it("throws when multiple sales channels found for market", async () => {
    const container = makeContainer({
      salesChannel: {
        listSalesChannels: jest.fn().mockResolvedValue([
          { id: "sc-1", metadata: { gp_market_id: "bonbeauty" } },
          { id: "sc-2", metadata: { gp_market_id: "bonbeauty" } },
        ]),
      },
    })
    const warnings: string[] = []
    await expect(validatePrerequisites(container, "bonbeauty", "PLN", warnings)).rejects.toThrow(
      /Multiple sales channels/
    )
  })

  it("throws when no shipping profile exists", async () => {
    const container = makeContainer({
      fulfillment: {
        listShippingProfiles: jest.fn().mockResolvedValue([]),
      },
    })
    const warnings: string[] = []
    await expect(validatePrerequisites(container, "bonbeauty", "PLN", warnings)).rejects.toThrow(
      /No shipping profile/i
    )
  })
})

// ---------------------------------------------------------------------------
// syncCategories
// ---------------------------------------------------------------------------

describe("syncCategories", () => {
  it("creates a new category and returns it in fixtureToMedusaMap", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts, fixtureToMedusaMap } = await syncCategories(
      svc,
      [{ category_id: "cat-1", name: "Twarz", handle: "twarz" }],
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(1)
    expect(counts.updated).toBe(0)
    expect(fixtureToMedusaMap.get("cat-1")).toMatch(/medusa-cat-twarz/)
    expect(warnings).toHaveLength(0)
  })

  it("updates an existing category (same market)", async () => {
    const svc = makeProductModuleService({
      listProductCategories: jest.fn().mockResolvedValue([
        { id: "existing-123", handle: "twarz", metadata: { gp: { market_id: "bonbeauty" } } },
      ]),
    })
    const warnings: string[] = []

    const { counts } = await syncCategories(
      svc,
      [{ category_id: "cat-1", name: "Twarz Updated", handle: "twarz" }],
      "bonbeauty",
      warnings
    )

    expect(counts.updated).toBe(1)
    expect(counts.created).toBe(0)
  })

  it("skips and warns for cross-market category (H-3)", async () => {
    const svc = makeProductModuleService({
      listProductCategories: jest.fn().mockResolvedValue([
        { id: "foreign-cat", handle: "twarz", metadata: { gp: { market_id: "bonbeauty" } } },
      ]),
    })
    const warnings: string[] = []

    const { counts } = await syncCategories(
      svc,
      [{ category_id: "cat-mercur", name: "Twarz", handle: "twarz" }],
      "mercur", // different market
      warnings
    )

    expect(counts.skipped).toBe(1)
    expect(warnings.some((w) => w.includes("cross-market guard"))).toBe(true)
  })

  it("filters out inactive categories (D-3)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts } = await syncCategories(
      svc,
      [
        { category_id: "cat-active", name: "Active", handle: "active" },
        { category_id: "cat-inactive", name: "Inactive", handle: "inactive", active: false },
      ],
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(1) // only active
    expect(svc.listProductCategories).toHaveBeenCalledTimes(1)
  })

  it("warns on duplicate handles in fixture and skips second occurrence", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts } = await syncCategories(
      svc,
      [
        { category_id: "cat-1", name: "Cat A", handle: "twarz" },
        { category_id: "cat-2", name: "Cat B", handle: "twarz" }, // duplicate — must be skipped
      ],
      "bonbeauty",
      warnings
    )

    expect(warnings.some((w) => w.includes("duplicate handle"))).toBe(true)
    // Second occurrence must be actually skipped (not just warned)
    expect(counts.created).toBe(1)
    expect(counts.skipped).toBe(1)
  })

  it("3x run is idempotent — counts stable across runs (AC-2 idempotency)", async () => {
    const categories = [{ category_id: "cat-1", name: "Twarz", handle: "twarz" }]
    const existingCategory = [
      { id: "medusa-cat-twarz", handle: "twarz", metadata: { gp: { market_id: "bonbeauty" } } },
    ]

    // First run: category does not exist → creates
    const svc1 = makeProductModuleService()
    const { counts: counts1 } = await syncCategories(svc1, categories, "bonbeauty", [])
    expect(counts1.created).toBe(1)
    expect(counts1.updated).toBe(0)

    // Second run: same fixture, category exists → updates (not creates)
    const svc2 = makeProductModuleService({
      listProductCategories: jest.fn().mockResolvedValue(existingCategory),
    })
    const { counts: counts2 } = await syncCategories(svc2, categories, "bonbeauty", [])
    expect(counts2.created).toBe(0)
    expect(counts2.updated).toBe(1)

    // Third run: same fixture again → still updates (counts stable, no drift)
    const svc3 = makeProductModuleService({
      listProductCategories: jest.fn().mockResolvedValue(existingCategory),
    })
    const { counts: counts3 } = await syncCategories(svc3, categories, "bonbeauty", [])
    expect(counts3.created).toBe(0)
    expect(counts3.updated).toBe(1)
  })

  it("skips category with missing handle and pushes warning (H-8)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts } = await syncCategories(
      svc,
      [{ category_id: "cat-nhandle", name: "No Handle", handle: "" }],
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(0)
    expect(warnings.some((w) => w.includes("missing handle"))).toBe(true)
  })

  it("warns when parent_category_id references unknown fixture id", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    await syncCategories(
      svc,
      [{ category_id: "cat-child", name: "Child", handle: "child", parent_category_id: "nonexistent" }],
      "bonbeauty",
      warnings
    )

    expect(warnings.some((w) => w.includes("parent_category_id") && w.includes("not found"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// syncCollections
// ---------------------------------------------------------------------------

describe("syncCollections", () => {
  it("creates a new collection", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts, fixtureToMedusaMap } = await syncCollections(
      svc,
      [{ collection_id: "col-1", title: "Premium Core", handle: "premium-core" }],
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(1)
    expect(fixtureToMedusaMap.get("col-1")).toMatch(/medusa-col-premium-core/)
  })

  it("skips and warns for cross-market collection (H-3)", async () => {
    const svc = makeProductModuleService({
      listProductCollections: jest.fn().mockResolvedValue([
        { id: "col-foreign", handle: "premium-core", metadata: { gp: { market_id: "bonbeauty" } } },
      ]),
    })
    const warnings: string[] = []

    const { counts } = await syncCollections(
      svc,
      [{ collection_id: "col-mercur", title: "Premium Core", handle: "premium-core" }],
      "mercur",
      warnings
    )

    expect(counts.skipped).toBe(1)
    expect(warnings.some((w) => w.includes("cross-market guard"))).toBe(true)
  })

  it("filters out inactive collections (D-3)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts } = await syncCollections(
      svc,
      [
        { collection_id: "col-active", title: "Active", handle: "active-col" },
        { collection_id: "col-inactive", title: "Inactive", handle: "inactive-col", active: false },
      ],
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(1)
  })

  it("skips collection with missing handle and warns (H-8)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const { counts } = await syncCollections(
      svc,
      [{ collection_id: "col-nhandle", title: "No Handle", handle: "" }],
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(0)
    expect(warnings.some((w) => w.includes("missing handle"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// syncProducts
// ---------------------------------------------------------------------------

describe("syncProducts", () => {
  const prereqs = { salesChannelId: "sc-bonbeauty", shippingProfileId: "sp-default" }
  const emptyMaps = { categoryMap: new Map<string, string>(), collectionMap: new Map<string, string>() }

  function makeContainer2() {
    return {
      resolve: jest.fn().mockReturnValue({}),
    }
  }

  it("skips product with empty handle and warns (H-8)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const counts = await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-1", name: "No Handle", handle: "", base_price: { amount: 0, currency: "PLN" } }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(0)
    expect(warnings.some((w) => w.includes("missing handle"))).toBe(true)
  })

  it("skips product with non-numeric base_price.amount and warns (H-8)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const counts = await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-2", name: "Bad Price", handle: "bad-price", base_price: { amount: "free" as any, currency: "PLN" } }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(0)
    expect(warnings.some((w) => w.includes("base_price.amount is not a number"))).toBe(true)
  })

  it("skips product with empty currency and warns (H-8)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const counts = await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-3", name: "No Currency", handle: "no-currency", base_price: { amount: 0, currency: "" } }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    expect(counts.created).toBe(0)
    expect(warnings.some((w) => w.includes("base_price.currency is empty"))).toBe(true)
  })

  it("skips cross-market product and warns (H-3)", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        { id: "p-foreign", handle: "haircut", metadata: { gp: { market_id: "bonbeauty" } } },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-mercur", name: "Haircut", handle: "haircut", base_price: { amount: 0, currency: "PLN" } }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "mercur", // different market
      warnings
    )

    expect(counts.skipped).toBe(1)
    expect(warnings.some((w) => w.includes("cross-market guard"))).toBe(true)
  })

  it("warns when category_id not in categoryMap (H-7 partial assignment)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-5", name: "Product", handle: "product-5", base_price: { amount: 50, currency: "PLN" }, category_id: "cat-nonexistent" }],
      prereqs,
      emptyMaps.categoryMap, // empty map — category unresolved
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    expect(warnings.some((w) => w.includes("category_id") && w.includes("not in category map"))).toBe(true)
  })

  it("update payload does not contain variants or prices — pricing preserved (H-4, AC-2)", async () => {
    // Existing product with matching market
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "existing-prod",
          handle: "nail-art",
          categories: [],
          metadata: { gp: { market_id: "bonbeauty" } },
        },
      ]),
    })
    const warnings: string[] = []

    await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-nail", name: "Nail Art", handle: "nail-art", base_price: { amount: 50, currency: "PLN" } }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    // Must have triggered an update (not create) for existing product
    expect(svc.updateProducts).toHaveBeenCalledTimes(1)

    // H-4: updateProducts payload must NOT contain variants or prices (preserve existing pricing)
    const [, updatePayload] = (svc.updateProducts as jest.Mock).mock.calls[0]
    expect(updatePayload).not.toHaveProperty("variants")
    expect(updatePayload).not.toHaveProperty("prices")
    expect(updatePayload).toHaveProperty("title", "Nail Art")
    // Quality gate: short description + no photo_url → draft
    expect(updatePayload).toHaveProperty("status", "draft")
  })

  it("filters out inactive products (D-3)", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []

    const counts = await syncProducts(
      makeContainer2(),
      svc,
      [
        { product_id: "p-active", name: "Active", handle: "active-prod", base_price: { amount: 0, currency: "PLN" } },
        { product_id: "p-inactive", name: "Inactive", handle: "inactive-prod", base_price: { amount: 0, currency: "PLN" }, active: false },
      ],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    // Only active product is processed — listProducts called once
    expect(svc.listProducts).toHaveBeenCalledTimes(1)
    expect(svc.listProducts).toHaveBeenCalledWith(
      { handle: "active-prod" },
      expect.anything()
    )
  })

  it("quality gate: product with short description → draft status on sync", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "existing-prod",
          handle: "short-desc",
          categories: [],
          metadata: { gp: { market_id: "bonbeauty" } },
        },
      ]),
    })
    const warnings: string[] = []

    await syncProducts(
      makeContainer2(),
      svc,
      [{
        product_id: "p-short",
        name: "Short Desc",
        handle: "short-desc",
        description: "Only a few words here.",
        base_price: { amount: 150, currency: "PLN" },
        photo_url: "https://real-cdn.example.org/image.jpg",
      }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = (svc.updateProducts as jest.Mock).mock.calls[0]
    expect(payload).toHaveProperty("status", "draft")
  })

  it("quality gate: product with ≥80 words + image + price → published status on sync", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "existing-prod",
          handle: "full-desc",
          categories: [],
          metadata: { gp: { market_id: "bonbeauty" } },
        },
      ]),
    })
    const warnings: string[] = []

    const longDesc = Array(85).fill("word").join(" ")
    await syncProducts(
      makeContainer2(),
      svc,
      [{
        product_id: "p-full",
        name: "Full Product",
        handle: "full-desc",
        description: longDesc,
        base_price: { amount: 150, currency: "PLN" },
        photo_url: "https://real-cdn.example.org/products/full/thumb.jpg",
      }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = (svc.updateProducts as jest.Mock).mock.calls[0]
    expect(payload).toHaveProperty("status", "published")
  })

  it("quality gate: product with price=0 + short desc → draft (quality gate, not vendor gate)", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "existing-prod",
          handle: "inactive-vendor-prod",
          categories: [],
          metadata: { gp: { market_id: "bonbeauty" } },
        },
      ]),
    })
    const warnings: string[] = []

    await syncProducts(
      makeContainer2(),
      svc,
      [{
        product_id: "p-inactive-v",
        name: "Inactive Vendor Product",
        handle: "inactive-vendor-prod",
        description: "Short description",
        base_price: { amount: 0, currency: "PLN" },
      }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      "bonbeauty",
      warnings
    )

    // Price=0 + short desc → draft
    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = (svc.updateProducts as jest.Mock).mock.calls[0]
    expect(payload).toHaveProperty("status", "draft")
  })
})

// ---------------------------------------------------------------------------
// evaluateQualityGate
// ---------------------------------------------------------------------------

describe("evaluateQualityGate", () => {
  it("returns published when all gates pass", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 150, currency: "PLN" },
      description: longDesc,
      photo_url: "https://real-cdn.example.org/products/image.jpg",
    })
    expect(result.status).toBe("published")
    expect(result.reasons).toHaveLength(0)
  })

  it("returns draft when description <80 words", () => {
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 150, currency: "PLN" },
      description: "Short description only.",
      photo_url: "https://real-cdn.example.org/image.jpg",
    })
    expect(result.status).toBe("draft")
    expect(result.reasons.some((r) => r.includes("words="))).toBe(true)
  })

  it("returns draft when price is 0", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 0, currency: "PLN" },
      description: longDesc,
      photo_url: "https://real-cdn.example.org/image.jpg",
    })
    expect(result.status).toBe("draft")
    expect(result.reasons.some((r) => r.includes("price="))).toBe(true)
  })

  it("returns published when price is 0 but vendorPricing is true", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate(
      {
        product_id: "p-1",
        name: "Test",
        base_price: { amount: 0, currency: "PLN" },
        description: longDesc,
        photo_url: "https://real-cdn.example.org/image.jpg",
      },
      { vendorPricing: true }
    )
    expect(result.status).toBe("published")
    expect(result.reasons).toHaveLength(0)
  })

  it("returns draft when price is 0 and vendorPricing is false", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate(
      {
        product_id: "p-1",
        name: "Test",
        base_price: { amount: 0, currency: "PLN" },
        description: longDesc,
        photo_url: "https://real-cdn.example.org/image.jpg",
      },
      { vendorPricing: false }
    )
    expect(result.status).toBe("draft")
    expect(result.reasons.some((r) => r.includes("price="))).toBe(true)
  })

  it("returns draft when image is missing", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 150, currency: "PLN" },
      description: longDesc,
    })
    expect(result.status).toBe("draft")
    expect(result.reasons.some((r) => r.includes("image=missing"))).toBe(true)
  })

  it("returns draft when image URL is a placeholder", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 150, currency: "PLN" },
      description: longDesc,
      photo_url: "https://via.placeholder.com/400x300",
    })
    expect(result.status).toBe("draft")
    expect(result.reasons.some((r) => r.includes("image=placeholder"))).toBe(true)
  })

  it("returns draft when image URL is cdn.example.com", () => {
    const longDesc = Array(85).fill("word").join(" ")
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 150, currency: "PLN" },
      description: longDesc,
      photo_url: "https://cdn.example.com/gp/bonbeauty/products/srv_0101/thumb.jpg",
    })
    expect(result.status).toBe("draft")
    expect(result.reasons.some((r) => r.includes("image=placeholder"))).toBe(true)
  })

  it("accumulates multiple failure reasons", () => {
    const result = evaluateQualityGate({
      product_id: "p-1",
      name: "Test",
      base_price: { amount: 0, currency: "PLN" },
      description: "Short",
    })
    expect(result.status).toBe("draft")
    expect(result.reasons.length).toBeGreaterThanOrEqual(3) // words, price, image
  })
})

// ---------------------------------------------------------------------------
// isPlaceholderUrl
// ---------------------------------------------------------------------------

describe("isPlaceholderUrl", () => {
  it("detects via.placeholder.com URLs", () => {
    expect(isPlaceholderUrl("https://via.placeholder.com/400x300")).toBe(true)
  })

  it("detects placeholder in path", () => {
    expect(isPlaceholderUrl("https://cdn.example.com/placeholder.jpg")).toBe(true)
  })

  it("detects no-image pattern", () => {
    expect(isPlaceholderUrl("https://cdn.example.com/no-image.png")).toBe(true)
  })

  it("detects default-product pattern", () => {
    expect(isPlaceholderUrl("https://cdn.example.com/default-product.jpg")).toBe(true)
  })

  it("detects cdn.example.com as placeholder", () => {
    expect(isPlaceholderUrl("https://cdn.example.com/gp/bonbeauty/products/srv_0101/thumb.jpg")).toBe(true)
  })

  it("returns false for normal product images", () => {
    expect(isPlaceholderUrl("https://real-cdn.example.org/products/srv_0101/thumb.jpg")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// enforceVendorStatusGate
// ---------------------------------------------------------------------------

// Mock fs and js-yaml for file reads in enforceVendorStatusGate
jest.mock("node:fs/promises", () => ({
  readFile: jest.fn(),
}))

import fs from "node:fs/promises"
import * as yaml from "js-yaml"

describe("enforceVendorStatusGate", () => {
  const mockReadFile = fs.readFile as jest.Mock

  beforeEach(() => {
    mockReadFile.mockReset()
  })

  function setupFiles(marketYaml: object, vendorFiles: Record<string, object>) {
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("market.yaml")) {
        return yaml.dump(marketYaml)
      }
      for (const [vendorId, data] of Object.entries(vendorFiles)) {
        if (filePath.includes(`vendors/${vendorId}/products.yaml`)) {
          return yaml.dump(data)
        }
      }
      throw new Error(`File not found: ${filePath}`)
    })
  }

  it("drafts products from suspended vendor based on vendor product file", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "good-vendor", status: "active" },
          { vendor_id: "bad-vendor", status: "suspended" },
        ],
      },
      {
        "bad-vendor": {
          vendor_id: "bad-vendor",
          market_id: "bonbeauty",
          products: [{ product_id: "srv_0101" }, { product_id: "srv_0102" }],
        },
      }
    )

    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        { id: "p1", handle: "product-1", status: "published", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_0101" } } },
        { id: "p2", handle: "product-2", status: "published", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_0102" } } },
        { id: "p3", handle: "product-3", status: "published", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_0201" } } },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(2)
    expect(svc.updateProducts).toHaveBeenCalledTimes(2)
    expect(svc.updateProducts).toHaveBeenCalledWith("p1", { status: "draft" })
    expect(svc.updateProducts).toHaveBeenCalledWith("p2", { status: "draft" })
    expect(warnings).toHaveLength(0)
  })

  it("skips products already in draft status", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [{ vendor_id: "bad-vendor", status: "suspended" }],
      },
      {
        "bad-vendor": {
          vendor_id: "bad-vendor",
          market_id: "bonbeauty",
          products: [{ product_id: "srv_0101" }],
        },
      }
    )

    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        { id: "p1", handle: "product-1", status: "draft", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_0101" } } },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.updateProducts).not.toHaveBeenCalled()
  })

  it("returns 0 when all vendors are active", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [{ vendor_id: "good-vendor", status: "active" }],
      },
      {}
    )

    const svc = {
      listProducts: jest.fn(),
      updateProducts: jest.fn(),
    }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.listProducts).not.toHaveBeenCalled()
  })

  it("treats 'onboarded' as active — does NOT draft products from onboarded vendors", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [{ vendor_id: "new-vendor", status: "onboarded" }],
      },
      {
        "new-vendor": {
          vendor_id: "new-vendor",
          market_id: "bonbeauty",
          products: [{ product_id: "srv_0301" }],
        },
      }
    )

    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        { id: "p1", handle: "product-1", status: "published", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_0301" } } },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.updateProducts).not.toHaveBeenCalled()
  })

  it("warns when market.yaml is unreadable", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))

    const svc = { listProducts: jest.fn(), updateProducts: jest.fn() }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/missing/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(warnings.some((w) => w.includes("cannot read market.yaml"))).toBe(true)
  })

  it("warns when vendor product file is missing but continues", async () => {
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("market.yaml")) {
        return yaml.dump({
          market_id: "bonbeauty",
          vendors: [{ vendor_id: "ghost-vendor", status: "suspended" }],
        })
      }
      throw new Error("ENOENT")
    })

    const svc = { listProducts: jest.fn(), updateProducts: jest.fn() }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(warnings.some((w) => w.includes("ghost-vendor"))).toBe(true)
  })

  it("ignores products from other markets", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [{ vendor_id: "bad-vendor", status: "suspended" }],
      },
      {
        "bad-vendor": {
          vendor_id: "bad-vendor",
          market_id: "bonbeauty",
          products: [{ product_id: "srv_0101" }],
        },
      }
    )

    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        { id: "p1", handle: "product-1", status: "published", metadata: { gp: { market_id: "other-market", fixture_id: "srv_0101" } } },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.updateProducts).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// buildVendorPricingMap
// ---------------------------------------------------------------------------

describe("buildVendorPricingMap", () => {
  const mockReadFile = fs.readFile as jest.Mock

  beforeEach(() => {
    mockReadFile.mockReset()
  })

  function setupFiles(marketYaml: object, vendorFiles: Record<string, object>) {
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("market.yaml")) {
        return yaml.dump(marketYaml)
      }
      for (const [vendorId, data] of Object.entries(vendorFiles)) {
        if (filePath.includes(`vendors/${vendorId}/products.yaml`)) {
          return yaml.dump(data)
        }
      }
      throw new Error(`File not found: ${filePath}`)
    })
  }

  it("returns map with product_ids that have vendor pricing from active vendors", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "city-beauty", status: "active" },
          { vendor_id: "kremidotyk", status: "onboarded" },
        ],
      },
      {
        "city-beauty": {
          vendor_id: "city-beauty",
          products: [
            { product_id: "srv_0101", status: "active", vendor_price: { amount: 160, currency: "PLN" } },
            { product_id: "srv_0102", status: "active", vendor_price: { amount: 0, currency: "PLN" } },
          ],
        },
        "kremidotyk": {
          vendor_id: "kremidotyk",
          products: [
            { product_id: "srv_0401", status: "active", vendor_price: { amount: 180, currency: "PLN" } },
          ],
        },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings)

    expect(map.get("srv_0101")).toBe(true)
    expect(map.has("srv_0102")).toBe(false) // price=0 — not valid vendor pricing
    expect(map.get("srv_0401")).toBe(true) // onboarded vendor counts as active
    expect(warnings).toHaveLength(0)
  })

  it("excludes products from suspended vendors", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "bad-vendor", status: "suspended" },
        ],
      },
      {
        "bad-vendor": {
          vendor_id: "bad-vendor",
          products: [
            { product_id: "srv_0101", status: "active", vendor_price: { amount: 200, currency: "PLN" } },
          ],
        },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings)

    expect(map.size).toBe(0)
  })

  it("returns empty map when market.yaml is unreadable", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/missing/market.yaml", warnings)

    expect(map.size).toBe(0)
  })
})
