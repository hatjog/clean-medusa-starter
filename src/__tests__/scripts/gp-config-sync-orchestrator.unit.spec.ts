import {
  buildHealthReport,
  callRevalidateAll,
  parseOrchestratorArgs,
  runStage,
  sendSlackNotification,
} from "../../scripts/gp-config-sync-orchestrator"

describe("parseOrchestratorArgs", () => {
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

  it("parses args array and dry-run flag", () => {
    const result = parseOrchestratorArgs(["gp-stage", "mercur", "--dry-run"])

    expect(result).toEqual(
      expect.objectContaining({
        instanceId: "gp-stage",
        marketId: "mercur",
        dryRun: true,
      })
    )
  })

  it("falls back to env vars", () => {
    process.env.GP_INSTANCE_ID = "gp-prod"
    process.env.GP_MARKET_ID = "bonbeauty"
    process.env.GP_CONFIG_ROOT = "/config"
    process.env.GP_DRY_RUN = "true"

    const result = parseOrchestratorArgs(undefined)

    expect(result.instanceId).toBe("gp-prod")
    expect(result.marketId).toBe("bonbeauty")
    expect(result.configRoot).toBe("/config")
    expect(result.dryRun).toBe(true)
  })
})

describe("runStage", () => {
  it("returns ok for successful stage", async () => {
    const result = await runStage({
      name: "sync-catalog",
      required: true,
      execute: async () => "done",
    })

    expect(result.status).toBe("ok")
    expect(result.message).toBe("done")
  })

  it("gracefully downgrades optional stage failure to warning", async () => {
    const result = await runStage({
      name: "sync-redirects",
      required: false,
      execute: async () => {
        throw new Error("optional failed")
      },
    })

    expect(result.status).toBe("warning")
    expect(result.message).toBe("optional failed")
  })

  it("throws on required stage failure", async () => {
    await expect(
      runStage({
        name: "sync-vendors",
        required: true,
        execute: async () => {
          throw new Error("required failed")
        },
      })
    ).rejects.toThrow("required failed")
  })
})

describe("buildHealthReport", () => {
  it("reports visibility ratio, SPL count and SEO coverage for current market", async () => {
    const productModuleService = {
      listProducts: jest.fn().mockResolvedValue([
        {
          id: "prod-1",
          status: "published",
          metadata: { gp: { market_id: "bonbeauty", seo: { meta_title: "SEO 1" } } },
        },
        {
          id: "prod-2",
          status: "draft",
          metadata: { gp: { market_id: "bonbeauty" } },
        },
        {
          id: "prod-3",
          status: "published",
          metadata: { gp: { market_id: "bonbeauty" } },
        },
        {
          id: "prod-4",
          status: "published",
          metadata: { gp: { market_id: "mercur", seo: { meta_title: "SEO 2" } } },
        },
      ]),
    }
    const db = {
      raw: jest.fn().mockResolvedValue({ rows: [{ count: 7 }] }),
    }

    const report = await buildHealthReport(productModuleService, db, "bonbeauty")

    expect(report).toEqual({
      totalProducts: 3,
      publishedProducts: 2,
      visibilityRatio: 2 / 3,
      splCount: 7,
      seoProducts: 1,
      seoCoverage: 1 / 3,
    })
  })
})

describe("sendSlackNotification", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("posts summary payload to webhook", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" }) as any

    await sendSlackNotification("https://hooks.slack.test/abc", "summary text")

    expect(global.fetch).toHaveBeenCalledWith(
      "https://hooks.slack.test/abc",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "summary text" }),
      })
    )
  })
})

describe("callRevalidateAll", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("calls storefront revalidate-all endpoint with secret header", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" }) as any

    await callRevalidateAll("https://storefront.example/", "secret-123")

    expect(global.fetch).toHaveBeenCalledWith(
      "https://storefront.example/api/revalidate-all",
      expect.objectContaining({
        method: "POST",
        headers: { "x-revalidate-secret": "secret-123" },
      })
    )
  })
})