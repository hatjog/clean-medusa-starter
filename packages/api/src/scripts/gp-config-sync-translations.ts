import type { ExecArgs } from "@medusajs/framework/types"

import { parseDryRunFlag } from "./gp-sync-dry-run"
import {
  isTranslationFeatureFlagEnabled,
  STORE_SUPPORTED_LOCALES,
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
  dryRun?: boolean
}

type ListOptions = {
  filters?: Record<string, unknown>
  config?: Record<string, unknown>
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

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
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
  currentSettings: TranslationSettingRow[]
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
    if (!sameArray(currentFields, fields) || current.is_active !== true) {
      if (!current.id) {
        throw new Error(`translation_settings row for ${setting.entity_type} has no id`)
      }

      updatePayload.push({
        id: current.id,
        fields,
        is_active: true,
      })
    }
  }

  return { createPayload, updatePayload }
}

export async function syncStoreSupportedLocales(
  storeService: any,
  options: SyncOptions = {}
): Promise<SyncStoreSummary> {
  const dryRun = options.dryRun === true
  const supportedLocales = STORE_SUPPORTED_LOCALES.map((locale) => ({
    locale_code: locale.code,
  }))
  const codes = STORE_SUPPORTED_LOCALES.map((locale) => locale.code)
  const stores = await tryList(storeService, [
    "listStores",
    "listAndCountStores",
    "listAndCount",
    "list",
  ], {
    config: { take: null, relations: ["supported_locales"] },
  })

  if (stores.length === 0) {
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

export async function syncTranslationSettings(
  translationService: any,
  options: SyncOptions = {}
): Promise<SyncTranslationSettingsSummary> {
  const dryRun = options.dryRun === true
  let plan = buildTranslationSettingsPlan(
    await listCurrentTranslationSettings(translationService)
  )
  const created: string[] = []
  const updated: string[] = []

  if (dryRun) {
    return {
      story_labels: TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.story_label),
      entity_types: TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.entity_type),
      created: plan.createPayload.map((setting) => setting.entity_type),
      updated: plan.updatePayload.map((setting) => setting.id),
      dry_run: dryRun,
    }
  }

  if (plan.updatePayload.length) {
    const updateSettings = firstFunction(translationService, [
      "updateTranslationSettings",
      "update",
    ])
    if (!updateSettings) {
      throw new Error("Translation service does not expose updateTranslationSettings/update")
    }
    await updateSettings(plan.updatePayload)
    updated.push(...plan.updatePayload.map((setting) => setting.id))
  }

  if (plan.createPayload.length) {
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
        created.push(setting.entity_type)
      } catch (error) {
        if (!isDuplicateTranslationSettingsError(error)) {
          throw error
        }
        duplicateDuringCreate = true
      }
    }

    if (duplicateDuringCreate) {
      plan = buildTranslationSettingsPlan(
        await listCurrentTranslationSettings(translationService)
      )

      if (plan.updatePayload.length) {
        const updateSettings = firstFunction(translationService, [
          "updateTranslationSettings",
          "update",
        ])
        if (!updateSettings) {
          throw new Error("Translation service does not expose updateTranslationSettings/update")
        }
        await updateSettings(plan.updatePayload)
        updated.push(...plan.updatePayload.map((setting) => setting.id))
      }

      const remainingCreates = plan.createPayload.filter(
        (setting) => !created.includes(setting.entity_type)
      )
      for (const setting of remainingCreates) {
        try {
          await createSettings(setting)
          created.push(setting.entity_type)
        } catch (error) {
          if (!isDuplicateTranslationSettingsError(error)) {
            throw error
          }
        }
      }
    }
  }

  return {
    story_labels: TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.story_label),
    entity_types: TRANSLATION_ENTITY_SETTINGS.map((setting) => setting.entity_type),
    created,
    updated,
    dry_run: dryRun,
  }
}

export async function gpConfigSyncTranslations({ container, args }: ExecArgs) {
  const dryRun = parseDryRunFlag(args)

  if (!isTranslationFeatureFlagEnabled()) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason: "MEDUSA_FF_TRANSLATION is not true",
        },
        null,
        2
      )
    )
    return
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

  const store = await syncStoreSupportedLocales(storeService, { dryRun })
  const translation_settings = await syncTranslationSettings(translationService, {
    dryRun,
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: dryRun,
        store,
        translation_settings,
      },
      null,
      2
    )
  )
}

export default gpConfigSyncTranslations
