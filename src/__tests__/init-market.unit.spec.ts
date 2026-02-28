/**
 * Unit tests for initMarket business logic (AC-2: Jest coverage for POST /api/init-market)
 *
 * Tests cover:
 * - 201: MarketConfig successfully created
 * - 409: MarketConfig already exists (idempotent guard)
 * - 409: Unique constraint violation from DB (race condition guard)
 * - 403: Non-platform_admin user
 * - 422: Missing required fields
 * - 422: Vendor not found
 * - 422: Template not found
 *
 * MONOREPO DEPENDENCY: This file imports from GP/portal/src/lib/initMarket (sibling module).
 * Must be run from within the GP monorepo: `cd GP/backend && yarn test:unit`
 * Running this submodule standalone will fail. See jest.config.js note.
 */

import { initMarket, buildMarketConfigCreateData } from "../../../portal/src/lib/initMarket"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVendor(overrides: Record<string, unknown> = {}) {
  return {
    id: "vendor-1",
    market_id: "bonbeauty",
    slug: "bonbeauty",
    ...overrides,
  }
}

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "tmpl-1",
    name: "GP Default",
    theme: "light",
    primary_color: "#fff",
    ...overrides,
  }
}

function makePayload({
  vendorResult = makeVendor(),
  templateResult = makeTemplate(),
  existingConfigs = [] as unknown[],
  createResult = { id: "config-1" } as unknown,
}: {
  vendorResult?: unknown
  templateResult?: unknown
  existingConfigs?: unknown[]
  createResult?: unknown
} = {}) {
  return {
    findByID: jest.fn(async ({ collection }: { collection: string; id: unknown }) => {
      if (collection === "vendors") return vendorResult
      if (collection === "storefront-templates") return templateResult
      throw new Error(`Unknown collection: ${collection}`)
    }),
    find: jest.fn(async () => ({ docs: existingConfigs })),
    create: jest.fn(async () => createResult),
  }
}

// ---------------------------------------------------------------------------
// initMarket — status 201 (created)
// ---------------------------------------------------------------------------

describe("initMarket — 201 Created", () => {
  it("returns 201 when MarketConfig is created successfully", async () => {
    const payload = makePayload()
    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "vendor-1", storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(201)
    expect(result.body).toHaveProperty("message", "MarketConfig initialized")
    expect(result.body).toHaveProperty("market_id", "bonbeauty")
    expect(result.body).toHaveProperty("market_config_id", "config-1")
    expect(payload.create).toHaveBeenCalledTimes(1)
  })

  it("passes correct data to payload.create including vendor and template fields", async () => {
    const template = makeTemplate({ name: "Custom Theme", theme: "dark", primary_color: "#000" })
    const vendor = makeVendor({ market_id: "bonevent", slug: "bonevent" })
    const payload = makePayload({ vendorResult: vendor, templateResult: template })

    await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "vendor-2", storefront_template_id: "tmpl-2" },
    })

    const createArgs = (payload.create as jest.Mock).mock.calls[0][0]
    expect(createArgs.collection).toBe("market-configs")
    expect(createArgs.data.market_id).toBe("bonevent")
    expect(createArgs.data.slug).toBe("bonevent")
    expect(createArgs.data.name).toBe("Custom Theme")
    expect(createArgs.data.theme).toBe("dark")
  })
})

// ---------------------------------------------------------------------------
// initMarket — status 409 (conflict)
// ---------------------------------------------------------------------------

describe("initMarket — 409 Conflict", () => {
  it("returns 409 when MarketConfig already exists for vendor", async () => {
    const payload = makePayload({
      existingConfigs: [{ id: "existing-config", market_id: "bonbeauty" }],
    })

    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "vendor-1", storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(409)
    expect(result.body).toHaveProperty("error")
    expect(payload.create).not.toHaveBeenCalled()
  })

  it("returns 409 on unique constraint DB error (race condition guard)", async () => {
    const uniqueError = { code: "23505", message: "duplicate key value" }
    const payload = makePayload()
    ;(payload.create as jest.Mock).mockRejectedValueOnce(uniqueError)

    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "vendor-1", storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(409)
    expect(result.body).toHaveProperty("error")
  })
})

// ---------------------------------------------------------------------------
// initMarket — status 403 (forbidden)
// ---------------------------------------------------------------------------

describe("initMarket — 403 Forbidden", () => {
  it("returns 403 for non-platform_admin user", async () => {
    const payload = makePayload()

    const result = await initMarket({
      payload,
      user: { role: "market_admin" },
      body: { vendor_id: "vendor-1", storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(403)
    expect(result.body).toHaveProperty("error", "Forbidden")
    expect(payload.findByID).not.toHaveBeenCalled()
  })

  it("returns 403 for unauthenticated user (null)", async () => {
    const payload = makePayload()

    const result = await initMarket({
      payload,
      user: null,
      body: { vendor_id: "vendor-1", storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// initMarket — status 422 (validation errors)
// ---------------------------------------------------------------------------

describe("initMarket — 422 Validation", () => {
  it("returns 422 when vendor_id is missing", async () => {
    const payload = makePayload()

    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(422)
    expect(payload.findByID).not.toHaveBeenCalled()
  })

  it("returns 422 when storefront_template_id is missing", async () => {
    const payload = makePayload()

    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "vendor-1" },
    })

    expect(result.status).toBe(422)
  })

  it("returns 422 when vendor is not found", async () => {
    const payload = makePayload()
    ;(payload.findByID as jest.Mock).mockImplementation(async ({ collection }: { collection: string }) => {
      if (collection === "vendors") throw { status: 404 }
      return makeTemplate()
    })

    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "nonexistent", storefront_template_id: "tmpl-1" },
    })

    expect(result.status).toBe(422)
  })

  it("returns 422 when template is not found", async () => {
    const payload = makePayload()
    ;(payload.findByID as jest.Mock).mockImplementation(async ({ collection }: { collection: string }) => {
      if (collection === "storefront-templates") throw { status: 404 }
      return makeVendor()
    })

    const result = await initMarket({
      payload,
      user: { role: "platform_admin" },
      body: { vendor_id: "vendor-1", storefront_template_id: "nonexistent" },
    })

    expect(result.status).toBe(422)
  })
})

// ---------------------------------------------------------------------------
// buildMarketConfigCreateData — unit test
// ---------------------------------------------------------------------------

describe("buildMarketConfigCreateData", () => {
  it("includes all non-null template fields in create data", () => {
    const vendor = makeVendor()
    const template = makeTemplate({ homepage_sections: [{ type: "hero" }], footer: { copyright: "GP" } })

    const data = buildMarketConfigCreateData({ template, vendor })

    expect(data.market_id).toBe("bonbeauty")
    expect(data.slug).toBe("bonbeauty")
    expect(data.storefront_template).toBe("tmpl-1")
    expect(data.homepage_sections).toEqual([{ type: "hero" }])
    expect(data.footer).toEqual({ copyright: "GP" })
  })

  it("omits null/undefined template fields to avoid overwriting existing config", () => {
    const vendor = makeVendor()
    const template = makeTemplate({ theme: null, primary_color: undefined })

    const data = buildMarketConfigCreateData({ template, vendor })

    expect(data).not.toHaveProperty("theme")
    expect(data).not.toHaveProperty("primary_color")
  })
})
