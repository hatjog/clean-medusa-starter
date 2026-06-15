import type { ExecArgs } from "@medusajs/framework/types"

import fs from "node:fs/promises"
import * as fsSync from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import { parseDryRunFlag } from "./gp-sync-dry-run"
import { loadMarketSupportedLocaleCodes } from "./gp-config-sync-translations"
import { isTranslationFeatureFlagEnabled } from "../lib/translation-ff-config"

type EntityType = "product_category" | "product" | "seller"

type I18nFields = Record<string, Record<string, unknown>>

type I18nEntry = {
  handle?: unknown
  fields?: I18nFields
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
}

type I18nContentSummary = {
  ok: true
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

  if (entityType === "product") {
    return tryList(services.productModuleService, ["listProducts", "list"], {
      filters: { handle },
      config: { select: ["id", "handle", "metadata"], take: null },
    })
  }

  return tryList(services.sellerModuleService, ["list", "listSellers"], {
    filters: { handle },
    config: { select: ["id", "handle", "metadata"], take: null },
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
  }
}

function createEntitySummaries(): Record<EntityType, EntitySummary> {
  return {
    product_category: emptyEntitySummary(),
    product: emptyEntitySummary(),
    seller: emptyEntitySummary(),
  }
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
  }
): Promise<TranslationPayload[]> {
  const payloads: TranslationPayload[] = []

  for (const config of configs) {
    const filePath = path.join(options.i18nDir, config.fileName)
    const entries = await readI18nFile(filePath)
    const summary = options.summaries[config.entityType]
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
      }
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

export async function syncI18nTranslationContent(
  translationService: any,
  productModuleService: any,
  sellerModuleService: any,
  options: {
    dryRun?: boolean
    i18nDir: string
    locales: string[]
    marketId: string
  }
): Promise<Omit<I18nContentSummary, "ok" | "dry_run" | "i18n_root" | "locales">> {
  const dryRun = options.dryRun === true
  const summaries = createEntitySummaries()
  const warnings: string[] = []
  const payloads = await collectTranslationPayloads(
    CONTENT_ENTITY_CONFIGS,
    { productModuleService, sellerModuleService },
    {
      i18nDir: options.i18nDir,
      locales: options.locales,
      marketId: options.marketId,
      summaries,
      warnings,
    }
  )

  await applyTranslationPayloads(translationService, payloads, {
    dryRun,
    summaries,
  })

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
  const summary = await syncI18nTranslationContent(
    translation.service,
    productModuleService,
    sellerModuleService,
    {
      dryRun: parsedArgs.dryRun,
      i18nDir,
      locales,
      marketId: parsedArgs.marketId,
    }
  )
  const result: I18nContentSummary = {
    ok: true,
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
        `unchanged=${entitySummary.unchanged}, skipped=${entitySummary.skipped}`
    )
  }
  console.log(JSON.stringify(result, null, 2))
  return result
}

export default gpConfigSyncI18nContent
