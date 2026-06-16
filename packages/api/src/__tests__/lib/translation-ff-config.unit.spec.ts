import {
  buildTranslationModuleConfig,
  resolveTranslationFeatureFlagPolicy,
  TRANSLATION_ENTITY_SETTINGS,
} from "../../lib/translation-ff-config"

describe("translation FF config", () => {
  it("rozstrzyga per-env policy default: production, staging i test maja FF=on", () => {
    expect(resolveTranslationFeatureFlagPolicy({ GP_ENV: "production" })).toEqual(
      expect.objectContaining({
        environment: "production",
        enabled: true,
        source: "policy-default",
      })
    )
    expect(resolveTranslationFeatureFlagPolicy({ GP_ENV: "staging" })).toEqual(
      expect.objectContaining({
        environment: "staging",
        enabled: true,
        source: "policy-default",
      })
    )
    expect(resolveTranslationFeatureFlagPolicy({ NODE_ENV: "test" })).toEqual(
      expect.objectContaining({
        environment: "test",
        enabled: true,
        source: "policy-default",
      })
    )
  })

  it("rozstrzyga dev jako configurable z jawnym defaultem OFF", () => {
    expect(resolveTranslationFeatureFlagPolicy({})).toEqual(
      expect.objectContaining({
        environment: "dev",
        enabled: false,
        source: "policy-default",
      })
    )

    expect(resolveTranslationFeatureFlagPolicy({ GP_ENV: "dev" })).toEqual(
      expect.objectContaining({
        environment: "dev",
        enabled: false,
        source: "policy-default",
      })
    )
    expect(
      resolveTranslationFeatureFlagPolicy({
        GP_ENV: "dev",
        MEDUSA_FF_TRANSLATION: "true",
      })
    ).toEqual(
      expect.objectContaining({
        environment: "dev",
        enabled: true,
        source: "env-override",
      })
    )
    expect(
      resolveTranslationFeatureFlagPolicy({
        GP_ENV: "dev",
        MEDUSA_FF_TRANSLATION: "false",
      })
    ).toEqual(
      expect.objectContaining({
        environment: "dev",
        enabled: false,
        source: "env-override",
      })
    )
  })

  it("uzywa jawnej precedencji GP_ENV -> MEDUSA_STAGE -> NODE_ENV", () => {
    expect(
      resolveTranslationFeatureFlagPolicy({
        GP_ENV: "staging",
        MEDUSA_STAGE: "production",
        NODE_ENV: "development",
      }).environment
    ).toBe("staging")

    expect(
      resolveTranslationFeatureFlagPolicy({
        MEDUSA_STAGE: "production",
        NODE_ENV: "development",
      }).environment
    ).toBe("production")

    expect(
      resolveTranslationFeatureFlagPolicy({
        MEDUSA_STAGE: "canary",
        NODE_ENV: "development",
      }).environment
    ).toBe("staging")
  })

  it("fail-loud dla nieznanego env, niepoprawnej wartosci i proby wylaczenia FF poza dev", () => {
    expect(() => resolveTranslationFeatureFlagPolicy({ GP_ENV: "preview" })).toThrow(
      /Unsupported MEDUSA_FF_TRANSLATION environment/
    )

    expect(() =>
      resolveTranslationFeatureFlagPolicy({
        GP_ENV: "dev",
        MEDUSA_FF_TRANSLATION: "on",
      })
    ).toThrow(/Invalid MEDUSA_FF_TRANSLATION value/)

    expect(() =>
      resolveTranslationFeatureFlagPolicy({
        GP_ENV: "production",
        MEDUSA_FF_TRANSLATION: "false",
      })
    ).toThrow(/cannot be disabled by MEDUSA_FF_TRANSLATION=false/)
  })

  it("rejestruje core Translation Module zgodnie z per-env policy", () => {
    expect(
      buildTranslationModuleConfig({ GP_ENV: "production" }, [])
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])

    expect(
      buildTranslationModuleConfig({ GP_ENV: "dev", MEDUSA_FF_TRANSLATION: "true" }, [])
    ).toEqual([
      {
        key: "translation",
        resolve: "@medusajs/medusa/translation",
      },
    ])

    expect(
      buildTranslationModuleConfig({ GP_ENV: "dev", MEDUSA_FF_TRANSLATION: "false" }, [])
    ).toEqual([])
  })

  it("laduje modul przy jawnym rollbacku translation mimo FF=false", () => {
    expect(
      buildTranslationModuleConfig(
        { GP_ENV: "production", MEDUSA_FF_TRANSLATION: "false" },
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
        { GP_ENV: "production", MEDUSA_FF_TRANSLATION: "false" },
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
          GP_ENV: "production",
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
        { GP_ENV: "dev", MEDUSA_FF_TRANSLATION: "false" },
        ["node", "medusa", "db:rollback", "--modules", "translation"]
      )
    ).toThrow(/Unsupported translation rollback command/)

    expect(() =>
      buildTranslationModuleConfig(
        { GP_ENV: "dev", MEDUSA_FF_TRANSLATION: "false" },
        ["node", "medusa", "db:rollback"]
      )
    ).toThrow(/Unsupported translation rollback command/)
  })

  it("mapuje story label collection oraz seller na techniczne entity types", () => {
    expect(TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.story_label)).toEqual([
      "product",
      "product_category",
      "product_type",
      "product_variant",
      "collection",
      "seller",
    ])

    expect(
      TRANSLATION_ENTITY_SETTINGS.find(
        (setting) => setting.story_label === "collection"
      )?.entity_type
    ).toBe("product_collection")

    expect(
      TRANSLATION_ENTITY_SETTINGS.find((setting) => setting.story_label === "seller")
    ).toEqual({
      story_label: "seller",
      entity_type: "seller",
      fields: ["name", "description"],
    })
  })
})
