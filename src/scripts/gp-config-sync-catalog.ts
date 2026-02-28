import { ExecArgs } from "@medusajs/framework/types"
import { createProductsWorkflow, linkProductsToSalesChannelWorkflow } from "@medusajs/core-flows"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

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
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, marketId, configRoot }
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw)
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
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

async function listAll(service: any, methodNames: string[], query: object = {}): Promise<any[]> {
  for (const name of methodNames) {
    if (typeof service[name] !== "function") continue
    try {
      const result = await service[name](query)
      if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
      if (Array.isArray(result)) return result
    } catch {
      continue
    }
  }
  return []
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
  warnings: string[]
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
      continue
    }

    if (skipCategoryIds.has(cat.category_id)) {
      counts.skipped++
      continue
    }

    try {
      const matches = await productModuleService.listProductCategories({ handle })
      const existing = matches?.[0]

      if (existing) {
        // H-3: cross-market guard
        const existingMarket = (existing.metadata as any)?.gp?.market_id
        if (existingMarket && existingMarket !== marketId) {
          warnings.push(
            `Category '${cat.category_id}' handle='${handle}': cross-market guard — ` +
              `entity belongs to '${existingMarket}', skipping`
          )
          counts.skipped++
          continue
        }

        // H-1: explicit field update — updateProductCategories(id, data)
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
        fixtureToMedusaMap.set(cat.category_id, existing.id)
        counts.updated++
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
        const createdId = (
          Array.isArray(created) ? created[0]?.id : created?.id
        ) as string | undefined
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
      await productModuleService.updateProductCategories(medusaId, {
        parent_category_id: parentMedusaId,
      })
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
  warnings: string[]
): Promise<{ counts: OpCounts; fixtureToMedusaMap: Map<string, string> }> {
  const counts: OpCounts = { created: 0, updated: 0, skipped: 0 }
  const fixtureToMedusaMap = new Map<string, string>()

  const active = collections.filter((c) => c.active !== false)

  console.log(`Syncing collections (${active.length} active)...`)

  for (const col of active) {
    const handle = normalizeHandle((col.handle ?? "").trim())
    if (!handle) {
      warnings.push(`Collection '${col.collection_id}': missing handle, skipping`)
      continue
    }

    try {
      const matches = await productModuleService.listProductCollections({ handle })
      const existing = matches?.[0]

      if (existing) {
        // H-3: cross-market guard
        const existingMarket = (existing.metadata as any)?.gp?.market_id
        if (existingMarket && existingMarket !== marketId) {
          warnings.push(
            `Collection '${col.collection_id}' handle='${handle}': cross-market guard — ` +
              `entity belongs to '${existingMarket}', skipping`
          )
          counts.skipped++
          continue
        }

        // H-1: explicit field update (no product_ids — managed via products)
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
        fixtureToMedusaMap.set(col.collection_id, existing.id)
        counts.updated++
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
        const createdId = (created?.id ?? created?.[0]?.id) as string | undefined
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
  marketId: string,
  warnings: string[]
): Promise<OpCounts> {
  const counts: OpCounts = { created: 0, updated: 0, skipped: 0 }

  const active = products.filter((p) => p.active !== false)

  console.log(`Syncing products (${active.length} active)...`)

  for (const product of active) {
    // H-8: runtime validation
    const handle = normalizeHandle((product.handle ?? product.slug ?? "").trim())
    if (!handle) {
      warnings.push(`Product '${product.product_id}': missing handle/slug, skipping`)
      continue
    }
    if (typeof product.base_price?.amount !== "number") {
      warnings.push(
        `Product '${product.product_id}': base_price.amount is not a number, skipping`
      )
      continue
    }
    if (!product.base_price?.currency) {
      warnings.push(`Product '${product.product_id}': base_price.currency is empty, skipping`)
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

    try {
      const matches = await productModuleService.listProducts(
        { handle },
        { relations: ["variants", "categories"] }
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

        // H-1: explicit fields, H-4: no pricing/variants update
        const updatePayload: Record<string, any> = {
          title: product.name,
          description: product.description ?? existing.description,
          status: "published",
          metadata: {
            ...(existing.metadata ?? {}),
            gp: {
              ...((existing.metadata as any)?.gp ?? {}),
              synced_by: "gp-config-sync-catalog",
              market_id: marketId,
              fixture_id: product.product_id,
            },
          },
        }

        if (mergedCategoryIds.length > 0) {
          updatePayload.category_ids = mergedCategoryIds
        }
        if (resolvedCollectionId) {
          updatePayload.collection_id = resolvedCollectionId
        }

        await productModuleService.updateProducts(existing.id, updatePayload)

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
        // Create via createProductsWorkflow (handles variants + pricing + sales_channels + shipping)
        const { result, errors } = await createProductsWorkflow(container).run({
          input: {
            products: [
              {
                title: product.name,
                handle,
                status: "published",
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
                        amount: Math.round(product.base_price.amount * 100),
                        currency_code: product.base_price.currency.toLowerCase(),
                      },
                    ],
                  },
                ],
                sales_channels: [{ id: prereqs.salesChannelId }],
                ...(resolvedCategoryIds.length > 0 ? { category_ids: resolvedCategoryIds } : {}),
                ...(resolvedCollectionId ? { collection_id: resolvedCollectionId } : {}),
                metadata: {
                  gp: {
                    synced_by: "gp-config-sync-catalog",
                    market_id: marketId,
                    fixture_id: product.product_id,
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

// ---- Main Orchestrator ----

export default async function gpConfigSyncCatalog({ container, args }: ExecArgs) {
  const { instanceId, marketId, configRoot } = parseArgs(args)
  const productsPath = path.resolve(configRoot, instanceId, "markets", marketId, "products.yaml")

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

  // Determine currency from first product (fallback PLN)
  const activeCurrency =
    products.find((p) => p.base_price?.currency)?.base_price?.currency ?? "PLN"

  const warnings: string[] = []

  // Prerequisites (fail-fast on critical)
  console.log(`Validating prerequisites for market '${marketId}'...`)
  const prereqs = await validatePrerequisites(container, marketId, activeCurrency, warnings)
  console.log(`  ✓ Sales channel: ${prereqs.salesChannelId}`)
  console.log(`  ✓ Shipping profile: ${prereqs.shippingProfileId}`)
  console.log(`  ✓ Region with currency '${activeCurrency}' found`)

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
    warnings
  )

  // Sync collections
  const { counts: collectionCounts, fixtureToMedusaMap: collectionMap } = await syncCollections(
    productModuleService,
    collections,
    marketId,
    warnings
  )

  // Sync products
  const productCounts = await syncProducts(
    container,
    productModuleService,
    products,
    prereqs,
    categoryMap,
    collectionMap,
    marketId,
    warnings
  )

  // JSON summary (like sync-media)
  const summary = {
    ok: warnings.length === 0,
    instance_id: instanceId,
    market_id: marketId,
    config_root: configRoot,
    products_path: productsPath,
    categories: categoryCounts,
    collections: collectionCounts,
    products: productCounts,
    warnings,
    timestamp: new Date().toISOString(),
  }

  console.log(JSON.stringify(summary, null, 2))

  // Exit code 1 if warnings (data synced but with issues)
  if (warnings.length > 0) {
    process.exit(1)
  }
}
