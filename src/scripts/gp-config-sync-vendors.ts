import { ExecArgs } from "@medusajs/framework/types"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

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
}

type SyncSummary = {
  ok: boolean
  instance_id: string
  market_id: string
  vendors: { created: number; updated: number; skipped: number }
  spl: { created: number; skipped: number; missing_products: number }
  warnings: string[]
}

// ---- Utilities ----

function parseArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")).trim()
  const dryRun = args?.includes("--dry-run") ?? false

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

function resolveSeedIfEmpty(
  fieldName: string,
  configValue: unknown,
  dbValue: unknown,
  seededFields: string[]
): SeedIfEmptyResult {
  const isSeeded = seededFields.includes(fieldName)
  const dbEmpty = dbValue === null || dbValue === undefined || dbValue === ""

  if (isSeeded) {
    // Case 1: field tracked AND current DB == config value → apply (config changed, vendor still on config)
    // Case 2: field tracked AND current DB != config value → skip (vendor edited, preserve)
    if (dbValue === configValue) {
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
  marketId: string
): Promise<SellerSyncResult> {
  const handle = vendor.slug.trim()

  // Look up existing seller by handle
  let existingSellers: any[] = []
  if (typeof sellerModuleService.list === "function") {
    existingSellers = (await sellerModuleService.list({ handle })) ?? []
  } else if (typeof sellerModuleService.listSellers === "function") {
    existingSellers = (await sellerModuleService.listSellers({ handle })) ?? []
  }

  const existingSeller = existingSellers[0] ?? null
  const storeStatus = vendorStatusToStoreStatus(vendor.status)

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
      console.log(`[dry-run] Would CREATE seller handle='${handle}'`)
      return { sellerId: `dry-run-${handle}`, action: "created" }
    }

    const created = await sellerModuleService.create(createPayload)
    return { sellerId: created?.id ?? null, action: "created" }
  }

  // ---- UPDATE: existing seller ----
  const existingMetadata = (existingSeller.metadata ?? {}) as Record<string, unknown>
  const existingGp = (existingMetadata.gp ?? {}) as Record<string, unknown>
  const seededFields = Array.isArray(existingGp.seeded_fields)
    ? (existingGp.seeded_fields as string[])
    : []

  // config_wins fields — always overwrite
  const configWinsPayload: Record<string, unknown> = {
    handle,
    email: vendor.email,
    phone: vendor.phone,
    tax_id: vendor.tax_id,
    store_status: storeStatus,
  }

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
    const r = resolveSeedIfEmpty("name", vendor.display_name, existingGp.name ?? existingSeller.name, seededFields)
    if (r.shouldWrite) {
      gpMetaUpdate.name = r.value
      if (r.isNewSeed) newlySeededFields.push("name")
    }
  }

  // description
  if (vendor.description !== undefined) {
    const r = resolveSeedIfEmpty("description", vendor.description, existingGp.description ?? existingSeller.description, seededFields)
    if (r.shouldWrite) {
      gpMetaUpdate.description = r.value
      if (r.isNewSeed) newlySeededFields.push("description")
    }
  }

  // photo_url
  if (vendor.photo_url !== undefined) {
    const r = resolveSeedIfEmpty("photo_url", vendor.photo_url, existingGp.photo_url, seededFields)
    if (r.shouldWrite) {
      gpMetaUpdate.photo_url = r.value
      if (r.isNewSeed) newlySeededFields.push("photo_url")
    }
  }

  // gallery
  if (vendor.gallery_urls !== undefined) {
    const r = resolveSeedIfEmpty("gallery", vendor.gallery_urls, existingGp.gallery, seededFields)
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
    console.log(`[dry-run] Would UPDATE seller handle='${handle}' id='${existingSeller.id}'`)
    return { sellerId: existingSeller.id, action: "updated" }
  }

  await sellerModuleService.update(existingSeller.id, updatePayload)
  return { sellerId: existingSeller.id, action: "updated" }
}

// ---- Default export: Medusa script entrypoint ----

export default async function gpConfigSyncVendors({ container, args }: ExecArgs) {
  const { instanceId, marketId, configRoot, dryRun } = parseArgs(args)

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

  const warnings: string[] = []
  const vendorCounts = { created: 0, updated: 0, skipped: 0 }
  const splCounts = { created: 0, skipped: 0, missing_products: 0 }

  const vendors = marketConfig.vendors ?? []
  if (vendors.length === 0) {
    warnings.push(`No vendors found in market config for market_id='${marketId}'`)
  }

  for (const vendor of vendors) {
    if (!vendor.slug) {
      warnings.push(`Vendor '${vendor.vendor_id}': missing slug; skipping`)
      vendorCounts.skipped++
      continue
    }

    try {
      const result = await upsertSeller(sellerModuleService, vendor, dryRun, marketId)

      if (result.action === "created") vendorCounts.created++
      else if (result.action === "updated") vendorCounts.updated++
      else vendorCounts.skipped++

      // SellerProductLink sync — skip for suspended vendors
      const isSuspended = vendorStatusToStoreStatus(vendor.status) === "SUSPENDED"
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

        let vendorProducts: { products?: Array<{ product_id: string }> } = {}
        try {
          vendorProducts = await readYamlFile(vendorProductsPath)
        } catch {
          // No products.yaml — not an error
        }

        for (const vp of vendorProducts.products ?? []) {
          const fixtureId = vp.product_id
          if (!fixtureId) continue

          let products: any[] = []
          try {
            const listFn =
              typeof productModuleService.listProducts === "function"
                ? (f: any) => productModuleService.listProducts(f)
                : (f: any) => productModuleService.list(f)
            products = (await listFn({ metadata: { gp: { fixture_id: fixtureId } } })) ?? []
          } catch {
            // try alternate lookup
          }

          const product = products[0]
          if (!product?.id) {
            warnings.push(
              `Vendor '${vendor.vendor_id}': product fixture_id='${fixtureId}' not found in DB; skipping SPL`
            )
            splCounts.missing_products++
            continue
          }

          // Upsert SellerProductLink
          if (dryRun) {
            console.log(
              `[dry-run] Would link seller='${result.sellerId}' → product='${product.id}'`
            )
            splCounts.created++
            continue
          }

          try {
            const splService = resolveService(container, [
              "sellerProductLink",
              "seller_product_link",
              "ISellerProductLinkService",
            ])
            await splService.upsert({ seller_id: result.sellerId, product_id: product.id })
            splCounts.created++
          } catch {
            splCounts.skipped++
          }
        }
      }
    } catch (err: any) {
      warnings.push(`Vendor '${vendor.vendor_id}': ${err?.message ?? String(err)}`)
      vendorCounts.skipped++
    }
  }

  const summary: SyncSummary = {
    ok: warnings.length === 0,
    instance_id: instanceId,
    market_id: marketId,
    vendors: vendorCounts,
    spl: splCounts,
    warnings,
  }

  console.log(JSON.stringify(summary, null, 2))

  if (warnings.length > 0) {
    process.exitCode = 1
  }
}
