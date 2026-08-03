/**
 * `gp-config-content-bar` — pomiar baru treści (AD-4), logika bez DB i bez LLM.
 *
 * Skrypt czyta source YAML gp-ops (`gp-ops/markets/<market>/i18n/*.yaml`
 * + PL kategorii z `gp-ops/config/<instance>/markets/<market>/products.yaml`
 * wg AD-12) i emituje na stdout JSON z pomiarem `content_bar` per encja
 * × locale.
 *
 * Dlaczego osobny skrypt, a nie część `gp-config-sync-i18n-content`:
 * pipeline FR-22 (gp-cli, Story 4.2) musi umieć zmierzyć bar bez pisania do
 * Medusy i bez klucza LLM (AC4: „etapy nie wymagające modelu działają bez
 * klucza") — `measureMarketContentBar` NIE dotyka `container` (patrz
 * komentarz przy `gpConfigContentBar` niżej) i da się wywołać z testu
 * jednostkowego bez bootowania Medusy w ogóle. Sync nadal używa TEJ SAMEJ
 * stałej i TEJ SAMEJ funkcji wordcount z `./lib/content-bar.ts` — AD-4
 * wymaga jednego źródła, nie jednego wywołania.
 *
 * Code review 4.2 F7 / 4.3 F2 — **nuance na "bez DB" powyżej**: to jest
 * prawda dla `measureMarketContentBar` (logika czysta, testowalna
 * izolowanie), ale NIEPRAWDA dla wywołania przez `pnpm gp-config-content-bar`
 * — ten entrypoint jest odpalany przez `medusa exec`, więc bootuje cały
 * kontener Medusy (w tym realne połączenie z DB) zanim ten kod dostanie
 * sterowanie; sam kontener jest po prostu świadomie nieużywany. Konsument
 * oczekujący realnego "bez DB" (offline / bez uruchomionego Postgresa —
 * raport FR-23, etapy no-LLM pipeline'u FR-22) MUSI wołać
 * `pnpm gp-config-content-bar:standalone`
 * (`gp-config-content-bar-standalone.ts`) — ten sam kontrakt stdout, zero
 * bootu Medusy.
 *
 * Uruchomienie (bez dodatkowych zależności poza działającą Medusą):
 *   pnpm gp-config-content-bar --market bonbeauty --instance gp-dev
 *
 * Kontrakt wyjścia jest STABILNY — konsumuje go gp-cli
 * (`gp content pipeline --stage bar`) oraz raport FR-23 (Story 4.3). Zmiana
 * kształtu = zmiana kontraktu.
 */

import fs from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  CONTENT_BAR_ENTITY_TYPES,
  CONTENT_BAR_THRESHOLDS,
  CONTENT_BAR_THRESHOLD_ASSUMPTIONS,
  buildContentBarMap,
  localeRoutingSlug,
  type ContentBarEntityType,
  type ContentBarMap,
} from "./lib/content-bar"

/** Pole niosące „body" treści per typ encji — to ono jest mierzone barem. */
const BODY_FIELD_BY_ENTITY: Readonly<Record<ContentBarEntityType, string>> = {
  product: "description",
  product_category: "description",
  seller: "description",
}

const FILE_BY_ENTITY: Readonly<Record<ContentBarEntityType, string>> = {
  product: "products.yaml",
  product_category: "categories.yaml",
  seller: "sellers.yaml",
}

export interface ContentBarEntityMeasurement {
  readonly handle: string
  readonly content_bar: ContentBarMap
}

export interface ContentBarReport {
  readonly ok: true
  readonly market: string
  readonly instance: string
  readonly i18n_root: string
  readonly thresholds: Record<ContentBarEntityType, number>
  /** Które progi są jeszcze `[ASSUMPTION]` (ratyfikacja PO — Story 4.1). */
  readonly threshold_assumptions: Record<ContentBarEntityType, boolean>
  readonly entities: Record<ContentBarEntityType, ContentBarEntityMeasurement[]>
  readonly warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

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
    if (parent === current) {
      throw new Error(
        `Cannot locate GP workspace root from '${start}' ` +
          `(expected a directory containing both 'gp-ops/' and 'GP/').`
      )
    }
    current = parent
  }
}

function readYamlEntries(filePath: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(filePath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!isRecord(doc) || !Array.isArray(doc.entries)) {
    throw new Error(`Invalid i18n YAML document (expected 'entries' list): ${filePath}`)
  }
  return doc.entries.filter(isRecord)
}

/**
 * PL kategorii NIE mieszka w `i18n/categories.yaml` (AD-12) — jego źródłem
 * jest `categories[].description` w gp-config `products.yaml`. Zwracamy mapę
 * handle → opis PL, żeby raport mógł pokazać „source coverage" PL także dla
 * kategorii.
 */
export function readCategoryPlSource(
  configRoot: string,
  instanceId: string,
  marketId: string,
  warnings: string[]
): Map<string, string> {
  const filePath = path.join(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "products.yaml"
  )
  const out = new Map<string, string>()
  if (!fs.existsSync(filePath)) {
    warnings.push(
      `category PL source not found at '${filePath}' — PL source coverage for ` +
        `categories will report 0 words (AD-12 expects categories[].description there).`
    )
    return out
  }
  const doc = yaml.load(fs.readFileSync(filePath, "utf8"), { schema: yaml.JSON_SCHEMA })
  const categories = isRecord(doc) && Array.isArray(doc.categories) ? doc.categories : []
  for (const category of categories) {
    if (!isRecord(category)) continue
    const handle = typeof category.handle === "string" ? category.handle.trim() : ""
    const description =
      typeof category.description === "string" ? category.description : ""
    if (handle) out.set(handle, description)
  }
  return out
}

/**
 * Wyciąga opisy per locale z wpisu i18n. Klucze wynikowe to kody locale
 * tak, jak stoją w YAML (BCP 47) — normalizacja do slugów routingu dzieje
 * się w `buildContentBarMap`.
 */
function bodiesByLocale(
  entry: Record<string, unknown>,
  bodyField: string
): Record<string, unknown> {
  const fields = isRecord(entry.fields) ? entry.fields : {}
  const body = fields[bodyField]
  return isRecord(body) ? body : {}
}

export function measureMarketContentBar(options: {
  configRoot: string
  i18nRoot: string
  instanceId: string
  marketId: string
}): ContentBarReport {
  const warnings: string[] = []
  const i18nDir = path.resolve(options.i18nRoot, options.marketId, "i18n")
  const categoryPl = readCategoryPlSource(
    options.configRoot,
    options.instanceId,
    options.marketId,
    warnings
  )

  const entities = {
    product: [],
    product_category: [],
    seller: [],
  } as Record<ContentBarEntityType, ContentBarEntityMeasurement[]>

  for (const entityType of CONTENT_BAR_ENTITY_TYPES) {
    const filePath = path.join(i18nDir, FILE_BY_ENTITY[entityType])
    if (!fs.existsSync(filePath)) {
      warnings.push(`${entityType}: source file not found at '${filePath}' — skipped.`)
      continue
    }

    for (const entry of readYamlEntries(filePath)) {
      const handle = typeof entry.handle === "string" ? entry.handle.trim() : ""
      if (!handle) {
        warnings.push(`${entityType}: entry without 'handle' in ${filePath} — skipped.`)
        continue
      }

      const bodies = { ...bodiesByLocale(entry, BODY_FIELD_BY_ENTITY[entityType]) }

      // AD-12: PL kategorii pochodzi z gp-config products.yaml, nie z
      // categories.yaml. Wstrzykujemy go tu, żeby raport „source coverage"
      // PL był kompletny — NIE zapisujemy niczego z powrotem do
      // categories.yaml (klucz `pl-PL` tam pozostaje błędem walidacji).
      if (entityType === "product_category") {
        const plSlug = localeRoutingSlug("pl-PL")
        if (Object.keys(bodies).some((locale) => localeRoutingSlug(locale) === plSlug)) {
          throw new Error(
            `AD-12 violation: '${handle}' in ${filePath} carries a PL description. ` +
              `Category PL lives in gp-config products.yaml (categories[].description).`
          )
        }
        bodies["pl-PL"] = categoryPl.get(handle) ?? ""
      }

      entities[entityType].push({
        handle,
        content_bar: buildContentBarMap(entityType, bodies),
      })
    }
  }

  return {
    ok: true,
    market: options.marketId,
    instance: options.instanceId,
    i18n_root: i18nDir,
    thresholds: { ...CONTENT_BAR_THRESHOLDS },
    threshold_assumptions: { ...CONTENT_BAR_THRESHOLD_ASSUMPTIONS },
    entities,
    warnings,
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (withEquals) return withEquals.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1]
  return undefined
}

/**
 * Entrypoint `medusa exec` — spójny z rodziną `gp-config-sync-*`.
 *
 * Container jest przyjmowany, ale ŚWIADOMIE nieużywany: pomiar baru czyta
 * wyłącznie source YAML. Dzięki temu ten sam kod da się wywołać z testu
 * jednostkowego (`measureMarketContentBar`) bez bootowania Medusy.
 *
 * Konwencja argumentów kopiuje `gp-config-sync-i18n-content`
 * (`args[0] = instance`, `args[1] = market`), a flagi `--market/--instance`
 * są akceptowane jako czytelniejszy alias dla wywołań z gp-cli.
 */
export async function gpConfigContentBar({
  args,
}: {
  args?: string[]
}): Promise<ContentBarReport> {
  // Code review 4.2 F12: a `process.env.GP_INSTANCE_ID`/`GP_MARKET_ID`
  // fallback used to sit here, directly under the AD-11 "no hidden
  // defaults" comment — a genuine contradiction (an operator's ambient env
  // var could silently pick the target instance/market instead of the
  // explicit flag/positional arg). Removed: only `--instance`/`--market`
  // (or the positional args mirroring `gp-config-sync-i18n-content`) count.
  const argv = args ?? []
  const positional = argv.filter((arg) => !arg.startsWith("--"))
  const instanceId = (readFlag(argv, "instance") ?? positional[0] ?? "").trim()
  const marketId = (readFlag(argv, "market") ?? positional[1] ?? "").trim()

  // AD-11: instance + market OBOWIĄZKOWE, bez ukrytych defaultów.
  if (!instanceId || !marketId) {
    throw new Error(
      "gp-config-content-bar: instance and market are required " +
        "(pass --instance/--market or two positional args). " +
        "AD-11 forbids implicit defaults."
    )
  }

  const projectRoot = resolveProjectRoot(process.cwd())
  const report = measureMarketContentBar({
    configRoot: process.env.GP_CONFIG_ROOT ?? path.join(projectRoot, "gp-ops", "config"),
    i18nRoot: process.env.GP_I18N_ROOT ?? path.join(projectRoot, "gp-ops", "markets"),
    instanceId,
    marketId,
  })

  // Jedyna linia na stdout to JSON — gp-cli parsuje ją bez heurystyk.
  console.log(JSON.stringify(report))
  return report
}

export default gpConfigContentBar
