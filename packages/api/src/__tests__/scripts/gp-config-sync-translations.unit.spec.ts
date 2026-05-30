import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  gpConfigSyncTranslations,
  loadMarketSupportedLocaleCodes,
  syncStoreSupportedLocales,
  syncTranslationSettings,
} from "../../scripts/gp-config-sync-translations"

function createAdvisoryLockDb() {
  const connection = {
    query: jest.fn(async () => ({ rows: [] })),
  }
  const db = {
    client: {
      acquireConnection: jest.fn(async () => connection),
      releaseConnection: jest.fn(async () => undefined),
    },
  }

  return { connection, db }
}

async function writeMarketYaml(locales: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gp-market-config-"))
  const marketDir = path.join(root, "gp-dev", "markets", "bonbeauty")
  await fs.mkdir(marketDir, { recursive: true })
  await fs.writeFile(
    path.join(marketDir, "market.yaml"),
    [
      "market_id: bonbeauty",
      "supported_locales:",
      ...locales.map((locale) => `  - ${locale}`),
      "",
    ].join("\n"),
    "utf8"
  )

  return root
}

describe("gp-config-sync-translations", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_CONFIG_ROOT
    delete process.env.GP_INSTANCE_ID
    delete process.env.GP_MARKET_ID
    delete process.env.MEDUSA_FF_TRANSLATION
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("czyta Store.supported_locales z market.yaml dla aktualnego marketu", async () => {
    const configRoot = await writeMarketYaml(["pl-PL", "en-US", "uk-UA", "de-DE"])
    const storeService = {
      listStores: jest.fn(async () => [
        {
          id: "store_1",
          supported_locales: [{ locale_code: "pl_PL" }, { locale_code: "en" }],
        },
      ]),
      updateStores: jest.fn(async () => undefined),
    }

    const summary = await syncStoreSupportedLocales(storeService, {
      localeConfig: { configRoot, instanceId: "gp-dev", marketId: "bonbeauty" },
    })

    expect(storeService.listStores).toHaveBeenCalledWith(
      {},
      { take: null, relations: ["supported_locales"] }
    )
    expect(storeService.updateStores).toHaveBeenCalledWith("store_1", {
      supported_locales: [
        { locale_code: "pl-PL" },
        { locale_code: "en-US" },
        { locale_code: "uk-UA" },
        { locale_code: "de-DE" },
      ],
    })
    expect(summary.codes).toEqual(["pl-PL", "en-US", "uk-UA", "de-DE"])
  })

  it("failuje bez GP_MARKET_ID albo supported_locales", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gp-market-config-"))
    const marketDir = path.join(root, "gp-dev", "markets", "bonbeauty")
    await fs.mkdir(marketDir, { recursive: true })
    await fs.writeFile(path.join(marketDir, "market.yaml"), "market_id: bonbeauty\n", "utf8")

    await expect(
      loadMarketSupportedLocaleCodes({ configRoot: root, instanceId: "gp-dev" })
    ).rejects.toThrow(/GP_MARKET_ID is required/)

    await expect(
      loadMarketSupportedLocaleCodes({
        configRoot: root,
        instanceId: "gp-dev",
        marketId: "bonbeauty",
      })
    ).rejects.toThrow(/supported_locales is required/)
  })

  it("nie tworzy Store bez jawnego --bootstrap-store", async () => {
    const configRoot = await writeMarketYaml(["pl-PL"])
    const storeService = {
      listStores: jest.fn(async () => []),
      createStores: jest.fn(async () => undefined),
    }

    await expect(
      syncStoreSupportedLocales(storeService, {
        localeConfig: { configRoot, instanceId: "gp-dev", marketId: "bonbeauty" },
      })
    ).rejects.toThrow("no Store found; pass --bootstrap-store with separate evidence to create default")

    const summary = await syncStoreSupportedLocales(storeService, {
      bootstrapStore: true,
      localeConfig: { configRoot, instanceId: "gp-dev", marketId: "bonbeauty" },
    })

    expect(storeService.createStores).toHaveBeenCalledWith({
      name: "Medusa Store",
      supported_locales: [{ locale_code: "pl-PL" }],
    })
    expect(summary.stores).toBe(1)
  })

  it("uzupelnia translation_settings pod PostgreSQL advisory lockiem", async () => {
    const { connection, db } = createAdvisoryLockDb()
    const translationService = {
      listTranslationSettings: jest.fn(async () => [
        {
          id: "trset_product",
          entity_type: "product",
          fields: ["title"],
          is_active: false,
        },
      ]),
      createTranslationSettings: jest.fn(async () => undefined),
      updateTranslationSettings: jest.fn(async () => undefined),
    }

    const summary = await syncTranslationSettings(translationService, { db })

    expect(connection.query).toHaveBeenNthCalledWith(1, "SELECT pg_advisory_lock($1)", [
      210260021,
    ])
    expect(connection.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock($1)", [
      210260021,
    ])
    expect(translationService.listTranslationSettings).toHaveBeenCalledTimes(2)
    expect(translationService.updateTranslationSettings).toHaveBeenCalledWith([
      {
        id: "trset_product",
        fields: ["title", "subtitle", "description", "material"],
        is_active: true,
      },
    ])
    expect(translationService.createTranslationSettings).toHaveBeenCalledTimes(5)
    expect(translationService.createTranslationSettings).toHaveBeenCalledWith({
      entity_type: "seller",
      fields: ["name", "description"],
    })
    expect(summary.story_labels).toEqual([
      "product",
      "product_category",
      "product_type",
      "product_variant",
      "collection",
      "seller",
    ])
  })

  it("nie usuwa istniejacych fields bez --overwrite", async () => {
    const { db } = createAdvisoryLockDb()
    const translationService = {
      listTranslationSettings: jest.fn(async () => [
        {
          id: "trset_product",
          entity_type: "product",
          fields: ["title", "custom_field"],
          is_active: true,
        },
        {
          id: "trset_category",
          entity_type: "product_category",
          fields: ["name", "description"],
          is_active: true,
        },
        {
          id: "trset_type",
          entity_type: "product_type",
          fields: ["value"],
          is_active: true,
        },
        {
          id: "trset_variant",
          entity_type: "product_variant",
          fields: ["title", "material"],
          is_active: true,
        },
        {
          id: "trset_collection",
          entity_type: "product_collection",
          fields: ["title"],
          is_active: true,
        },
      ]),
      createTranslationSettings: jest.fn(async () => undefined),
      updateTranslationSettings: jest.fn(async () => undefined),
    }

    await syncTranslationSettings(translationService, { db })

    expect(translationService.updateTranslationSettings).toHaveBeenCalledWith([
      {
        id: "trset_product",
        fields: ["title", "custom_field", "subtitle", "description", "material"],
        is_active: true,
      },
    ])
    expect(translationService.createTranslationSettings).toHaveBeenCalledWith({
      entity_type: "seller",
      fields: ["name", "description"],
    })
  })

  it("usuwa nadmiarowe fields tylko przy --overwrite", async () => {
    const { db } = createAdvisoryLockDb()
    const translationService = {
      listTranslationSettings: jest.fn(async () => [
        {
          id: "trset_product",
          entity_type: "product",
          fields: ["title", "custom_field"],
          is_active: true,
        },
        {
          id: "trset_category",
          entity_type: "product_category",
          fields: ["name", "description"],
          is_active: true,
        },
        {
          id: "trset_type",
          entity_type: "product_type",
          fields: ["value"],
          is_active: true,
        },
        {
          id: "trset_variant",
          entity_type: "product_variant",
          fields: ["title", "material"],
          is_active: true,
        },
        {
          id: "trset_collection",
          entity_type: "product_collection",
          fields: ["title"],
          is_active: true,
        },
      ]),
      createTranslationSettings: jest.fn(async () => undefined),
      updateTranslationSettings: jest.fn(async () => undefined),
    }

    await syncTranslationSettings(translationService, { db, overwrite: true })

    expect(translationService.updateTranslationSettings).toHaveBeenCalledWith([
      {
        id: "trset_product",
        fields: ["title", "subtitle", "description", "material"],
        is_active: true,
      },
    ])
  })

  it("jest idempotentny gdy Medusa auto-rejestruje translation_settings rownolegle", async () => {
    const { db } = createAdvisoryLockDb()
    const rowsAfterRace = [
      {
        id: "trset_product",
        entity_type: "product",
        fields: ["title"],
        is_active: false,
      },
      {
        id: "trset_category",
        entity_type: "product_category",
        fields: ["name", "description"],
        is_active: true,
      },
      {
        id: "trset_type",
        entity_type: "product_type",
        fields: ["value"],
        is_active: true,
      },
      {
        id: "trset_variant",
        entity_type: "product_variant",
        fields: ["title", "material"],
        is_active: true,
      },
      {
        id: "trset_collection",
        entity_type: "product_collection",
        fields: ["title"],
        is_active: true,
      },
    ]
    const translationService = {
      listTranslationSettings: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(rowsAfterRace),
      createTranslationSettings: jest.fn(async (payload) => {
        if (payload.entity_type === "product") {
          throw new Error("Translation settings with entity_type: product, already exists.")
        }
      }),
      updateTranslationSettings: jest.fn(async () => undefined),
    }

    const summary = await syncTranslationSettings(translationService, { db })

    expect(translationService.listTranslationSettings).toHaveBeenCalledTimes(2)
    expect(translationService.updateTranslationSettings).toHaveBeenCalledWith([
      {
        id: "trset_product",
        fields: ["title", "subtitle", "description", "material"],
        is_active: true,
      },
    ])
    expect(summary.created).toEqual([
      "product_category",
      "product_type",
      "product_variant",
      "product_collection",
      "seller",
    ])
    expect(summary.updated).toEqual(["trset_product"])
  })

  it("pomija sync bez rozwiazywania serwisow gdy Translation FF jest wylaczony", async () => {
    process.env.MEDUSA_FF_TRANSLATION = "false"
    const container = {
      resolve: jest.fn(() => {
        throw new Error("nie powinno byc wywolane")
      }),
    }

    await expect(
      gpConfigSyncTranslations({ container: container as never, args: [] })
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "MEDUSA_FF_TRANSLATION is not true",
    })
    expect(container.resolve).not.toHaveBeenCalled()
  })
})
