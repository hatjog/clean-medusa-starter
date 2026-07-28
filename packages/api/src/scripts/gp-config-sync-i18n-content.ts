import type { ExecArgs } from "@medusajs/framework/types"

import fs from "node:fs/promises"
import * as fsSync from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import { parseDryRunFlag } from "./gp-sync-dry-run"
import { loadMarketSupportedLocaleCodes } from "./gp-config-sync-translations"
import { isTranslationFeatureFlagEnabled } from "../lib/translation-ff-config"
import { buildContentBarMap, localeRoutingSlug, type ContentBarMap } from "./lib/content-bar"
import { readCategoryPlSource } from "./gp-config-content-bar"

type EntityType = "product_category" | "product" | "seller"

type I18nFields = Record<string, Record<string, unknown>>

type I18nEntry = {
  handle?: unknown
  fields?: I18nFields
  /**
   * Marker kolejki review (gp-cli Story 4.2 / AD-13) — legacy scalar albo
   * mapa per-locale. Code review 4.2 F3: ten sync dziś TYLKO CZYTA to pole
   * do celów raportowania (`countUnshippedLocales` niżej) — NIE gate'uje na
   * nim materializacji. Patrz deferral note w ContentPipelineService.ts
   * (gp-cli) i ADR-160 (status Proposed).
   */
  review_status?: unknown
}

type I18nFile = {
  entries?: I18nEntry[]
}

type TranslationSettingRow = {
  entity_type?: string
  fields?: string[]
  is_active?: boolean
}

type TranslationRow = {
  id?: string
  reference_id?: string
  reference?: string
  locale_code?: string
  translations?: Record<string, unknown>
}

type TranslationPayload = {
  reference_id: string
  reference: EntityType
  locale_code: string
  translations: Record<string, unknown>
}

type EntityContentConfig = {
  entityType: EntityType
  fileName: string
  fields: string[]
}

type I18nContentArgs = {
  configRoot: string
  dryRun: boolean
  i18nRoot: string
  instanceId: string
  marketId: string
}

type ListOptions = {
  filters?: Record<string, unknown>
  config?: Record<string, unknown>
}

type EntitySummary = {
  source_entries: number
  resolved_entries: number
  translation_records: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  missing_handles: string[]
  /** AD-4: ile encji dostało nowy/zmieniony `metadata.gp.content_bar`. */
  content_bar_updated: number
  /** AD-4: ile encji miało już identyczny `content_bar` (idempotencja). */
  content_bar_unchanged: number
  /**
   * Review 1-4-F2: ile zapisów `content_bar` NIE powiodło się. Nieudany zapis
   * cofa inkrement `content_bar_updated`, dokłada warning z typem encji,
   * handle i id — i NIE przerywa przebiegu. Fail-closed jest w WYNIKU:
   * `ok: false` + exit 1 PO wypisaniu pełnego summary.
   */
  content_bar_write_failed: number
  /**
   * Code review 4.2 F3: ile zmaterializowanych rekordów tłumaczeń NIE miało
   * `review_status: shipped` dla swojego locale (brak markera liczy się jako
   * "nie shipped"). Materializacja i tak je synchronizuje — patrz deferral
   * note w gp-cli `ContentPipelineService.ts` i ADR-160. To pole jest
   * WYŁĄCZNIE widocznością, nie bramką.
   */
  unshipped_records: number
}

/**
 * Encja rozwiązana w DB wraz z jej opisami per locale — wejście do
 * materializacji `metadata.gp.content_bar` (AD-4). Locale tłumaczone pochodzą
 * z source YAML; natywny PL z realnego body (DB `description` dla
 * product/seller, gp-config `products.yaml` dla kategorii — fix 1-4-c2).
 */
type ContentBarTarget = {
  entityType: EntityType
  entityId: string
  handle: string
  metadata: unknown
  bodiesByLocale: Record<string, unknown>
}

type I18nContentSummary = {
  /** Review 1-4-F2: `false`, gdy którykolwiek zapis `content_bar` padł. */
  ok: boolean
  dry_run: boolean
  locales: string[]
  i18n_root: string
  entities: Record<EntityType, EntitySummary>
  warnings: string[]
}

type I18nContentSkipped = {
  ok: true
  skipped: true
  reason: string
  dry_run: boolean
}

type I18nContentResult = I18nContentSummary | I18nContentSkipped

const DEFAULT_INSTANCE_ID = "gp-dev"
const DEFAULT_MARKET_ID = "bonbeauty"

const CONTENT_ENTITY_CONFIGS: EntityContentConfig[] = [
  {
    entityType: "product_category",
    fileName: "categories.yaml",
    fields: ["name", "description"],
  },
  {
    entityType: "product",
    fileName: "products.yaml",
    fields: ["title", "subtitle", "description", "material"],
  },
  {
    entityType: "seller",
    fileName: "sellers.yaml",
    fields: ["name", "description"],
  },
]

function fsSyncExists(candidate: string): boolean {
  try {
    return fsSync.existsSync(candidate)
  } catch {
    return false
  }
}

function resolveProjectRoot(start: string): string {
  let current = path.resolve(start)

  while (true) {
    if (fsSyncExists(path.join(current, "gp-ops")) && fsSyncExists(path.join(current, "GP"))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(start)
    }
    current = parent
  }
}

function parseEntrypointArgs(args: string[] | undefined): I18nContentArgs {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? DEFAULT_INSTANCE_ID).trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? DEFAULT_MARKET_ID).trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()
  const projectRoot = resolveProjectRoot(process.cwd())
  const i18nRoot = (
    process.env.GP_I18N_ROOT ?? path.join(projectRoot, "gp-ops", "markets")
  ).trim()
  const dryRun = parseDryRunFlag(args)

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")
  if (!i18nRoot) throw new Error("i18nRoot is required (GP_I18N_ROOT)")

  return { configRoot, dryRun, i18nRoot, instanceId, marketId }
}

function resolveService(container: any, keysToTry: string[]): any {
  const errors: string[] = []

  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (error: any) {
      errors.push(`${key}: ${error?.message ?? String(error)}`)
    }
  }

  throw new Error(
    `Cannot resolve service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

function tryResolveService(container: any, keysToTry: string[]): { service?: any; error?: string } {
  try {
    return { service: resolveService(container, keysToTry) }
  } catch (error: any) {
    return { error: error?.message ?? String(error) }
  }
}

function firstFunction(obj: any, names: string[]) {
  for (const name of names) {
    const candidate = obj?.[name]
    if (typeof candidate === "function") {
      return candidate.bind(obj)
    }
  }

  return null
}

async function tryList(
  service: any,
  methods: string[],
  options: ListOptions = {}
): Promise<any[]> {
  const fn = firstFunction(service, methods)
  if (!fn) {
    throw new Error(`Service does not expose supported list method: ${methods.join(", ")}`)
  }

  const result = await fn(options.filters ?? {}, options.config ?? { take: null })
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0]
  }

  return Array.isArray(result) ? result : []
}

function normalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0142/g, "l")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readMarketId(entity: any): string | null {
  const marketId = entity?.metadata?.gp?.market_id
  return typeof marketId === "string" && marketId.trim() ? marketId.trim() : null
}

function selectMarketEntity(
  matches: any[],
  marketId: string
): { match?: any; reason?: string } {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {}
  }

  const exact = matches.filter((match) => readMarketId(match) === marketId)
  if (exact.length === 1) return { match: exact[0] }
  if (exact.length > 1) {
    return { reason: `multiple entities found for market '${marketId}'` }
  }

  const untagged = matches.filter((match) => readMarketId(match) === null)
  if (untagged.length === 1) return { match: untagged[0] }
  if (untagged.length > 1) {
    return { reason: "multiple untagged entities found for the same handle" }
  }

  const knownMarkets = [
    ...new Set(matches.map((match) => readMarketId(match)).filter(Boolean)),
  ]
  return {
    reason:
      knownMarkets.length > 0
        ? `cross-market guard - entity belongs to '${knownMarkets.join(", ")}'`
        : "no eligible entity match found",
  }
}

async function listEntitiesByHandle(
  entityType: EntityType,
  services: { productModuleService: any; sellerModuleService: any },
  handle: string
): Promise<any[]> {
  if (entityType === "product_category") {
    return tryList(services.productModuleService, ["listProductCategories"], {
      filters: { handle },
      config: { select: ["id", "handle", "metadata"], take: null },
    })
  }

  // Fix 1-4-c2: `description` w select produktu/sellera to źródło natywnego
  // PL body dla baru — bez niego bar.pl liczyłby się ze stubów YAML.
  if (entityType === "product") {
    return tryList(services.productModuleService, ["listProducts", "list"], {
      filters: { handle },
      config: { select: ["id", "handle", "metadata", "description"], take: null },
    })
  }

  return tryList(services.sellerModuleService, ["list", "listSellers"], {
    filters: { handle },
    config: { select: ["id", "handle", "metadata", "description"], take: null },
  })
}

async function readI18nFile(filePath: string): Promise<I18nEntry[]> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })

  if (!doc || typeof doc !== "object" || !Array.isArray((doc as I18nFile).entries)) {
    throw new Error(`Invalid i18n YAML document: ${filePath}`)
  }

  return (doc as I18nFile).entries ?? []
}

function localeAliases(locale: string): string[] {
  const normalized = locale.replace("_", "-")
  const base = normalized.split("-")[0]
  const aliases = [normalized, base]

  if (normalized === "uk-UA") {
    aliases.push("ua", "uk")
  }
  if (normalized === "en-US") {
    aliases.push("en")
  }
  if (normalized === "de-DE") {
    aliases.push("de")
  }

  return [...new Set(aliases)]
}

function pickLocalizedString(values: unknown, locale: string): string | null {
  if (!isRecord(values)) {
    return null
  }

  for (const alias of localeAliases(locale)) {
    const value = values[alias]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function buildEntryTranslations(
  entry: I18nEntry,
  fields: string[],
  locale: string
): Record<string, unknown> {
  const translations: Record<string, unknown> = {}
  const sourceFields = entry.fields ?? {}

  for (const field of fields) {
    const value = pickLocalizedString(sourceFields[field], locale)
    if (value !== null) {
      translations[field] = value
    }
  }

  return translations
}

function emptyEntitySummary(): EntitySummary {
  return {
    source_entries: 0,
    resolved_entries: 0,
    translation_records: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    missing_handles: [],
    content_bar_updated: 0,
    content_bar_unchanged: 0,
    content_bar_write_failed: 0,
    unshipped_records: 0,
  }
}

/**
 * Code review 4.2 F3: czy `review_status` wpisu oznacza dane `locale` jako
 * `shipped`. Akceptuje oba kształty (legacy scalar = ten sam stan dla
 * wszystkich locale ≠ PL; mapa per-locale). Brak markera = `false` (nie
 * "nieznany", nie "zakładamy shipped") — nowe wpisy bez markera nie powinny
 * cicho liczyć się jako gotowe.
 */
function isLocaleShipped(entry: I18nEntry, locale: string): boolean {
  const raw = entry.review_status
  if (typeof raw === 'string') return raw === 'shipped'
  if (isRecord(raw)) return raw[locale] === 'shipped'
  return false
}

function createEntitySummaries(): Record<EntityType, EntitySummary> {
  return {
    product_category: emptyEntitySummary(),
    product: emptyEntitySummary(),
    seller: emptyEntitySummary(),
  }
}

/**
 * Fix 1-4-c2: czy klucz locale z source YAML wskazuje na natywny PL (slug
 * routingu `pl`). Klucz niebędący poprawnym locale zwraca `false` — zostaje
 * w mapie i to `buildContentBarMap` zgłosi go fail-loud per encja.
 */
function isNativePlLocale(locale: string): boolean {
  try {
    return localeRoutingSlug(locale) === "pl"
  } catch {
    return false
  }
}

/**
 * Natywne PL body SELLERA odczytane z encji.
 *
 * Review 4-6-H1 (znalezione na żywej bazie dev, nie w analizie). Ten sam
 * kształt co regresja 1-4-c2, tylko na innej encji i o klasę cichszy:
 * `gp-config-sync-vendors` NIGDY nie zapisuje kolumny `seller.description`.
 * `createPayload` jej nie zawiera, a ścieżka UPDATE pisze wyłącznie
 * `gpMetaUpdate.description` (i czyta `existingGp.description ??
 * existingSeller.description`) — opis z `market.yaml → vendors[].description`
 * żyje więc w `metadata.gp.description`.
 *
 * Czytanie samej kolumny dawało `bodies["pl-PL"] = ""` dla KAŻDEGO sellera i
 * `content_bar.pl = {words: 0, bar: false}` — czyli storefront gasił polskie
 * profile salonów, podczas gdy metryka AD-4 (czytająca `i18n/sellers.yaml`)
 * pokazywała `3/3, bar = true`. Stan bazy dev w chwili fixu potwierdzał to
 * co do liczby: `pl {words: 0}` przy `de/en/ua {words: 5..19}`.
 *
 * Kolejność (`metadata.gp.description` → kolumna) jest ta sama, co w
 * `gp-config-sync-vendors.resolveSeedIfEmpty`, żeby obie ścieżki widziały
 * dokładnie ten sam byt.
 */
function resolveSellerPlBody(match: any): string {
  const metadata = isRecord(match?.metadata) ? match.metadata : {}
  const gp = isRecord(metadata.gp) ? metadata.gp : {}
  if (typeof gp.description === "string" && gp.description.trim().length > 0) {
    return gp.description
  }
  return typeof match?.description === "string" ? match.description : ""
}

function materializedLocales(supportedLocales: string[]): string[] {
  return supportedLocales.filter((locale) => !locale.toLowerCase().startsWith("pl"))
}

async function listTranslationSettings(
  translationService: any
): Promise<TranslationSettingRow[]> {
  return (await tryList(translationService, [
    "listTranslationSettings",
    "listAndCountTranslationSettings",
    "listAndCount",
    "list",
  ], {
    config: { take: null },
  })) as TranslationSettingRow[]
}

async function missingTranslationSettings(translationService: any): Promise<string[]> {
  const settings = await listTranslationSettings(translationService)
  const byEntity = new Map(
    settings
      .filter((setting) => typeof setting.entity_type === "string")
      .map((setting) => [setting.entity_type as string, setting])
  )
  const missing: string[] = []

  for (const config of CONTENT_ENTITY_CONFIGS) {
    const current = byEntity.get(config.entityType)
    if (!current) {
      missing.push(`${config.entityType}: missing settings`)
      continue
    }
    if (current.is_active !== true) {
      missing.push(`${config.entityType}: inactive settings`)
      continue
    }

    const currentFields = Array.isArray(current.fields) ? current.fields : []
    const missingFields = config.fields.filter((field) => !currentFields.includes(field))
    if (missingFields.length) {
      missing.push(`${config.entityType}: missing fields ${missingFields.join(", ")}`)
    }
  }

  return missing
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)])
    )
  }
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

function mergeTranslations(
  current: unknown,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(isRecord(current) ? current : {}),
    ...incoming,
  }
}

async function collectTranslationPayloads(
  configs: EntityContentConfig[],
  services: { productModuleService: any; sellerModuleService: any },
  options: {
    i18nDir: string
    locales: string[]
    marketId: string
    summaries: Record<EntityType, EntitySummary>
    warnings: string[]
    /**
     * AD-4: zbierane po drodze cele materializacji `content_bar`. Celowo
     * wypełniane w tej samej pętli co payloady tłumaczeń — druga pętla po
     * YAML rozjechałaby się z pierwszą przy pierwszej zmianie filtra.
     */
    barTargets: ContentBarTarget[]
    /** AD-12: PL kategorii pochodzi z gp-config products.yaml, nie z i18n. */
    categoryPlByHandle: Map<string, string>
  }
): Promise<TranslationPayload[]> {
  const payloads: TranslationPayload[] = []

  for (const config of configs) {
    const filePath = path.join(options.i18nDir, config.fileName)
    const summary = options.summaries[config.entityType]

    // Markety bez contentu i18n (brak pliku encji albo całego katalogu i18n)
    // są poprawnym stanem — pomijamy encję z warningiem. Niepoprawny YAML
    // nadal rzuca.
    let entries: I18nEntry[]
    try {
      entries = await readI18nFile(filePath)
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        options.warnings.push(
          `${config.entityType}: i18n source file missing (${filePath}) — entity skipped`
        )
        continue
      }
      throw error
    }
    summary.source_entries = entries.length

    for (const entry of entries) {
      const handle = normalizeHandle(entry.handle)
      if (!handle) {
        summary.skipped += 1
        options.warnings.push(`${config.entityType}: skipped entry without handle in ${filePath}`)
        continue
      }

      const matches = await listEntitiesByHandle(config.entityType, services, handle)
      const { match, reason } = selectMarketEntity(matches, options.marketId)
      if (!match?.id) {
        summary.skipped += 1
        summary.missing_handles.push(handle)
        options.warnings.push(
          `${config.entityType} '${handle}': ${reason ?? "not found in DB"}`
        )
        continue
      }

      summary.resolved_entries += 1

      // AD-4: bar locale TŁUMACZONYCH mierzymy z SOURCE YAML (ciała tłumaczeń),
      // a bar locale natywnego PL z REALNEGO PL body — gate FAZY 1 czyta
      // `content_bar.pl`, więc pominięcie PL wyzerowałoby katalog.
      //
      // Fix 1-4-c2 (regresja zerowego katalogu): PL w source YAML tłumaczeń to
      // stuby (10-14 słów) — liczenie z nich dało bar.pl=false dla 113/113
      // produktów i 452/452 smoke FAIL, włącznie z /pl. Natywny PL produktów
      // i sellerów żyje na encji w DB (`description`), analogicznie do
      // gp-config `products.yaml` dla kategorii (AD-12). Klucze PL z YAML są
      // usuwane, żeby stub nigdy nie konkurował z realnym body.
      const bodyValues = entry.fields?.["description"]
      const bodies: Record<string, unknown> = isRecord(bodyValues) ? { ...bodyValues } : {}
      for (const key of Object.keys(bodies)) {
        if (isNativePlLocale(key)) {
          delete bodies[key]
        }
      }
      if (config.entityType === "product_category") {
        bodies["pl-PL"] = options.categoryPlByHandle.get(handle) ?? ""
      } else if (config.entityType === "seller") {
        bodies["pl-PL"] = resolveSellerPlBody(match)
      } else {
        bodies["pl-PL"] = typeof match.description === "string" ? match.description : ""
      }
      options.barTargets.push({
        entityType: config.entityType,
        entityId: match.id,
        handle,
        metadata: match.metadata,
        bodiesByLocale: bodies,
      })

      for (const locale of options.locales) {
        const translations = buildEntryTranslations(entry, config.fields, locale)
        if (Object.keys(translations).length === 0) {
          summary.skipped += 1
          options.warnings.push(
            `${config.entityType} '${handle}': no i18n fields for locale '${locale}'`
          )
          continue
        }

        payloads.push({
          reference_id: match.id,
          reference: config.entityType,
          locale_code: locale,
          translations,
        })
        summary.translation_records += 1
        // Code review 4.2 F3: visibility-only counter — materialization does
        // NOT gate on review_status (deferred, see ADR-160 / F3 note above).
        if (!isLocaleShipped(entry, locale)) {
          summary.unshipped_records += 1
        }
      }
    }

    if (summary.unshipped_records > 0) {
      options.warnings.push(
        `${config.entityType}: materialized ${summary.unshipped_records} translation record(s) ` +
          `whose review_status is not 'shipped' — Story 4.2 does NOT gate ship on review_status ` +
          `(deferred, see ADR-160 / gp-cli ContentPipelineService.ts F3 note).`
      )
    }
  }

  return payloads
}

async function listExistingTranslations(
  translationService: any,
  reference: EntityType,
  locale: string,
  referenceIds: string[]
): Promise<TranslationRow[]> {
  if (referenceIds.length === 0) {
    return []
  }

  return (await tryList(translationService, ["listTranslations"], {
    filters: {
      reference,
      locale_code: locale,
      reference_id: referenceIds,
    },
    config: {
      select: ["id", "reference_id", "reference", "locale_code", "translations"],
      take: null,
    },
  })) as TranslationRow[]
}

async function applyTranslationPayloads(
  translationService: any,
  payloads: TranslationPayload[],
  options: {
    dryRun: boolean
    summaries: Record<EntityType, EntitySummary>
  }
): Promise<void> {
  const grouped = new Map<string, TranslationPayload[]>()

  for (const payload of payloads) {
    const key = `${payload.reference}:${payload.locale_code}`
    grouped.set(key, [...(grouped.get(key) ?? []), payload])
  }

  const createTranslations = firstFunction(translationService, ["createTranslations"])
  const updateTranslations = firstFunction(translationService, ["updateTranslations"])

  if (!createTranslations || !updateTranslations) {
    throw new Error("Translation service does not expose createTranslations/updateTranslations")
  }

  for (const groupPayloads of grouped.values()) {
    const reference = groupPayloads[0].reference
    const locale = groupPayloads[0].locale_code
    const existingRows = await listExistingTranslations(
      translationService,
      reference,
      locale,
      groupPayloads.map((payload) => payload.reference_id)
    )
    const existingByReferenceId = new Map(
      existingRows
        .filter((row) => typeof row.reference_id === "string")
        .map((row) => [row.reference_id as string, row])
    )
    const createPayload: TranslationPayload[] = []
    const updatePayload: Array<{
      id: string
      reference: EntityType
      translations: Record<string, unknown>
    }> = []

    for (const payload of groupPayloads) {
      const summary = options.summaries[payload.reference]
      const existing = existingByReferenceId.get(payload.reference_id)
      if (!existing?.id) {
        createPayload.push(payload)
        summary.created += 1
        continue
      }

      const nextTranslations = mergeTranslations(existing.translations, payload.translations)
      if (sameJson(existing.translations ?? {}, nextTranslations)) {
        summary.unchanged += 1
        continue
      }

      updatePayload.push({
        id: existing.id,
        reference: payload.reference,
        translations: nextTranslations,
      })
      summary.updated += 1
    }

    if (options.dryRun) {
      continue
    }

    if (updatePayload.length) {
      await updateTranslations(updatePayload)
    }
    if (createPayload.length) {
      await createTranslations(createPayload)
    }
  }
}

/**
 * AD-4 — materializuje `metadata.gp.content_bar` na encji.
 *
 * Kontrakt: `{ [localeSlug]: { words: int, bar: bool } }`. Storefront
 * (`checkQualityGate` w `normalize-listed-products.ts`) czyta WYŁĄCZNIE
 * pole `bar` i nigdy nie przelicza słów — dlatego liczba musi powstać tutaj,
 * w sync-time, z tej samej stałej i tej samej funkcji wordcount co pipeline
 * gp-cli (FR-22) i raport (FR-23).
 *
 * Zapis jest idempotentny: identyczna mapa nie generuje update'u.
 *
 * Semantyka błędów zapisu (review 1-4-F2, klasa defektu ze Story 4.2 naprawiona
 * w zakresie fixu 1.4): fail-loud PER ENCJA — nieudany zapis dokłada warning
 * (typ encji + handle + id), cofa inkrement `content_bar_updated` i zlicza się
 * w `content_bar_write_failed`; przebieg ŻYJE dalej, a summary i warnings są
 * emitowane ZAWSZE. Fail-closed realizuje entrypoint: `ok: false` + exit 1
 * dopiero PO wypisaniu summary.
 *
 * Eksport wyłącznie dla testów jednostkowych (regresja 1-4-F1/F2).
 */
export async function applyContentBarMetadata(
  services: { productModuleService: any; sellerModuleService: any },
  targets: ContentBarTarget[],
  options: {
    dryRun: boolean
    summaries: Record<EntityType, EntitySummary>
    warnings: string[]
  }
): Promise<void> {
  const updatesByEntity = new Map<
    EntityType,
    Array<{ id: string; handle: string; metadata: Record<string, unknown> }>
  >()

  for (const target of targets) {
    const summary = options.summaries[target.entityType]
    let nextBar: ContentBarMap
    try {
      nextBar = buildContentBarMap(target.entityType, target.bodiesByLocale)
    } catch (error: any) {
      // Fail-loud na poziomie encji, ale bez zabijania całego syncu —
      // nieznany typ treści to błąd konfiguracji, nie błąd danych operatora.
      options.warnings.push(
        `${target.entityType} '${target.handle}': content_bar not computed — ` +
          `${error?.message ?? String(error)}`
      )
      continue
    }

    const metadata = isRecord(target.metadata) ? target.metadata : {}
    const gp = isRecord(metadata.gp) ? metadata.gp : {}

    if (sameJson(gp.content_bar ?? null, nextBar)) {
      summary.content_bar_unchanged += 1
      continue
    }

    summary.content_bar_updated += 1
    updatesByEntity.set(target.entityType, [
      ...(updatesByEntity.get(target.entityType) ?? []),
      {
        id: target.entityId,
        handle: target.handle,
        // Merge, nie podmiana: `metadata.gp` niesie też `market_id`,
        // `images[]` (AD-10) i inne pola, których ten sync nie jest właścicielem.
        metadata: { ...metadata, gp: { ...gp, content_bar: nextBar } },
      },
    ])
  }

  if (options.dryRun) {
    return
  }

  for (const [entityType, updates] of updatesByEntity.entries()) {
    if (updates.length === 0) continue

    const summary = options.summaries[entityType]
    const service =
      entityType === "seller" ? services.sellerModuleService : services.productModuleService
    const methodNames =
      entityType === "product"
        ? ["updateProducts", "update"]
        : entityType === "product_category"
          ? ["updateProductCategories", "update"]
          : ["updateSellers", "update"]

    const updateFn = firstFunction(service, methodNames)
    if (!updateFn) {
      throw new Error(
        `Cannot materialize content_bar for '${entityType}': service exposes none of ` +
          `${methodNames.join(", ")}.`
      )
    }

    for (const update of updates) {
      // Review 1-4-F1 rec. 2: pusty id łapiemy PRZED ORM-em — MedusaError
      // `with id "" not found` nie niesie ani typu encji, ani handle'a
      // (evidence 1-4-sync-i18n-failure.log kosztował cały przebieg diagnozy).
      if (!update.id) {
        summary.content_bar_updated -= 1
        summary.content_bar_write_failed += 1
        options.warnings.push(
          `${entityType} '${update.handle}': content_bar write skipped — empty entity id`
        )
        continue
      }

      try {
        // Review 1-4-F1 (defekt Story 4.2, pierwszy raz blokujący w 1.4):
        // konwencja wywołania zależy od serwisu. Ręcznie pisany core'owy
        // ProductModuleService ma overload `(id, data)` dla
        // updateProducts/updateProductCategories. Auto-generowane metody
        // MedusaService (updateSellers w module sellera) przyjmują JEDEN
        // argument danych (`data | data[] | {selector, data}`) — pozycyjny
        // string NIE jest tam id i schodzi jako pusty selektor
        // (`Seller with id "" not found`).
        if (entityType === "seller") {
          await updateFn([{ id: update.id, metadata: update.metadata }])
        } else {
          await updateFn(update.id, { metadata: update.metadata })
        }
      } catch (error: any) {
        summary.content_bar_updated -= 1
        summary.content_bar_write_failed += 1
        options.warnings.push(
          `${entityType} '${update.handle}' (${update.id}): content_bar write failed — ` +
            `${error?.message ?? String(error)}`
        )
      }
    }
  }
}

export async function syncI18nTranslationContent(
  translationService: any,
  productModuleService: any,
  sellerModuleService: any,
  options: {
    dryRun?: boolean
    i18nDir: string
    locales: string[]
    marketId: string
    /** AD-12: skąd wziąć PL kategorii. Bez tego PL kategorii = 0 słów. */
    categoryPlByHandle?: Map<string, string>
  }
): Promise<Omit<I18nContentSummary, "ok" | "dry_run" | "i18n_root" | "locales">> {
  const dryRun = options.dryRun === true
  const summaries = createEntitySummaries()
  const warnings: string[] = []
  const barTargets: ContentBarTarget[] = []

  // Klucze mapy PL normalizujemy tak samo jak handle z i18n YAML, żeby
  // `Twarz` / `twarz` / `tward-` nie rozjechały się cicho na 0 słów.
  const categoryPlByHandle = new Map<string, string>()
  for (const [handle, description] of options.categoryPlByHandle ?? []) {
    categoryPlByHandle.set(normalizeHandle(handle), description)
  }

  const payloads = await collectTranslationPayloads(
    CONTENT_ENTITY_CONFIGS,
    { productModuleService, sellerModuleService },
    {
      i18nDir: options.i18nDir,
      locales: options.locales,
      marketId: options.marketId,
      summaries,
      warnings,
      barTargets,
      categoryPlByHandle,
    }
  )

  await applyTranslationPayloads(translationService, payloads, {
    dryRun,
    summaries,
  })

  await applyContentBarMetadata(
    { productModuleService, sellerModuleService },
    barTargets,
    { dryRun, summaries, warnings }
  )

  return {
    entities: summaries,
    warnings,
  }
}

export async function gpConfigSyncI18nContent({
  container,
  args,
}: ExecArgs): Promise<I18nContentResult> {
  const parsedArgs = parseEntrypointArgs(args)

  if (!isTranslationFeatureFlagEnabled()) {
    const result: I18nContentSkipped = {
      ok: true,
      skipped: true,
      reason: "MEDUSA_FF_TRANSLATION is not true",
      dry_run: parsedArgs.dryRun,
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  }

  const translation = tryResolveService(container, [
    "translation",
    "translationModuleService",
    "ITranslationModuleService",
    "translation_module",
  ])
  if (!translation.service) {
    const result: I18nContentSkipped = {
      ok: true,
      skipped: true,
      reason: `translation module unavailable: ${translation.error}`,
      dry_run: parsedArgs.dryRun,
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  }

  const missingSettings = await missingTranslationSettings(translation.service)
  if (missingSettings.length) {
    const result: I18nContentSkipped = {
      ok: true,
      skipped: true,
      reason: `translation settings incomplete: ${missingSettings.join("; ")}`,
      dry_run: parsedArgs.dryRun,
    }
    console.warn(`[gp-config-sync-i18n-content] ${result.reason}`)
    console.log(JSON.stringify(result, null, 2))
    return result
  }

  const productModuleService = resolveService(container, [
    "product",
    "productModuleService",
    "product_module",
  ])
  const sellerModuleService = resolveService(container, [
    "seller",
    "sellerModuleService",
    "seller_module",
  ])
  const locales = materializedLocales(
    await loadMarketSupportedLocaleCodes({
      configRoot: parsedArgs.configRoot,
      instanceId: parsedArgs.instanceId,
      marketId: parsedArgs.marketId,
    })
  )
  const i18nDir = path.resolve(parsedArgs.i18nRoot, parsedArgs.marketId, "i18n")

  // AD-12: PL kategorii czytamy z gp-config `products.yaml`. Brak pliku nie
  // wywraca syncu (tłumaczenia ≠ PL), ale MUSI być widoczny — bez tego
  // `content_bar.pl` kategorii wyszedłby cicho zerem i gate FAZY 1
  // wyczyściłby kafelki kategorii.
  const categoryPlWarnings: string[] = []
  const categoryPlByHandle = readCategoryPlSource(
    parsedArgs.configRoot,
    parsedArgs.instanceId,
    parsedArgs.marketId,
    categoryPlWarnings
  )
  for (const warning of categoryPlWarnings) {
    console.warn(`[gp-config-sync-i18n-content] ${warning}`)
  }

  const summary = await syncI18nTranslationContent(
    translation.service,
    productModuleService,
    sellerModuleService,
    {
      dryRun: parsedArgs.dryRun,
      i18nDir,
      locales,
      marketId: parsedArgs.marketId,
      categoryPlByHandle,
    }
  )
  summary.warnings.push(...categoryPlWarnings)
  const contentBarWriteFailures = Object.values(summary.entities).reduce(
    (total, entitySummary) => total + entitySummary.content_bar_write_failed,
    0
  )
  const result: I18nContentSummary = {
    // Review 1-4-F2: fail-closed w WYNIKU, nie w przerwaniu — nieudane zapisy
    // content_bar dają ok:false i exit 1, ale dopiero PO wypisaniu summary.
    ok: contentBarWriteFailures === 0,
    dry_run: parsedArgs.dryRun,
    locales,
    i18n_root: i18nDir,
    ...summary,
  }

  for (const [entityType, entitySummary] of Object.entries(result.entities)) {
    console.log(
      `[gp-config-sync-i18n-content] ${entityType}: ` +
        `records=${entitySummary.translation_records}, ` +
        `created=${entitySummary.created}, updated=${entitySummary.updated}, ` +
        `unchanged=${entitySummary.unchanged}, skipped=${entitySummary.skipped}, ` +
        `content_bar_updated=${entitySummary.content_bar_updated}, ` +
        `content_bar_unchanged=${entitySummary.content_bar_unchanged}, ` +
        `content_bar_write_failed=${entitySummary.content_bar_write_failed}`
    )
  }
  console.log(JSON.stringify(result, null, 2))

  if (contentBarWriteFailures > 0) {
    throw new Error(
      `content_bar write failed for ${contentBarWriteFailures} entity(-ies) — ` +
        `per-entity details are in \`warnings\` of the summary above (review 1-4-F2: ` +
        `summary is always emitted, exit is non-zero AFTER reporting)`
    )
  }

  return result
}

export default gpConfigSyncI18nContent
