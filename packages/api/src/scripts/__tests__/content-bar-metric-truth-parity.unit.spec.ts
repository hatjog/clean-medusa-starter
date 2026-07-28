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
 *   - `product` → PL z kolumny `description` encji w DB,
 *   - `seller` → PL z `metadata.gp.description` encji w DB (fallback: kolumna).
 *
 * Jeśli sync zmieni źródło PL, ten test zacznie kłamać — dlatego pilnuje go
 * `it("reguła sourcingu PL w sync-i18n-content nie zmieniła kształtu")`, który
 * czyta kod skryptu i failuje, gdy zniknie któryś z jego znaczników.
 *
 * ## Review 4-6-H1 — dlaczego seller czyta ENCJĘ, a nie gp-config
 *
 * Pierwsza wersja tego testu podstawiała za encję sellera plik
 * `market.yaml → vendors[].description` („wiarygodny stand-in dla DB").
 * Stand-in jest wiarygodny wyłącznie wtedy, gdy encja == gp-config — czyli
 * dokładnie przy założeniu, którego lekcja sprint-3 kazała nie robić. Na
 * żywej bazie dev to założenie było FAŁSZYWE i test świecił się na zielono:
 *
 *   - `description` sellera jest polem `seed_if_empty` z ochroną własności
 *     vendora, więc `--stage ship` BEZ `--overwrite` nie przenosi nowych
 *     opisów PL z gp-config na encję (Case 2: „vendor edited → skip"),
 *   - opis żyje w `metadata.gp.description`, nie w kolumnie `description`
 *     (`gp-config-sync-vendors` nigdy tej kolumny nie zapisuje).
 *
 * Dlatego gałąź `seller` pyta teraz REALNĄ bazę. Brak połączenia = `describe.skip`
 * (widoczny w raporcie), nigdy cichy pass — pominięta bramka nie może wyglądać
 * jak bramka, która przeszła.
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
 * PL widziany przez SYNC dla sellera — odczytany z ENCJI (review 4-6-H1),
 * dokładnie tą samą regułą co `resolveSellerPlBody`: `metadata.gp.description`,
 * a dopiero potem kolumna `description`.
 */
async function syncSellerPlFromDb(
  pool: any,
  marketId: string
): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `select handle, description, metadata from seller where deleted_at is null`
  )
  const out = new Map<string, string>()
  for (const row of rows) {
    const metadata = isRecord(row.metadata) ? row.metadata : {}
    const gp = isRecord(metadata.gp) ? metadata.gp : {}
    if (gp.market_id !== marketId) continue
    const fromMeta = typeof gp.description === "string" ? gp.description : ""
    const body = fromMeta.trim().length > 0
      ? fromMeta
      : typeof row.description === "string"
        ? row.description
        : ""
    out.set(String(row.handle ?? "").trim(), body)
  }
  return out
}

const PL_SLUG = localeRoutingSlug("pl-PL")

/**
 * Reguła sourcingu SYNC-u zastosowana do wpisu i18n: PL z YAML-a wypada,
 * na jego miejsce wchodzi PL z bytu, który sync realnie czyta.
 */
function truthBarFor(
  entityType: "product_category" | "seller",
  entry: Record<string, unknown>,
  plBody: string
) {
  const fields = isRecord(entry.fields) ? entry.fields : {}
  const description = isRecord(fields.description) ? { ...fields.description } : {}
  for (const locale of Object.keys(description)) {
    if (localeRoutingSlug(locale) === PL_SLUG) {
      delete description[locale]
    }
  }
  description["pl-PL"] = plBody
  return buildContentBarMap(entityType, description)
}

function readI18nEntries(fileName: string): Array<Record<string, unknown>> {
  const doc = loadYaml(path.join(marketI18nDir, fileName))
  const entries = isRecord(doc) && Array.isArray(doc.entries) ? doc.entries : []
  return entries.filter(isRecord)
}

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

  const measuredFor = (entityType: "product_category" | "seller") =>
    new Map(report.entities[entityType].map((entity) => [entity.handle, entity.content_bar]))

  it("product_category: content_bar z metryki == content_bar policzony ze źródła prawdy (gp-config)", () => {
    const entries = readI18nEntries("categories.yaml")
    expect(entries.length).toBeGreaterThan(0)
    const plByHandle = syncCategoryPl(syncConfigRoot)
    const measured = measuredFor("product_category")

    for (const entry of entries) {
      const handle = String(entry.handle ?? "").trim()
      const truth = truthBarFor("product_category", entry, plByHandle.get(handle) ?? "")
      expect({ handle, bar: measured.get(handle) }).toEqual({ handle, bar: truth })
    }
  })

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
    expect(source).toContain('bodies["pl-PL"] = resolveSellerPlBody(match)')
    expect(source).toContain(
      'bodies["pl-PL"] = typeof match.description === "string" ? match.description : ""'
    )
    // Review 4-6-H1: kolejność odczytu sellera MUSI zostać przy metadanych gp.
    expect(source).toContain('typeof gp.description === "string"')
  })
})

// ---------------------------------------------------------------------------
// Gałąź `seller` — parity przeciwko REALNEJ encji (review 4-6-H1).
// ---------------------------------------------------------------------------

/**
 * `.env.test` backendu ustawia `DATABASE_URL=` (puste), więc pusta wartość
 * musi znaczyć „brak DB", nie „połącz się z niczym". `GP_CONTENT_PARITY_DATABASE_URL`
 * jest jawnym wejściem dla przebiegu po materializacji.
 */
const parityDbUrl = (
  process.env.GP_CONTENT_PARITY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  ""
).trim()

const maybeDbDescribe = marketI18nDir && fs.existsSync(marketI18nDir) && parityDbUrl
  ? describe
  : describe.skip

maybeDbDescribe("AD-4 / 4-6-H1 — seller: metryka == content_bar policzony z ENCJI", () => {
  let pool: any
  let plByHandle: Map<string, string>

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require("pg")
    pool = new Pool({ connectionString: parityDbUrl })
    plByHandle = await syncSellerPlFromDb(pool, MARKET)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it("każdy seller z i18n ma encję w bazie tego marketu", () => {
    for (const entry of readI18nEntries("sellers.yaml")) {
      const handle = String(entry.handle ?? "").trim()
      // Brak encji = metryka mierzy byt, którego sync nigdy nie zobaczy.
      expect({ handle, market: MARKET, present: plByHandle.has(handle) }).toEqual({
        handle,
        market: MARKET,
        present: true,
      })
    }
  })

  it("content_bar z metryki == content_bar policzony z encji (wszystkie wpisy, wszystkie locale)", () => {
    const entries = readI18nEntries("sellers.yaml")
    expect(entries.length).toBeGreaterThan(0)
    const measured = new Map(
      measureMarketContentBar({
        configRoot: path.join(projectRoot, "gp-ops", "config"),
        i18nRoot,
        instanceId: INSTANCE,
        marketId: MARKET,
      }).entities.seller.map((entity) => [entity.handle, entity.content_bar])
    )

    for (const entry of entries) {
      const handle = String(entry.handle ?? "").trim()
      const truth = truthBarFor("seller", entry, plByHandle.get(handle) ?? "")
      expect({ handle, bar: measured.get(handle) }).toEqual({ handle, bar: truth })
    }
  })

  it("zmaterializowany metadata.gp.content_bar na encji zgadza się z metryką", async () => {
    const { rows } = await pool.query(
      `select handle, metadata->'gp'->'content_bar' as content_bar
         from seller
        where deleted_at is null and metadata->'gp'->>'market_id' = $1`,
      [MARKET]
    )
    const persisted = new Map(rows.map((row: any) => [String(row.handle), row.content_bar]))
    const measured = measureMarketContentBar({
      configRoot: path.join(projectRoot, "gp-ops", "config"),
      i18nRoot,
      instanceId: INSTANCE,
      marketId: MARKET,
    })

    for (const entity of measured.entities.seller) {
      expect({ handle: entity.handle, bar: persisted.get(entity.handle) }).toEqual({
        handle: entity.handle,
        bar: entity.content_bar,
      })
    }
  })
})
