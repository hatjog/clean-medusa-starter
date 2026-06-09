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
  draftOrphanMarketProducts,
  buildVendorPricingMap,
  buildProductGpMetadata,
  loadEntitlementProfileMap,
  resolveProductEntitlementProfile,
} from "../../scripts/gp-config-sync-catalog"
import { DryRunCollector } from "../../scripts/gp-sync-dry-run"

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
    delete process.env.GP_DRY_RUN
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("parses instanceId, marketId from args array", () => {
    const result = parseArgs(["gp-dev", "bonbeauty"])
    expect(result.instanceId).toBe("gp-dev")
    expect(result.marketId).toBe("bonbeauty")
    expect(result.dryRun).toBe(false)
  })

  it("falls back to env vars when args are empty", () => {
    process.env.GP_INSTANCE_ID = "gp-prod"
    process.env.GP_MARKET_ID = "mercur"
    process.env.GP_CONFIG_ROOT = "/config"
    const result = parseArgs([])
    expect(result.instanceId).toBe("gp-prod")
    expect(result.marketId).toBe("mercur")
    expect(result.dryRun).toBe(false)
  })

  it("uses defaults when args and env are both missing", () => {
    process.env.GP_CONFIG_ROOT = "/config"
    const result = parseArgs(undefined)
    expect(result.instanceId).toBe("gp-dev")
    expect(result.marketId).toBe("bonbeauty")
    expect(result.dryRun).toBe(false)
  })

  it("parses dryRun from flag and env var", () => {
    process.env.GP_CONFIG_ROOT = "/config"
    process.env.GP_DRY_RUN = "true"

    expect(parseArgs(undefined).dryRun).toBe(true)
    expect(parseArgs(["gp-dev", "bonbeauty", "--dry-run"]).dryRun).toBe(true)
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
// draftOrphanMarketProducts
// ---------------------------------------------------------------------------

describe("draftOrphanMarketProducts", () => {
  it("drafts only market-scoped products missing from configured fixture ids", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "prod-keep",
          handle: "keep-me",
          status: "published",
          metadata: { gp: { market_id: "bonbeauty", fixture_id: "prod-001" } },
        },
        {
          id: "prod-orphan",
          handle: "orphan-me",
          status: "published",
          metadata: { gp: { market_id: "bonbeauty", fixture_id: "prod-999" } },
        },
        {
          id: "prod-other-market",
          handle: "other-market",
          status: "published",
          metadata: { gp: { market_id: "mercur", fixture_id: "prod-999" } },
        },
        {
          id: "prod-already-draft",
          handle: "already-draft",
          status: "draft",
          metadata: { gp: { market_id: "bonbeauty", fixture_id: "prod-998" } },
        },
      ]),
    })
    const warnings: string[] = []

    const result = await draftOrphanMarketProducts(
      svc,
      new Set(["prod-001"]),
      "bonbeauty",
      warnings
    )

    expect(result).toEqual({ draftedCount: 1 })
    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    expect(svc.updateProducts).toHaveBeenCalledWith("prod-orphan", { status: "draft" })
    expect(warnings).toHaveLength(0)
  })

  it("records dry-run draft operations without touching the DB", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "prod-orphan",
          handle: "orphan-me",
          status: "published",
          metadata: { gp: { market_id: "bonbeauty", fixture_id: "prod-999" } },
        },
      ]),
    })
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const result = await draftOrphanMarketProducts(
      svc,
      new Set(["prod-001"]),
      "bonbeauty",
      warnings,
      collector
    )

    expect(result).toEqual({ draftedCount: 1 })
    expect(svc.updateProducts).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "product",
          handle: "orphan-me",
          action: "update",
          note: "status=draft (missing from gp-config)",
        }),
      ])
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

  it("records planned category writes in dry-run without touching DB", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const { counts, fixtureToMedusaMap } = await syncCategories(
      svc,
      [{ category_id: "cat-1", name: "Twarz", handle: "twarz" }],
      "bonbeauty",
      warnings,
      collector
    )

    expect(counts.created).toBe(1)
    expect(fixtureToMedusaMap.get("cat-1")).toBe("dry-run-category-cat-1")
    expect(svc.createProductCategories).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "category", handle: "twarz", action: "create" }),
      ])
    )
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

  it("records planned collection writes in dry-run without touching DB", async () => {
    const svc = makeProductModuleService()
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const { counts, fixtureToMedusaMap } = await syncCollections(
      svc,
      [{ collection_id: "col-1", title: "Premium Core", handle: "premium-core" }],
      "bonbeauty",
      warnings,
      collector
    )

    expect(counts.created).toBe(1)
    expect(fixtureToMedusaMap.get("col-1")).toBe("dry-run-collection-col-1")
    expect(svc.createProductCollections).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "collection", handle: "premium-core", action: "create" }),
      ])
    )
  })
})

// ---------------------------------------------------------------------------
// syncProducts
// ---------------------------------------------------------------------------

describe("syncProducts", () => {
  const prereqs = { salesChannelId: "sc-bonbeauty", shippingProfileId: "sp-default" }
  const emptyMaps = {
    categoryMap: new Map<string, string>(),
    collectionMap: new Map<string, string>(),
    tagIdMap: new Map<string, string>(),
  }

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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
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
      emptyMaps.tagIdMap,
      "bonbeauty",
      warnings
    )

    // Price=0 + short desc → draft
    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = (svc.updateProducts as jest.Mock).mock.calls[0]
    expect(payload).toHaveProperty("status", "draft")
  })

  it("records planned product update in dry-run without touching DB", async () => {
    const svc = makeProductModuleService({
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "existing-prod",
          handle: "nail-art",
          categories: [],
          variants: [{ id: "variant-1", title: "Default" }],
          metadata: { gp: { market_id: "bonbeauty" } },
        },
      ]),
    })
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const counts = await syncProducts(
      makeContainer2(),
      svc,
      [{ product_id: "p-nail", name: "Nail Art", handle: "nail-art", base_price: { amount: 50, currency: "PLN" } }],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      emptyMaps.tagIdMap,
      "bonbeauty",
      warnings,
      undefined,
      true,
      collector
    )

    expect(counts.updated).toBe(1)
    expect(svc.updateProducts).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "product", handle: "nail-art", action: "update" }),
      ])
    )
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

  // Stub db — vendors in these existing tests have no slug, so resolveVendorRuntimeStateMap
  // returns an empty Map immediately (slugs.length === 0) without calling the db handle.
  // Passing null satisfies the updated signature; the stub is never invoked in config-only path.
  const noOpDb = null as any

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

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(2)
    expect(svc.updateProducts).toHaveBeenCalledTimes(2)
    expect(svc.updateProducts).toHaveBeenCalledWith("p1", { status: "draft" })
    expect(svc.updateProducts).toHaveBeenCalledWith("p2", { status: "draft" })
    // F2/F3 fix: aggregated warning about legacy vendors without slug (config-only path
    // because noOpDb is null). Assert warning IS emitted (non-vacuous) AND content shape.
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes("legacy vendor(s) without slug"))).toBe(true)
  })

  it("does not draft a shared product when an active vendor still offers it", async () => {
    setupFiles(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "good-vendor", status: "active" },
          { vendor_id: "bad-vendor", status: "suspended" },
        ],
      },
      {
        "good-vendor": {
          vendor_id: "good-vendor",
          market_id: "bonbeauty",
          products: [{ product_id: "srv_1201", status: "active", available: true }],
        },
        "bad-vendor": {
          vendor_id: "bad-vendor",
          market_id: "bonbeauty",
          products: [{ product_id: "srv_1201", status: "active", available: true }],
        },
      }
    )

    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        { id: "p1", handle: "premium-product", status: "published", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_1201" } } },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.updateProducts).not.toHaveBeenCalled()
    // F2/F3 fix: aggregated warning about legacy vendors without slug — assert non-vacuous.
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes("legacy vendor(s) without slug"))).toBe(true)
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

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

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

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

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

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.updateProducts).not.toHaveBeenCalled()
  })

  it("warns when market.yaml is unreadable", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))

    const svc = { listProducts: jest.fn(), updateProducts: jest.fn() }
    const warnings: string[] = []

    const result = await enforceVendorStatusGate(noOpDb, svc, "/missing/market.yaml", "bonbeauty", warnings)

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

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

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

    const result = await enforceVendorStatusGate(noOpDb, svc, "/config/bonbeauty/market.yaml", "bonbeauty", warnings)

    expect(result.draftedCount).toBe(0)
    expect(svc.updateProducts).not.toHaveBeenCalled()
  })

  it("records planned vendor-gate draft in dry-run without touching DB", async () => {
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
        { id: "p1", handle: "product-1", status: "published", metadata: { gp: { market_id: "bonbeauty", fixture_id: "srv_0101" } } },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    }
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const result = await enforceVendorStatusGate(
      noOpDb,
      svc,
      "/config/bonbeauty/market.yaml",
      "bonbeauty",
      warnings,
      collector
    )

    expect(result.draftedCount).toBe(1)
    expect(svc.updateProducts).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "product", handle: "product-1", action: "update" }),
      ])
    )
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
            { product_id: "srv_0101", status: "active", vendor_price: { amount: 140, currency: "PLN" } },
            { product_id: "srv_0401", status: "active", vendor_price: { amount: 180, currency: "PLN" } },
          ],
        },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings)

    expect(map.get("srv_0101")?.prices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vendor_id: "city-beauty", amount: 160, currency: "PLN" }),
        expect.objectContaining({ vendor_id: "kremidotyk", amount: 140, currency: "PLN" }),
      ])
    )
    expect(map.has("srv_0102")).toBe(false) // price=0 — not valid vendor pricing
    expect(map.get("srv_0401")?.prices).toEqual([
      expect.objectContaining({ vendor_id: "kremidotyk", amount: 180, currency: "PLN" }),
    ]) // onboarded vendor counts as active
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

// ---------------------------------------------------------------------------
// buildVendorPricingMap — runtime-state-map scenarios (AC4 a-e)
// Story v160-cleanup-60: TF-170 — real seller store_status via runtimeStateMap
// ---------------------------------------------------------------------------

describe("buildVendorPricingMap — runtime-state-map", () => {
  const mockReadFile = fs.readFile as jest.Mock

  beforeEach(() => {
    mockReadFile.mockReset()
  })

  function setupMarketFile(marketYaml: object, vendorFiles: Record<string, object> = {}) {
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

  /**
   * Build a Knex-stub that returns fixed rows from
   * db("seller").select(...).whereIn(...).whereRaw(...).whereNull(...).
   *
   * F7 fix: dead `chainEnd` / first `whereNull` removed.
   * F9 fix: returns the inner spies so tests can assert query-parameter contracts
   *         (especially `whereRaw` bindings — locks cross-market isolation).
   */
  function makeDbStub(rows: Array<{ handle: string; store_status: string | null }>) {
    const whereNull = jest.fn().mockResolvedValue(rows)
    const whereRaw = jest.fn().mockReturnValue({ whereNull })
    const whereIn = jest.fn().mockReturnValue({ whereRaw })
    const select = jest.fn().mockReturnValue({ whereIn })
    const db = jest.fn().mockReturnValue({ select })
    return { db, select, whereIn, whereRaw, whereNull }
  }

  // AC4 (a) — Mixed-status happy path
  it("(a) includes only ACTIVE sellers when runtime rows provided", async () => {
    const dbRows = [
      { handle: "seller-a", store_status: "ACTIVE" }, // noqa: mercur15-drift — legacy bridge fixture
      { handle: "seller-b", store_status: "ACTIVE" }, // noqa: mercur15-drift — legacy bridge fixture
      { handle: "seller-c", store_status: "ACTIVE" }, // noqa: mercur15-drift — legacy bridge fixture
      { handle: "seller-d", store_status: "SUSPENDED" }, // noqa: mercur15-drift — legacy bridge fixture
      { handle: "seller-e", store_status: "CLOSED" },
    ]
    const { db, whereIn, whereRaw, select } = makeDbStub(dbRows)

    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "seller-a", slug: "seller-a", status: "active" },
          { vendor_id: "seller-b", slug: "seller-b", status: "active" },
          { vendor_id: "seller-c", slug: "seller-c", status: "active" },
          { vendor_id: "seller-d", slug: "seller-d", status: "active" },
          { vendor_id: "seller-e", slug: "seller-e", status: "active" },
        ],
      },
      {
        "seller-a": { products: [{ product_id: "p-a1", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "seller-b": { products: [{ product_id: "p-b1", status: "active", vendor_price: { amount: 200, currency: "PLN" } }] },
        "seller-c": { products: [{ product_id: "p-c1", status: "active", vendor_price: { amount: 300, currency: "PLN" } }] },
        "seller-d": { products: [{ product_id: "p-d1", status: "active", vendor_price: { amount: 400, currency: "PLN" } }] },
        "seller-e": { products: [{ product_id: "p-e1", status: "active", vendor_price: { amount: 500, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings, db, "bonbeauty")

    // Only 3 ACTIVE sellers should have pricing entries
    expect(map.has("p-a1")).toBe(true)
    expect(map.has("p-b1")).toBe(true)
    expect(map.has("p-c1")).toBe(true)
    expect(map.has("p-d1")).toBe(false) // SUSPENDED
    expect(map.has("p-e1")).toBe(false) // CLOSED
    expect(warnings).toHaveLength(0)

    // F9 fix: assert the seller query was scoped correctly — locks cross-market
    // isolation contract and verifies marketIdForRuntime is actually parameterised.
    expect(select).toHaveBeenCalledWith("handle", { store_status: "status" })
    expect(whereIn).toHaveBeenCalledWith(
      "handle",
      expect.arrayContaining(["seller-a", "seller-b", "seller-c", "seller-d", "seller-e"])
    )
    expect(whereRaw).toHaveBeenCalledWith(
      "metadata->'gp'->>'market_id' = ?",
      ["bonbeauty"]
    )
  })

  // AC4 (b) — Runtime DB query throws
  it("(b) falls back to config status and pushes warning when db throws", async () => {
    const db = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        whereIn: jest.fn().mockReturnValue({
          whereRaw: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockRejectedValue(new Error("connection refused")),
          }),
        }),
      }),
    })

    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "seller-x", slug: "seller-x", status: "active" },
        ],
      },
      {
        "seller-x": { products: [{ product_id: "p-x1", status: "active", vendor_price: { amount: 150, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings, db, "bonbeauty")

    // Fallback to config status "active" — pricing map still built
    expect(map.has("p-x1")).toBe(true)
    expect(warnings.some((w) => w.includes("cannot resolve runtime seller states"))).toBe(true)
    expect(warnings.some((w) => w.includes("connection refused"))).toBe(true)
  })

  // AC4 (c) — Missing runtime row for 1 of 3 vendors
  it("(c) falls back to config status for vendor with no runtime row", async () => {
    // DB returns rows for seller-1 and seller-2 only; seller-3 has no runtime row
    const dbRows = [
      { handle: "seller-1", store_status: "ACTIVE" }, // noqa: mercur15-drift — legacy bridge fixture
      { handle: "seller-2", store_status: "SUSPENDED" }, // noqa: mercur15-drift — legacy bridge fixture
    ]
    const { db } = makeDbStub(dbRows)

    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "seller-1", slug: "seller-1", status: "active" },
          { vendor_id: "seller-2", slug: "seller-2", status: "active" },
          { vendor_id: "seller-3", slug: "seller-3", status: "active" }, // no runtime row → config fallback
        ],
      },
      {
        "seller-1": { products: [{ product_id: "p1", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "seller-2": { products: [{ product_id: "p2", status: "active", vendor_price: { amount: 200, currency: "PLN" } }] },
        "seller-3": { products: [{ product_id: "p3", status: "active", vendor_price: { amount: 300, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings, db, "bonbeauty")

    expect(map.has("p1")).toBe(true)  // runtime ACTIVE // noqa: mercur15-drift — assertion label
    expect(map.has("p2")).toBe(false) // runtime SUSPENDED // noqa: mercur15-drift — assertion label
    expect(map.has("p3")).toBe(true)  // no runtime row → config "active" → included

    // F4 fix: aggregated drift warning is emitted for slugged vendors lacking runtime row
    // (real prod-vs-config drift signal). Single warning, not one per vendor.
    expect(
      warnings.some(
        (w) =>
          w.includes("Vendor pricing:") &&
          w.includes("lack runtime row") &&
          w.includes("seller-3")
      )
    ).toBe(true)
  })

  // AC4 (d) — No db / no marketIdForRuntime → config-only, no DB query
  it("(d) behaves identically to pre-stash when db/marketIdForRuntime omitted", async () => {
    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "ok-vendor", slug: "ok-vendor", status: "active" },
          { vendor_id: "bad-vendor", slug: "bad-vendor", status: "suspended" },
        ],
      },
      {
        "ok-vendor": { products: [{ product_id: "p-ok", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "bad-vendor": { products: [{ product_id: "p-bad", status: "active", vendor_price: { amount: 200, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    // Called WITHOUT db and marketIdForRuntime — config-only path
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings)

    expect(map.has("p-ok")).toBe(true)   // config "active"
    expect(map.has("p-bad")).toBe(false) // config "suspended" — excluded by ACTIVE_VENDOR_STATUSES
    expect(warnings).toHaveLength(0)
  })

  // AC4 (e) — Slug missing on config vendor → fallback to config status, no crash
  it("(e) handles vendors with missing slug gracefully — falls back to config status", async () => {
    const dbRows = [{ handle: "slug-vendor", store_status: "ACTIVE" }] // noqa: mercur15-drift — legacy bridge fixture
    const { db } = makeDbStub(dbRows)

    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "no-slug-vendor", status: "active" }, // no slug field
          { vendor_id: "slug-vendor", slug: "slug-vendor", status: "active" },
        ],
      },
      {
        "no-slug-vendor": { products: [{ product_id: "p-ns", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "slug-vendor": { products: [{ product_id: "p-sv", status: "active", vendor_price: { amount: 200, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings, db, "bonbeauty")

    // no-slug-vendor has no slug → falls back to config "active" → included
    expect(map.has("p-ns")).toBe(true)
    // slug-vendor has runtime ACTIVE → included
    expect(map.has("p-sv")).toBe(true)
    // No crash
    expect(warnings).toHaveLength(0)
  })

  // F5 fix: forward-compat across Mercur 2 enum variants — `OPEN` must also count as active.
  it("(f) treats OPEN store_status as active (Mercur 2 enum forward-compat)", async () => {
    const dbRows = [
      { handle: "seller-open", store_status: "OPEN" },
      { handle: "seller-open-lc", store_status: "open" }, // case-insensitive
      { handle: "seller-suspended", store_status: "SUSPENDED" }, // noqa: mercur15-drift — legacy bridge fixture
    ]
    const { db } = makeDbStub(dbRows)

    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "seller-open", slug: "seller-open", status: "active" },
          { vendor_id: "seller-open-lc", slug: "seller-open-lc", status: "active" },
          { vendor_id: "seller-suspended", slug: "seller-suspended", status: "active" },
        ],
      },
      {
        "seller-open": { products: [{ product_id: "p-open", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "seller-open-lc": { products: [{ product_id: "p-open-lc", status: "active", vendor_price: { amount: 110, currency: "PLN" } }] },
        "seller-suspended": { products: [{ product_id: "p-susp", status: "active", vendor_price: { amount: 200, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings, db, "bonbeauty")

    expect(map.has("p-open")).toBe(true)
    expect(map.has("p-open-lc")).toBe(true)
    expect(map.has("p-susp")).toBe(false)
  })

  // F1 fix: db = null with slugged vendors must NOT crash — guarded path returns config-only.
  it("(g) does not crash when db is null even if vendors have slug (F1 guard)", async () => {
    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "ok", slug: "ok", status: "active" },
          { vendor_id: "bad", slug: "bad", status: "suspended" },
        ],
      },
      {
        "ok": { products: [{ product_id: "p-ok", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "bad": { products: [{ product_id: "p-bad", status: "active", vendor_price: { amount: 200, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    // db = null + marketIdForRuntime present → outer guard short-circuits, no crash.
    const map = await buildVendorPricingMap(
      "/config/bonbeauty/market.yaml",
      warnings,
      null as any,
      "bonbeauty"
    )

    expect(map.has("p-ok")).toBe(true)   // config "active"
    expect(map.has("p-bad")).toBe(false) // config "suspended"
  })

  // F11 fix: pin NULL/undefined/empty-string semantics for isRuntimeSellerActive helper.
  it("(h) excludes sellers whose runtime store_status is NULL", async () => {
    const dbRows = [
      { handle: "seller-null", store_status: null },
      { handle: "seller-empty", store_status: "" },
      { handle: "seller-active", store_status: "ACTIVE" }, // noqa: mercur15-drift — legacy bridge fixture
    ]
    const { db } = makeDbStub(dbRows)

    setupMarketFile(
      {
        market_id: "bonbeauty",
        vendors: [
          { vendor_id: "seller-null", slug: "seller-null", status: "active" },
          { vendor_id: "seller-empty", slug: "seller-empty", status: "active" },
          { vendor_id: "seller-active", slug: "seller-active", status: "active" },
        ],
      },
      {
        "seller-null": { products: [{ product_id: "p-null", status: "active", vendor_price: { amount: 100, currency: "PLN" } }] },
        "seller-empty": { products: [{ product_id: "p-empty", status: "active", vendor_price: { amount: 110, currency: "PLN" } }] },
        "seller-active": { products: [{ product_id: "p-active", status: "active", vendor_price: { amount: 120, currency: "PLN" } }] },
      }
    )

    const warnings: string[] = []
    const map = await buildVendorPricingMap("/config/bonbeauty/market.yaml", warnings, db, "bonbeauty")

    // NULL/empty store_status counts as "not yet onboarded" → excluded (runtime row IS present
    // but value is NULL — authoritative "not active" signal, no config fallback).
    expect(map.has("p-null")).toBe(false)
    expect(map.has("p-empty")).toBe(false)
    expect(map.has("p-active")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// v1.8.0 Story 1.10.1 — loadEntitlementProfileMap + resolveProductEntitlementProfile
// Catalog → checkout entitlement_profile propagation bridge (per investigation
// finding `_bmad-output/releases/v1.8.0/planning-artifacts/
// 1-10-1-investigation-finding-2026-05-23.md`).
// ---------------------------------------------------------------------------

describe("loadEntitlementProfileMap (Story 1.10.1)", () => {
  const mockReadFile = fs.readFile as jest.Mock

  beforeEach(() => {
    mockReadFile.mockReset()
  })

  it("loads 3 BonBeauty MVP profiles from market.yaml", async () => {
    mockReadFile.mockResolvedValue(
      yaml.dump({
        market_id: "bonbeauty",
        entitlement_profiles: [
          {
            profile_id: "voucher-kwotowy-365d",
            entitlement_type: "VOUCHER_AMOUNT",
            policy: { validity_months: 12 },
          },
          {
            profile_id: "voucher-rezerwacja-otwarta",
            entitlement_type: "VOUCHER_SERVICE",
            policy: { validity_months: 12 },
          },
          {
            profile_id: "voucher-sezonowy",
            entitlement_type: "VOUCHER_AMOUNT",
            policy: { validity_months: 6 },
          },
        ],
      })
    )
    const warnings: string[] = []
    const map = await loadEntitlementProfileMap("/config/bonbeauty/market.yaml", warnings)
    expect(map.size).toBe(3)
    expect(map.has("voucher-kwotowy-365d")).toBe(true)
    expect(map.has("voucher-rezerwacja-otwarta")).toBe(true)
    expect(map.has("voucher-sezonowy")).toBe(true)
    expect(warnings).toHaveLength(0)
  })

  it("returns empty map and warns when market.yaml unreadable", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    const warnings: string[] = []
    const map = await loadEntitlementProfileMap("/config/missing/market.yaml", warnings)
    expect(map.size).toBe(0)
    expect(warnings.some((w) => w.includes("cannot read market.yaml"))).toBe(true)
  })

  it("returns empty map when market has no entitlement_profiles section (legacy markets)", async () => {
    mockReadFile.mockResolvedValue(yaml.dump({ market_id: "bonbeauty" }))
    const warnings: string[] = []
    const map = await loadEntitlementProfileMap("/config/bonbeauty/market.yaml", warnings)
    expect(map.size).toBe(0)
    expect(warnings).toHaveLength(0)
  })

  it("skips malformed profiles with explicit warnings (fail-loud)", async () => {
    mockReadFile.mockResolvedValue(
      yaml.dump({
        market_id: "bonbeauty",
        entitlement_profiles: [
          { entitlement_type: "VOUCHER_AMOUNT", policy: {} }, // no profile_id
          { profile_id: "p1", policy: {} }, // no entitlement_type
          { profile_id: "p2", entitlement_type: "VOUCHER_AMOUNT" }, // no policy
          { profile_id: "ok", entitlement_type: "VOUCHER_AMOUNT", policy: { validity_months: 12 } },
        ],
      })
    )
    const warnings: string[] = []
    const map = await loadEntitlementProfileMap("/config/bonbeauty/market.yaml", warnings)
    expect(map.size).toBe(1)
    expect(map.has("ok")).toBe(true)
    expect(warnings.length).toBeGreaterThanOrEqual(3)
  })
})

describe("resolveProductEntitlementProfile (Story 1.10.1)", () => {
  function makeProfileMap() {
    return new Map([
      [
        "voucher-rezerwacja-otwarta",
        {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          policy: { validity_months: 12, cancellation: { cutoff_hours: 12 } },
        },
      ],
    ])
  }

  it("returns undefined when product has no entitlement_profile_id (non-voucher SKU)", () => {
    const warnings: string[] = []
    const result = resolveProductEntitlementProfile(
      { product_id: "p1", name: "x", base_price: { amount: 100, currency: "PLN" } },
      makeProfileMap(),
      warnings
    )
    expect(result).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  it("returns embedded profile + currency when cross-ref resolves", () => {
    const warnings: string[] = []
    const result = resolveProductEntitlementProfile(
      {
        product_id: "p1",
        name: "x",
        base_price: { amount: 100, currency: "pln" },
        entitlement_profile_id: "voucher-rezerwacja-otwarta",
      },
      makeProfileMap(),
      warnings
    )
    expect(result).toMatchObject({
      profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      policy: { validity_months: 12 },
      currency: "PLN",
    })
    expect(warnings).toHaveLength(0)
  })

  it("returns undefined + warns when cross-ref dangles (fail-loud)", () => {
    const warnings: string[] = []
    const result = resolveProductEntitlementProfile(
      {
        product_id: "p1",
        name: "x",
        base_price: { amount: 100, currency: "PLN" },
        entitlement_profile_id: "voucher-typo-id",
      },
      makeProfileMap(),
      warnings
    )
    expect(result).toBeUndefined()
    expect(warnings.some((w) => w.includes("dangling cross-ref"))).toBe(true)
  })
})

describe("buildProductGpMetadata (Story 2.6 product/catalog field parity)", () => {
  it("materializes schema-declared catalog fields into metadata.gp, preserving nullable duration", () => {
    const metadata = buildProductGpMetadata(
      {
        product_id: "srv_0702",
        name: "Wypełnianie kwasem hialuronowym",
        subtitle: "Naturalny efekt objętości",
        base_price: { amount: 0, currency: "PLN" },
        duration_minutes: null,
        seo: {
          meta_title: "Kwas hialuronowy | BonBeauty",
          meta_description: "Wypełnianie kwasem hialuronowym w BonBeauty.",
        },
        sort_rank: 7,
        validity_period: "12 miesięcy",
        regulatory_class: "standard",
        entitlement_profile_id: "voucher-rezerwacja-otwarta",
      },
      "bonbeauty",
      true,
      {
        profile_id: "voucher-rezerwacja-otwarta",
        entitlement_type: "VOUCHER_SERVICE",
        policy: { validity_months: 12 },
        currency: "PLN",
      }
    )

    expect(metadata).toMatchObject({
      synced_by: "gp-config-sync-catalog",
      market_id: "bonbeauty",
      fixture_id: "srv_0702",
      has_vendor_pricing: true,
      subtitle: "Naturalny efekt objętości",
      duration_minutes: null,
      seo: {
        meta_title: "Kwas hialuronowy | BonBeauty",
        meta_description: "Wypełnianie kwasem hialuronowym w BonBeauty.",
      },
      sort_rank: 7,
      validity_period: "12 miesięcy",
      regulatory_class: "standard",
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_profile: {
        profile_id: "voucher-rezerwacja-otwarta",
        entitlement_type: "VOUCHER_SERVICE",
        policy: { validity_months: 12 },
        currency: "PLN",
      },
    })
  })

  it("omits optional metadata fields when absent instead of inventing storefront fallbacks", () => {
    const metadata = buildProductGpMetadata(
      {
        product_id: "srv_0101",
        name: "Oczyszczanie twarzy",
        base_price: { amount: 180, currency: "PLN" },
      },
      "bonbeauty",
      false
    )

    expect(metadata).toEqual({
      synced_by: "gp-config-sync-catalog",
      market_id: "bonbeauty",
      fixture_id: "srv_0101",
      has_vendor_pricing: false,
    })
  })
})

describe("syncProducts writes entitlement_profile to product.metadata.gp (Story 1.10.1)", () => {
  const prereqs = { salesChannelId: "sc-bonbeauty", shippingProfileId: "sp-default" }
  const emptyMaps = {
    categoryMap: new Map<string, string>(),
    collectionMap: new Map<string, string>(),
    tagIdMap: new Map<string, string>(),
  }

  function makeContainerLite() {
    return { resolve: jest.fn().mockReturnValue({}) }
  }

  it("writes embedded entitlement_profile on the update payload for a voucher product", async () => {
    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "p-existing",
          handle: "oczyszczanie-twarzy",
          categories: [],
          metadata: { gp: { market_id: "bonbeauty" } },
          variants: [],
        },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    } as any
    const warnings: string[] = []
    const profileMap = new Map([
      [
        "voucher-rezerwacja-otwarta",
        {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          policy: { validity_months: 12 },
        },
      ],
    ])

    await syncProducts(
      makeContainerLite(),
      svc,
      [
        {
          product_id: "srv_0101",
          name: "Oczyszczanie twarzy",
          subtitle: "Autorski zabieg oczyszczający",
          handle: "oczyszczanie-twarzy",
          base_price: { amount: 180, currency: "PLN" },
          duration_minutes: null,
          regulatory_class: "standard",
          entitlement_profile_id: "voucher-rezerwacja-otwarta",
        },
      ],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      emptyMaps.tagIdMap,
      "bonbeauty",
      warnings,
      undefined,
      false,
      undefined,
      profileMap
    )

    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = svc.updateProducts.mock.calls[0]
    expect(payload.metadata.gp.entitlement_profile).toMatchObject({
      profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      policy: { validity_months: 12 },
      currency: "PLN",
    })
    // Existing gp.* keys preserved + new SoT keys re-asserted.
    expect(payload.metadata.gp.market_id).toBe("bonbeauty")
    expect(payload.metadata.gp.synced_by).toBe("gp-config-sync-catalog")
    expect(payload.metadata.gp.fixture_id).toBe("srv_0101")
    expect(payload.metadata.gp.entitlement_profile_id).toBe("voucher-rezerwacja-otwarta")
    expect(payload.metadata.gp.subtitle).toBe("Autorski zabieg oczyszczający")
    expect(payload.metadata.gp.duration_minutes).toBeNull()
    expect(payload.metadata.gp.regulatory_class).toBe("standard")
    expect(payload.subtitle).toBe("Autorski zabieg oczyszczający")
  })

  it("does NOT write entitlement_profile when product lacks entitlement_profile_id (legacy/non-voucher flow)", async () => {
    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "p-existing",
          handle: "hair-color",
          categories: [],
          metadata: { gp: { market_id: "bonbeauty" } },
          variants: [],
        },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    } as any
    const warnings: string[] = []

    await syncProducts(
      makeContainerLite(),
      svc,
      [
        {
          product_id: "p-no-ent",
          name: "Hair Color",
          handle: "hair-color",
          base_price: { amount: 200, currency: "PLN" },
        },
      ],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      emptyMaps.tagIdMap,
      "bonbeauty",
      warnings,
      undefined,
      false,
      undefined,
      new Map()
    )

    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = svc.updateProducts.mock.calls[0]
    expect(payload.metadata.gp.entitlement_profile).toBeUndefined()
  })

  it("removes stale entitlement_profile from existing metadata when product no longer voucher-bearing", async () => {
    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "p-existing",
          handle: "former-voucher",
          categories: [],
          metadata: {
            gp: {
              market_id: "bonbeauty",
              entitlement_profile: {
                profile_id: "stale-profile",
                entitlement_type: "VOUCHER_AMOUNT",
                policy: { validity_months: 12 },
              },
            },
          },
          variants: [],
        },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    } as any
    const warnings: string[] = []

    await syncProducts(
      makeContainerLite(),
      svc,
      [
        {
          product_id: "p-clean",
          name: "Former Voucher",
          handle: "former-voucher",
          base_price: { amount: 100, currency: "PLN" },
          // no entitlement_profile_id
        },
      ],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      emptyMaps.tagIdMap,
      "bonbeauty",
      warnings,
      undefined,
      false,
      undefined,
      new Map()
    )

    const [, payload] = svc.updateProducts.mock.calls[0]
    expect(payload.metadata.gp.entitlement_profile).toBeUndefined()
  })
})

describe("syncProducts stale-clear on update path (Story 2.6 symmetric delete-on-absent)", () => {
  const prereqs = { salesChannelId: "sc-bonbeauty", shippingProfileId: "sp-default" }
  const emptyMaps = {
    categoryMap: new Map<string, string>(),
    collectionMap: new Map<string, string>(),
    tagIdMap: new Map<string, string>(),
  }
  function makeContainerLite() {
    return { resolve: jest.fn().mockReturnValue({}) }
  }

  it("clears stale schema-materialized fields from metadata.gp when removed from source", async () => {
    const svc = {
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "p-stale",
          handle: "produkt-stale",
          categories: [],
          metadata: {
            gp: {
              market_id: "bonbeauty",
              subtitle: "Stary podtytuł",
              seo: { meta_title: "Stary tytuł SEO" },
              sort_rank: 5,
              validity_period: "6 miesięcy",
              regulatory_class: "premium",
              duration_minutes: 60,
            },
          },
          variants: [],
        },
      ]),
      updateProducts: jest.fn().mockResolvedValue({}),
    } as any
    const warnings: string[] = []

    await syncProducts(
      makeContainerLite(),
      svc,
      [
        {
          // Source no longer declares any of the previously synced catalog fields
          product_id: "p-stale",
          name: "Produkt bez pól katalogowych",
          handle: "produkt-stale",
          base_price: { amount: 200, currency: "PLN" },
        },
      ],
      prereqs,
      emptyMaps.categoryMap,
      emptyMaps.collectionMap,
      emptyMaps.tagIdMap,
      "bonbeauty",
      warnings,
      undefined,
      false,
      undefined,
      new Map()
    )

    expect(svc.updateProducts).toHaveBeenCalledTimes(1)
    const [, payload] = svc.updateProducts.mock.calls[0]
    const gp = payload.metadata.gp
    expect(gp.subtitle).toBeUndefined()
    expect(gp.seo).toBeUndefined()
    expect(gp.sort_rank).toBeUndefined()
    expect(gp.validity_period).toBeUndefined()
    expect(gp.regulatory_class).toBeUndefined()
    expect(gp.duration_minutes).toBeUndefined()
  })
})
