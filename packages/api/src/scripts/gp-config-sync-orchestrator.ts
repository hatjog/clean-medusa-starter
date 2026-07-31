import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  FORCE_VENDOR_OVERWRITE_FLAG,
  parseDryRunFlag,
  parseOverwriteFlag,
  parsePruneFlag,
  resolveForceVendorOverwriteRelay,
} from "./gp-sync-dry-run"
import gpConfigSyncAccounts from "./gp-config-sync-accounts"
import gpConfigSyncBlog from "./gp-config-sync-blog"
import gpConfigSyncCatalog from "./gp-config-sync-catalog"
import gpConfigSyncI18nContent from "./gp-config-sync-i18n-content"
import gpConfigSyncMarketRuntime from "./gp-config-sync-market-runtime"
import gpConfigSyncTranslations from "./gp-config-sync-translations"
import gpConfigSyncMedia from "./gp-config-sync-media"
import gpConfigSyncPayments from "./gp-config-sync-payments"
import gpConfigSyncReviews from "./gp-config-sync-reviews"
import gpConfigSyncShipping from "./gp-config-sync-shipping"
import gpConfigSyncVendors, {
  type OwnershipProtectedSkip,
  type VendorContentOverwrite,
} from "./gp-config-sync-vendors"
import { isTranslationFeatureFlagEnabled } from "../lib/translation-ff-config"

const ADVISORY_LOCK_ID = 1234567890
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type OrchestratorArgs = {
  allowSkip: boolean
  apply: boolean
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
  overwrite: boolean
  prune: boolean
  /**
   * ADR-165 / W3 — świadome nadpisanie treści vendor-owned. Osobny, mocniejszy
   * kanał niż `overwrite`; orchestrator go RELAYUJE (argv etapu + env), a nie
   * wymyśla. Bez tego relayu `resolveForceVendorOverwrite` nie miał jak
   * zwrócić `enabled: true` poza testami: `gp catalog sync` wysyła orchestratorowi
   * wyłącznie argumenty pozycyjne, a `withStageEnv` zerowało env na sztywno,
   * więc żadna realna ścieżka nie ustawiała OBU połówek koniunkcji.
   */
  forceVendorOverwrite: boolean
  /**
   * Cykl 5 — kanał ustawiony JEDNOSTRONNIE (sam odziedziczony env albo sam
   * token) i w efekcie zignorowany. Musi trafić do `warnings`: cichy no-op
   * zostawia operatora w przekonaniu, że force zadziałał.
   */
  forceVendorOverwriteIgnoredReason?: string
}

type StageRunResult = {
  name: string
  required: boolean
  status: "ok" | "skipped" | "warning"
  duration_ms: number
  message?: string
}

type StageExecutionResult =
  | string
  | void
  | {
      status: "skipped"
      message: string
    }

export type HealthReport = {
  totalProducts: number
  publishedProducts: number
  visibilityRatio: number
  splCount: number
  seoProducts: number
  seoCoverage: number
}

type AdvisoryLockHandle = {
  release: () => Promise<void>
}

type SlugRedirectEntry = {
  from: string
  to: string
  permanent: boolean
}

type RedirectConfig = {
  redirects?: SlugRedirectEntry[] | null
}

type OrchestratorSummary = {
  ok: boolean
  generated_at: string
  instance_id: string
  market_id: string
  dry_run: boolean
  overwrite: boolean
  /** ADR-165 §3 — czy run miał zdjętą ochronę treści vendor-owned. */
  force_vendor_overwrite: boolean
  /** ADR-165 §2 — pominięcia bramki własności; niepuste ⟹ `ok: false`. */
  ownership_protected: OwnershipProtectedSkip[]
  address_write_failures?: Array<{ vendor_id: string; reason: string }>
  sellers_without_address?: string[]
  /**
   * ADR-165 §4 (cykl 5) — treść vendora, którą `--force` REALNIE nadpisał.
   * Niepuste NIE oznacza porażki (operator o to prosił), ale `gp catalog sync`
   * odróżnia po tym polu „nadpisano treść vendora" od zwykłego sukcesu.
   */
  vendor_overwritten: VendorContentOverwrite[]
  stages: StageRunResult[]
  health: HealthReport
  changed_entity_ids: string[]
  revalidate: {
    attempted: boolean
    ok: boolean
    url?: string
    error?: string
    skipped?: boolean
  }
  slack: {
    sent: boolean
    error?: string
  }
  warnings: string[]
  report_path: string
}

export function parseOrchestratorArgs(args: string[] | undefined): OrchestratorArgs {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()
  const dryRun = parseDryRunFlag(args)
  const overwrite = parseOverwriteFlag(args)
  const prune = parsePruneFlag(args)
  const forceVendorOverwriteDecision = resolveForceVendorOverwriteRelay(args)
  const allowSkip = args?.includes("--allow-skip") === true
  const apply = args?.includes("--apply") === true

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return {
    allowSkip,
    apply,
    instanceId,
    marketId,
    configRoot,
    dryRun,
    forceVendorOverwrite: forceVendorOverwriteDecision.enabled,
    ...(forceVendorOverwriteDecision.ignoredReason
      ? { forceVendorOverwriteIgnoredReason: forceVendorOverwriteDecision.ignoredReason }
      : {}),
    overwrite,
    prune,
  }
}

export function assertTranslationStageGate(
  orchestratorArgs: Pick<OrchestratorArgs, "allowSkip">,
  env: NodeJS.ProcessEnv = process.env
): void {
  const stage = env.MEDUSA_STAGE?.trim().toLowerCase()
  const gatedStages = new Set(["staging", "canary", "production"])
  const rawTranslationFlag = env.MEDUSA_FF_TRANSLATION?.trim().toLowerCase()

  if (
    stage &&
    gatedStages.has(stage) &&
    !orchestratorArgs.allowSkip &&
    (rawTranslationFlag === "false" || !isTranslationFeatureFlagEnabled(env))
  ) {
    throw new Error(
      `FF translation gate required in stage ${stage}; pass --allow-skip to override`
    )
  }
}

function resolveProductModuleService(container: any): any {
  const keysToTry = ["product", "productModuleService", "product_module"]
  const errors: string[] = []

  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (error: any) {
      errors.push(`${key}: ${error?.message ?? String(error)}`)
    }
  }

  throw new Error(
    `Cannot resolve product service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

async function readYamlIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
    if (!doc || typeof doc !== "object") {
      throw new Error(`Invalid YAML document: ${filePath}`)
    }
    return doc as T
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null
    }
    throw error
  }
}

function normalizeRawResultCount(result: any): number {
  const row = Array.isArray(result?.rows)
    ? result.rows[0]
    : Array.isArray(result)
      ? Array.isArray(result[0])
        ? result[0][0]
        : result[0]
      : result

  const rawCount = row?.count ?? Object.values(row ?? {})[0]
  const parsed = Number(rawCount)
  return Number.isFinite(parsed) ? parsed : 0
}

async function loadMarketProducts(productModuleService: any): Promise<any[]> {
  if (typeof productModuleService.listProducts === "function") {
    const result = await productModuleService.listProducts(
      {},
      { select: ["id", "handle", "status", "metadata"], take: null }
    )
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
    return Array.isArray(result) ? result : []
  }

  if (typeof productModuleService.list === "function") {
    const result = await productModuleService.list({})
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
    return Array.isArray(result) ? result : []
  }

  return []
}

export async function buildHealthReport(
  productModuleService: any,
  db: { raw: (sql: string) => Promise<any> },
  marketId: string
): Promise<HealthReport> {
  const allProducts = await loadMarketProducts(productModuleService)
  const marketProducts = allProducts.filter((product) => {
    const gpMeta = product?.metadata?.gp
    return gpMeta?.market_id === marketId
  })

  const totalProducts = marketProducts.length
  const publishedProducts = marketProducts.filter(
    (product) => product?.status === "published"
  ).length
  const seoProducts = marketProducts.filter((product) => {
    const metaTitle = product?.metadata?.gp?.seo?.meta_title
    return typeof metaTitle === "string" && metaTitle.trim().length > 0
  }).length
  const splCount = normalizeRawResultCount(
    await db.raw("SELECT COUNT(*)::int AS count FROM product_product_seller_seller")
  )

  return {
    totalProducts,
    publishedProducts,
    visibilityRatio: totalProducts === 0 ? 1 : publishedProducts / totalProducts,
    splCount,
    seoProducts,
    seoCoverage: totalProducts === 0 ? 1 : seoProducts / totalProducts,
  }
}

async function acquireAdvisoryLock(db: Knex, lockId: number): Promise<AdvisoryLockHandle | null> {
  const client = db.client as any
  const connection = await client.acquireConnection()

  try {
    const result = await connection.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockId]
    )
    const locked = result?.rows?.[0]?.locked === true

    if (!locked) {
      await client.releaseConnection(connection)
      return null
    }

    return {
      release: async () => {
        try {
          await connection.query("SELECT pg_advisory_unlock($1)", [lockId])
        } finally {
          await client.releaseConnection(connection)
        }
      },
    }
  } catch (error) {
    await client.releaseConnection(connection)
    throw error
  }
}

export async function runStage(stage: {
  name: string
  required: boolean
  execute: () => Promise<StageExecutionResult>
}): Promise<StageRunResult> {
  const started = Date.now()

  try {
    const result = await stage.execute()
    if (result && typeof result === "object" && result.status === "skipped") {
      return {
        name: stage.name,
        required: stage.required,
        status: "skipped",
        duration_ms: Date.now() - started,
        message: result.message,
      }
    }

    const message = typeof result === "string" ? result : undefined
    return {
      name: stage.name,
      required: stage.required,
      status: "ok",
      duration_ms: Date.now() - started,
      ...(message ? { message } : {}),
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error)
    if (stage.required) {
      throw error
    }

    return {
      name: stage.name,
      required: stage.required,
      status: "warning",
      duration_ms: Date.now() - started,
      message,
    }
  }
}

export function buildStageArgs(orchestratorArgs: OrchestratorArgs): string[] {
  const args = [orchestratorArgs.instanceId, orchestratorArgs.marketId]
  if (orchestratorArgs.dryRun) {
    args.push("--dry-run")
  }
  if (orchestratorArgs.overwrite) {
    args.push("--overwrite")
  }
  if (orchestratorArgs.prune) {
    args.push("--prune")
  }
  // W3 — druga połówka koniunkcji ADR-165 §3. Bez niej etap `sync-vendors`
  // widziałby wyłącznie env i zawsze raportowałby „ZIGNOROWANE: brak jawnej
  // intencji w argumentach wywołania".
  if (orchestratorArgs.forceVendorOverwrite) {
    args.push(FORCE_VENDOR_OVERWRITE_FLAG)
  }
  if (orchestratorArgs.apply) {
    args.push("--apply")
  }
  return args
}

export async function withStageEnv<T>(
  orchestratorArgs: OrchestratorArgs,
  action: () => Promise<T>
): Promise<T> {
  const previous = {
    GP_BACKFILL_APPLY: process.env.GP_BACKFILL_APPLY,
    GP_CONFIG_ROOT: process.env.GP_CONFIG_ROOT,
    GP_DRY_RUN: process.env.GP_DRY_RUN,
    GP_FORCE_VENDOR_OVERWRITE: process.env.GP_FORCE_VENDOR_OVERWRITE,
    GP_INSTANCE_ID: process.env.GP_INSTANCE_ID,
    GP_MARKET_ID: process.env.GP_MARKET_ID,
    GP_OVERWRITE: process.env.GP_OVERWRITE,
    GP_SYNC_PRUNE: process.env.GP_SYNC_PRUNE,
  }

  process.env.GP_CONFIG_ROOT = orchestratorArgs.configRoot
  // Orchestrator nie ma kroku backfillu; odziedziczony kanał zapisu nie może
  // zostać przypadkiem odczytany przez żaden etap uruchamiany in-process.
  process.env.GP_BACKFILL_APPLY = "false"
  process.env.GP_DRY_RUN = orchestratorArgs.dryRun ? "true" : "false"
  process.env.GP_INSTANCE_ID = orchestratorArgs.instanceId
  process.env.GP_MARKET_ID = orchestratorArgs.marketId
  process.env.GP_OVERWRITE = orchestratorArgs.overwrite ? "true" : "false"
  process.env.GP_SYNC_PRUNE = orchestratorArgs.prune ? "true" : "false"
  // ADR-165 §3 / W3: kanał destrukcyjny jest odtąd RELAYOWANY, nie zerowany
  // na sztywno — inaczej `gp catalog sync --force-vendor-overwrite` nie miałby
  // jak dojechać do etapu (`invokeStageEntrypoint` woła etapy IN-PROCESS, więc
  // env procesu JEST kanałem). Kluczowe zostaje to samo, co przy
  // GP_OVERWRITE/GP_SYNC_PRUNE: wartość jest ZAWSZE jawna, wyprowadzona
  // z intencji runu — nigdy „cokolwiek odziedziczysz".
  process.env.GP_FORCE_VENDOR_OVERWRITE = orchestratorArgs.forceVendorOverwrite
    ? "true"
    : "false"

  try {
    return await action()
  } finally {
    if (previous.GP_BACKFILL_APPLY === undefined) delete process.env.GP_BACKFILL_APPLY
    else process.env.GP_BACKFILL_APPLY = previous.GP_BACKFILL_APPLY

    if (previous.GP_CONFIG_ROOT === undefined) delete process.env.GP_CONFIG_ROOT
    else process.env.GP_CONFIG_ROOT = previous.GP_CONFIG_ROOT

    if (previous.GP_DRY_RUN === undefined) delete process.env.GP_DRY_RUN
    else process.env.GP_DRY_RUN = previous.GP_DRY_RUN

    if (previous.GP_FORCE_VENDOR_OVERWRITE === undefined)
      delete process.env.GP_FORCE_VENDOR_OVERWRITE
    else process.env.GP_FORCE_VENDOR_OVERWRITE = previous.GP_FORCE_VENDOR_OVERWRITE

    if (previous.GP_INSTANCE_ID === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = previous.GP_INSTANCE_ID

    if (previous.GP_MARKET_ID === undefined) delete process.env.GP_MARKET_ID
    else process.env.GP_MARKET_ID = previous.GP_MARKET_ID

    if (previous.GP_OVERWRITE === undefined) delete process.env.GP_OVERWRITE
    else process.env.GP_OVERWRITE = previous.GP_OVERWRITE

    if (previous.GP_SYNC_PRUNE === undefined) delete process.env.GP_SYNC_PRUNE
    else process.env.GP_SYNC_PRUNE = previous.GP_SYNC_PRUNE
  }
}

/**
 * Sygnał „etap zakończył się niezerowym kodem wyjścia", przechwycony z
 * `process.exitCode` ustawionego przez wywołany in-process entrypoint.
 */
export type StageExitSignal = {
  readonly stage: string
  readonly exitCode: number
}

/**
 * Woła entrypoint etapu IN-PROCESS, izolując jego `process.exitCode` od kodu
 * wyjścia orchestratora — ale NIE połykając go.
 *
 * Verify-B5 V4: wcześniejsza wersja bezwarunkowo przywracała `previousExitCode`
 * w `finally`, więc `process.exitCode = 1` z `gp-config-sync-vendors`
 * (`warnings.length > 0 && !dryRun`) znikał bez śladu. Na podstawowej ścieżce
 * operatora (`gp catalog sync`) pominięcie pola vendor-owned wyglądało wtedy na
 * pełny sukces — czyli gwarancja ADR-165 §2 („cichy skip byłby powtórzeniem
 * tego samego defektu w drugą stronę") była unieważniona dokładnie tam, gdzie
 * ma znaczenie. Kod wyjścia etapu trafia teraz do `signals`, a wołający
 * podnosi go do warningów i do kodu wyjścia całego runu.
 */
export async function invokeStageEntrypoint<T>(
  entrypoint: (ctx: ExecArgs) => Promise<T>,
  container: any,
  args: string[],
  exitSignal?: { readonly stage: string; readonly sink: StageExitSignal[] }
): Promise<T> {
  const previousExitCode = process.exitCode

  try {
    process.exitCode = undefined
    return await entrypoint({ container, args })
  } finally {
    const stageExitCode = process.exitCode
    if (exitSignal && typeof stageExitCode === "number" && stageExitCode !== 0) {
      exitSignal.sink.push({ stage: exitSignal.stage, exitCode: stageExitCode })
    }
    process.exitCode = previousExitCode
  }
}

async function previewCatalogStage(orchestratorArgs: OrchestratorArgs): Promise<string> {
  const catalogPath = path.resolve(
    orchestratorArgs.configRoot,
    orchestratorArgs.instanceId,
    "markets",
    orchestratorArgs.marketId,
    "products.yaml"
  )
  const catalog = await readYamlIfExists<{
    categories?: unknown[]
    collections?: unknown[]
    products?: unknown[]
  }>(catalogPath)

  if (!catalog) {
    throw new Error(`Catalog fixture not found: ${catalogPath}`)
  }

  const categoryCount = Array.isArray(catalog.categories) ? catalog.categories.length : 0
  const collectionCount = Array.isArray(catalog.collections) ? catalog.collections.length : 0
  const productCount = Array.isArray(catalog.products) ? catalog.products.length : 0

  const message =
    `would inspect ${categoryCount} categories, ` +
    `${collectionCount} collections, ${productCount} products`

  console.log(`[dry-run][sync-catalog] ${message}`)
  return message
}

function validateRedirectEntry(entry: unknown, index: number): SlugRedirectEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`redirects[${index}] must be an object`)
  }

  const candidate = entry as Record<string, unknown>
  if (typeof candidate.from !== "string" || !SLUG_RE.test(candidate.from)) {
    throw new Error(`redirects[${index}].from must be a lowercase slug`)
  }
  if (typeof candidate.to !== "string" || !SLUG_RE.test(candidate.to)) {
    throw new Error(`redirects[${index}].to must be a lowercase slug`)
  }
  if (typeof candidate.permanent !== "boolean") {
    throw new Error(`redirects[${index}].permanent must be boolean`)
  }

  return {
    from: candidate.from,
    to: candidate.to,
    permanent: candidate.permanent,
  }
}

async function loadSlugRedirectEntries(orchestratorArgs: OrchestratorArgs): Promise<SlugRedirectEntry[]> {
  const filePath = path.resolve(
    orchestratorArgs.configRoot,
    orchestratorArgs.instanceId,
    "markets",
    orchestratorArgs.marketId,
    "slug-redirects.yaml"
  )
  const config = await readYamlIfExists<RedirectConfig>(filePath)

  if (!config) {
    return []
  }

  const rawEntries = config.redirects
  if (rawEntries == null) {
    return []
  }
  if (!Array.isArray(rawEntries)) {
    throw new Error(`Invalid slug-redirects.yaml: redirects must be an array or null`)
  }

  const deduped = new Map<string, SlugRedirectEntry>()
  rawEntries.forEach((entry, index) => {
    const validEntry = validateRedirectEntry(entry, index)
    deduped.set(validEntry.from, validEntry)
  })

  return Array.from(deduped.values())
}

async function runRedirectStage(orchestratorArgs: OrchestratorArgs): Promise<string> {
  const entries = await loadSlugRedirectEntries(orchestratorArgs)
  const message =
    entries.length === 0
      ? "no slug redirects configured"
      : `validated ${entries.length} slug redirect(s)`

  if (orchestratorArgs.dryRun) {
    console.log(`[dry-run][sync-redirects] ${message}`)
  } else {
    console.log(`[sync-redirects] ${message}`)
  }

  return message
}

async function collectChangedEntityIds(orchestratorArgs: OrchestratorArgs): Promise<string[]> {
  const ids = new Set<string>()

  const productsPath = path.resolve(
    orchestratorArgs.configRoot,
    orchestratorArgs.instanceId,
    "markets",
    orchestratorArgs.marketId,
    "products.yaml"
  )
  const marketPath = path.resolve(
    orchestratorArgs.configRoot,
    orchestratorArgs.instanceId,
    "markets",
    orchestratorArgs.marketId,
    "market.yaml"
  )

  const [catalog, market, redirects] = await Promise.all([
    readYamlIfExists<{
      categories?: Array<{ category_id?: string }>
      collections?: Array<{ collection_id?: string }>
      products?: Array<{ product_id?: string }>
    }>(productsPath),
    readYamlIfExists<{ vendors?: Array<{ vendor_id?: string }> }>(marketPath),
    loadSlugRedirectEntries(orchestratorArgs),
  ])

  for (const category of catalog?.categories ?? []) {
    if (category.category_id) ids.add(category.category_id)
  }
  for (const collection of catalog?.collections ?? []) {
    if (collection.collection_id) ids.add(collection.collection_id)
  }
  for (const product of catalog?.products ?? []) {
    if (product.product_id) ids.add(product.product_id)
  }
  for (const vendor of market?.vendors ?? []) {
    if (vendor.vendor_id) ids.add(vendor.vendor_id)
  }
  for (const redirect of redirects) {
    ids.add(`redirect:${redirect.from}->${redirect.to}`)
  }

  return Array.from(ids)
}

export async function callRevalidateAll(baseUrl: string, secret: string): Promise<void> {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "")
  const response = await fetch(`${trimmedBaseUrl}/api/revalidate-all`, {
    method: "POST",
    headers: {
      "x-revalidate-secret": secret,
    },
  })

  if (!response.ok) {
    throw new Error(`revalidate-all failed: ${response.status} ${response.statusText}`)
  }
}

export async function sendSlackNotification(webhookUrl: string, text: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  })

  if (!response.ok) {
    throw new Error(`slack webhook failed: ${response.status} ${response.statusText}`)
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function buildReportPath(now: Date): string {
  const fileName = `${now.toISOString().slice(0, 13).replace("T", "-")}.json`
  return path.resolve(process.cwd(), "../../gp-ops/sync-reports", fileName)
}

function buildSlackSummary(summary: OrchestratorSummary): string {
  return [
    `GP sync ${summary.dry_run ? "dry-run" : "completed"} for ${summary.market_id}`,
    `Visibility: ${summary.health.publishedProducts}/${summary.health.totalProducts} (${formatPercent(summary.health.visibilityRatio)})`,
    `SPL links: ${summary.health.splCount}`,
    `SEO coverage: ${summary.health.seoProducts}/${summary.health.totalProducts} (${formatPercent(summary.health.seoCoverage)})`,
    `Report: ${summary.report_path}`,
  ].join("\n")
}

export default async function gpConfigSyncOrchestrator({ container, args }: ExecArgs) {
  const orchestratorArgs = parseOrchestratorArgs(args)
  assertTranslationStageGate(orchestratorArgs)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const productModuleService = resolveProductModuleService(container)
  const lock = await acquireAdvisoryLock(db, ADVISORY_LOCK_ID)

  if (!lock) {
    console.warn("Sync already in progress")
    return
  }

  const stageArgs = buildStageArgs(orchestratorArgs)
  const warnings: string[] = []

  if (orchestratorArgs.forceVendorOverwriteIgnoredReason) {
    // Cykl 5 — kanał destrukcyjny ustawiony jednostronnie. Nic nie zniszczyliśmy,
    // ale operator musi wiedzieć, że jego (albo odziedziczone) ustawienie nie
    // zadziałało; inaczej uzna, że force był aktywny, i wyciągnie z runu zły wniosek.
    console.warn(
      `[GP_FORCE_VENDOR_OVERWRITE] ${orchestratorArgs.forceVendorOverwriteIgnoredReason}`
    )
    warnings.push(orchestratorArgs.forceVendorOverwriteIgnoredReason)
  }
  /** Verify-B5 V4 — niezerowe kody wyjścia etapów; nie wolno ich połknąć. */
  const stageExitSignals: StageExitSignal[] = []
  /** ADR-165 / W2 — jedyna klasa sygnału, która zamienia run w porażkę. */
  const ownershipProtectedSkips: OwnershipProtectedSkip[] = []
  /** F-1 (review 5.7) — nieudane zapisy `seller_address` z etapu vendors. */
  const addressWriteFailures: Array<{ vendor_id: string; reason: string }> = []
  /** F-5 (review 5.7) — sellerzy bez adresu: ich mail potwierdzenia NIE wyjdzie. */
  const sellersWithoutAddress: string[] = []
  /** ADR-165 §4 / cykl 5 — druga klasa sygnału tej samej bramki: co force zniszczył. */
  const vendorContentOverwrites: VendorContentOverwrite[] = []

  try {
    const changedEntityIds = await collectChangedEntityIds(orchestratorArgs)
    const stageDefinitions = [
      {
        // Story 5.7 (AC2.6) — PIERWSZY etap: `market_runtime_config` jest
        // źródłem `locales`/`support_email`/`market_url` dla runtime'u, więc
        // musi być aktualne zanim cokolwiek zacznie z niego czytać.
        name: "sync-market-runtime",
        required: true,
        execute: async () => {
          const summary = await withStageEnv(orchestratorArgs, async () => {
            return await invokeStageEntrypoint(
              gpConfigSyncMarketRuntime,
              container,
              stageArgs,
              { stage: "sync-market-runtime", sink: stageExitSignals },
            )
          })

          return orchestratorArgs.dryRun
            ? `market runtime dry-run completed (action=${summary?.action})`
            : `market runtime sync completed (action=${summary?.action})`
        },
      },
      {
        name: "sync-catalog",
        required: true,
        execute: async () => {
          if (orchestratorArgs.dryRun) {
            return previewCatalogStage(orchestratorArgs)
          }

          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncCatalog, container, stageArgs, {
              stage: "sync-catalog",
              sink: stageExitSignals,
            })
          })
          return "catalog sync completed"
        },
      },
      {
        name: "sync-translations",
        required: true,
        execute: async () => {
          const result = await withStageEnv(orchestratorArgs, async () => {
            return await invokeStageEntrypoint(gpConfigSyncTranslations, container, stageArgs, {
              stage: "sync-translations",
              sink: stageExitSignals,
            })
          })

          if ("skipped" in result && result.skipped) {
            return {
              status: "skipped" as const,
              message: "translations sync: SKIPPED (FF=false)",
            }
          }

          const completedResult = result as Extract<
            Awaited<ReturnType<typeof gpConfigSyncTranslations>>,
            { store: unknown }
          >
          const localeCount = completedResult.store.codes.length
          const settingsCount = completedResult.translation_settings.entity_types.length
          return orchestratorArgs.dryRun
            ? `translations sync: COMPLETED (dry-run, FF=true, locales=${localeCount}, settings=${settingsCount})`
            : `translations sync: COMPLETED (FF=true, locales=${localeCount}, settings=${settingsCount})`
        },
      },
      {
        name: "sync-media",
        required: true,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncMedia, container, stageArgs, {
              stage: "sync-media",
              sink: stageExitSignals,
            })
          })
          return orchestratorArgs.dryRun ? "media dry-run completed" : "media sync completed"
        },
      },
      {
        name: "sync-vendors",
        required: true,
        execute: async () => {
          const vendorSummary = await withStageEnv(orchestratorArgs, async () => {
            return await invokeStageEntrypoint(gpConfigSyncVendors, container, stageArgs, {
              stage: "sync-vendors",
              sink: stageExitSignals,
            })
          })

          // W2 — typowany sygnał zamiast „jakiś warning". Tylko pominięcie
          // bramki własności ADR-165 eskaluje run; zastane warningi etapu
          // (vendor suspended, brak sellerId) zostają warningami.
          for (const skip of vendorSummary?.ownership_protected ?? []) {
            ownershipProtectedSkips.push(skip)
          }

          // F-1/F-5 (review 5.7) — relay do raportu orchestratora, bo to jedyne,
          // co widzi `gp catalog sync`. Bez niego brak adresu salonu wychodzi na
          // jaw dopiero jako `failed` w ledgerze PO zakupie klientki.
          for (const failure of vendorSummary?.address_write_failures ?? []) {
            addressWriteFailures.push(failure)
          }
          for (const vendorId of vendorSummary?.sellers_without_address ?? []) {
            sellersWithoutAddress.push(vendorId)
          }

          // ADR-165 §4 (cykl 5) — to samo dla drugiej strony bramki. Bez tego
          // relayu raport orchestratora (jedyne, co widzi `gp catalog sync`)
          // nie niósł ANI JEDNEGO śladu po tym, co force skasował.
          for (const overwrite of vendorSummary?.vendor_overwritten ?? []) {
            vendorContentOverwrites.push(overwrite)
          }

          return orchestratorArgs.dryRun ? "vendor dry-run completed" : "vendor sync completed"
        },
      },
      {
        name: "sync-i18n-content",
        required: true,
        execute: async () => {
          const result = await withStageEnv(orchestratorArgs, async () => {
            return await invokeStageEntrypoint(gpConfigSyncI18nContent, container, stageArgs, {
              stage: "sync-i18n-content",
              sink: stageExitSignals,
            })
          })

          if ("skipped" in result && result.skipped) {
            return {
              status: "skipped" as const,
              message: `i18n content sync: SKIPPED (${result.reason})`,
            }
          }

          const completedResult = result as {
            locales: string[]
            entities: Record<
              string,
              {
                created: number
                translation_records: number
                updated: number
              }
            >
          }
          const recordCount = Object.values(completedResult.entities).reduce(
            (sum, entity) => sum + entity.translation_records,
            0
          )
          const changedCount = Object.values(completedResult.entities).reduce(
            (sum, entity) => sum + entity.created + entity.updated,
            0
          )

          return orchestratorArgs.dryRun
            ? `i18n content sync: COMPLETED (dry-run, locales=${completedResult.locales.length}, records=${recordCount}, planned_changes=${changedCount})`
            : `i18n content sync: COMPLETED (locales=${completedResult.locales.length}, records=${recordCount}, changes=${changedCount})`
        },
      },
      {
        name: "sync-reviews",
        required: false,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncReviews, container, stageArgs, {
              stage: "sync-reviews",
              sink: stageExitSignals,
            })
          })
          return orchestratorArgs.apply
            ? "reviews sync completed"
            : "reviews dry-run completed"
        },
      },
      {
        name: "sync-accounts",
        required: true,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncAccounts, container, stageArgs, {
              stage: "sync-accounts",
              sink: stageExitSignals,
            })
          })
          return orchestratorArgs.dryRun ? "accounts dry-run completed" : "accounts sync completed"
        },
      },
      {
        name: "sync-payments",
        required: true,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncPayments, container, stageArgs, {
              stage: "sync-payments",
              sink: stageExitSignals,
            })
          })
          return orchestratorArgs.dryRun ? "payments dry-run completed" : "payments sync completed"
        },
      },
      {
        name: "sync-shipping",
        required: true,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncShipping, container, stageArgs, {
              stage: "sync-shipping",
              sink: stageExitSignals,
            })
          })
          return orchestratorArgs.dryRun ? "shipping dry-run completed" : "shipping sync completed"
        },
      },
      {
        name: "sync-blog",
        required: false,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncBlog, container, stageArgs, {
              stage: "sync-blog",
              sink: stageExitSignals,
            })
          })
          return orchestratorArgs.dryRun ? "blog dry-run completed" : "blog sync completed"
        },
      },
      {
        name: "sync-redirects",
        required: false,
        execute: async () => runRedirectStage(orchestratorArgs),
      },
    ]

    const stages: StageRunResult[] = []
    for (const stage of stageDefinitions) {
      const result = await runStage(stage)
      stages.push(result)
      if (result.status === "warning" && result.message) {
        warnings.push(`${result.name}: ${result.message}`)
      }
    }

    // Verify-B5 V4 — etap, który sam zgłosił niezerowy kod wyjścia, nie może
    // wyglądać na pełny sukces tylko dlatego, że nie rzucił wyjątku.
    //
    // W2 (review cykl 4) — ale nie może też ZABIJAĆ runu. Kod wyjścia etapu
    // jest sygnałem grubym: `gp-config-sync-accounts` podnosi go przy KAŻDYM
    // warningu (domyślne `GP_SYNC_ACCOUNTS_WARNINGS_ARE_ERRORS`), a
    // `gp-config-sync-catalog` po przekroczeniu progu ich liczby. Podniesienie
    // tego do porażki całego runu zamieniało w pełni udany `gp catalog sync`
    // w wyjątek. Sygnał zostaje więc WIDOCZNY (status etapu + `warnings`),
    // ale o porażce runu decyduje wyłącznie klasa ownership-protected niżej.
    for (const signal of stageExitSignals) {
      const stageResult = stages.find((entry) => entry.name === signal.stage)
      const message =
        `zakończył się kodem wyjścia ${signal.exitCode} — patrz warningi tego etapu`
      if (stageResult && stageResult.status === "ok") {
        stageResult.status = "warning"
        stageResult.message = stageResult.message
          ? `${stageResult.message}; ${message}`
          : message
      }
      warnings.push(`${signal.stage}: ${message}`)
    }

    // ADR-165 §2 — „nie zrobiłem tego, o co prosiłeś" nie może wyglądać jak
    // sukces. To jedyna klasa, która eskaluje.
    for (const skip of ownershipProtectedSkips) {
      warnings.push(
        `sync-vendors: ADR-165 — pola vendor-owned [${skip.fields.join(", ")}] vendora ` +
          `'${skip.vendor_id}' POMINIĘTE mimo --overwrite (treść vendora wygrywa; ` +
          `świadome nadpisanie: gp catalog sync <instance> <market> --force)`
      )
    }

    // F-1 (review 5.7) — nieudany zapis adresu salonu NIE jest kosmetyka: jego
    // skutkiem jest mail bez `salon_address` albo brak maila w ogole, bo bramka
    // kontraktu szablonu wstrzymuje wysylke. Byl degradowany do warningu, ktory
    // niczego nie zatrzymywal.
    for (const failure of addressWriteFailures) {
      warnings.push(
        `sync-vendors: zapis seller_address dla '${failure.vendor_id}' NIEUDANY ` +
          `(${failure.reason}) — mail potwierdzenia dla tego salonu sie NIE wysle ` +
          `(brak wymaganej zmiennej salon_address w kontrakcie szablonu)`
      )
    }

    // F-5 (review 5.7) — pre-flight: to jedyne miejsce, ktore widzi brak adresu
    // ZANIM ktos kupi. Wczesniej dowiadywalismy sie z `failed` w ledgerze.
    if (sellersWithoutAddress.length > 0) {
      warnings.push(
        `sync-vendors: ${sellersWithoutAddress.length} seller(ow) bez adresu w configu ` +
          `[${sellersWithoutAddress.join(", ")}] — mail potwierdzenia dla nich NIE wyjdzie, ` +
          `dopoki 'locations[0].address' nie zostanie uzupelnione w market.yaml`
      )
    }

    // ADR-165 §4 (cykl 5) — nadpisanie treści vendora NIE wywraca runu, ale
    // nie ma prawa być ciche: to jedyna operacja syncu, której nie da się
    // cofnąć z drzewa configu.
    for (const overwrite of vendorContentOverwrites) {
      warnings.push(
        `sync-vendors: ADR-165 §4 — pola vendor-owned [${overwrite.fields.join(", ")}] vendora ` +
          `'${overwrite.vendor_id}' NADPISANE przez --force wartościami z gp-config ` +
          `(treść vendora bezpowrotnie utracona)`
      )
    }

    const health = await buildHealthReport(productModuleService, db, orchestratorArgs.marketId)
    if (health.visibilityRatio < 0.7) {
      warnings.push(
        `Visibility ratio below threshold: ${formatPercent(health.visibilityRatio)} < 70.0%`
      )
    }

    const revalidate = {
      attempted: false,
      ok: true,
      skipped: false,
    } as OrchestratorSummary["revalidate"]

    if (orchestratorArgs.dryRun) {
      revalidate.skipped = true
    } else {
      const storefrontUrl = process.env.STOREFRONT_URL?.trim()
      const secret = process.env.REVALIDATE_SECRET?.trim()

      if (!storefrontUrl || !secret) {
        revalidate.ok = false
        revalidate.error = "STOREFRONT_URL or REVALIDATE_SECRET missing"
        warnings.push(revalidate.error)
      } else {
        revalidate.attempted = true
        revalidate.url = `${storefrontUrl.replace(/\/+$/, "")}/api/revalidate-all`

        try {
          await callRevalidateAll(storefrontUrl, secret)
        } catch (error: any) {
          revalidate.ok = false
          revalidate.error = error instanceof Error ? error.message : String(error)
          warnings.push(`Storefront revalidation failed: ${revalidate.error}`)
        }
      }
    }

    const reportPath = buildReportPath(new Date())
    const slack = { sent: false } as OrchestratorSummary["slack"]

    const summary: OrchestratorSummary = {
      ok: true,
      generated_at: new Date().toISOString(),
      instance_id: orchestratorArgs.instanceId,
      market_id: orchestratorArgs.marketId,
      dry_run: orchestratorArgs.dryRun,
      overwrite: orchestratorArgs.overwrite,
      force_vendor_overwrite: orchestratorArgs.forceVendorOverwrite,
      ownership_protected: ownershipProtectedSkips,
      address_write_failures: addressWriteFailures,
      sellers_without_address: sellersWithoutAddress,
      vendor_overwritten: vendorContentOverwrites,
      stages,
      health,
      changed_entity_ids: changedEntityIds,
      revalidate,
      slack,
      warnings,
      report_path: reportPath,
    }

    // Verify-B5 V4 + W2 — sygnał głośności musi dożyć do raportu I do kodu
    // wyjścia procesu. `gp catalog sync` czyta wyłącznie exit code
    // orchestratora; bez tego pominięcie treści vendor-owned kończyło się
    // zerem, czyli wyglądało na pełny sukces. Eskaluje WYŁĄCZNIE ta klasa —
    // zastane warningi etapów są widoczne, ale nie wywracają runu.
    // Dry-run niczego nie zapisał, więc tam zostaje 0.
    if (ownershipProtectedSkips.length > 0 && !orchestratorArgs.dryRun) {
      summary.ok = false
      process.exitCode = 1
    }

    if (!orchestratorArgs.dryRun && process.env.SLACK_WEBHOOK_URL?.trim()) {
      try {
        await sendSlackNotification(
          process.env.SLACK_WEBHOOK_URL.trim(),
          buildSlackSummary(summary)
        )
        summary.slack.sent = true
      } catch (error: any) {
        summary.slack.error = error instanceof Error ? error.message : String(error)
        warnings.push(`Slack notification failed: ${summary.slack.error}`)
      }
    }

    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8")

    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await lock.release()
  }
}
