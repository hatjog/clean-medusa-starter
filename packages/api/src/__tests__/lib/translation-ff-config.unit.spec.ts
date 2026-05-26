import {
  buildTranslationModuleConfig,
  STORE_SUPPORTED_LOCALES,
  TRANSLATION_ENTITY_SETTINGS,
} from "../../lib/translation-ff-config"

describe("translation FF config", () => {
  it("rejestruje core Translation Module tylko gdy MEDUSA_FF_TRANSLATION=true", () => {
    expect(
      buildTranslationModuleConfig({ MEDUSA_FF_TRANSLATION: "true" }, [])
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])

    expect(
      buildTranslationModuleConfig({ MEDUSA_FF_TRANSLATION: "false" }, [])
    ).toEqual([])
    expect(buildTranslationModuleConfig({}, [])).toEqual([])
  })

  it("laduje modul przy jawnym rollbacku translation mimo FF=false", () => {
    expect(
      buildTranslationModuleConfig(
        { MEDUSA_FF_TRANSLATION: "false" },
        ["node", "medusa", "db:rollback", "--modules", "translation"]
      )
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])

    expect(
      buildTranslationModuleConfig(
        { MEDUSA_FF_TRANSLATION: "false" },
        ["node", "medusa", "db:rollback", "--modules=translation"]
      )
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])
  })

  it("publikuje dokladnie 4 canonical BCP 47 locale codes dla Store", () => {
    expect(STORE_SUPPORTED_LOCALES.map((locale) => locale.code)).toEqual([
      "pl-PL",
      "en-US",
      "uk-UA",
      "de-DE",
    ])
  })

  it("mapuje story label collection na techniczny ProductCollection entity type", () => {
    expect(TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.story_label)).toEqual([
      "product",
      "product_category",
      "product_type",
      "product_variant",
      "collection",
    ])

    expect(
      TRANSLATION_ENTITY_SETTINGS.find(
        (setting) => setting.story_label === "collection"
      )?.entity_type
    ).toBe("product_collection")
  })
})
