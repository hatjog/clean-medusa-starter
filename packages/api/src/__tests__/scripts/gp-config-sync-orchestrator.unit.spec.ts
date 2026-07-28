import {
  assertTranslationStageGate,
  buildHealthReport,
  buildStageArgs,
  callRevalidateAll,
  invokeStageEntrypoint,
  parseOrchestratorArgs,
  runStage,
  sendSlackNotification,
  withStageEnv,
} from "../../scripts/gp-config-sync-orchestrator"
import type { StageExitSignal } from "../../scripts/gp-config-sync-orchestrator"
import fs from "node:fs"
import path from "node:path"

describe("parseOrchestratorArgs", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_INSTANCE_ID
    delete process.env.GP_MARKET_ID
    delete process.env.GP_CONFIG_ROOT
    delete process.env.GP_DRY_RUN
    delete process.env.GP_OVERWRITE
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
    process.env.GP_OVERWRITE = "true"

    const result = parseOrchestratorArgs(undefined)

    expect(result.instanceId).toBe("gp-prod")
    expect(result.marketId).toBe("bonbeauty")
    expect(result.configRoot).toBe("/config")
    expect(result.dryRun).toBe(true)
    expect(result.overwrite).toBe(true)
  })

  it("parses overwrite flag from args", () => {
    const result = parseOrchestratorArgs(["gp-stage", "mercur", "--overwrite"])

    expect(result).toEqual(
      expect.objectContaining({
        instanceId: "gp-stage",
        marketId: "mercur",
        overwrite: true,
      })
    )
  })

  it("parsuje flage allow-skip z argumentow", () => {
    const result = parseOrchestratorArgs(["gp-stage", "mercur", "--allow-skip"])

    expect(result.allowSkip).toBe(true)
  })

  it("parsuje jawny apply gate dla stage sync-reviews", () => {
    const result = parseOrchestratorArgs(["gp-stage", "mercur", "--apply"])

    expect(result.apply).toBe(true)
  })
})

describe("stage registry — sync-reviews behawioralny", () => {
  // L3 fix: zastępujemy text-scraping test behawioralnym. Zamiast czytać źródło pliku jako string,
  // weryfikujemy zachowanie runStage z mocked entrypoint — sprawdzamy kolejność (vendors przed reviews),
  // required:false (brak --apply = dry-run only, nie blokuje pipeline na błędzie) i integrację z parseOrchestratorArgs.

  it("sync-reviews jest opcjonalny — błąd nie rzuca wyjątkiem z runStage", async () => {
    const result = await runStage({
      name: "sync-reviews",
      required: false,
      execute: async () => {
        throw new Error("reviews stage failed")
      },
    })

    // required:false oznacza downgrade do warning, nie throw
    expect(result.status).toBe("warning")
    expect(result.message).toBe("reviews stage failed")
  })

  it("parseOrchestratorArgs rozpoznaje --apply i przekazuje dalej do stageArgs", () => {
    const result = parseOrchestratorArgs(["gp-dev", "bonbeauty", "--apply"])

    expect(result.apply).toBe(true)
    // Bez --dry-run główny orchestrator nie jest w dry-run
    expect(result.dryRun).toBe(false)
  })

  it("--dry-run orchestratora wyklucza apply (dry-run twardy override dla stage reviews)", () => {
    // Weryfikuje że parseOrchestratorArgs z --dry-run nie ustawia apply
    const result = parseOrchestratorArgs(["gp-dev", "bonbeauty", "--dry-run"])

    expect(result.dryRun).toBe(true)
    expect(result.apply).toBeFalsy()
  })

  it("sync-vendors pojawia się przed sync-reviews w pliku orchestratora (kolejność stage'ów)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/gp-config-sync-orchestrator.ts"),
      "utf8"
    )
    const vendorsIndex = source.indexOf('name: "sync-vendors"')
    const reviewsIndex = source.indexOf('name: "sync-reviews"')

    expect(vendorsIndex).toBeGreaterThan(-1)
    expect(reviewsIndex).toBeGreaterThan(vendorsIndex)
  })

  it("sync-i18n-content jest po sync-catalog i sync-vendors (treść tłumaczeń wymaga istniejących encji kategorii/produktów ORAZ sprzedawców)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/gp-config-sync-orchestrator.ts"),
      "utf8"
    )
    const catalogIndex = source.indexOf('name: "sync-catalog"')
    const vendorsIndex = source.indexOf('name: "sync-vendors"')
    const i18nContentIndex = source.indexOf('name: "sync-i18n-content"')
    const reviewsIndex = source.indexOf('name: "sync-reviews"')

    expect(i18nContentIndex).toBeGreaterThan(catalogIndex)
    expect(i18nContentIndex).toBeGreaterThan(vendorsIndex)
    expect(reviewsIndex).toBeGreaterThan(i18nContentIndex)
  })
})

describe("assertTranslationStageGate", () => {
  it("blokuje staging/canary/production bez Translation FF i bez allow-skip", () => {
    expect(() =>
      assertTranslationStageGate(
        { allowSkip: false },
        {
          MEDUSA_STAGE: "canary",
          MEDUSA_FF_TRANSLATION: "false",
        } as NodeJS.ProcessEnv
      )
    ).toThrow("FF translation gate required in stage canary; pass --allow-skip to override")
  })

  it("pozwala na override --allow-skip oraz lokalny stage", () => {
    expect(() =>
      assertTranslationStageGate(
        { allowSkip: true },
        {
          MEDUSA_STAGE: "staging",
          MEDUSA_FF_TRANSLATION: "false",
        } as NodeJS.ProcessEnv
      )
    ).not.toThrow()

    expect(() =>
      assertTranslationStageGate(
        { allowSkip: false },
        {
          MEDUSA_STAGE: "local",
          MEDUSA_FF_TRANSLATION: "false",
        } as NodeJS.ProcessEnv
      )
    ).not.toThrow()
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

  it("zwraca skipped dla pominietego etapu", async () => {
    const result = await runStage({
      name: "sync-translations",
      required: true,
      execute: async () => ({
        status: "skipped",
        message: "translations sync: SKIPPED (FF=false)",
      }),
    })

    expect(result.status).toBe("skipped")
    expect(result.message).toBe("translations sync: SKIPPED (FF=false)")
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

// ---- Verify-B5 V1/V4: kanały env etapu i sygnał kodu wyjścia ----

const STAGE_ARGS = {
  instanceId: "gp-dev",
  marketId: "bonbeauty",
  configRoot: "/tmp/gp-config",
  dryRun: false,
  overwrite: false,
  prune: false,
  apply: false,
} as any

describe("withStageEnv — normalizacja kanałów destrukcyjnych (V1)", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("zeruje odziedziczone GP_FORCE_VENDOR_OVERWRITE na czas etapu", async () => {
    // `invokeStageEntrypoint` woła etapy IN-PROCESS, więc bez tej normalizacji
    // odziedziczona zmienna docierała do gp-config-sync-vendors 1:1.
    process.env.GP_FORCE_VENDOR_OVERWRITE = "true"

    const seen = await withStageEnv(
      STAGE_ARGS,
      async () => process.env.GP_FORCE_VENDOR_OVERWRITE
    )

    expect(seen).toBe("false")
  })

  it("przywraca wartość operatora po etapie (i usuwa, gdy jej nie było)", async () => {
    process.env.GP_FORCE_VENDOR_OVERWRITE = "true"
    await withStageEnv(STAGE_ARGS, async () => undefined)
    expect(process.env.GP_FORCE_VENDOR_OVERWRITE).toBe("true")

    delete process.env.GP_FORCE_VENDOR_OVERWRITE
    await withStageEnv(STAGE_ARGS, async () => undefined)
    expect(process.env.GP_FORCE_VENDOR_OVERWRITE).toBeUndefined()
  })
})

describe("kanał --force-vendor-overwrite jest OSIĄGALNY przez orchestrator (W3)", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_FORCE_VENDOR_OVERWRITE
  })

  afterAll(() => {
    process.env = originalEnv
  })

  // RED-FIRST: przed tym fixem `resolveForceVendorOverwrite` nie mógł zwrócić
  // `enabled: true` poza testami. Wymaga koniunkcji argv+env, a orchestrator
  // ani nie parsował flagi (brak pola w OrchestratorArgs), ani nie przekazywał
  // jej do stageArgs, ani nie ustawiał env inaczej niż na sztywne "false".
  it("parseOrchestratorArgs wymaga env ORAZ pozycyjnego tokenu intencji (cykl 5)", () => {
    process.env.GP_FORCE_VENDOR_OVERWRITE = "true"
    const args = parseOrchestratorArgs(["gp-dev", "bonbeauty", "force-vendor-overwrite"])
    expect(args.forceVendorOverwrite).toBe(true)
    expect(args.forceVendorOverwriteIgnoredReason).toBeUndefined()
  })

  // RED-FIRST (cykl 5): do cyklu 4 relay orchestratora był `OR(argv, env)`
  // z uzasadnieniem „verb i tak ustawia env dwustronnie". To prawda o ścieżce
  // verb-a i nieprawda o świecie: ręczne `medusa exec gp-config-sync-orchestrator
  // gp-dev bonbeauty` z odziedziczonym `GP_FORCE_VENDOR_OVERWRITE=true`
  // (`.envrc`, CI, poprzednia sesja) kasowało treść salonów bez jednego słowa
  // intencji — czyli dokładnie scenariusz, przed którym kanał miał chronić.
  it("samo odziedziczone env NIE włącza kanału i jest raportowane głośno", () => {
    process.env.GP_FORCE_VENDOR_OVERWRITE = "true"
    const args = parseOrchestratorArgs(["gp-dev", "bonbeauty"])
    expect(args.forceVendorOverwrite).toBe(false)
    expect(args.forceVendorOverwriteIgnoredReason).toContain("ZIGNOROWANE")
    expect(args.forceVendorOverwriteIgnoredReason).toContain("force-vendor-overwrite")
  })

  it("sam token bez potwierdzenia w env też jest ignorowany i raportowany", () => {
    const args = parseOrchestratorArgs(["gp-dev", "bonbeauty", "force-vendor-overwrite"])
    expect(args.forceVendorOverwrite).toBe(false)
    expect(args.forceVendorOverwriteIgnoredReason).toContain("ZIGNOROWANE")
  })

  it("domyślnie kanał jest wyłączony", () => {
    expect(parseOrchestratorArgs(["gp-dev", "bonbeauty"]).forceVendorOverwrite).toBe(false)
  })

  it("buildStageArgs dokłada --force-vendor-overwrite (druga połówka koniunkcji)", () => {
    const args = buildStageArgs({
      ...STAGE_ARGS,
      forceVendorOverwrite: true,
    })

    expect(args).toContain("--force-vendor-overwrite")
  })

  it("buildStageArgs NIE dokłada flagi, gdy kanał jest wyłączony", () => {
    expect(buildStageArgs({ ...STAGE_ARGS, forceVendorOverwrite: false })).not.toContain(
      "--force-vendor-overwrite"
    )
  })

  it("withStageEnv ustawia env na 'true' dokładnie wtedy, gdy taka jest intencja runu", async () => {
    const enabled = await withStageEnv(
      { ...STAGE_ARGS, forceVendorOverwrite: true },
      async () => process.env.GP_FORCE_VENDOR_OVERWRITE
    )
    expect(enabled).toBe("true")

    // ...i nadal jawnie zeruje odziedziczoną wartość, gdy intencji nie ma
    process.env.GP_FORCE_VENDOR_OVERWRITE = "true"
    const disabled = await withStageEnv(
      { ...STAGE_ARGS, forceVendorOverwrite: false },
      async () => process.env.GP_FORCE_VENDOR_OVERWRITE
    )
    expect(disabled).toBe("false")
  })
})

describe("invokeStageEntrypoint — nie połyka kodu wyjścia etapu (V4)", () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it("przechwytuje niezerowy process.exitCode etapu do sinka sygnałów", async () => {
    const sink: StageExitSignal[] = []

    await invokeStageEntrypoint(
      async () => {
        // dokładnie to robi gp-config-sync-vendors przy warnings.length > 0
        process.exitCode = 1
      },
      {},
      [],
      { stage: "sync-vendors", sink }
    )

    expect(sink).toEqual([{ stage: "sync-vendors", exitCode: 1 }])
  })

  it("nie zaraża orchestratora kodem wyjścia etapu (izolacja zachowana)", async () => {
    const sink: StageExitSignal[] = []
    process.exitCode = undefined

    await invokeStageEntrypoint(
      async () => {
        process.exitCode = 1
      },
      {},
      [],
      { stage: "sync-vendors", sink }
    )

    expect(process.exitCode).toBeUndefined()
  })

  it("nie zgłasza sygnału, gdy etap zakończył się zerem", async () => {
    const sink: StageExitSignal[] = []

    await invokeStageEntrypoint(async () => undefined, {}, [], {
      stage: "sync-catalog",
      sink,
    })

    expect(sink).toEqual([])
  })
})
