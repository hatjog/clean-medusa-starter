import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import { parseDryRunFlag, parseOverwriteFlag } from "./gp-sync-dry-run"
import {
  isTranslationFeatureFlagEnabled,
  TRANSLATION_ENTITY_SETTINGS,
} from "../lib/translation-ff-config"

type SyncStoreSummary = {
  stores: number
  codes: string[]
  dry_run: boolean
}

type SyncTranslationSettingsSummary = {
  story_labels: string[]
  entity_types: string[]
  created: string[]
  updated: string[]
  dry_run: boolean
}

type TranslationSettingRow = {
  id?: string
  entity_type?: string
  fields?: string[]
  is_active?: boolean
}

type TranslationSettingsPlan = {
  createPayload: Array<{ entity_type: string; fields: string[] }>
  updatePayload: Array<{ id: string; fields: string[]; is_active: boolean }>
}

type SyncOptions = {
  db?: AdvisoryLockDb
  dryRun?: boolean
  overwrite?: boolean
}

type LocaleConfigOptions = {
  configRoot?: string
  instanceId?: string
  marketId?: string
}

type SyncStoreOptions = {
  bootstrapStore?: boolean
  dryRun?: boolean
  localeConfig?: LocaleConfigOptions
}

type AdvisoryLockConnection = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

type AdvisoryLockDb = {
  client?: {
    acquireConnection: () => Promise<AdvisoryLockConnection>
    releaseConnection: (connection: AdvisoryLockConnection) => Promise<void>
  }
}

type TranslationSyncResult =
  | {
      ok: true
      skipped: true
      reason: string
    }
  | {
      ok: true
      dry_run: boolean
      store: SyncStoreSummary
      translation_settings: SyncTranslationSettingsSummary
    }

type TranslationEntrypointArgs = {
  bootstrapStore: boolean
  configRoot: string
  dryRun: boolean
  instanceId: string
  marketId?: string
  overwrite: boolean
}

type ListOptions = {
  filters?: Record<string, unknown>
  config?: Record<string, unknown>
}

const TRANSLATION_SETTINGS_ADVISORY_LOCK_ID = 210260021

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

function firstFunction(obj: any, names: string[]) {
  for (const name of names) {
    const candidate = obj?.[name]
    if (typeof candidate === "function") {
      return candidate.bind(obj)
    }
  }

  return null
}

function parseBooleanFlag(args: string[] | undefined, flag: string): boolean {
  return args?.includes(flag) === true
}

function parseEntrypointArgs(args: string[] | undefined): TranslationEntrypointArgs {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID)?.trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()

  if (!instanceId) {
    throw new Error("GP_INSTANCE_ID is required to resolve market.yaml supported_locales")
  }
  if (!configRoot) {
    throw new Error("GP_CONFIG_ROOT is required to resolve market.yaml supported_locales")
  }

  return {
    bootstrapStore: parseBooleanFlag(args, "--bootstrap-store"),
    configRoot,
    dryRun: parseDryRunFlag(args),
    instanceId,
    marketId,
    overwrite: parseOverwriteFlag(args),
  }
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

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeSupportedLocales(value: unknown, filePath: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`market.yaml supported_locales is required: ${filePath}`)
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`market.yaml supported_locales[${index}] must be a non-empty string`)
    }

    return entry.trim()
  })
}

export async function loadMarketSupportedLocaleCodes(
  options: LocaleConfigOptions = {}
): Promise<string[]> {
  const marketId = (options.marketId ?? process.env.GP_MARKET_ID)?.trim()
  if (!marketId) {
    throw new Error("GP_MARKET_ID is required to resolve market.yaml supported_locales")
  }

  const instanceId = (options.instanceId ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const configRoot = (
    options.configRoot ?? process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()
  const filePath = path.resolve(configRoot, instanceId, "markets", marketId, "market.yaml")

  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error(`market.yaml not found: ${filePath}`)
    }
    throw error
  }

  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid market.yaml document: ${filePath}`)
  }

  return normalizeSupportedLocales(
    (doc as { supported_locales?: unknown }).supported_locales,
    filePath
  )
}

function mergeFields(
  currentFields: readonly string[],
  desiredFields: readonly string[],
  overwrite: boolean
): string[] {
  if (overwrite) {
    return [...desiredFields]
  }

  const merged = [...currentFields]
  for (const field of desiredFields) {
    if (!merged.includes(field)) {
      merged.push(field)
    }
  }

  return merged
}

function isDuplicateTranslationSettingsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Translation settings with entity_type: .+ already exists/i.test(message)
}

async function listCurrentTranslationSettings(service: any): Promise<TranslationSettingRow[]> {
  return (await tryList(service, [
    "listTranslationSettings",
    "listAndCountTranslationSettings",
    "listAndCount",
    "list",
  ], {
    config: { take: null },
  })) as TranslationSettingRow[]
}

function buildTranslationSettingsPlan(
  currentSettings: TranslationSettingRow[],
  options: { overwrite: boolean }
): TranslationSettingsPlan {
  const byEntityType = new Map(
    currentSettings
      .filter((setting) => typeof setting.entity_type === "string")
      .map((setting) => [setting.entity_type as string, setting])
  )
  const createPayload: TranslationSettingsPlan["createPayload"] = []
  const updatePayload: TranslationSettingsPlan["updatePayload"] = []

  for (const setting of TRANSLATION_ENTITY_SETTINGS) {
    const current = byEntityType.get(setting.entity_type)
    const fields = [...setting.fields]

    if (!current) {
      createPayload.push({
        entity_type: setting.entity_type,
        fields,
      })
      continue
    }

    const currentFields = Array.isArray(current.fields) ? current.fields : []
    const targetFields = mergeFields(currentFields, fields, options.overwrite)
    if (!sameArray(currentFields, targetFields) || current.is_active !== true) {
      if (!current.id) {
        throw new Error(`translation_settings row for ${setting.entity_type} has no id`)
      }

      updatePayload.push({
        id: current.id,
        fields: targetFields,
        is_active: true,
      })
    }
  }

  return { createPayload, updatePayload }
}

export async function syncStoreSupportedLocales(
  storeService: any,
  options: SyncStoreOptions = {}
): Promise<SyncStoreSummary> {
  const dryRun = options.dryRun === true
  const codes = await loadMarketSupportedLocaleCodes(options.localeConfig)
  const supportedLocales = codes.map((code) => ({ locale_code: code }))
  const stores = await tryList(storeService, [
    "listStores",
    "listAndCountStores",
    "listAndCount",
    "list",
  ], {
    config: { take: null, relations: ["supported_locales"] },
  })

  if (stores.length === 0) {
    if (options.bootstrapStore !== true) {
      throw new Error("no Store found; pass --bootstrap-store with separate evidence to create default")
    }

    const createStores = firstFunction(storeService, ["createStores", "create"])
    if (!createStores) {
      throw new Error("No stores found and store service cannot create one")
    }

    if (!dryRun) {
      await createStores({
        name: "Medusa Store",
        supported_locales: supportedLocales,
      })
    }

    return {
      stores: 1,
      codes,
      dry_run: dryRun,
    }
  }

  const updateStores = firstFunction(storeService, ["updateStores", "update"])
  if (!updateStores) {
    throw new Error("Store service does not expose updateStores/update")
  }

  for (const store of stores) {
    const currentCodes = Array.isArray(store?.supported_locales)
      ? store.supported_locales
          .map((locale: any) => locale?.locale_code)
          .filter((code: unknown): code is string => typeof code === "string")
      : []

    if (sameArray(currentCodes, codes)) {
      continue
    }

    if (!dryRun) {
      await updateStores(store.id, {
        supported_locales: supportedLocales,
      })
    }
  }

  return {
    stores: stores.length,
    codes,
    dry_run: dryRun,
  }
}

async function withTranslationSettingsLock<T>(
  db: AdvisoryLockDb | undefined,
  action: () => Promise<T>
): Promise<T> {
  const client = db?.client
  if (!client) {
    throw new Error("PostgreSQL connection is required for translation_settings advisory lock")
  }

  const connection = await client.acquireConnection()
  let locked = false

  try {
    await connection.query("SELECT pg_advisory_lock($1)", [
      TRANSLATION_SETTINGS_ADVISORY_LOCK_ID,
    ])
    locked = true
    return await action()
  } finally {
    try {
      if (locked) {
        await connection.query("SELECT pg_advisory_unlock($1)", [
          TRANSLATION_SETTINGS_ADVISORY_LOCK_ID,
        ])
      }
    } finally {
      await client.releaseConnection(connection)
    }
  }
}

async function applyTranslationSettingsPlan(
  translationService: any,
  plan: TranslationSettingsPlan,
  summary: { created: string[]; updated: string[] },
  options: { overwrite: boolean }
): Promise<void> {
  if (plan.updatePayload.length) {
    const updateSettings = firstFunction(translationService, [
      "updateTranslationSettings",
      "update",
    ])
    if (!updateSettings) {
      throw new Error("Translation service does not expose updateTranslationSettings/update")
    }
    await updateSettings(plan.updatePayload)
    summary.updated.push(...plan.updatePayload.map((setting) => setting.id))
  }

  if (!plan.createPayload.length) {
    return
  }

  const createSettings = firstFunction(translationService, [
    "createTranslationSettings",
    "create",
  ])
  if (!createSettings) {
    throw new Error("Translation service does not expose createTranslationSettings/create")
  }

  let duplicateDuringCreate = false
  for (const setting of plan.createPayload) {
    try {
      await createSettings(setting)
      summary.created.push(setting.entity_type)
    } catch (error) {
      if (!isDuplicateTranslationSettingsError(error)) {
        throw error
      }
      duplicateDuringCreate = true
    }
  }

  if (!duplicateDuringCreate) {
    return
  }

  const remainingPlan = buildTranslationSettingsPlan(
    await listCurrentTranslationSettings(translationService),
    { overwrite: options.overwrite }
  )
  const remainingCreates = remainingPlan.createPayload.filter(
    (setting) => !summary.created.includes(setting.entity_type)
  )

  if (remainingPlan.updatePayload.length || remainingCreates.length) {
    await applyTranslationSettingsPlan(
      translationService,
      {
        createPayload: remainingCreates,
        updatePayload: remainingPlan.updatePayload,
      },
      summary,
      options
    )
  }
}

export async function syncTranslationSettings(
  translationService: any,
  options: SyncOptions = {}
): Promise<SyncTranslationSettingsSummary> {
  const dryRun = options.dryRun === true
  const overwrite = options.overwrite === true
  const created: string[] = []
  const updated: string[] = []
  const common = {
    story_labels: TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.story_label),
    entity_types: TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.entity_type),
  }

  if (dryRun) {
    const plan = buildTranslationSettingsPlan(
      await listCurrentTranslationSettings(translationService),
      { overwrite }
    )

    return {
      ...common,
      created: plan.createPayload.map((setting) => setting.entity_type),
      updated: plan.updatePayload.map((setting) => setting.id),
      dry_run: dryRun,
    }
  }

  await withTranslationSettingsLock(options.db, async () => {
    const plan = buildTranslationSettingsPlan(
      await listCurrentTranslationSettings(translationService),
      { overwrite }
    )

    const freshPlan = plan.updatePayload.length
      ? buildTranslationSettingsPlan(
          await listCurrentTranslationSettings(translationService),
          { overwrite }
        )
      : plan

    await applyTranslationSettingsPlan(
      translationService,
      freshPlan,
      { created, updated },
      { overwrite }
    )
  })

  return {
    ...common,
    created,
    updated,
    dry_run: dryRun,
  }
}

export async function gpConfigSyncTranslations({
  container,
  args,
}: ExecArgs): Promise<TranslationSyncResult> {
  const parsedArgs = parseEntrypointArgs(args)

  if (!isTranslationFeatureFlagEnabled()) {
    const result: TranslationSyncResult = {
      ok: true,
      skipped: true,
      reason: "MEDUSA_FF_TRANSLATION is not true",
    }

    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    )
    return result
  }

  const storeService = resolveService(container, [
    "store",
    "storeModuleService",
    "IStoreModuleService",
    "store_module",
  ])
  const translationService = resolveService(container, [
    "translation",
    "translationModuleService",
    "ITranslationModuleService",
    "translation_module",
  ])
  const db = resolveService(container, [
    ContainerRegistrationKeys.PG_CONNECTION,
    "pg_connection",
  ])

  const store = await syncStoreSupportedLocales(storeService, {
    bootstrapStore: parsedArgs.bootstrapStore,
    dryRun: parsedArgs.dryRun,
    localeConfig: {
      configRoot: parsedArgs.configRoot,
      instanceId: parsedArgs.instanceId,
      marketId: parsedArgs.marketId,
    },
  })
  const translation_settings = await syncTranslationSettings(translationService, {
    db,
    dryRun: parsedArgs.dryRun,
    overwrite: parsedArgs.overwrite,
  })
  const result: TranslationSyncResult = {
    ok: true,
    dry_run: parsedArgs.dryRun,
    store,
    translation_settings,
  }

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  )
  return result
}

export default gpConfigSyncTranslations
