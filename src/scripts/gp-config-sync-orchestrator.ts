import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import gpConfigSyncBlog from "./gp-config-sync-blog"
import gpConfigSyncCatalog from "./gp-config-sync-catalog"
import gpConfigSyncVendors from "./gp-config-sync-vendors"

const ADVISORY_LOCK_ID = 1234567890
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type OrchestratorArgs = {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
}

type StageRunResult = {
  name: string
  required: boolean
  status: "ok" | "warning"
  duration_ms: number
  message?: string
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
  const dryRun =
    args?.includes("--dry-run") === true || process.env.GP_DRY_RUN === "true"

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, marketId, configRoot, dryRun }
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
    await db.raw("SELECT COUNT(*)::int AS count FROM seller_seller_product_product")
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
  execute: () => Promise<string | void>
}): Promise<StageRunResult> {
  const started = Date.now()

  try {
    const message = await stage.execute()
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

function buildStageArgs(orchestratorArgs: OrchestratorArgs): string[] {
  const args = [orchestratorArgs.instanceId, orchestratorArgs.marketId]
  if (orchestratorArgs.dryRun) {
    args.push("--dry-run")
  }
  return args
}

async function withStageEnv<T>(
  orchestratorArgs: OrchestratorArgs,
  action: () => Promise<T>
): Promise<T> {
  const previous = {
    GP_CONFIG_ROOT: process.env.GP_CONFIG_ROOT,
    GP_DRY_RUN: process.env.GP_DRY_RUN,
    GP_INSTANCE_ID: process.env.GP_INSTANCE_ID,
    GP_MARKET_ID: process.env.GP_MARKET_ID,
  }

  process.env.GP_CONFIG_ROOT = orchestratorArgs.configRoot
  process.env.GP_DRY_RUN = orchestratorArgs.dryRun ? "true" : "false"
  process.env.GP_INSTANCE_ID = orchestratorArgs.instanceId
  process.env.GP_MARKET_ID = orchestratorArgs.marketId

  try {
    return await action()
  } finally {
    if (previous.GP_CONFIG_ROOT === undefined) delete process.env.GP_CONFIG_ROOT
    else process.env.GP_CONFIG_ROOT = previous.GP_CONFIG_ROOT

    if (previous.GP_DRY_RUN === undefined) delete process.env.GP_DRY_RUN
    else process.env.GP_DRY_RUN = previous.GP_DRY_RUN

    if (previous.GP_INSTANCE_ID === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = previous.GP_INSTANCE_ID

    if (previous.GP_MARKET_ID === undefined) delete process.env.GP_MARKET_ID
    else process.env.GP_MARKET_ID = previous.GP_MARKET_ID
  }
}

async function invokeStageEntrypoint(
  entrypoint: (ctx: ExecArgs) => Promise<void>,
  container: any,
  args: string[]
): Promise<void> {
  const previousExitCode = process.exitCode

  try {
    process.exitCode = undefined
    await entrypoint({ container, args })
  } finally {
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
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const productModuleService = resolveProductModuleService(container)
  const lock = await acquireAdvisoryLock(db, ADVISORY_LOCK_ID)

  if (!lock) {
    console.warn("Sync already in progress")
    return
  }

  const stageArgs = buildStageArgs(orchestratorArgs)
  const warnings: string[] = []

  try {
    const changedEntityIds = await collectChangedEntityIds(orchestratorArgs)
    const stageDefinitions = [
      {
        name: "sync-catalog",
        required: true,
        execute: async () => {
          if (orchestratorArgs.dryRun) {
            return previewCatalogStage(orchestratorArgs)
          }

          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncCatalog, container, stageArgs)
          })
          return "catalog sync completed"
        },
      },
      {
        name: "sync-vendors",
        required: true,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncVendors, container, stageArgs)
          })
          return orchestratorArgs.dryRun ? "vendor dry-run completed" : "vendor sync completed"
        },
      },
      {
        name: "sync-blog",
        required: false,
        execute: async () => {
          await withStageEnv(orchestratorArgs, async () => {
            await invokeStageEntrypoint(gpConfigSyncBlog, container, stageArgs)
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
      stages,
      health,
      changed_entity_ids: changedEntityIds,
      revalidate,
      slack,
      warnings,
      report_path: reportPath,
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