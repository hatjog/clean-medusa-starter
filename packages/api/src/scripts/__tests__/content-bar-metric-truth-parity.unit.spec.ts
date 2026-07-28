/**
 * Story 4.6 / AC-A3 — „źródło metryki ≠ źródło prawdy" jako test, nie jako notatka.
 *
 * ## Klasa błędu, przed którą to broni
 *
 * W sprincie 3 `content_bar` był liczony ze **stubowego source YAML**, a nie
 * z ciała, które realnie ląduje na encji — dało to `bar.pl = false` dla
 * 113/113 produktów i regresję zerowego katalogu. Wada nie polegała na złej
 * matematyce progu (ta miała komplet zielonych unitów), tylko na tym, że
 * DWIE ścieżki czytały PL z DWÓCH RÓŻNYCH MIEJSC.
 *
 * Te dwie ścieżki nadal istnieją i nadal są niezależne:
 *
 *   1. **metryka** — `measureMarketContentBar` (`gp-config-content-bar`),
 *      którą konsumuje raport FR-23 i etap `bar` pipeline'u FR-22,
 *   2. **prawda** — `collectTranslationPayloads` w `gp-config-sync-i18n-content`,
 *      która buduje `bodiesByLocale` materializowany na encji jako
 *      `metadata.gp.content_bar` i to jej wynik widzi storefront.
 *
 * Ten test odtwarza regułę sourcingu (2) na realnych plikach repo i porównuje
 * ją z (1) — pole po polu, wpis po wpisie, locale po locale. Rozjazd = FAIL.
 *
 * ## Dlaczego reguła (2) jest tu odtworzona, a nie zaimportowana
 *
 * `collectTranslationPayloads` nie jest eksportowane i wymaga kontenera Medusy
 * (`listEntitiesByHandle` → DB). Odtwarzamy więc jego **regułę sourcingu PL**,
 * która jest w kodzie jawna i krótka:
 *
 *   - klucze PL z `i18n/*.yaml` są USUWANE (stub nigdy nie konkuruje z body),
 *   - `product_category` → PL z gp-config `products.yaml → categories[]`,
 *   - `product` / `seller` → PL z `description` encji w DB, a ta jest
 *     seedowana z gp-config (`products[].description` / `vendors[].description`).
 *
 * Jeśli sync zmieni źródło PL, ten test zacznie kłamać — dlatego pilnuje go
 * `it("reguła sourcingu PL w sync-i18n-content nie zmieniła kształtu")`, który
 * czyta kod skryptu i failuje, gdy zniknie któryś z jego znaczników.
 */

import fs from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import { measureMarketContentBar } from "../gp-config-content-bar"
import { buildContentBarMap, localeRoutingSlug } from "../lib/content-bar"

function resolveProjectRoot(start: string): string {
  let current = path.resolve(start)
  while (true) {
    if (
      fs.existsSync(path.join(current, "gp-ops")) &&
      fs.existsSync(path.join(current, "GP"))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return ""
    current = parent
  }
}

const INSTANCE = "gp-dev"
const MARKET = "bonbeauty"

const projectRoot = resolveProjectRoot(process.cwd())
const i18nRoot = projectRoot ? path.join(projectRoot, "gp-ops", "markets") : ""
const marketI18nDir = i18nRoot ? path.join(i18nRoot, MARKET, "i18n") : ""

// Samodzielny checkout submodulu nie ma `gp-ops/` — wtedy nie ma czego
// porównywać i test jest pomijany zamiast fałszywie failować (ta sama
// konwencja co content-bar-smoke).
const maybeDescribe =
  marketI18nDir && fs.existsSync(marketI18nDir) ? describe : describe.skip

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function loadYaml(filePath: string): unknown {
  return yaml.load(fs.readFileSync(filePath, "utf8"), { schema: yaml.JSON_SCHEMA })
}

/** PL widziany przez SYNC dla kategorii: gp-config `products.yaml → categories[]`. */
function syncCategoryPl(configRoot: string): Map<string, string> {
  const doc = loadYaml(path.join(configRoot, INSTANCE, "markets", MARKET, "products.yaml"))
  const out = new Map<string, string>()
  const categories = isRecord(doc) && Array.isArray(doc.categories) ? doc.categories : []
  for (const category of categories) {
    if (!isRecord(category)) continue
    const handle = typeof category.handle === "string" ? category.handle.trim() : ""
    if (!handle) continue
    out.set(handle, typeof category.description === "string" ? category.description : "")
  }
  return out
}

/**
 * PL widziany przez SYNC dla sellera: `description` encji w DB. Encja jest
 * seedowana z gp-config `market.yaml → vendors[].description`, więc to ten
 * plik jest tu wiarygodnym stand-inem dla DB (i jednocześnie to on jest
 * rozstrzygniętym ŹRÓDŁEM PL sellera wg Story 4.6 / AC-A1).
 */
function syncSellerPl(configRoot: string): Map<string, string> {
  const doc = loadYaml(path.join(configRoot, INSTANCE, "markets", MARKET, "market.yaml"))
  const out = new Map<string, string>()
  const vendors = isRecord(doc) && Array.isArray(doc.vendors) ? doc.vendors : []
  for (const vendor of vendors) {
    if (!isRecord(vendor)) continue
    const handle =
      typeof vendor.slug === "string" && vendor.slug.trim()
        ? vendor.slug.trim()
        : typeof vendor.vendor_id === "string"
          ? vendor.vendor_id.trim()
          : ""
    if (!handle) continue
    out.set(handle, typeof vendor.description === "string" ? vendor.description : "")
  }
  return out
}

const PL_SLUG = localeRoutingSlug("pl-PL")

maybeDescribe("AD-4 — metryka baru i materializacja czytają to samo body", () => {
  // Metryka czyta assembled `gp-ops/config` (default `gp-config-content-bar`).
  const metricConfigRoot = path.join(projectRoot, "gp-ops", "config")
  // Sync czyta assembled `GP/config` (default `../config` względem backendu).
  const syncConfigRoot = path.join(projectRoot, "GP", "config")

  const report = measureMarketContentBar({
    configRoot: metricConfigRoot,
    i18nRoot,
    instanceId: INSTANCE,
    marketId: MARKET,
  })

  it.each(["product_category", "seller"] as const)(
    "%s: content_bar z metryki == content_bar policzony ze źródła prawdy (wszystkie wpisy, wszystkie locale)",
    (entityType) => {
      const fileName = entityType === "seller" ? "sellers.yaml" : "categories.yaml"
      const doc = loadYaml(path.join(marketI18nDir, fileName))
      const entries = isRecord(doc) && Array.isArray(doc.entries) ? doc.entries : []
      expect(entries.length).toBeGreaterThan(0)

      const plByHandle =
        entryTypeIsCategory(entityType)
          ? syncCategoryPl(syncConfigRoot)
          : syncSellerPl(syncConfigRoot)

      const measured = new Map(
        report.entities[entityType].map((entity) => [entity.handle, entity.content_bar])
      )

      for (const entry of entries) {
        if (!isRecord(entry)) continue
        const handle = String(entry.handle ?? "").trim()
        const fields = isRecord(entry.fields) ? entry.fields : {}
        const description = isRecord(fields.description) ? { ...fields.description } : {}

        // Reguła sourcingu SYNC-u, krok po kroku.
        for (const locale of Object.keys(description)) {
          if (localeRoutingSlug(locale) === PL_SLUG) {
            delete description[locale]
          }
        }
        description["pl-PL"] = plByHandle.get(handle) ?? ""

        const truth = buildContentBarMap(entityType, description)
        expect({ handle, bar: measured.get(handle) }).toEqual({ handle, bar: truth })
      }
    }
  )

  it("każdy wpis kategorii i sellera ma pomiar dla wszystkich czterech slugów locale", () => {
    for (const entityType of ["product_category", "seller"] as const) {
      for (const entity of report.entities[entityType]) {
        expect(Object.keys(entity.content_bar).sort()).toEqual(["de", "en", "pl", "ua"])
      }
    }
  })

  it("reguła sourcingu PL w sync-i18n-content nie zmieniła kształtu", () => {
    // Ten test odtwarza regułę z `collectTranslationPayloads`. Gdyby sync
    // przestał usuwać PL z YAML-a albo zmienił źródło PL, odtworzenie
    // cicho przestałoby opisywać rzeczywistość — a asercje wyżej nadal
    // byłyby zielone. Kotwiczymy się więc w kodzie skryptu.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "gp-config-sync-i18n-content.ts"),
      "utf8"
    )
    expect(source).toContain("isNativePlLocale(key)")
    expect(source).toContain('bodies["pl-PL"] = options.categoryPlByHandle.get(handle)')
    expect(source).toContain(
      'bodies["pl-PL"] = typeof match.description === "string" ? match.description : ""'
    )
  })
})

function entryTypeIsCategory(entityType: string): boolean {
  return entityType === "product_category"
}
