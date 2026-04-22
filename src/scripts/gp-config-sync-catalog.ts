import { ExecArgs } from "@medusajs/framework/types"
import { createProductsWorkflow, linkProductsToSalesChannelWorkflow, upsertVariantPricesWorkflow } from "@medusajs/core-flows"

import fs from "node:fs/promises"
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
  slug?: string
  handle?: string
  status?: string
  discountable?: boolean
  base_price: { amount: number; currency: string }
  duration_minutes?: number | null
  description?: string
  photo_url?: string
  tags?: string[]
  active?: boolean
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

// ---- Utilities (pattern from gp-config-sync-media) ----

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
  warnings: string[]
): Promise<Map<string, VendorPricingInfo>> {
  const map = new Map<string, VendorPricingInfo>()
  const marketDir = path.dirname(marketConfigPath)

  let marketConfig: MarketConfig
  try {
    marketConfig = await readYamlFile<MarketConfig>(marketConfigPath)
  } catch {
    return map
  }

  const activeVendors = (marketConfig.vendors ?? []).filter(
    (v) => ACTIVE_VENDOR_STATUSES.has(v.status)
  )

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
  warnings: string[]
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
    throw new Error(
      `No region found with currency_code '${currency}'. ` +
        `Ensure a region with currency '${currency}' exists in Medusa Admin or seed.`
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
  collector?: DryRunCollector
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

    try {
      const matches = await productModuleService.listProducts(
        { handle },
        { select: ["id", "handle", "title", "description", "status", "metadata"], relations: ["variants", "categories"] }
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

        // REPLACE semantic: merge existing category_ids + fixture (H-7, full set)
        const existingCategoryIds = (existing.categories ?? [])
          .map((c: any) => c.id)
          .filter(Boolean)
        const mergedCategoryIds = Array.from(
          new Set([...existingCategoryIds, ...resolvedCategoryIds])
        )

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
          if (mergedCategoryIds.length > 0) {
            noteParts.push(`category_ids=${mergedCategoryIds.length}`)
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
        const updatePayload: Record<string, any> = {
          title: product.name,
          description: product.description ?? existing.description,
          status: gateStatus,
          metadata: {
            ...(existing.metadata ?? {}),
            gp: {
              ...((existing.metadata as any)?.gp ?? {}),
              synced_by: "gp-config-sync-catalog",
              market_id: marketId,
              fixture_id: product.product_id,
              has_vendor_pricing: hasVendorPricing,
            },
          },
        }

        if (mergedCategoryIds.length > 0) {
          updatePayload.category_ids = mergedCategoryIds
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
                  gp: {
                    synced_by: "gp-config-sync-catalog",
                    market_id: marketId,
                    fixture_id: product.product_id,
                    has_vendor_pricing: hasVendorPricing,
                  },
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

// ---- Vendor Status Enforcement ----

const ACTIVE_VENDOR_STATUSES = new Set(["active", "onboarded"])

type MarketVendor = {
  vendor_id: string
  status: string
}

type MarketConfig = {
  market_id: string
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

export async function enforceVendorStatusGate(
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
  const nonActiveVendors = vendors.filter((v) => !ACTIVE_VENDOR_STATUSES.has(v.status))

  if (nonActiveVendors.length === 0) {
    return { draftedCount: 0 }
  }

  console.log(
    `Vendor status gate: ${nonActiveVendors.length} non-active vendor(s): ${nonActiveVendors.map((v) => `${v.vendor_id}=${v.status}`).join(", ")}`
  )

  const activeVendors = vendors.filter((v) => ACTIVE_VENDOR_STATUSES.has(v.status))

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

  if (categories.length === 0) console.warn("Warning: 0 categories in fixture — intentional?")
  if (products.length === 0) console.warn("Warning: 0 products in fixture — intentional?")

  // Determine all currencies used in fixture (fallback PLN)
  const allCurrencies = [...new Set(
    products.map((p) => p.base_price?.currency).filter(Boolean)
  )]
  if (allCurrencies.length === 0) allCurrencies.push("PLN")
  const activeCurrency = allCurrencies[0]

  const warnings: string[] = []

  // Prerequisites (fail-fast on critical) — validate region for each currency
  console.log(`Validating prerequisites for market '${marketId}'...`)
  const prereqs = await validatePrerequisites(container, marketId, activeCurrency, warnings)
  console.log(`  ✓ Sales channel: ${prereqs.salesChannelId}`)
  console.log(`  ✓ Shipping profile: ${prereqs.shippingProfileId}`)
  console.log(`  ✓ Region with currency '${activeCurrency}' found`)
  for (const currency of allCurrencies.slice(1)) {
    try {
      await validatePrerequisites(container, marketId, currency, warnings)
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

  // Build vendor pricing map before product sync
  const marketConfigPath = path.resolve(configRoot, instanceId, "markets", marketId, "market.yaml")
  const vendorPricingMap = await buildVendorPricingMap(marketConfigPath, warnings)
  if (vendorPricingMap.size > 0) {
    console.log(`Vendor pricing: ${vendorPricingMap.size} product(s) have active vendor prices`)
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
    vendorPricingMap,
    dryRun,
    collector
  )

  // Vendor status enforcement — draft products from non-active vendors
  const { draftedCount } = await enforceVendorStatusGate(
    productModuleService,
    marketConfigPath,
    marketId,
    warnings,
    collector
  )
  if (draftedCount > 0) {
    console.log(`Vendor status gate: ${draftedCount} product(s) set to draft`)
  }

  // JSON summary (like sync-media)
  const summary = {
    ok: warnings.length === 0,
    dry_run: dryRun,
    instance_id: instanceId,
    market_id: marketId,
    config_root: configRoot,
    products_path: productsPath,
    categories: categoryCounts,
    collections: collectionCounts,
    products: productCounts,
    vendor_gate: { drafted: draftedCount },
    warnings,
    timestamp: new Date().toISOString(),
  }

  if (dryRun && collector) {
    console.log(collector.renderTable())
  }

  console.log(JSON.stringify(summary, null, 2))

  // Signal warnings via exit code (non-destructive — lets event loop drain)
  if (warnings.length > 0 && !dryRun) {
    process.exitCode = 1
  }
}
