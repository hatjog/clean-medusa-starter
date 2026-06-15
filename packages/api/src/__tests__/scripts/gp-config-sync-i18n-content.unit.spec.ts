import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { syncI18nTranslationContent } from "../../scripts/gp-config-sync-i18n-content"

async function writeI18nFixture() {
  const i18nDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-i18n-content-"))

  await fs.writeFile(
    path.join(i18nDir, "categories.yaml"),
    [
      "entries:",
      "  - handle: twarz",
      "    fields:",
      "      name:",
      "        uk-UA: Обличчя",
      "        en-US: Face",
      "      description:",
      "        uk-UA: Категорія обличчя",
      "        en-US: Face category",
      "",
    ].join("\n"),
    "utf8"
  )
  await fs.writeFile(
    path.join(i18nDir, "products.yaml"),
    [
      "entries:",
      "  - handle: oczyszczanie-twarzy",
      "    fields:",
      "      title:",
      "        uk-UA: Очищення обличчя",
      "        en-US: Facial cleansing",
      "      subtitle:",
      "        uk-UA: Ваучер BonBeauty",
      "        en-US: BonBeauty voucher",
      "      description:",
      "        uk-UA: Український опис",
      "        en-US: English description",
      "",
    ].join("\n"),
    "utf8"
  )
  await fs.writeFile(
    path.join(i18nDir, "sellers.yaml"),
    [
      "entries:",
      "  - handle: city-beauty",
      "    fields:",
      "      name:",
      "        uk-UA: City Beauty",
      "        en-US: City Beauty",
      "      description:",
      "        uk-UA: Український опис салону",
      "        en-US: English seller description",
      "",
    ].join("\n"),
    "utf8"
  )

  return i18nDir
}

function makeServices(existingTranslations: any[] = []) {
  const productModuleService = {
    listProductCategories: jest.fn(async (filters) =>
      filters.handle === "twarz"
        ? [{ id: "pcat_1", handle: "twarz", metadata: { gp: { market_id: "bonbeauty" } } }]
        : []
    ),
    listProducts: jest.fn(async (filters) =>
      filters.handle === "oczyszczanie-twarzy"
        ? [{ id: "prod_1", handle: "oczyszczanie-twarzy", metadata: { gp: { market_id: "bonbeauty" } } }]
        : []
    ),
  }
  const sellerModuleService = {
    list: jest.fn(async (filters) =>
      filters.handle === "city-beauty"
        ? [{ id: "sel_1", handle: "city-beauty", metadata: { gp: { market_id: "bonbeauty" } } }]
        : []
    ),
  }
  const translationService = {
    listTranslations: jest.fn(async (filters) => {
      const ids = Array.isArray(filters.reference_id)
        ? filters.reference_id
        : [filters.reference_id]

      return existingTranslations.filter(
        (row) =>
          row.reference === filters.reference &&
          row.locale_code === filters.locale_code &&
          ids.includes(row.reference_id)
      )
    }),
    createTranslations: jest.fn(async (_payload: any) => undefined),
    updateTranslations: jest.fn(async (_payload: any) => undefined),
  }

  return { productModuleService, sellerModuleService, translationService }
}

describe("gp-config-sync-i18n-content", () => {
  it("upserts translation content idempotently by reference id and locale", async () => {
    const i18nDir = await writeI18nFixture()
    const { productModuleService, sellerModuleService, translationService } = makeServices([
      {
        id: "trans_cat_en",
        reference_id: "pcat_1",
        reference: "product_category",
        locale_code: "en-US",
        translations: {
          name: "Face",
          description: "Face category",
        },
      },
      {
        id: "trans_prod_uk",
        reference_id: "prod_1",
        reference: "product",
        locale_code: "uk-UA",
        translations: {
          title: "Old title",
        },
      },
    ])

    const summary = await syncI18nTranslationContent(
      translationService,
      productModuleService,
      sellerModuleService,
      {
        i18nDir,
        locales: ["uk-UA", "en-US"],
        marketId: "bonbeauty",
      }
    )

    expect(summary.entities.product_category).toMatchObject({
      translation_records: 2,
      created: 1,
      unchanged: 1,
    })
    expect(summary.entities.product).toMatchObject({
      translation_records: 2,
      created: 1,
      updated: 1,
    })
    expect(summary.entities.seller).toMatchObject({
      translation_records: 2,
      created: 2,
    })
    expect(translationService.updateTranslations).toHaveBeenCalledWith([
      {
        id: "trans_prod_uk",
        reference: "product",
        translations: {
          title: "Очищення обличчя",
          subtitle: "Ваучер BonBeauty",
          description: "Український опис",
        },
      },
    ])
    expect(translationService.createTranslations).toHaveBeenCalledTimes(4)
    expect(
      translationService.createTranslations.mock.calls.flatMap(([payload]) => payload)
    ).toHaveLength(4)
  })

  it("keeps dry-run side-effect free while reporting planned changes", async () => {
    const i18nDir = await writeI18nFixture()
    const { productModuleService, sellerModuleService, translationService } = makeServices()

    const summary = await syncI18nTranslationContent(
      translationService,
      productModuleService,
      sellerModuleService,
      {
        dryRun: true,
        i18nDir,
        locales: ["uk-UA"],
        marketId: "bonbeauty",
      }
    )

    expect(summary.entities.product.created).toBe(1)
    expect(summary.entities.product_category.created).toBe(1)
    expect(summary.entities.seller.created).toBe(1)
    expect(translationService.createTranslations).not.toHaveBeenCalled()
    expect(translationService.updateTranslations).not.toHaveBeenCalled()
  })
})
