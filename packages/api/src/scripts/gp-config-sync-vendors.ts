import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  computeFieldDiffs,
  DryRunCollector,
  parseDryRunFlag,
  parseOverwriteFlag,
} from "./gp-sync-dry-run"

// ---- Types ----

type VendorLocation = {
  city?: string
  address?: string
  postal_code?: string
  country_code?: string
}

type VendorSeo = {
  meta_title?: string
  meta_description?: string
  [key: string]: unknown
}

type VendorSocialLinks = {
  instagram?: string
  facebook?: string
  tiktok?: string
  [key: string]: unknown
}

type VendorFixture = {
  vendor_id: string
  slug: string
  status?: string
  display_name?: string
  email?: string
  phone?: string
  tax_id?: string
  description?: string
  photo_url?: string
  gallery_urls?: string[]
  social_links?: VendorSocialLinks
  seo?: VendorSeo
  locations?: VendorLocation[]
}

type MarketConfig = {
  market_id: string
  vendors?: VendorFixture[]
}

export type SellerSyncResult = {
  sellerId: string | null
  action: "created" | "updated" | "skipped"
  note?: string
}

type SplDetail = {
  vendor_id: string
  fixture_id: string
  status: "created" | "skipped" | "missing_product"
  product_db_id?: string
  reason?: string
}

type SyncSummary = {
  ok: boolean
  instance_id: string
  market_id: string
  vendors: { created: number; updated: number; skipped: number }
  spl: { created: number; skipped: number; missing_products: number }
  stale_sellers: { inactivated: number; skipped: number }
  spl_details: SplDetail[]
  warnings: string[]
}

type DbLinkOutcome = "inserted" | "restored" | "exists"

type MarketProductFixture = {
  product_id?: string
  slug?: string
  handle?: string
}

type MarketProductsFile = {
  products?: MarketProductFixture[]
}

type VendorProductsFile = {
  products?: Array<{ product_id?: string }>
}

type MarketScopedSellerRow = {
  id: string
  handle: string | null
  store_status: string | null
}

// ---- Utilities ----

function formatDryRunNote(prefix: string, note?: string): string {
  return note ? `${prefix} (${note})` : prefix
}

function formatSeedDiffNote(
  currentValues: Record<string, unknown>,
  incomingValues: Record<string, unknown>
): string | undefined {
  const diffs = computeFieldDiffs(currentValues, incomingValues)
  if (diffs.length === 0) {
    return "seed_if_empty=no-op"
  }

  return diffs
    .map((diff) => `${diff.field}: ${diff.current} -> ${diff.incoming}`)
    .join("; ")
}

function parseArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
  overwrite: boolean
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")).trim()
  const dryRun = parseDryRunFlag(args)
  const overwrite = parseOverwriteFlag(args)

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, marketId, configRoot, dryRun, overwrite }
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid YAML document: ${filePath}`)
  }
  return doc as T
}

function resolveService(container: any, keysToTry: string[]): any {
  const errors: string[] = []
  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (e: any) {
      errors.push(`${key}: ${e?.message ?? String(e)}`)
    }
  }
  throw new Error(
    `Cannot resolve service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

function readSellerMarketId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const marketId = (value as { metadata?: { gp?: { market_id?: unknown } } }).metadata?.gp?.market_id
  return typeof marketId === "string" && marketId.trim() ? marketId.trim() : null
}

function selectSellerMatch(matches: any[], marketId: string): { match?: any; reason?: string } {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {}
  }

  const exactMatches = matches.filter((match) => readSellerMarketId(match) === marketId)
  if (exactMatches.length === 1) {
    return { match: exactMatches[0] }
  }

  if (exactMatches.length > 1) {
    return {
      reason: `multiple sellers found for market '${marketId}' and handle collision prevents safe update`,
    }
  }

  const untaggedMatches = matches.filter((match) => readSellerMarketId(match) === null)
  if (untaggedMatches.length === 1) {
    return { match: untaggedMatches[0] }
  }

  if (untaggedMatches.length > 1) {
    return {
      reason: "multiple untagged sellers found for the same handle; manual cleanup required",
    }
  }

  const knownMarkets = [...new Set(matches.map((match) => readSellerMarketId(match)).filter(Boolean))]
  return {
    reason:
      knownMarkets.length > 0
        ? `cross-market guard — entity belongs to '${knownMarkets.join(", ")}'`
        : "no eligible seller match found",
  }
}

function resolveProductListFn(productModuleService: any): (filters: any) => Promise<any[]> {
  return typeof productModuleService.listProducts === "function"
    ? (filters: any) => productModuleService.listProducts(filters)
    : (filters: any) => productModuleService.list(filters)
}

function buildSellerProductLinkId(sellerId: string, productId: string): string {
  const ts = Date.now().toString(36)
  const entropy = Math.random().toString(36).slice(2, 8)
  return `spl_${sellerId.slice(-8)}_${productId.slice(-8)}_${ts}_${entropy}`
}

async function upsertSellerProductLinkViaDb(
  db: any,
  sellerId: string,
  productId: string
): Promise<DbLinkOutcome> {
  const existing = await db("seller_seller_product_product")
    .where({ seller_id: sellerId, product_id: productId })
    .first()

  if (!existing) {
    await db("seller_seller_product_product").insert({
      id: buildSellerProductLinkId(sellerId, productId),
      seller_id: sellerId,
      product_id: productId,
    })
    return "inserted"
  }

  if (existing.deleted_at) {
    await db("seller_seller_product_product")
      .where({ id: existing.id })
      .update({ deleted_at: null })
    return "restored"
  }

  return "exists"
}

async function createSellerRecord(sellerModuleService: any, payload: Record<string, unknown>): Promise<any> {
  if (typeof sellerModuleService.create === "function") {
    return sellerModuleService.create(payload)
  }
  if (typeof sellerModuleService.createSeller === "function") {
    return sellerModuleService.createSeller(payload)
  }
  if (typeof sellerModuleService.createSellers === "function") {
    const created = await sellerModuleService.createSellers([payload])
    return Array.isArray(created) ? created[0] : created
  }

  throw new Error("Seller service does not expose a supported create method")
}

async function updateSellerRecord(
  sellerModuleService: any,
  id: string,
  payload: Record<string, unknown>
): Promise<any> {
  if (typeof sellerModuleService.update === "function") {
    return sellerModuleService.update(id, payload)
  }
  if (typeof sellerModuleService.updateSeller === "function") {
    return sellerModuleService.updateSeller(id, payload)
  }
  if (typeof sellerModuleService.updateSellers === "function") {
    const updated = await sellerModuleService.updateSellers([{ id, ...payload }])
    return Array.isArray(updated) ? updated[0] : updated
  }

  throw new Error("Seller service does not expose a supported update method")
}

async function resolveSalesChannelId(db: any, marketId: string): Promise<string | null> {
  const row = await db("sales_channel")
    .select("id")
    .whereRaw("metadata->>'gp_market_id' = ?", [marketId])
    .whereNull("deleted_at")
    .first<{ id: string }>()

  return row?.id ?? null
}

export async function inactivateStaleMarketSellers(
  sellerModuleService: any,
  db: any,
  salesChannelId: string,
  configuredVendorHandles: Set<string>,
  dryRun: boolean,
  collector?: DryRunCollector
): Promise<{ inactivated: number; skipped: number }> {
  const scopedSellers = await db("seller as seller")
    .distinct("seller.id", "seller.handle", "seller.store_status")
    .innerJoin("seller_seller_product_product as sspp", "seller.id", "sspp.seller_id")
    .innerJoin("product as product", "sspp.product_id", "product.id")
    .innerJoin("product_sales_channel as psc", "product.id", "psc.product_id")
    .where("psc.sales_channel_id", salesChannelId)
    .whereNull("seller.deleted_at")
    .whereNull("sspp.deleted_at")
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at")

  let inactivated = 0
  let skipped = 0

  for (const seller of scopedSellers as MarketScopedSellerRow[]) {
    const handle = seller.handle?.trim() ?? ""

    if (!handle || configuredVendorHandles.has(handle)) {
      continue
    }

    if (seller.store_status && seller.store_status !== "ACTIVE") {
      skipped++
      continue
    }

    if (dryRun) {
      collector?.add({
        entityType: "seller",
        handle,
        action: "update",
        note: "store_status=INACTIVE (missing from market config)",
      })
    } else {
      await updateSellerRecord(sellerModuleService, seller.id, { store_status: "INACTIVE" })
    }

    console.log(`Seller '${handle}': set to INACTIVE (missing from market config)`)
    inactivated++
  }

  return { inactivated, skipped }
}

export async function resolveProductByFixture(
  listProducts: (filters: any) => Promise<any[]>,
  fixtureId: string,
  fallbackHandle?: string
): Promise<{ product: any | null; strategy: "fixture" | "handle" | "none"; error?: string }> {
  try {
    const byFixture = (await listProducts({ metadata: { gp: { fixture_id: fixtureId } } })) ?? []
    if (byFixture[0]?.id) {
      return { product: byFixture[0], strategy: "fixture" }
    }
  } catch (e: any) {
    const message = e?.message ?? String(e)
    // Continue to fallback lookup when available.
    if (!fallbackHandle) {
      return { product: null, strategy: "none", error: `fixture lookup failed: ${message}` }
    }
  }

  if (!fallbackHandle) {
    return { product: null, strategy: "none" }
  }

  try {
    const byHandle = (await listProducts({ handle: fallbackHandle })) ?? []
    if (byHandle[0]?.id) {
      return { product: byHandle[0], strategy: "handle" }
    }
    return { product: null, strategy: "none", error: `handle lookup returned 0 rows for '${fallbackHandle}'` }
  } catch (e: any) {
    return {
      product: null,
      strategy: "none",
      error: `handle lookup failed for '${fallbackHandle}': ${e?.message ?? String(e)}`,
    }
  }
}

function vendorStatusToStoreStatus(status: string | undefined): string {
  switch (status) {
    case "onboarded":
    case "active":
      return "ACTIVE"
    case "suspended":
    case "inactive":
      return "SUSPENDED"
    default:
      return "ACTIVE"
  }
}

// ---- FR-56 seeded_fields logic ----

type SeedIfEmptyResult = {
  value: unknown
  shouldWrite: boolean
  isNewSeed: boolean
}

/** Deep equality for primitives and JSON-serialisable values (including arrays). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function resolveSeedIfEmpty(
  fieldName: string,
  configValue: unknown,
  dbValue: unknown,
  seededFields: string[],
  overwrite = false
): SeedIfEmptyResult {
  const isSeeded = seededFields.includes(fieldName)
  const dbEmpty = dbValue === null || dbValue === undefined || dbValue === ""

  if (overwrite) {
    return { value: configValue, shouldWrite: true, isNewSeed: !isSeeded }
  }

  if (isSeeded) {
    // Case 1: field tracked AND current DB == config value → apply (config changed, vendor still on config)
    // Case 2: field tracked AND current DB != config value → skip (vendor edited, preserve)
    if (deepEqual(dbValue, configValue)) {
      // values match → config wins (applies even if vendor "reverted")
      return { value: configValue, shouldWrite: true, isNewSeed: false }
    } else {
      // vendor edited → skip
      return { value: dbValue, shouldWrite: false, isNewSeed: false }
    }
  } else {
    // Case 3: field NOT tracked AND DB empty → seed + track
    // Case 4: field NOT tracked AND DB non-empty → treat as vendor-owned (never overwrite)
    if (dbEmpty) {
      return { value: configValue, shouldWrite: true, isNewSeed: true }
    } else {
      return { value: dbValue, shouldWrite: false, isNewSeed: false }
    }
  }
}

// ---- Core upsert logic ----

export async function upsertSeller(
  sellerModuleService: any,
  vendor: VendorFixture,
  dryRun: boolean,
  marketId: string,
  overwrite = false
): Promise<SellerSyncResult> {
  const handle = vendor.slug.trim()

  // Look up existing seller by handle
  let existingSellers: any[] = []
  if (typeof sellerModuleService.list === "function") {
    existingSellers = (await sellerModuleService.list({ handle })) ?? []
  } else if (typeof sellerModuleService.listSellers === "function") {
    existingSellers = (await sellerModuleService.listSellers({ handle })) ?? []
  }

  const { match: existingSeller, reason: matchReason } = selectSellerMatch(existingSellers, marketId)
  const storeStatus = vendorStatusToStoreStatus(vendor.status)

  if (matchReason) {
    return { sellerId: null, action: "skipped", note: matchReason }
  }

  if (!existingSeller) {
    // ---- CREATE: fresh vendor ----
    const seededFields: string[] = []
    const gpMetaSeeded: Record<string, unknown> = {}

    // seed_if_empty fields — all written on first create + tracked
    if (vendor.display_name !== undefined && vendor.display_name !== null) {
      gpMetaSeeded.name = vendor.display_name
      seededFields.push("name")
    }
    if (vendor.description !== undefined && vendor.description !== null) {
      gpMetaSeeded.description = vendor.description
      seededFields.push("description")
    }
    if (vendor.photo_url !== undefined && vendor.photo_url !== null) {
      gpMetaSeeded.photo_url = vendor.photo_url
      seededFields.push("photo_url")
    }
    if (vendor.gallery_urls !== undefined && vendor.gallery_urls !== null) {
      gpMetaSeeded.gallery = vendor.gallery_urls
      seededFields.push("gallery")
    }

    const gpMeta: Record<string, unknown> = {
      market_id: marketId,
      seeded_fields: seededFields,
      ...(vendor.social_links ? { social_links: vendor.social_links } : {}),
      ...(vendor.seo ? { seo: vendor.seo } : {}),
      ...(vendor.locations ? { locations: vendor.locations } : {}),
      ...gpMetaSeeded,
    }

    const createPayload: Record<string, unknown> = {
      handle,
      name: vendor.display_name ?? handle,
      email: vendor.email,
      phone: vendor.phone,
      tax_id: vendor.tax_id,
      store_status: storeStatus,
      metadata: { gp: gpMeta },
    }

    if (dryRun) {
      const note = seededFields.length > 0 ? `seed_if_empty=${seededFields.join(",")}` : undefined
      console.log(formatDryRunNote(`[dry-run] Would CREATE seller handle='${handle}'`, note))
      return { sellerId: `dry-run-${handle}`, action: "created", note }
    }

    const created = await createSellerRecord(sellerModuleService, createPayload)
    return { sellerId: created?.id ?? null, action: "created" }
  }

  // ---- UPDATE: existing seller ----
  const existingMetadata = (existingSeller.metadata ?? {}) as Record<string, unknown>
  const existingGp = (existingMetadata.gp ?? {}) as Record<string, unknown>
  const seededFields = Array.isArray(existingGp.seeded_fields)
    ? (existingGp.seeded_fields as string[])
    : []

  // config_wins fields — always overwrite (only include defined values to avoid clearing existing data)
  const configWinsPayload: Record<string, unknown> = { handle, store_status: storeStatus }
  if (vendor.email !== undefined) configWinsPayload.email = vendor.email
  if (vendor.phone !== undefined) configWinsPayload.phone = vendor.phone
  if (vendor.tax_id !== undefined) configWinsPayload.tax_id = vendor.tax_id

  // seed_if_empty fields — check ownership before writing
  const gpMetaUpdate: Record<string, unknown> = {
    market_id: marketId,
    // config_wins metadata fields
    ...(vendor.social_links !== undefined ? { social_links: vendor.social_links } : {}),
    ...(vendor.seo !== undefined ? { seo: vendor.seo } : {}),
    ...(vendor.locations !== undefined ? { locations: vendor.locations } : {}),
  }

  const newlySeededFields: string[] = []

  // name
  if (vendor.display_name !== undefined) {
    const r = resolveSeedIfEmpty(
      "name",
      vendor.display_name,
      existingGp.name ?? existingSeller.name,
      seededFields,
      overwrite
    )
    if (r.shouldWrite) {
      gpMetaUpdate.name = r.value
      if (r.isNewSeed) newlySeededFields.push("name")
    }
  }

  // description
  if (vendor.description !== undefined) {
    const r = resolveSeedIfEmpty(
      "description",
      vendor.description,
      existingGp.description ?? existingSeller.description,
      seededFields,
      overwrite
    )
    if (r.shouldWrite) {
      gpMetaUpdate.description = r.value
      if (r.isNewSeed) newlySeededFields.push("description")
    }
  }

  // photo_url
  if (vendor.photo_url !== undefined) {
    const r = resolveSeedIfEmpty(
      "photo_url",
      vendor.photo_url,
      existingGp.photo_url,
      seededFields,
      overwrite
    )
    if (r.shouldWrite) {
      gpMetaUpdate.photo_url = r.value
      if (r.isNewSeed) newlySeededFields.push("photo_url")
    }
  }

  // gallery
  if (vendor.gallery_urls !== undefined) {
    const r = resolveSeedIfEmpty(
      "gallery",
      vendor.gallery_urls,
      existingGp.gallery,
      seededFields,
      overwrite
    )
    if (r.shouldWrite) {
      gpMetaUpdate.gallery = r.value
      if (r.isNewSeed) newlySeededFields.push("gallery")
    }
  }

  const updatedSeededFields = [...seededFields, ...newlySeededFields]
  gpMetaUpdate.seeded_fields = updatedSeededFields

  const updatePayload: Record<string, unknown> = {
    ...configWinsPayload,
    metadata: {
      ...existingMetadata,
      gp: {
        ...existingGp,
        ...gpMetaUpdate,
      },
    },
  }

  if (dryRun) {
    const currentSeedValues: Record<string, unknown> = {}
    const incomingSeedValues: Record<string, unknown> = {}

    if (vendor.display_name !== undefined) {
      currentSeedValues.name = existingGp.name ?? existingSeller.name
      incomingSeedValues.name = vendor.display_name
    }
    if (vendor.description !== undefined) {
      currentSeedValues.description = existingGp.description ?? existingSeller.description
      incomingSeedValues.description = vendor.description
    }
    if (vendor.photo_url !== undefined) {
      currentSeedValues.photo_url = existingGp.photo_url
      incomingSeedValues.photo_url = vendor.photo_url
    }
    if (vendor.gallery_urls !== undefined) {
      currentSeedValues.gallery = existingGp.gallery
      incomingSeedValues.gallery = vendor.gallery_urls
    }

    const note = formatSeedDiffNote(currentSeedValues, incomingSeedValues)
    console.log(
      formatDryRunNote(
        `[dry-run] Would UPDATE seller handle='${handle}' id='${existingSeller.id}'`,
        note
      )
    )
    return { sellerId: existingSeller.id, action: "updated", note }
  }

  await updateSellerRecord(sellerModuleService, existingSeller.id, updatePayload)
  return { sellerId: existingSeller.id, action: "updated" }
}

// ---- Default export: Medusa script entrypoint ----

export default async function gpConfigSyncVendors({ container, args }: ExecArgs) {
  const { instanceId, marketId, configRoot, dryRun, overwrite } = parseArgs(args)
  const collector = dryRun ? new DryRunCollector() : undefined

  const marketYamlPath = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "market.yaml"
  )

  const marketConfig = await readYamlFile<MarketConfig>(marketYamlPath)
  if (marketConfig.market_id !== marketId) {
    throw new Error(
      `market_id mismatch in ${marketYamlPath}: expected '${marketId}', got '${marketConfig.market_id}'`
    )
  }

  const marketProductsPath = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "products.yaml"
  )

  const fixtureToHandle = new Map<string, string>()
  try {
    const marketProducts = await readYamlFile<MarketProductsFile>(marketProductsPath)
    for (const p of marketProducts.products ?? []) {
      const fixtureId = (p.product_id ?? "").trim()
      const candidate = (p.slug ?? p.handle ?? "").trim()
      if (fixtureId && candidate) {
        fixtureToHandle.set(fixtureId, candidate)
      }
    }
  } catch {
    // Optional optimization-only mapping. Keep flow running without this file.
  }

  const sellerModuleService = resolveService(container, [
    "seller",
    "sellerModuleService",
    "seller_module",
    "ISellerModuleService",
  ])

  const productModuleService = resolveService(container, [
    "product",
    "productModuleService",
    "product_module",
  ])
  const productListFn = resolveProductListFn(productModuleService)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  let splService: any = null
  let splServiceResolveError: string | null = null
  if (!dryRun) {
    try {
      splService = resolveService(container, [
        "sellerProductLink",
        "seller_product_link",
        "ISellerProductLinkService",
      ])
    } catch (e: any) {
      splServiceResolveError = e?.message ?? String(e)
    }
  }

  const warnings: string[] = []
  const vendorCounts = { created: 0, updated: 0, skipped: 0 }
  const splCounts = { created: 0, skipped: 0, missing_products: 0 }
  const staleSellerCounts = { inactivated: 0, skipped: 0 }
  const splDetails: SplDetail[] = []

  const vendors = marketConfig.vendors ?? []
  if (vendors.length === 0) {
    warnings.push(`No vendors found in market config for market_id='${marketId}'`)
  }

  for (const vendor of vendors) {
    if (!vendor.slug) {
      warnings.push(`Vendor '${vendor.vendor_id}': missing slug; skipping`)
      collector?.add({
        entityType: "seller",
        handle: vendor.vendor_id,
        action: "skip",
        note: "missing slug",
      })
      vendorCounts.skipped++
      continue
    }

    try {
      const result = await upsertSeller(sellerModuleService, vendor, dryRun, marketId, overwrite)

      if (result.action === "created") vendorCounts.created++
      else if (result.action === "updated") vendorCounts.updated++
      else vendorCounts.skipped++

      if (dryRun && collector) {
        collector.add({
          entityType: "seller",
          handle: vendor.slug.trim(),
          action:
            result.action === "created"
              ? "create"
              : result.action === "updated"
                ? "update"
                : "skip",
          note: result.note,
        })
      }

      // SellerProductLink sync — skip for suspended vendors
      const isSuspended = vendorStatusToStoreStatus(vendor.status) === "SUSPENDED"
      if (isSuspended) {
        warnings.push(`Vendor '${vendor.vendor_id}': suspended; skipping seller-product linking`)
      }

      if (!result.sellerId) {
        warnings.push(`Vendor '${vendor.vendor_id}': missing sellerId after upsert; skipping seller-product linking`)
      }

      if (!isSuspended && result.sellerId) {
        const vendorProductsPath = path.resolve(
          configRoot,
          instanceId,
          "markets",
          marketId,
          "vendors",
          vendor.vendor_id,
          "products.yaml"
        )

        let vendorProducts: VendorProductsFile = {}
        try {
          vendorProducts = await readYamlFile(vendorProductsPath)
        } catch (e: any) {
          warnings.push(
            `Vendor '${vendor.vendor_id}': cannot read products.yaml for linking (${e?.message ?? String(e)})`
          )
          // Keep flow running so other vendors can still sync.
        }

        for (const vp of vendorProducts.products ?? []) {
          const fixtureId = (vp.product_id ?? "").trim()
          if (!fixtureId) {
            warnings.push(`Vendor '${vendor.vendor_id}': product row with empty product_id; skipping SPL`)
            splCounts.skipped++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: "",
              status: "skipped",
              reason: "missing product_id",
            })
            continue
          }

          const fallbackHandle = fixtureToHandle.get(fixtureId)
          const resolved = await resolveProductByFixture(productListFn, fixtureId, fallbackHandle)
          const product = resolved.product
          if (!product?.id) {
            const reason = resolved.error ?? "not found by fixture_id and fallback handle"
            warnings.push(
              `Vendor '${vendor.vendor_id}': product fixture_id='${fixtureId}' not found in DB; skipping SPL (${reason})`
            )
            splCounts.missing_products++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "missing_product",
              reason,
            })
            continue
          }

          if (resolved.strategy === "handle") {
            warnings.push(
              `Vendor '${vendor.vendor_id}': linked fixture_id='${fixtureId}' using fallback handle='${fallbackHandle}'`
            )
          }

          // Upsert SellerProductLink
          if (dryRun) {
            collector?.add({
              entityType: "seller-product-link",
              handle: fixtureId,
              action: "create",
              note: `seller=${result.sellerId}; product=${product.id}`,
            })
            splCounts.created++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "created",
              product_db_id: product.id,
              reason: resolved.strategy === "handle" ? "fallback handle" : "fixture_id",
            })
            continue
          }

          if (splServiceResolveError || !splService) {
            const reason = `seller-product-link service unavailable: ${splServiceResolveError ?? "unknown"}`
            try {
              const outcome = await upsertSellerProductLinkViaDb(db, result.sellerId, product.id)
              splCounts.created++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "created",
                product_db_id: product.id,
                reason: `db-fallback:${outcome}`,
              })
              warnings.push(
                `Vendor '${vendor.vendor_id}': ${reason}; linked via DB fallback (${outcome})`
              )
            } catch (dbError: any) {
              const dbReason = dbError?.message ?? String(dbError)
              warnings.push(`Vendor '${vendor.vendor_id}': ${reason}; DB fallback failed - ${dbReason}`)
              splCounts.skipped++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "skipped",
                product_db_id: product.id,
                reason: `service-unavailable + db-fallback-failed: ${dbReason}`,
              })
            }
            continue
          }

          try {
            await splService.upsert({ seller_id: result.sellerId, product_id: product.id })
            splCounts.created++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "created",
              product_db_id: product.id,
              reason: resolved.strategy === "handle" ? "fallback handle" : "fixture_id",
            })
          } catch (e: any) {
            const reason = e?.message ?? String(e)
            try {
              const outcome = await upsertSellerProductLinkViaDb(db, result.sellerId, product.id)
              splCounts.created++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "created",
                product_db_id: product.id,
                reason: `service-upsert-failed + db-fallback:${outcome}`,
              })
              warnings.push(
                `Vendor '${vendor.vendor_id}': seller-product upsert failed for fixture_id='${fixtureId}' (product='${product.id}') - ${reason}; linked via DB fallback (${outcome})`
              )
            } catch (dbError: any) {
              const dbReason = dbError?.message ?? String(dbError)
              warnings.push(
                `Vendor '${vendor.vendor_id}': seller-product upsert failed for fixture_id='${fixtureId}' (product='${product.id}') - ${reason}; DB fallback failed - ${dbReason}`
              )
              splCounts.skipped++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "skipped",
                product_db_id: product.id,
                reason: `${reason}; db-fallback-failed: ${dbReason}`,
              })
            }
          }
        }
      }
    } catch (err: any) {
      warnings.push(`Vendor '${vendor.vendor_id}': ${err?.message ?? String(err)}`)
      vendorCounts.skipped++
    }
  }

  const configuredVendorHandles = new Set(
    vendors
      .map((vendor) => vendor.slug?.trim())
      .filter((handle): handle is string => Boolean(handle))
  )

  if (configuredVendorHandles.size > 0) {
    const salesChannelId = await resolveSalesChannelId(db, marketId)

    if (salesChannelId) {
      try {
        const staleSync = await inactivateStaleMarketSellers(
          sellerModuleService,
          db,
          salesChannelId,
          configuredVendorHandles,
          dryRun,
          collector
        )
        staleSellerCounts.inactivated = staleSync.inactivated
        staleSellerCounts.skipped = staleSync.skipped
      } catch (err: any) {
        warnings.push(`Stale seller cleanup failed — ${err?.message ?? String(err)}`)
      }
    }
  }

  const summary: SyncSummary = {
    ok: warnings.length === 0,
    instance_id: instanceId,
    market_id: marketId,
    vendors: vendorCounts,
    spl: splCounts,
    stale_sellers: staleSellerCounts,
    spl_details: splDetails,
    warnings,
  }

  if (dryRun && collector) {
    console.log(collector.renderTable())
  }

  console.log(JSON.stringify(summary, null, 2))

  if (warnings.length > 0 && !dryRun) {
    process.exitCode = 1
  }
}
