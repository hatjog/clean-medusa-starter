import {
  buildTranslationModuleConfig,
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
        ["node", "medusa", "db:rollback", "--module", "translation"]
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
        ["node", "medusa", "db:rollback", "--module=@medusajs/translation"]
      )
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])
  })

  it("laduje modul przy jawnym env rollback override", () => {
    expect(
      buildTranslationModuleConfig(
        {
          MEDUSA_FF_TRANSLATION: "false",
          MEDUSA_TRANSLATION_ROLLBACK: "true",
        },
        ["node", "medusa", "db:rollback", "--modules", "translation"]
      )
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])
  })

  it("failuje przy nieobslugiwanym formacie rollbacku", () => {
    expect(() =>
      buildTranslationModuleConfig(
        { MEDUSA_FF_TRANSLATION: "false" },
        ["node", "medusa", "db:rollback", "--modules", "translation"]
      )
    ).toThrow(/Unsupported translation rollback command/)

    expect(() =>
      buildTranslationModuleConfig(
        { MEDUSA_FF_TRANSLATION: "false" },
        ["node", "medusa", "db:rollback"]
      )
    ).toThrow(/Unsupported translation rollback command/)
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
