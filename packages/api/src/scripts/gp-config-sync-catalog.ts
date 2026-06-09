/**
 * gp-config-sync-catalog.ts — catalog sync from gp-config to backend (v1.5.0).
 *
 * Story v160-1-7.1: catalog sync reads Mercur 2 native `seller.status`
 * values. Legacy gp-config status names are normalized by
 * `gp-config-sync-vendors.ts` before catalog linking runs.
 */
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createProductsWorkflow, linkProductsToSalesChannelWorkflow, upsertVariantPricesWorkflow } from "@medusajs/core-flows"

import fs from "node:fs/promises"
import * as fsSync from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import { DryRunCollector, parseDryRunFlag } from "./gp-sync-dry-run"

// ---- Types ----

type FixtureCollection = {
  collection_id: string
  title: string
  handle: string
  active?: boolean
}

type FixtureCategory = {
  category_id: string
  name: string
  slug?: string
  handle?: string
  active?: boolean
  visibility?: string
  rank?: number
  parent_category_id?: string | null
  description?: string
}

type FixtureProduct = {
  product_id: string
  category_id?: string
  collection_id?: string
  name: string
  subtitle?: string
  slug?: string
  handle?: string
  status?: string
  discountable?: boolean
  base_price: { amount: number; currency: string }
  duration_minutes?: number | null
  description?: string
  photo_url?: string
  seo?: {
    meta_title?: string
    meta_description?: string
    og_image_url?: string
  }
  sort_rank?: number
  validity_period?: string
  regulatory_class?: string
  tags?: string[]
  active?: boolean
  // v1.8.0 Story 1.10.1 — opcjonalny cross-ref do market.yaml
  // entitlement_profiles[].profile_id (ADR-099 Layer 3). Sync writes the
  // resolved embedded profile to `product.metadata.gp.entitlement_profile`
  // so storefront cart can echo the triad to line_item.metadata (resolver
  // short-circuit at GP/backend voucher issue-entitlement.ts:123-128).
  entitlement_profile_id?: string
}

// v1.8.0 Story 1.10.1 — Layer 3 entitlement_profile structure from market.yaml.
// Loaded once per sync run and looked up by `entitlement_profile_id` to enrich
// product.metadata. Mirrors the canonical schema at
// specs/contracts/config/schemas/market-config.v1.schema.json (entitlement_profiles).
type EntitlementProfileFixture = {
  profile_id: string
  display_name?: string
  entitlement_type: string
  policy: Record<string, unknown>
}

type MarketConfigWithEntitlements = {
  market_id: string
  vendors?: Array<Record<string, unknown>>
  entitlement_profiles?: EntitlementProfileFixture[]
}

/**
 * Embedded form persisted on `product.metadata.gp.entitlement_profile`.
 * Shape MUST match `EntitlementProfilePayload` in
 * GP/backend voucher issue-entitlement.ts so the storefront cart echo
 * satisfies `resolveEntitlementProfile()` short-circuit without DB scan.
 */
type EmbeddedEntitlementProfile = {
  profile_id: string
  entitlement_type: string
  policy: Record<string, unknown>
  currency?: string
}

type CatalogFixture = {
  market_id: string
  version?: string
  collections?: FixtureCollection[]
  categories?: FixtureCategory[]
  products?: FixtureProduct[]
}

type OpCounts = { created: number; updated: number; skipped: number }

type Prerequisites = {
  salesChannelId: string
  shippingProfileId: string
}

export function buildProductGpMetadata(
  product: FixtureProduct,
  marketId: string,
  hasVendorPricing: boolean,
  entitlementProfile?: EmbeddedEntitlementProfile
): Record<string, any> {
  const metadata: Record<string, any> = {
    synced_by: "gp-config-sync-catalog",
    market_id: marketId,
    fixture_id: product.product_id,
    has_vendor_pricing: hasVendorPricing,
  }

  if (product.subtitle !== undefined) metadata.subtitle = product.subtitle
  if (Object.prototype.hasOwnProperty.call(product, "duration_minutes")) {
    metadata.duration_minutes = product.duration_minutes ?? null
  }
  if (product.seo !== undefined) metadata.seo = product.seo
  if (product.sort_rank !== undefined) metadata.sort_rank = product.sort_rank
  if (product.validity_period !== undefined) metadata.validity_period = product.validity_period
  if (product.regulatory_class !== undefined) metadata.regulatory_class = product.regulatory_class
  if (product.entitlement_profile_id !== undefined) {
    metadata.entitlement_profile_id = product.entitlement_profile_id
  }
  if (entitlementProfile) {
    metadata.entitlement_profile = entitlementProfile
  }

  return metadata
}

// ---- Utilities (pattern from gp-config-sync-media) ----

const DEFAULT_WARNING_THRESHOLD = 3
const DEFAULT_SUMMARY_PATH = "_grow/output/sync-catalog-last-run.json"

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings))
}

function resolveProjectRoot(start: string): string {
  let current = path.resolve(start)

  while (true) {
    if (
      fsSyncExists(path.join(current, "_grow")) ||
      fsSyncExists(path.join(current, "specs"))
    ) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(start)
    }
    current = parent
  }
}

function fsSyncExists(candidate: string): boolean {
  try {
    return fsSync.existsSync(candidate)
  } catch {
    return false
  }
}

function normalizeCountryCode(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase()
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function resolveSummaryPath(): string {
  return path.resolve(
    process.env.GP_SYNC_CATALOG_SUMMARY ??
      path.join(resolveProjectRoot(process.cwd()), DEFAULT_SUMMARY_PATH)
  )
}

export function parseArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()
  const dryRun = parseDryRunFlag(args)

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, marketId, configRoot, dryRun }
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

export function normalizeHandle(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (ł→l, ó→o, ż→z etc.)
    .replace(/\u0142/g, "l")         // ł is not a combining char — handle explicitly
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")   // collapse consecutive hyphens
    .replace(/^-|-$/g, "")    // trim leading/trailing hyphens
}

async function listAll(service: any, methodNames: string[], query: object = {}): Promise<any[]> {
  let lastError: Error | null = null
  for (const name of methodNames) {
    if (typeof service[name] !== "function") continue
    try {
      const result = await service[name](query)
      if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
      if (Array.isArray(result)) return result
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e))
      continue
    }
  }
  if (lastError) throw lastError
  return []
}

function readGpMarketId(entity: any): string | null {
  const marketId = entity?.metadata?.gp?.market_id
  return typeof marketId === "string" && marketId.trim() ? marketId.trim() : null
}

function normalizeProductTagValue(tag: string): string {
  return tag.trim()
}

async function resolveProductTagIdMap(
  productModuleService: any,
  products: FixtureProduct[],
  marketId: string,
  warnings: string[],
  collector?: DryRunCollector
): Promise<Map<string, string>> {
  const uniqueTagValues = Array.from(
    new Set(
      products
        .flatMap((product) => product.tags ?? [])
        .map(normalizeProductTagValue)
        .filter(Boolean)
    )
  )

  if (uniqueTagValues.length === 0) {
    return new Map()
  }

  const existingTags = await productModuleService.listProductTags(
    { value: uniqueTagValues },
    { take: null }
  )

  const tagsByValue = new Map<string, any[]>()
  for (const tag of existingTags ?? []) {
    if (typeof tag?.value !== "string" || typeof tag?.id !== "string") continue
    const bucket = tagsByValue.get(tag.value) ?? []
    bucket.push(tag)
    tagsByValue.set(tag.value, bucket)
  }

  const tagIdMap = new Map<string, string>()
  const tagsToBackfill: Array<{ id: string; metadata: Record<string, any> }> = []
  const tagsToCreate: Array<{ value: string; metadata: Record<string, any> }> = []

  for (const tagValue of uniqueTagValues) {
    const matches = tagsByValue.get(tagValue) ?? []
    const exact = matches.filter((tag) => readGpMarketId(tag) === marketId)

    if (exact.length === 1) {
      tagIdMap.set(tagValue, exact[0].id)
      continue
    }

    if (exact.length > 1) {
      warnings.push(
        `Product tags: multiple tags found for value '${tagValue}' in market '${marketId}'`
      )
      continue
    }

    const untagged = matches.filter((tag) => readGpMarketId(tag) === null)
    if (untagged.length === 1) {
      const tag = untagged[0]
      const metadata = {
        ...(tag.metadata ?? {}),
        gp: {
          ...((tag.metadata as any)?.gp ?? {}),
          market_id: marketId,
        },
      }

      if (collector) {
        tagIdMap.set(tagValue, tag.id)
        collector.add({
          entityType: "product-tag",
          handle: tagValue,
          action: "update",
          note: `value=${tagValue}, market_id=${marketId}`,
        })
      } else {
        tagsToBackfill.push({ id: tag.id, metadata })
      }
      continue
    }

    if (untagged.length > 1) {
      warnings.push(
        `Product tags: multiple unscoped tags found for value '${tagValue}'`
      )
      continue
    }

    if (collector) {
      const dryRunId = `dry-run-tag-${normalizeHandle(tagValue || "tag")}`
      tagIdMap.set(tagValue, dryRunId)
      collector.add({
        entityType: "product-tag",
        handle: tagValue,
        action: "create",
        note: `value=${tagValue}, market_id=${marketId}`,
      })
      continue
    }

    tagsToCreate.push({
      value: tagValue,
      metadata: {
        gp: {
          market_id: marketId,
        },
      },
    })
  }

  if (!collector && tagsToBackfill.length > 0) {
    try {
      const updatedTags = await productModuleService.upsertProductTags(tagsToBackfill)
      for (const tag of Array.isArray(updatedTags) ? updatedTags : [updatedTags]) {
        if (typeof tag?.value === "string" && typeof tag?.id === "string") {
          tagIdMap.set(tag.value, tag.id)
        }
      }
    } catch (e: any) {
      warnings.push(
        `Product tags: update error — ${e?.message ?? String(e)}`
      )
    }
  }

  if (!collector && tagsToCreate.length > 0) {
    try {
      const createdTags = await productModuleService.createProductTags(tagsToCreate)

      for (const tag of Array.isArray(createdTags) ? createdTags : [createdTags]) {
        if (typeof tag?.value === "string" && typeof tag?.id === "string") {
          tagIdMap.set(tag.value, tag.id)
        }
      }
    } catch (e: any) {
      warnings.push(
        `Product tags: create error — ${e?.message ?? String(e)}`
      )
    }
  }

  return tagIdMap
}

function selectEntityMatch(
  matches: any[] | undefined,
  marketId: string
): { match?: any; reason?: string } {
  if (!Array.isArray(matches) || matches.length === 0) return {}
  if (matches.length === 1) {
    const m = matches[0]
    const owner = readGpMarketId(m)
    if (owner && owner !== marketId) {
      return { reason: `cross-market guard — entity belongs to '${owner}', skipping` }
    }
    return { match: m }
  }
  const exact = matches.filter((m) => readGpMarketId(m) === marketId)
  if (exact.length === 1) return { match: exact[0] }
  if (exact.length > 1) {
    return { reason: `multiple entities found for market '${marketId}' — handle collision` }
  }
  const untagged = matches.filter((m) => readGpMarketId(m) === null)
  if (untagged.length === 1) return { match: untagged[0] }
  if (untagged.length > 1) {
    return { reason: "multiple untagged entities for same handle; manual cleanup required" }
  }
  const owners = [...new Set(matches.map(readGpMarketId).filter(Boolean))]
  return { reason: `cross-market guard — entity belongs to '${owners.join(", ")}', skipping` }
}

// ---- Quality Gate ----

const MIN_DESCRIPTION_WORDS = 80

const PLACEHOLDER_PATTERNS = [
  /placeholder/i,
  /no-image/i,
  /default-product/i,
  /via\.placeholder\.com/i,
  /cdn\.example\.com/i,
]

export type QualityGateOptions = {
  vendorPricing?: boolean
}

export type QualityGateResult = {
  status: "published" | "draft"
  reasons: string[]
  details: { words: number; price: number; image: string }
}

export function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(url))
}

export function evaluateQualityGate(
  product: FixtureProduct,
  options?: QualityGateOptions
): QualityGateResult {
  const reasons: string[] = []

  const wordCount = (product.description ?? "").split(/\s+/).filter(Boolean).length
  if (wordCount < MIN_DESCRIPTION_WORDS) {
    reasons.push(`words=${wordCount} < ${MIN_DESCRIPTION_WORDS}`)
  }

  const price = product.base_price?.amount ?? 0
  if (price <= 0 && !options?.vendorPricing) {
    reasons.push(`price=${price} <= 0`)
  }

  const imageUrl = product.photo_url ?? ""
  if (!imageUrl) {
    reasons.push("image=missing")
  } else if (isPlaceholderUrl(imageUrl)) {
    reasons.push("image=placeholder")
  }

  const imageDetail = !imageUrl ? "missing" : isPlaceholderUrl(imageUrl) ? "placeholder" : "OK"

  return {
    status: reasons.length === 0 ? "published" : "draft",
    reasons,
    details: { words: wordCount, price, image: imageDetail },
  }
}

// ---- Vendor Pricing Lookup ----

type VendorProductEntry = {
  product_id: string
  vendor_price?: { amount: number; currency?: string }
  status?: string
}

type VendorProductFile = {
  vendor_id: string
  products?: VendorProductEntry[]
}

type VendorPricingEntry = {
  vendor_id: string
  amount: number
  currency?: string
}

export type VendorPricingInfo = {
  prices: VendorPricingEntry[]
}

export async function buildVendorPricingMap(
  marketConfigPath: string,
  warnings: string[],
  db?: any,
  marketIdForRuntime?: string
): Promise<Map<string, VendorPricingInfo>> {
  const map = new Map<string, VendorPricingInfo>()
  const marketDir = path.dirname(marketConfigPath)

  let marketConfig: MarketConfig
  try {
    marketConfig = await readYamlFile<MarketConfig>(marketConfigPath)
  } catch {
    return map
  }

  const vendors = marketConfig.vendors ?? []
  const runtimeStateMap =
    db && marketIdForRuntime
      ? await resolveVendorRuntimeStateMap(db, marketIdForRuntime, vendors, warnings)
      : new Map<string, { slug: string; store_status: string | null }>()

  // Aggregated drift signal (matches enforceVendorStatusGate semantics, F4): when runtime
  // lookup was attempted (db + marketId both provided) but some configured vendors with
  // slugs lack a runtime row, surface a single summary warning rather than spamming N
  // entries. Vendors without a slug are silent (legacy config path — already documented).
  if (db && marketIdForRuntime) {
    const slugged = vendors
      .map((v) => v.slug?.trim())
      .filter((s): s is string => Boolean(s))
    const missing = slugged.filter((slug) => !runtimeStateMap.has(slug))
    if (missing.length > 0) {
      warnings.push(
        `Vendor pricing: ${missing.length} of ${slugged.length} sellers with slug lack runtime row; ` +
          `falling back to config status (slugs: ${missing.join(", ")})`
      )
    }
  }

  const activeVendors = vendors.filter((vendor) => {
    const slug = vendor.slug?.trim() ?? ""
    const runtime = slug ? runtimeStateMap.get(slug) : undefined

    if (runtime) {
      return isRuntimeSellerActive(runtime.store_status)
    }

    return ACTIVE_VENDOR_STATUSES.has(vendor.status)
  })

  for (const vendor of activeVendors) {
    const vendorProductsPath = path.resolve(
      marketDir, "vendors", vendor.vendor_id, "products.yaml"
    )
    try {
      const vendorCatalog = await readYamlFile<VendorProductFile>(vendorProductsPath)
      for (const vp of vendorCatalog.products ?? []) {
        if (vp.product_id && vp.status !== "inactive" && (vp.vendor_price?.amount ?? 0) > 0) {
          const entry: VendorPricingEntry = {
            vendor_id: vendor.vendor_id,
            amount: vp.vendor_price!.amount,
            ...(vp.vendor_price?.currency
              ? { currency: vp.vendor_price.currency.toUpperCase() }
              : {}),
          }

          const existing = map.get(vp.product_id)
          if (existing) {
            existing.prices.push(entry)
          } else {
            map.set(vp.product_id, { prices: [entry] })
          }
        }
      }
    } catch {
      // Vendor product file missing — not an error, vendor may have no products yet
    }
  }

  return map
}

type CatalogPriceSource = "base_price" | "min_vendor_price"

function resolveCatalogPrice(
  product: FixtureProduct,
  vendorPricing: VendorPricingInfo | undefined,
  warnings: string[]
): { amount: number; currency: string; source: CatalogPriceSource } {
  const baseCurrency = product.base_price.currency.toUpperCase()

  if (!vendorPricing?.prices.length) {
    return {
      amount: product.base_price.amount,
      currency: baseCurrency,
      source: "base_price",
    }
  }

  const matchingCurrencyPrices = vendorPricing.prices.filter(
    (price) => (price.currency ?? baseCurrency).toUpperCase() === baseCurrency
  )
  const candidates = matchingCurrencyPrices.length > 0 ? matchingCurrencyPrices : vendorPricing.prices
  const selected = candidates.reduce((lowest, current) => {
    return current.amount < lowest.amount ? current : lowest
  })
  const selectedCurrency = (selected.currency ?? baseCurrency).toUpperCase()

  if (matchingCurrencyPrices.length === 0 && selected.currency && selectedCurrency !== baseCurrency) {
    warnings.push(
      `Product '${product.product_id}': vendor pricing currency '${selectedCurrency}' does not match base_price.currency '${baseCurrency}'; using vendor price currency`
    )
  }

  return {
    amount: selected.amount,
    currency: selectedCurrency,
    source: "min_vendor_price",
  }
}

// ---- Prerequisites ----

export async function validatePrerequisites(
  container: any,
  marketId: string,
  currency: string,
  warnings: string[],
  dryRun = false,
  countries: string[] = []
): Promise<Prerequisites> {
  // 1. Sales channel — fail-fast
  const salesChannelService = resolveService(container, [
    "sales_channel",
    "salesChannel",
    "sales-channel",
    "sales_channel_module",
    "salesChannelModuleService",
    "salesChannelService",
  ])

  const allChannels = await listAll(salesChannelService, [
    "listAndCountSalesChannels",
    "listSalesChannels",
    "listAndCount",
    "list",
  ])

  const matching = allChannels.filter(
    (ch: any) => (ch?.metadata as any)?.gp_market_id === marketId
  )
  if (matching.length === 0) {
    throw new Error(
      `Sales channel not found for market '${marketId}'. Run seed.ts first.`
    )
  }
  if (matching.length > 1) {
    throw new Error(
      `Multiple sales channels (${matching.length}) found for market '${marketId}'. Expected exactly 1.`
    )
  }
  const salesChannelId = matching[0].id as string

  // 2. Publishable key → sales channel link (best-effort warn)
  try {
    const apiKeyService = resolveService(container, [
      "api_key",
      "apiKey",
      "api_key_module",
      "apiKeyModuleService",
      "IApiKeyModuleService",
    ])
    const keys = await listAll(apiKeyService, ["listApiKeys", "list"], { type: "publishable" })
    if (keys.length === 0) {
      warnings.push(
        `No publishable API keys found for market '${marketId}'. Run gp-market-storefront-key first.`
      )
    }
  } catch {
    warnings.push(
      `Cannot verify publishable API key for market '${marketId}'. Ensure gp-market-storefront-key has been run.`
    )
  }

  // 3. Shipping profile — fail-fast
  const fulfillmentService = resolveService(container, [
    "fulfillment",
    "fulfillmentModuleService",
    "IFulfillmentModuleService",
    "fulfillment_module",
  ])

  const profiles = await listAll(fulfillmentService, [
    "listShippingProfiles",
    "listAndCountShippingProfiles",
    "list",
  ])
  if (profiles.length === 0) {
    throw new Error(
      "No shipping profiles found. Ensure Medusa has been bootstrapped (medusa db:migrate)."
    )
  }
  const shippingProfileId = profiles[0].id as string

  // 4. Stock location — warn only
  try {
    const stockService = resolveService(container, [
      "stock_location",
      "stockLocation",
      "stock_location_module",
      "IStockLocationModuleService",
    ])
    const locations = await listAll(stockService, ["listStockLocations", "list"])
    if (locations.length === 0) {
      warnings.push(
        "No stock locations found. Service-type products may not require inventory tracking."
      )
    }
  } catch {
    warnings.push(
      "Cannot verify stock locations. Service-type products may not require inventory tracking."
    )
  }

  // 5. Region with matching currency — fail-fast
  const regionService = resolveService(container, [
    "region",
    "regionModuleService",
    "IRegionModuleService",
    "region_module",
  ])

  const allRegions = await listAll(regionService, ["listRegions", "list"])
  const upperCurrency = currency.toUpperCase()
  const matchingRegions = allRegions.filter(
    (r: any) => (r?.currency_code ?? "").toUpperCase() === upperCurrency
  )
  if (matchingRegions.length === 0) {
    if (dryRun) {
      warnings.push(
        `No region found with currency_code '${currency}'. Dry-run continues; real seed must create or bootstrap this region first.`
      )
      return { salesChannelId, shippingProfileId }
    }

    const createFnName = ["createRegions", "createRegion", "create"].find(
      (name) => typeof regionService?.[name] === "function"
    )
    if (!createFnName) {
      throw new Error(
        `No region found with currency_code '${currency}' and region service cannot create regions. ` +
          `Ensure a region with currency '${currency}' exists in Medusa Admin or seed.`
      )
    }

    const assignedCountries = new Set<string>(
      allRegions.flatMap((region: any) =>
        Array.isArray(region?.countries)
          ? region.countries.map((country: any) =>
              normalizeCountryCode(typeof country === "string" ? country : country?.iso_2)
            )
          : []
      )
    )
    try {
      const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
      const result = await db.raw(
        `
          SELECT DISTINCT lower(iso_2) AS iso_2
          FROM region_country
          WHERE deleted_at IS NULL
        `
      )
      const rows = Array.isArray(result?.rows) ? result.rows : Array.isArray(result) ? result : []
      for (const row of rows) {
        const country = normalizeCountryCode(row?.iso_2)
        if (country) assignedCountries.add(country)
      }
    } catch {
      // Region service data above is the fallback in non-DB contexts.
    }
    const normalizedCountries = uniq(countries.map(normalizeCountryCode))
      .filter((country) => !assignedCountries.has(country))
    const regionName = upperCurrency === "EUR"
      ? "Europe"
      : normalizedCountries.length === 1
        ? `${normalizedCountries[0].toUpperCase()} ${upperCurrency}`
        : `${upperCurrency} Market Region`

    await regionService[createFnName]({
      name: regionName,
      currency_code: currency.toLowerCase(),
      countries: normalizedCountries,
      automatic_taxes: true,
      metadata: {
        gp_seeded_by: "gp-config-sync-catalog",
        gp_market_id: marketId,
        gp_seed_region: `${currency.toLowerCase()}/${normalizedCountries.join(",") || "global"}`,
      },
    })

    warnings.push(
      `Created missing region '${regionName}' for currency '${currency}' before catalog sync.`
    )
  }

  return { salesChannelId, shippingProfileId }
}

// ---- Category Sync (two-pass) ----

export async function syncCategories(
  productModuleService: any,
  categories: FixtureCategory[],
  marketId: string,
  warnings: string[],
  collector?: DryRunCollector
): Promise<{ counts: OpCounts; fixtureToMedusaMap: Map<string, string> }> {
  const counts: OpCounts = { created: 0, updated: 0, skipped: 0 }
  const fixtureToMedusaMap = new Map<string, string>()

  const active = categories.filter((c) => c.active !== false)

  // Pre-validate: unique handles in fixture
  const handleSet = new Set<string>()
  const skipCategoryIds = new Set<string>()
  for (const cat of active) {
    const h = normalizeHandle((cat.handle ?? cat.slug ?? "").trim())
    if (!h) continue
    if (handleSet.has(h)) {
      warnings.push(
        `Category '${cat.category_id}': duplicate handle '${h}' in fixture, second occurrence skipped`
      )
      collector?.add({
        entityType: "category",
        handle: h || cat.category_id,
        action: "skip",
        note: `duplicate handle in fixture (${cat.category_id})`,
      })
      skipCategoryIds.add(cat.category_id)
    }
    handleSet.add(h)
  }

  // Pre-validate: parent references exist in fixture
  const fixtureIdSet = new Set(active.map((c) => c.category_id))
  for (const cat of active) {
    if (cat.parent_category_id && !fixtureIdSet.has(cat.parent_category_id)) {
      warnings.push(
        `Category '${cat.category_id}': parent_category_id '${cat.parent_category_id}' not found in fixture`
      )
    }
  }

  console.log(`Syncing categories (${active.length} active)...`)

  // Pass 1: create/update flat (no parent hierarchy)
  for (const cat of active) {
    const handle = normalizeHandle((cat.handle ?? cat.slug ?? "").trim())
    if (!handle) {
      warnings.push(`Category '${cat.category_id}': missing handle/slug, skipping`)
      collector?.add({
        entityType: "category",
        handle: cat.category_id,
        action: "skip",
        note: "missing handle/slug",
      })
      continue
    }

    if (skipCategoryIds.has(cat.category_id)) {
      collector?.add({
        entityType: "category",
        handle,
        action: "skip",
        note: `duplicate handle in fixture (${cat.category_id})`,
      })
      counts.skipped++
      continue
    }

    try {
      const matches = await productModuleService.listProductCategories(
        { handle },
        { select: ["id", "handle", "name", "description", "rank", "metadata"] }
      )
      const { match: existing, reason: matchReason } = selectEntityMatch(matches, marketId)

      if (matchReason) {
        warnings.push(`Category '${cat.category_id}' handle='${handle}': ${matchReason}`)
        collector?.add({
          entityType: "category",
          handle,
          action: "skip",
          note: matchReason,
        })
        counts.skipped++
        continue
      }

      if (existing) {
        // H-1: explicit field update — updateProductCategories(id, data)
        // Safe hierarchical merge: preserves top-level metadata keys (e.g. photo_url)
        // while adding/updating gp sub-object. Requires metadata to be fetched via select.
        if (collector) {
          collector.add({
            entityType: "category",
            handle,
            action: "update",
            note: `fixture_id=${cat.category_id}`,
          })
        } else {
          await productModuleService.updateProductCategories(existing.id, {
            name: cat.name,
            description: cat.description ?? existing.description,
            is_active: true,
            rank: cat.rank ?? existing.rank ?? 0,
            metadata: {
              ...(existing.metadata ?? {}),
              gp: {
                ...((existing.metadata as any)?.gp ?? {}),
                synced_by: "gp-config-sync-catalog",
                market_id: marketId,
                fixture_id: cat.category_id,
              },
            },
          })
        }
        fixtureToMedusaMap.set(cat.category_id, existing.id)
        counts.updated++
      } else {
        let createdId: string | undefined
        if (collector) {
          collector.add({
            entityType: "category",
            handle,
            action: "create",
            note: `fixture_id=${cat.category_id}`,
          })
          createdId = `dry-run-category-${cat.category_id}`
        } else {
          const created = await productModuleService.createProductCategories({
            name: cat.name,
            handle,
            description: cat.description,
            is_active: true,
            is_internal: false,
            rank: cat.rank ?? 0,
            metadata: {
              gp: {
                synced_by: "gp-config-sync-catalog",
                market_id: marketId,
                fixture_id: cat.category_id,
              },
            },
          })
          createdId = (
            Array.isArray(created) ? created[0]?.id : created?.id
          ) as string | undefined
        }
        if (createdId) {
          fixtureToMedusaMap.set(cat.category_id, createdId)
        }
        counts.created++
      }
    } catch (e: any) {
      warnings.push(`Category '${cat.category_id}': error — ${e?.message ?? String(e)}`)
    }
  }

  // Pass 2: update parent_category_id
  for (const cat of active) {
    if (!cat.parent_category_id) continue

    const medusaId = fixtureToMedusaMap.get(cat.category_id)
    if (!medusaId) continue // skipped/failed in pass 1

    const parentMedusaId = fixtureToMedusaMap.get(cat.parent_category_id)
    if (!parentMedusaId) {
      warnings.push(
        `Category '${cat.category_id}': parent '${cat.parent_category_id}' not in Medusa map, keeping as root`
      )
      continue
    }

    try {
      if (collector) {
        collector.add({
          entityType: "category-parent",
          handle: cat.category_id,
          action: "update",
          note: `parent_category_id=${cat.parent_category_id}`,
        })
      } else {
        await productModuleService.updateProductCategories(medusaId, {
          parent_category_id: parentMedusaId,
        })
      }
    } catch (e: any) {
      warnings.push(
        `Category '${cat.category_id}' parent update: ${e?.message ?? String(e)}`
      )
    }
  }

  console.log(
    `Categories: created=${counts.created}, updated=${counts.updated}, skipped=${counts.skipped}`
  )
  return { counts, fixtureToMedusaMap }
}

// ---- Collection Sync ----

export async function syncCollections(
  productModuleService: any,
  collections: FixtureCollection[],
  marketId: string,
  warnings: string[],
  collector?: DryRunCollector
): Promise<{ counts: OpCounts; fixtureToMedusaMap: Map<string, string> }> {
  const counts: OpCounts = { created: 0, updated: 0, skipped: 0 }
  const fixtureToMedusaMap = new Map<string, string>()

  const active = collections.filter((c) => c.active !== false)

  console.log(`Syncing collections (${active.length} active)...`)

  for (const col of active) {
    const handle = normalizeHandle((col.handle ?? "").trim())
    if (!handle) {
      warnings.push(`Collection '${col.collection_id}': missing handle, skipping`)
      collector?.add({
        entityType: "collection",
        handle: col.collection_id,
        action: "skip",
        note: "missing handle",
      })
      continue
    }

    try {
      const matches = await productModuleService.listProductCollections({ handle })
      const { match: existing, reason: matchReason } = selectEntityMatch(matches, marketId)

      if (matchReason) {
        warnings.push(`Collection '${col.collection_id}' handle='${handle}': ${matchReason}`)
        collector?.add({
          entityType: "collection",
          handle,
          action: "skip",
          note: matchReason,
        })
        counts.skipped++
        continue
      }

      if (existing) {
        // H-1: explicit field update (no product_ids — managed via products)
        if (collector) {
          collector.add({
            entityType: "collection",
            handle,
            action: "update",
            note: `fixture_id=${col.collection_id}`,
          })
        } else {
          await productModuleService.updateProductCollections(existing.id, {
            title: col.title,
            metadata: {
              ...(existing.metadata ?? {}),
              gp: {
                ...((existing.metadata as any)?.gp ?? {}),
                synced_by: "gp-config-sync-catalog",
                market_id: marketId,
                fixture_id: col.collection_id,
              },
            },
          })
        }
        fixtureToMedusaMap.set(col.collection_id, existing.id)
        counts.updated++
      } else {
        let createdId: string | undefined
        if (collector) {
          collector.add({
            entityType: "collection",
            handle,
            action: "create",
            note: `fixture_id=${col.collection_id}`,
          })
          createdId = `dry-run-collection-${col.collection_id}`
        } else {
          const created = await productModuleService.createProductCollections({
            title: col.title,
            handle,
            metadata: {
              gp: {
                synced_by: "gp-config-sync-catalog",
                market_id: marketId,
                fixture_id: col.collection_id,
              },
            },
          })
          createdId = (created?.id ?? created?.[0]?.id) as string | undefined
        }
        if (createdId) {
          fixtureToMedusaMap.set(col.collection_id, createdId)
        }
        counts.created++
      }
    } catch (e: any) {
      warnings.push(`Collection '${col.collection_id}': error — ${e?.message ?? String(e)}`)
    }
  }

  console.log(
    `Collections: created=${counts.created}, updated=${counts.updated}, skipped=${counts.skipped}`
  )
  return { counts, fixtureToMedusaMap }
}

// ---- Product Sync ----

export async function syncProducts(
  container: any,
  productModuleService: any,
  products: FixtureProduct[],
  prereqs: Prerequisites,
  categoryMap: Map<string, string>,
  collectionMap: Map<string, string>,
  tagIdMap: Map<string, string>,
  marketId: string,
  warnings: string[],
  vendorPricingMap?: Map<string, VendorPricingInfo>,
  dryRun = false,
  collector?: DryRunCollector,
  // v1.8.0 Story 1.10.1 — Layer 3 entitlement_profile catalog loaded from
  // market.yaml. Passed in so syncProducts can write
  // `product.metadata.gp.entitlement_profile` from each product's
  // `entitlement_profile_id` cross-ref. Optional: when absent (legacy markets
  // without voucher config) all products stay non-voucher-bearing.
  entitlementProfileMap?: Map<string, EntitlementProfileFixture>
): Promise<OpCounts> {
  const counts: OpCounts = { created: 0, updated: 0, skipped: 0 }

  const active = products.filter((p) => p.active !== false)

  console.log(`Syncing products (${active.length} active)...`)

  for (const product of active) {
    // H-8: runtime validation
    const handle = normalizeHandle((product.handle ?? product.slug ?? "").trim())
    if (!handle) {
      warnings.push(`Product '${product.product_id}': missing handle/slug, skipping`)
      collector?.add({
        entityType: "product",
        handle: product.product_id,
        action: "skip",
        note: "missing handle/slug",
      })
      continue
    }
    if (typeof product.base_price?.amount !== "number") {
      warnings.push(
        `Product '${product.product_id}': base_price.amount is not a number, skipping`
      )
      collector?.add({
        entityType: "product",
        handle,
        action: "skip",
        note: "base_price.amount is not a number",
      })
      continue
    }
    if (!product.base_price?.currency) {
      warnings.push(`Product '${product.product_id}': base_price.currency is empty, skipping`)
      collector?.add({
        entityType: "product",
        handle,
        action: "skip",
        note: "base_price.currency is empty",
      })
      continue
    }

    // Resolve category (singular in fixture → array for Medusa)
    const resolvedCategoryIds: string[] = []
    if (product.category_id) {
      const catMedusaId = categoryMap.get(product.category_id)
      if (catMedusaId) {
        resolvedCategoryIds.push(catMedusaId)
      } else {
        warnings.push(
          `Product '${product.product_id}': category_id '${product.category_id}' not in category map (H-7)`
        )
      }
    }

    // Resolve collection
    let resolvedCollectionId: string | undefined
    if (product.collection_id) {
      const colMedusaId = collectionMap.get(product.collection_id)
      if (colMedusaId) {
        resolvedCollectionId = colMedusaId
      } else {
        warnings.push(
          `Product '${product.product_id}': collection_id '${product.collection_id}' not in collection map (H-7)`
        )
      }
    }

    const resolvedTagIds = Array.from(
      new Set(
        (product.tags ?? [])
          .map(normalizeProductTagValue)
          .filter(Boolean)
          .map((tagValue) => {
            const tagId = tagIdMap.get(tagValue)

            if (!tagId) {
              warnings.push(
                `Product '${product.product_id}': tag '${tagValue}' not resolved in product tag map`
              )
            }

            return tagId
          })
          .filter((tagId): tagId is string => Boolean(tagId))
      )
    )

    const vendorPricing = vendorPricingMap?.get(product.product_id)
    const hasVendorPricing = Boolean(vendorPricing?.prices.length)
    const catalogPrice = resolveCatalogPrice(product, vendorPricing, warnings)

    // v1.8.0 Story 1.10.1 — resolve the optional entitlement_profile cross-ref
    // so payment.captured can issue entitlement_instance. Undefined when the
    // product is non-voucher OR no map was passed (legacy market without
    // voucher activation). Dangling refs surface as warnings (fail-loud).
    const entitlementProfile = entitlementProfileMap
      ? resolveProductEntitlementProfile(product, entitlementProfileMap, warnings)
      : undefined

    try {
      const matches = await productModuleService.listProducts(
        { handle },
        { select: ["id", "handle", "title", "description", "status", "metadata"], relations: ["variants"] }
      )
      const existing = matches?.[0]

      if (existing) {
        // H-3: cross-market guard
        const existingMarket = (existing.metadata as any)?.gp?.market_id
        if (existingMarket && existingMarket !== marketId) {
          warnings.push(
            `Product '${product.product_id}' handle='${handle}': cross-market guard — ` +
              `entity belongs to '${existingMarket}', skipping`
          )
          collector?.add({
            entityType: "product",
            handle,
            action: "skip",
            note: `cross-market guard (${existingMarket})`,
          })
          counts.skipped++
          continue
        }

        // Keep the product read lean: Medusa/Mercur 2.14 local schemas may not expose
        // every category relation projection. gp-config remains the source of truth for
        // fixture category links, so sync the resolved fixture category set directly.
        const nextCategoryIds = Array.from(new Set(resolvedCategoryIds))

        // Quality gate evaluation before status assignment
        const gateResult = evaluateQualityGate(product, { vendorPricing: hasVendorPricing })
        const gateStatus = gateResult.status
        console.log(
          `Product '${product.product_id}': ${gateStatus.toUpperCase()} (words=${gateResult.details.words}, image=${gateResult.details.image}, price=${gateResult.details.price}${hasVendorPricing ? ", vendorPricing=true" : ""})` +
            (gateResult.reasons.length > 0 ? ` — failed: ${gateResult.reasons.join(", ")}` : "")
        )

        if (dryRun && collector) {
          const noteParts = [
            `fixture_id=${product.product_id}`,
            `status=${gateStatus}`,
            catalogPrice.source === "min_vendor_price"
              ? `price=${catalogPrice.amount} ${catalogPrice.currency} (min-vendor)`
              : `price=${catalogPrice.amount} ${catalogPrice.currency}`,
          ]
          if (nextCategoryIds.length > 0) {
            noteParts.push(`category_ids=${nextCategoryIds.length}`)
          }
          if (resolvedCollectionId) {
            noteParts.push(`collection_id=${resolvedCollectionId}`)
          }

          collector.add({
            entityType: "product",
            handle,
            action: "update",
            note: noteParts.join("; "),
          })
          counts.updated++
          continue
        }

        // H-1: explicit fields update (including base price when changed)
        // Story 1.10.1 — entitlement_profile is written when resolved; otherwise
        // cleared so a transition from voucher → non-voucher (rare but possible
        // via products.yaml edit) doesn't leave stale embedded data behind.
        const existingGpMeta = (existing.metadata as any)?.gp ?? {}
        const nextGpMeta: Record<string, any> = {
          ...existingGpMeta,
          ...buildProductGpMetadata(product, marketId, hasVendorPricing, entitlementProfile),
        }
        if (!entitlementProfile && "entitlement_profile" in existingGpMeta) {
          delete nextGpMeta.entitlement_profile
        }
        if (product.entitlement_profile_id === undefined && "entitlement_profile_id" in existingGpMeta) {
          delete nextGpMeta.entitlement_profile_id
        }
        // Symmetric stale-clear for all schema-materialized catalog fields:
        // if a field is removed from the source (products.yaml), delete it from
        // DB metadata.gp to prevent silent parity drift (mirrors entitlement delete above).
        const STALE_CLEAR_FIELDS = ["subtitle", "seo", "sort_rank", "validity_period", "regulatory_class"] as const
        for (const field of STALE_CLEAR_FIELDS) {
          if (product[field] === undefined && field in existingGpMeta) {
            delete nextGpMeta[field]
          }
        }
        if (!Object.prototype.hasOwnProperty.call(product, "duration_minutes") && "duration_minutes" in existingGpMeta) {
          delete nextGpMeta.duration_minutes
        }
        const updatePayload: Record<string, any> = {
          title: product.name,
          subtitle: product.subtitle ?? null,
          description: product.description ?? existing.description,
          status: gateStatus,
          metadata: {
            ...(existing.metadata ?? {}),
            gp: nextGpMeta,
          },
        }

        if (nextCategoryIds.length > 0) {
          updatePayload.category_ids = nextCategoryIds
        }
        if (resolvedCollectionId) {
          updatePayload.collection_id = resolvedCollectionId
        }
        updatePayload.tag_ids = resolvedTagIds

        await productModuleService.updateProducts(existing.id, updatePayload)

        // Update the catalog/reference price on the default variant.
        if (existing.variants?.length) {
          const defaultVariant = existing.variants.find(
            (v: any) => v.title === "Default"
          ) ?? existing.variants[0]

          if (defaultVariant?.id) {
            const fixtureAmountMinor = Math.round(catalogPrice.amount * 100)
            const currencyCode = catalogPrice.currency.toLowerCase()

            try {
              await upsertVariantPricesWorkflow(container).run({
                input: {
                  variantPrices: [
                    {
                      variant_id: defaultVariant.id,
                      product_id: existing.id,
                      prices: [
                        {
                          amount: fixtureAmountMinor,
                          currency_code: currencyCode,
                        },
                      ],
                    },
                  ],
                  previousVariantIds: [defaultVariant.id],
                },
              })
            } catch (e: any) {
              warnings.push(
                `Product '${product.product_id}': price update — ${e?.message ?? String(e)}`
              )
            }
          }
        }

        // Ensure sales channel assignment (best-effort, idempotent)
        try {
          await linkProductsToSalesChannelWorkflow(container).run({
            input: {
              id: prereqs.salesChannelId,
              add: [existing.id],
            },
          })
        } catch (e: any) {
          warnings.push(
            `Product '${product.product_id}': sales channel link — ${e?.message ?? String(e)}`
          )
        }

        counts.updated++
      } else {
        // Quality gate evaluation before status assignment
        const createGateResult = evaluateQualityGate(product, { vendorPricing: hasVendorPricing })
        console.log(
          `Product '${product.product_id}': ${createGateResult.status.toUpperCase()} (words=${createGateResult.details.words}, image=${createGateResult.details.image}, price=${createGateResult.details.price}${hasVendorPricing ? ", vendorPricing=true" : ""})` +
            (createGateResult.reasons.length > 0 ? ` — failed: ${createGateResult.reasons.join(", ")}` : "")
        )

        if (dryRun && collector) {
          const noteParts = [
            `fixture_id=${product.product_id}`,
            `status=${createGateResult.status}`,
            catalogPrice.source === "min_vendor_price"
              ? `price=${catalogPrice.amount} ${catalogPrice.currency} (min-vendor)`
              : `price=${catalogPrice.amount} ${catalogPrice.currency}`,
          ]
          if (resolvedCategoryIds.length > 0) {
            noteParts.push(`category_ids=${resolvedCategoryIds.length}`)
          }
          if (resolvedCollectionId) {
            noteParts.push(`collection_id=${resolvedCollectionId}`)
          }
          if (resolvedTagIds.length > 0) {
            noteParts.push(`tag_ids=${resolvedTagIds.length}`)
          }

          collector.add({
            entityType: "product",
            handle,
            action: "create",
            note: noteParts.join("; "),
          })
          counts.created++
          continue
        }

        // Create via createProductsWorkflow (handles variants + pricing + sales_channels + shipping)
        const { result, errors } = await createProductsWorkflow(container).run({
          input: {
            products: [
              {
                title: product.name,
                ...(product.subtitle !== undefined ? { subtitle: product.subtitle } : {}),
                handle,
                status: createGateResult.status as "published" | "draft",
                description: product.description,
                discountable: product.discountable ?? true,
                shipping_profile_id: prereqs.shippingProfileId,
                // options required by validateProductInputStep
                options: [{ title: "Default", values: ["Default"] }],
                variants: [
                  {
                    title: "Default",
                    options: { Default: "Default" },
                    manage_inventory: false,
                    prices: [
                      {
                        // Medusa stores prices in minor units (grosze)
                        amount: Math.round(catalogPrice.amount * 100),
                        currency_code: catalogPrice.currency.toLowerCase(),
                      },
                    ],
                  },
                ],
                sales_channels: [{ id: prereqs.salesChannelId }],
                tag_ids: resolvedTagIds,
                ...(resolvedCategoryIds.length > 0 ? { category_ids: resolvedCategoryIds } : {}),
                ...(resolvedCollectionId ? { collection_id: resolvedCollectionId } : {}),
                metadata: {
                  gp: buildProductGpMetadata(product, marketId, hasVendorPricing, entitlementProfile),
                },
              },
            ],
          },
        })

        if (errors?.length) {
          warnings.push(
            `Product '${product.product_id}': createProductsWorkflow errors — ` +
              errors.map((e: any) => e?.message ?? String(e)).join(", ")
          )
        } else if (result?.length) {
          counts.created++
        }
      }
    } catch (e: any) {
      warnings.push(`Product '${product.product_id}': error — ${e?.message ?? String(e)}`)
    }
  }

  console.log(
    `Products: created=${counts.created}, updated=${counts.updated}, skipped=${counts.skipped}`
  )
  return counts
}

// ---- Entitlement Profile Map (Story 1.10.1) ----

/**
 * v1.8.0 Story 1.10.1 — load market.yaml `entitlement_profiles[]` into a Map
 * keyed by `profile_id` so syncProducts can resolve each product's
 * `entitlement_profile_id` cross-ref into the embedded form (profile_id +
 * entitlement_type + policy). Returns empty Map when:
 *  - market.yaml unreadable / malformed (warning emitted, fall back to no-op),
 *  - market.yaml has no `entitlement_profiles` section (market not voucher-enabled),
 *  - all products lack `entitlement_profile_id` (no need to load).
 *
 * Fail-loud parity with validate_entitlement_profiles.py: the validator is the
 * design-time gate; this loader is the runtime gate; both must agree on the
 * Layer 1 entitlement_type taxonomy. Drift between validator + loader is
 * out-of-scope here (caught by validator at CI / pre-commit).
 */
export async function loadEntitlementProfileMap(
  marketConfigPath: string,
  warnings: string[]
): Promise<Map<string, EntitlementProfileFixture>> {
  const map = new Map<string, EntitlementProfileFixture>()
  let marketConfig: MarketConfigWithEntitlements
  try {
    marketConfig = await readYamlFile<MarketConfigWithEntitlements>(marketConfigPath)
  } catch (e: any) {
    warnings.push(
      `Entitlement profile map: cannot read market.yaml — ${e?.message ?? String(e)}`
    )
    return map
  }
  const profiles = marketConfig.entitlement_profiles ?? []
  for (const profile of profiles) {
    if (!profile?.profile_id || typeof profile.profile_id !== "string") {
      warnings.push(
        `Entitlement profile map: skipped profile without profile_id`
      )
      continue
    }
    if (!profile.entitlement_type || typeof profile.entitlement_type !== "string") {
      warnings.push(
        `Entitlement profile '${profile.profile_id}': missing entitlement_type — skipped`
      )
      continue
    }
    if (!profile.policy || typeof profile.policy !== "object" || Array.isArray(profile.policy)) {
      warnings.push(
        `Entitlement profile '${profile.profile_id}': missing/invalid policy — skipped`
      )
      continue
    }
    map.set(profile.profile_id, profile)
  }
  return map
}

/**
 * v1.8.0 Story 1.10.1 — resolve a product's `entitlement_profile_id` against
 * the loaded Layer 3 map. Returns:
 *  - the embedded entitlement_profile form when the cross-ref resolves;
 *  - `undefined` when the product has no entitlement_profile_id (non-voucher SKU);
 *  - `undefined` PLUS a warning when the cross-ref is dangling (referenced
 *    profile_id absent in market.yaml — propagation gap, NOT silent).
 *
 * Currency is derived from `product.base_price.currency` so the embedded form
 * carries it for the storefront cart write (avoids storefront lookup).
 */
export function resolveProductEntitlementProfile(
  product: FixtureProduct,
  profileMap: Map<string, EntitlementProfileFixture>,
  warnings: string[]
): EmbeddedEntitlementProfile | undefined {
  const profileId = product.entitlement_profile_id?.trim()
  if (!profileId) return undefined
  const profile = profileMap.get(profileId)
  if (!profile) {
    // Fail-loud: dangling cross-ref means a product was promoted to voucher-bearing
    // but the Layer 3 profile is missing from market.yaml. Story 1.10.1 GAP #1
    // surfaces this class of drift; surface it here too rather than silently drop.
    warnings.push(
      `Product '${product.product_id}': entitlement_profile_id '${profileId}' ` +
        `not found in market.yaml entitlement_profiles[] — entitlement metadata ` +
        `not propagated (Story 1.10.1 dangling cross-ref guard)`
    )
    return undefined
  }
  return {
    profile_id: profile.profile_id,
    entitlement_type: profile.entitlement_type,
    policy: profile.policy,
    ...(product.base_price?.currency
      ? { currency: product.base_price.currency.toUpperCase() }
      : {}),
  }
}

// ---- Vendor Status Enforcement ----

const ACTIVE_VENDOR_STATUSES = new Set(["active", "onboarded"])

type MarketVendor = {
  vendor_id: string
  slug?: string
  status: string
}

type MarketConfig = {
  market_id: string
  countries?: string[]
  vendors?: MarketVendor[]
}

type VendorProductCatalog = {
  vendor_id: string
  market_id: string
  products?: Array<{
    product_id: string
    status?: string
    available?: boolean
  }>
}

function isVendorProductSellable(product: { status?: string; available?: boolean }): boolean {
  return product.status !== "inactive" && product.available !== false
}

/**
 * Set of `seller.store_status` enum values (uppercased) that count as active for catalog
 * pricing/visibility purposes. Mercur 2 baseline ships `ACTIVE`; future enum variants
 * (`OPEN` per draft spec) included for forward-compat across migrations. Extending this
 * set is the localised escape hatch when Mercur enum drifts (per F5 review).
 */
export const ACTIVE_RUNTIME_STORE_STATUSES = new Set(["ACTIVE", "OPEN"]) // noqa: mercur15-drift — legacy Mercur 1.x runtime bridge

/**
 * Minimal Knex-shaped contract for the seller-status query chain. Keeps `db: any` escape
 * hatch out of the helper signatures while avoiding a hard `@types/knex` dependency.
 */
export type SellerStatusRow = { handle: string; store_status: string | null }
export type KnexSellerQuery = {
  select: (...cols: string[]) => {
    whereIn: (col: string, vals: string[]) => {
      whereRaw: (sql: string, bindings: unknown[]) => {
        whereNull: (col: string) => Promise<SellerStatusRow[]>
      }
    }
  }
}
export type KnexLikeDb = (table: string) => KnexSellerQuery

/**
 * Returns true when a Mercur 2 seller's runtime `store_status` indicates the seller is active.
 *
 * Prod-vs-config drift rationale: gp-config YAML `vendor.status` is a bootstrap/fallback.
 * The runtime DB (`seller` table, Mercur 2) is the source of truth for seller activity.
 * This helper is case-insensitive to guard against mixed-case enum values in early migrations.
 *
 * NULL semantics: `null`/`undefined`/empty string → NOT active (treated as "not yet onboarded").
 * Callers fall back to config status only when the runtime row itself is absent — once a row
 * exists with NULL `store_status`, that is an authoritative "not active" signal.
 *
 * Scope limit: no reverse-flow (writing back to gp-config), no real-time push.
 * Eventual consistency per sync run is sufficient for v1.6.0. Full ratification deferred to v1.10.0.
 */
export function isRuntimeSellerActive(storeStatus: string | null | undefined): boolean {
  const normalized = (storeStatus ?? "").trim().toUpperCase()
  if (!normalized) {
    return false
  }
  return ACTIVE_RUNTIME_STORE_STATUSES.has(normalized)
}

/**
 * Reads Mercur 2 `seller.status` for the given market from the DB (Knex handle).
 * Rows are mapped to `store_status` internally so older unit fixtures can keep exercising
 * the legacy bridge semantics while runtime SQL stays on the current Mercur schema.
 *
 * Best-effort: if the DB query throws, a warning is pushed and an empty Map is returned
 * so that the caller falls back to config-only filtering without crashing the sync run.
 *
 * Filter: `metadata->'gp'->>'market_id' = marketId AND deleted_at IS NULL`.
 * Slug-only matching: vendors without `slug` in gp-config are skipped and fall back to config status.
 */
async function resolveVendorRuntimeStateMap(
  db: KnexLikeDb | null | undefined | any,
  marketId: string,
  vendors: MarketVendor[],
  warnings: string[]
): Promise<Map<string, { slug: string; store_status: string | null }>> {
  // Defense-in-depth: caller sites guard `db && marketId`, but mirror that here so any
  // future caller (or a degraded container.resolve path) cannot accidentally invoke
  // `db("seller")` on null/undefined and crash. Empty marketId is also rejected to avoid
  // silent empty-result queries that look like "no sellers active" (catastrophic regression).
  if (!db || typeof db !== "function" || !marketId?.trim()) {
    return new Map()
  }

  const slugs = Array.from(
    new Set(
      vendors
        .map((vendor) => vendor.slug?.trim())
        .filter((slug): slug is string => Boolean(slug))
    )
  )

  if (slugs.length === 0) {
    return new Map()
  }

  let rows: Array<{ handle: string; store_status: string | null }> = []
  try {
    rows = await db("seller")
      .select("handle", { store_status: "status" })
      .whereIn("handle", slugs)
      .whereRaw("metadata->'gp'->>'market_id' = ?", [marketId])
      .whereNull("deleted_at")
  } catch (e: any) {
    warnings.push(`Vendor status gate: cannot resolve runtime seller states — ${e?.message ?? String(e)}`)
    return new Map()
  }

  const runtimeStateMap = new Map<string, { slug: string; store_status: string | null }>()
  for (const row of rows) {
    runtimeStateMap.set(row.handle, {
      slug: row.handle,
      store_status: row.store_status ?? null,
    })
  }

  return runtimeStateMap
}

export async function enforceVendorStatusGate(
  db: any,
  productModuleService: any,
  marketConfigPath: string,
  marketId: string,
  warnings: string[],
  collector?: DryRunCollector
): Promise<{ draftedCount: number }> {
  let marketConfig: MarketConfig
  try {
    marketConfig = await readYamlFile<MarketConfig>(marketConfigPath)
  } catch (e: any) {
    warnings.push(`Vendor status gate: cannot read market.yaml — ${e?.message ?? String(e)}`)
    return { draftedCount: 0 }
  }

  const vendors = marketConfig.vendors ?? []
  // F1 fix: mirror buildVendorPricingMap's guard so a null/undefined db (or empty marketId)
  // never reaches db("seller"). resolveVendorRuntimeStateMap also guards internally; this
  // outer guard skips an unnecessary call entirely and keeps semantics symmetric.
  const runtimeStateMap =
    db && marketId
      ? await resolveVendorRuntimeStateMap(db, marketId, vendors, warnings)
      : new Map<string, { slug: string; store_status: string | null }>()

  // F3 fix: aggregate "runtime seller missing" warnings into a single summary instead of
  // emitting one per vendor (warning spam on legacy configs). Distinguish vendors that
  // SHOULD have a runtime row (slug present but row absent — real drift signal) from
  // legacy vendors with no slug (silent config-only path).
  const missingRuntimeWithSlug: string[] = []
  const missingRuntimeNoSlug: string[] = []

  const vendorsWithRuntimeState = vendors.map((vendor) => {
    const slug = vendor.slug?.trim() ?? ""
    const runtime = slug ? runtimeStateMap.get(slug) : undefined
    const isActive = runtime
      ? isRuntimeSellerActive(runtime.store_status)
      : ACTIVE_VENDOR_STATUSES.has(vendor.status)

    if (!runtime) {
      if (slug) {
        missingRuntimeWithSlug.push(`${vendor.vendor_id}(slug=${slug}, config=${vendor.status})`)
      } else {
        missingRuntimeNoSlug.push(`${vendor.vendor_id}(config=${vendor.status})`)
      }
    }

    return {
      ...vendor,
      slug,
      runtimeStoreStatus: runtime?.store_status ?? null,
      isActive,
    }
  })

  if (missingRuntimeWithSlug.length > 0) {
    warnings.push(
      `Vendor status gate: ${missingRuntimeWithSlug.length} slugged vendor(s) lack runtime seller row; ` +
        `falling back to config status — ${missingRuntimeWithSlug.join(", ")}`
    )
  }
  if (missingRuntimeNoSlug.length > 0) {
    warnings.push(
      `Vendor status gate: ${missingRuntimeNoSlug.length} legacy vendor(s) without slug; ` +
        `runtime check skipped, using config status — ${missingRuntimeNoSlug.join(", ")}`
    )
  }

  const nonActiveVendors = vendorsWithRuntimeState.filter((vendor) => !vendor.isActive)

  if (nonActiveVendors.length === 0) {
    return { draftedCount: 0 }
  }

  console.log(
    `Vendor status gate: ${nonActiveVendors.length} non-active vendor(s): ${nonActiveVendors
      .map((vendor) => {
        const runtime = vendor.runtimeStoreStatus ? `runtime=${vendor.runtimeStoreStatus}` : "runtime=missing"
        return `${vendor.vendor_id}(${runtime}, config=${vendor.status})`
      })
      .join(", ")}`
  )

  const activeVendors = vendorsWithRuntimeState.filter((vendor) => vendor.isActive)

  // Build sets of fixture product_ids belonging to active and non-active vendors
  // by reading vendor product catalog files (vendors/{vendor_id}/products.yaml)
  const marketDir = path.dirname(marketConfigPath)
  const blockedFixtureIds = new Set<string>()
  const activeFixtureIds = new Set<string>()

  for (const vendor of activeVendors) {
    const vendorProductsPath = path.resolve(marketDir, "vendors", vendor.vendor_id, "products.yaml")
    try {
      const vendorCatalog = await readYamlFile<VendorProductCatalog>(vendorProductsPath)
      for (const vp of vendorCatalog.products ?? []) {
        if (vp.product_id && isVendorProductSellable(vp)) {
          activeFixtureIds.add(vp.product_id)
        }
      }
    } catch {
      // Vendor product file missing — not an error, vendor may have no products yet
    }
  }

  for (const vendor of nonActiveVendors) {
    const vendorProductsPath = path.resolve(marketDir, "vendors", vendor.vendor_id, "products.yaml")
    try {
      const vendorCatalog = await readYamlFile<VendorProductCatalog>(vendorProductsPath)
      for (const vp of vendorCatalog.products ?? []) {
        if (vp.product_id && isVendorProductSellable(vp) && !activeFixtureIds.has(vp.product_id)) {
          blockedFixtureIds.add(vp.product_id)
        }
      }
    } catch (e: any) {
      warnings.push(
        `Vendor status gate: cannot read vendor products for '${vendor.vendor_id}' — ${e?.message ?? String(e)}`
      )
    }
  }

  if (blockedFixtureIds.size === 0) {
    return { draftedCount: 0 }
  }

  // Fetch all market products from Medusa in one query
  let allProducts: any[]
  try {
    allProducts = await productModuleService.listProducts(
      {},
      { select: ["id", "handle", "status", "metadata"], take: null }
    )
    allProducts = allProducts ?? []
  } catch (e: any) {
    warnings.push(`Vendor status gate: cannot list products — ${e?.message ?? String(e)}`)
    return { draftedCount: 0 }
  }

  // Filter to market products whose fixture_id is in the blocked set
  const toBlock = allProducts.filter((p: any) => {
    const gpMeta = (p.metadata as any)?.gp
    return gpMeta?.market_id === marketId && blockedFixtureIds.has(gpMeta?.fixture_id)
  })

  let draftedCount = 0
  for (const prod of toBlock) {
    if (prod.status !== "draft") {
      try {
        if (collector) {
          collector.add({
            entityType: "product",
            handle: prod.handle,
            action: "update",
            note: "status=draft (vendor status gate)",
          })
        } else {
          await productModuleService.updateProducts(prod.id, { status: "draft" })
          console.log(
            `Product '${prod.handle}': DRAFT (vendor product blocked by vendor status gate)`
          )
        }
        draftedCount++
      } catch (e: any) {
        warnings.push(
          `Vendor status gate for product '${prod.handle}': update error — ${e?.message ?? String(e)}`
        )
      }
    }
  }

  return { draftedCount }
}

async function collectConfiguredProductFixtureIds(
  products: FixtureProduct[],
  marketConfigPath: string,
  warnings: string[]
): Promise<Set<string>> {
  const configuredFixtureIds = new Set<string>()

  for (const product of products) {
    const fixtureId = product.product_id?.trim()
    if (fixtureId) {
      configuredFixtureIds.add(fixtureId)
    }
  }

  let marketConfig: MarketConfig
  try {
    marketConfig = await readYamlFile<MarketConfig>(marketConfigPath)
  } catch (e: any) {
    warnings.push(`Orphan reconcile: cannot read market.yaml — ${e?.message ?? String(e)}`)
    return configuredFixtureIds
  }

  const marketDir = path.dirname(marketConfigPath)
  for (const vendor of marketConfig.vendors ?? []) {
    const vendorProductsPath = path.resolve(marketDir, "vendors", vendor.vendor_id, "products.yaml")
    try {
      const vendorCatalog = await readYamlFile<VendorProductCatalog>(vendorProductsPath)
      for (const product of vendorCatalog.products ?? []) {
        const fixtureId = product.product_id?.trim()
        if (fixtureId) {
          configuredFixtureIds.add(fixtureId)
        }
      }
    } catch {
      // Vendor product file missing — not an error, vendor may have no products yet.
    }
  }

  return configuredFixtureIds
}

export async function draftOrphanMarketProducts(
  productModuleService: any,
  configuredFixtureIds: Set<string>,
  marketId: string,
  warnings: string[],
  collector?: DryRunCollector
): Promise<{ draftedCount: number }> {
  let allProducts: any[]
  try {
    allProducts = await productModuleService.listProducts(
      {},
      { select: ["id", "handle", "status", "metadata"], take: null }
    )
    allProducts = allProducts ?? []
  } catch (e: any) {
    warnings.push(`Orphan reconcile: cannot list products — ${e?.message ?? String(e)}`)
    return { draftedCount: 0 }
  }

  const orphanProducts = allProducts.filter((product: any) => {
    const gpMeta = (product.metadata as any)?.gp
    const fixtureId = typeof gpMeta?.fixture_id === "string" ? gpMeta.fixture_id.trim() : ""
    return gpMeta?.market_id === marketId && fixtureId && !configuredFixtureIds.has(fixtureId)
  })

  let draftedCount = 0
  for (const product of orphanProducts) {
    if (product.status === "draft") {
      continue
    }

    try {
      if (collector) {
        collector.add({
          entityType: "product",
          handle: product.handle,
          action: "update",
          note: "status=draft (missing from gp-config)",
        })
      } else {
        await productModuleService.updateProducts(product.id, { status: "draft" })
        console.log(`Product '${product.handle}': DRAFT (missing from gp-config)`)
      }
      draftedCount++
    } catch (e: any) {
      warnings.push(
        `Orphan reconcile for product '${product.handle}': update error — ${e?.message ?? String(e)}`
      )
    }
  }

  return { draftedCount }
}

// ---- Main Orchestrator ----

export default async function gpConfigSyncCatalog({ container, args }: ExecArgs) {
  const { instanceId, marketId, configRoot, dryRun } = parseArgs(args)
  const productsPath = path.resolve(configRoot, instanceId, "markets", marketId, "products.yaml")
  const collector = dryRun ? new DryRunCollector() : undefined

  // Load fixture
  const catalog = await readYamlFile<CatalogFixture>(productsPath)

  // OP-1: market_id guard
  if (catalog.market_id !== marketId) {
    throw new Error(
      `market_id mismatch in ${productsPath}: expected '${marketId}', got '${catalog.market_id}'`
    )
  }

  const categories = catalog.categories ?? []
  const collections = catalog.collections ?? []
  const products = catalog.products ?? []
  const marketConfigPath = path.resolve(configRoot, instanceId, "markets", marketId, "market.yaml")
  let marketCountries: string[] = []
  try {
    const marketConfig = await readYamlFile<MarketConfig>(marketConfigPath)
    marketCountries = Array.isArray(marketConfig.countries) ? marketConfig.countries : []
  } catch {
    marketCountries = []
  }

  if (categories.length === 0) console.warn("Warning: 0 categories in fixture — intentional?")
  if (products.length === 0) console.warn("Warning: 0 products in fixture — intentional?")

  // Determine all currencies used in fixture (fallback PLN)
  const allCurrencies = [...new Set(
    products.map((p) => p.base_price?.currency).filter(Boolean)
  )]
  if (allCurrencies.length === 0) allCurrencies.push("PLN")
  const activeCurrency = allCurrencies[0]

  const warnings: string[] = []
  // Resolve Knex handle for runtime seller status lookups. Wrap in try/catch (F10): if
  // PG_CONNECTION is not registered in this container (e.g. CLI-only context, degraded
  // boot), fall back to config-only filtering with a single warning instead of crashing
  // the entire sync. resolveVendorRuntimeStateMap also handles null/undefined defensively.
  let db: any
  try {
    db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  } catch (e: any) {
    warnings.push(
      `Runtime seller lookup: PG_CONNECTION unresolved — ${e?.message ?? String(e)}; ` +
        `falling back to config-only vendor status filtering`
    )
    db = undefined
  }

  // Prerequisites (fail-fast on critical) — validate region for each currency
  console.log(`Validating prerequisites for market '${marketId}'...`)
  const prereqs = await validatePrerequisites(
    container,
    marketId,
    activeCurrency,
    warnings,
    Boolean(collector),
    marketCountries
  )
  console.log(`  ✓ Sales channel: ${prereqs.salesChannelId}`)
  console.log(`  ✓ Shipping profile: ${prereqs.shippingProfileId}`)
  console.log(`  ✓ Region with currency '${activeCurrency}' found`)
  for (const currency of allCurrencies.slice(1)) {
    try {
      await validatePrerequisites(
        container,
        marketId,
        currency,
        warnings,
        Boolean(collector),
        marketCountries
      )
      console.log(`  ✓ Region with currency '${currency}' found`)
    } catch (e: any) {
      warnings.push(`Additional currency '${currency}': ${e?.message ?? String(e)}`)
    }
  }

  // Resolve services
  const productModuleService = resolveService(container, [
    "product",
    "productModuleService",
    "product_module",
  ])

  // Sync categories (two-pass) — categories API is on productModuleService
  const { counts: categoryCounts, fixtureToMedusaMap: categoryMap } = await syncCategories(
    productModuleService,
    categories,
    marketId,
    warnings,
    collector
  )

  // Sync collections
  const { counts: collectionCounts, fixtureToMedusaMap: collectionMap } = await syncCollections(
    productModuleService,
    collections,
    marketId,
    warnings,
    collector
  )

  const tagIdMap = await resolveProductTagIdMap(
    productModuleService,
    products,
    marketId,
    warnings,
    collector
  )

  // Build vendor pricing map before product sync (now wired to real seller store_status)
  const resolvedVendorPricingMap = await buildVendorPricingMap(
    marketConfigPath,
    warnings,
    db,
    marketId
  )
  if (resolvedVendorPricingMap.size > 0) {
    console.log(`Vendor pricing: ${resolvedVendorPricingMap.size} product(s) have active vendor prices`)
  }

  // Story 1.10.1 — load Layer 3 entitlement_profiles[] from market.yaml so the
  // product sync can write the embedded form to product.metadata.gp.entitlement_profile.
  // Empty map for markets without voucher activation → product sync skips entitlement
  // augmentation (legacy single-vendor / non-voucher flow preserved).
  const entitlementProfileMap = await loadEntitlementProfileMap(marketConfigPath, warnings)
  if (entitlementProfileMap.size > 0) {
    console.log(
      `Entitlement profiles: ${entitlementProfileMap.size} Layer 3 profile(s) loaded from market.yaml`
    )
  }

  // Sync products
  const productCounts = await syncProducts(
    container,
    productModuleService,
    products,
    prereqs,
    categoryMap,
    collectionMap,
    tagIdMap,
    marketId,
    warnings,
    resolvedVendorPricingMap,
    dryRun,
    collector,
    entitlementProfileMap
  )

  const configuredFixtureIds = await collectConfiguredProductFixtureIds(
    products,
    marketConfigPath,
    warnings
  )
  const { draftedCount: orphanDraftedCount } = await draftOrphanMarketProducts(
    productModuleService,
    configuredFixtureIds,
    marketId,
    warnings,
    collector
  )
  if (orphanDraftedCount > 0) {
    console.log(`Orphan reconcile: ${orphanDraftedCount} product(s) set to draft`)
  }

  // Vendor status enforcement — draft products from non-active vendors
  const { draftedCount } = await enforceVendorStatusGate(
    db,
    productModuleService,
    marketConfigPath,
    marketId,
    warnings,
    collector
  )
  if (draftedCount > 0) {
    console.log(`Vendor status gate: ${draftedCount} product(s) set to draft`)
  }

  const uniqueWarnings = dedupeWarnings(warnings)
  const warningThreshold = Number.parseInt(
    process.env.GP_SYNC_CATALOG_MAX_WARNINGS ?? String(DEFAULT_WARNING_THRESHOLD),
    10
  )
  const maxWarnings = Number.isFinite(warningThreshold)
    ? warningThreshold
    : DEFAULT_WARNING_THRESHOLD

  // JSON summary (like sync-media)
  const summary = {
    ok: uniqueWarnings.length <= maxWarnings,
    dry_run: dryRun,
    instance_id: instanceId,
    market_id: marketId,
    config_root: configRoot,
    products_path: productsPath,
    categories: categoryCounts,
    collections: collectionCounts,
    products: productCounts,
    orphan_reconcile: { drafted: orphanDraftedCount },
    vendor_gate: { drafted: draftedCount },
    warnings: uniqueWarnings,
    warning_threshold: maxWarnings,
    timestamp: new Date().toISOString(),
  }

  if (dryRun && collector) {
    console.log(collector.renderTable())
  }

  const summaryJson = JSON.stringify(summary, null, 2)
  const summaryPath = resolveSummaryPath()
  await fs.mkdir(path.dirname(summaryPath), { recursive: true })
  await fs.writeFile(summaryPath, `${summaryJson}\n`, "utf8")
  console.log(summaryJson)
  console.log(`Summary written: ${summaryPath}`)

  // Signal blocking warning volume via exit code (non-destructive — lets event loop drain).
  // The threshold mirrors validate_sync_catalog_output.py so local sync and quality gate
  // classify the same result consistently.
  if (uniqueWarnings.length > maxWarnings && !dryRun) {
    process.exitCode = 1
  }
}
