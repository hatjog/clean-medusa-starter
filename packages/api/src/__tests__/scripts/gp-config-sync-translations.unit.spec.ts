import {
  gpConfigSyncTranslations,
  syncStoreSupportedLocales,
  syncTranslationSettings,
} from "../../scripts/gp-config-sync-translations"

describe("gp-config-sync-translations", () => {
  afterEach(() => {
    delete process.env.MEDUSA_FF_TRANSLATION
  })

  it("ustawia Store.supported_locales jako dokladnie 4 canonical BCP 47 codes", async () => {
    const storeService = {
      listStores: jest.fn(async () => [
        {
          id: "store_1",
          supported_locales: [{ locale_code: "pl_PL" }, { locale_code: "en" }],
        },
      ]),
      updateStores: jest.fn(async () => undefined),
    }

    const summary = await syncStoreSupportedLocales(storeService)

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

  it("uzupelnia translation_settings dla pieciu canonical Medusa entities", async () => {
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

    const summary = await syncTranslationSettings(translationService)

    expect(translationService.listTranslationSettings).toHaveBeenCalledWith(
      {},
      { take: null }
    )
    expect(translationService.updateTranslationSettings).toHaveBeenCalledWith([
      {
        id: "trset_product",
        fields: ["title", "subtitle", "description", "material"],
        is_active: true,
      },
    ])
    expect(translationService.createTranslationSettings).toHaveBeenCalledTimes(4)
    expect(translationService.createTranslationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: "product_category" })
    )
    expect(translationService.createTranslationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: "product_type" })
    )
    expect(translationService.createTranslationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: "product_variant" })
    )
    expect(translationService.createTranslationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: "product_collection" })
    )
    expect(summary.story_labels).toEqual([
      "product",
      "product_category",
      "product_type",
      "product_variant",
      "collection",
    ])
  })

  it("jest idempotentny gdy Medusa auto-rejestruje translation_settings rownolegle", async () => {
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

    const summary = await syncTranslationSettings(translationService)

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
    ).resolves.toBeUndefined()
    expect(container.resolve).not.toHaveBeenCalled()
  })
})
