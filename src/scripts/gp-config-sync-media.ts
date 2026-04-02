import { ExecArgs } from "@medusajs/framework/types"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import { DryRunCollector, parseDryRunFlag } from "./gp-sync-dry-run"

type ProductsCatalogCategory = {
  category_id: string
  slug: string
  handle?: string
  photo_url?: string
}

type ProductsCatalogCollection = {
  collection_id: string
  handle?: string
  photo_url?: string
}

type ProductsCatalogProduct = {
  product_id: string
  slug: string
  photo_url?: string
  gallery_urls?: string[]
}

type VendorProductsCatalogProduct = {
  product_id: string
  photo_url?: string | null
  gallery_urls?: string[]
}

type VendorProductsCatalog = {
  vendor_id: string
  market_id: string
  products: VendorProductsCatalogProduct[]
}

type ProductsCatalog = {
  market_id: string
  collections?: ProductsCatalogCollection[]
  categories: ProductsCatalogCategory[]
  products: ProductsCatalogProduct[]
}

type ProductImageLike = {
  id?: string
  url?: string
}

function uniqOrderedNonEmpty(values: Array<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const v of values) {
    const trimmed = (v ?? "").trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }

  return out
}

function computeProductMedia(input: {
  photo_url?: string | null
  gallery_urls?: string[]
}): { thumbnail?: string; image_urls?: string[] } {
  const gallery = Array.isArray(input.gallery_urls) ? input.gallery_urls : []
  const thumbnail = (input.photo_url ?? gallery[0])?.trim()
  const imageUrls = uniqOrderedNonEmpty([input.photo_url, ...gallery])

  const result: { thumbnail?: string; image_urls?: string[] } = {}
  if (thumbnail) result.thumbnail = thumbnail
  if (imageUrls.length) result.image_urls = imageUrls

  return result
}

function readGpMarketId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const marketId = (value as { metadata?: { gp?: { market_id?: unknown } } }).metadata?.gp?.market_id
  return typeof marketId === 'string' && marketId.trim() ? marketId.trim() : null
}

function selectCollectionMatch(matches: any[], marketId: string): { match?: any; reason?: string } {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {}
  }

  const exactMatches = matches.filter(match => readGpMarketId(match) === marketId)
  if (exactMatches.length === 1) {
    return { match: exactMatches[0] }
  }

  if (exactMatches.length > 1) {
    return {
      reason:
        `multiple collections found for market '${marketId}' and handle collision prevents safe update`
    }
  }

  const untaggedMatches = matches.filter(match => readGpMarketId(match) === null)
  if (untaggedMatches.length === 1) {
    return { match: untaggedMatches[0] }
  }

  if (untaggedMatches.length > 1) {
    return {
      reason: 'multiple untagged collections found for the same handle; manual cleanup required'
    }
  }

  const knownMarkets = [...new Set(matches.map(match => readGpMarketId(match)).filter(Boolean))]
  return {
    reason: knownMarkets.length > 0
      ? `cross-market guard — entity belongs to '${knownMarkets.join(", ")}'`
      : 'no eligible collection match found'
  }
}

export async function syncCollectionMedia(
  productModuleService: any,
  collections: ProductsCatalogCollection[],
  marketId: string,
  warnings: string[],
  collector?: DryRunCollector
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0

  for (const collection of collections ?? []) {
    const coverUrl = collection.photo_url?.trim()
    if (!coverUrl) {
      collector?.add({
        entityType: "collection-media",
        handle: (collection.handle ?? collection.collection_id ?? "").trim() || collection.collection_id,
        action: "skip",
        note: "missing photo_url",
      })
      skipped++
      continue
    }

    const handle = (collection.handle ?? collection.collection_id ?? '').trim()
    if (!handle) {
      warnings.push(
        `Collection '${collection.collection_id}': missing handle; cannot resolve collection`
      )
      collector?.add({
        entityType: "collection-media",
        handle: collection.collection_id,
        action: "skip",
        note: "missing handle",
      })
      skipped++
      continue
    }

    const matches = await productModuleService.listProductCollections({ handle })
    const { match: dbCollection, reason } = selectCollectionMatch(matches ?? [], marketId)
    if (!dbCollection?.id) {
      warnings.push(
        `Collection '${collection.collection_id}' handle='${handle}': ${reason ?? 'no Mercur collection found'}`
      )
      collector?.add({
        entityType: "collection-media",
        handle,
        action: "skip",
        note: reason ?? "no Mercur collection found",
      })
      skipped++
      continue
    }

    if (collector) {
      collector.add({
        entityType: "collection-media",
        handle,
        action: "update",
        note: "photo_url",
      })
    } else {
      await productModuleService.updateProductCollections(dbCollection.id, {
        metadata: {
          ...(dbCollection.metadata ?? {}),
          photo_url: coverUrl,
          gp: {
            ...((dbCollection.metadata as any)?.gp ?? {}),
            market_id: marketId,
          },
        },
      })
    }

    updated++
  }

  return { updated, skipped }
}

export function parseArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")).trim()
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

export default async function gpConfigSyncMedia({ container, args }: ExecArgs) {
  const { instanceId, marketId, configRoot, dryRun } = parseArgs(args)
  const collector = dryRun ? new DryRunCollector() : undefined
  const productsPath = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "products.yaml"
  )

  const catalog = await readYamlFile<ProductsCatalog>(productsPath)
  if (catalog.market_id !== marketId) {
    throw new Error(
      `market_id mismatch in ${productsPath}: expected '${marketId}', got '${catalog.market_id}'`
    )
  }

  const productModuleService = resolveService(container, [
    "product",
    "productModuleService",
    "product_module",
  ])

  const warnings: string[] = []
  let collectionsUpdated = 0
  let collectionsSkipped = 0
  let categoriesUpdated = 0
  let categoriesSkipped = 0
  let productsUpdated = 0
  let productsSkipped = 0
  let vendorMediaUpdated = 0
  let vendorMediaCleared = 0
  let vendorMediaSkipped = 0

  const handleByProductId = new Map<string, string>()
  for (const p of catalog.products ?? []) {
    const productId = (p.product_id ?? "").trim()
    const handle = (p.slug ?? "").trim()
    if (productId && handle && !handleByProductId.has(productId)) {
      handleByProductId.set(productId, handle)
    }
  }

  // 1) Collections: collections[].photo_url -> Mercur ProductCollection.metadata.photo_url
  const collectionMediaCounts = await syncCollectionMedia(
    productModuleService,
    catalog.collections ?? [],
    marketId,
    warnings,
    collector
  )
  collectionsUpdated = collectionMediaCounts.updated
  collectionsSkipped = collectionMediaCounts.skipped

  // 2) Categories: categories[].photo_url -> Mercur ProductCategory.metadata.photo_url
  for (const category of catalog.categories ?? []) {
    const coverUrl = category.photo_url?.trim()
    if (!coverUrl) {
      collector?.add({
        entityType: "category-media",
        handle: (category.handle ?? category.slug ?? category.category_id).trim(),
        action: "skip",
        note: "missing photo_url",
      })
      categoriesSkipped++
      continue
    }

    const handle = (category.handle ?? category.slug)?.trim()
    if (!handle) {
      warnings.push(`Category '${category.category_id}': missing slug/handle; cannot resolve category`)
      collector?.add({
        entityType: "category-media",
        handle: category.category_id,
        action: "skip",
        note: "missing slug/handle",
      })
      categoriesSkipped++
      continue
    }

    const matches = await productModuleService.listProductCategories({ handle })
    const { match: dbCategory, reason } = selectCollectionMatch(matches ?? [], marketId)
    if (!dbCategory?.id) {
      warnings.push(
        `Category '${category.category_id}' handle='${handle}': ${reason ?? 'no Mercur category found'}`
      )
      collector?.add({
        entityType: "category-media",
        handle,
        action: "skip",
        note: reason ?? "no Mercur category found",
      })
      categoriesSkipped++
      continue
    }

    const mergedMetadata = {
      ...(dbCategory.metadata ?? {}),
      photo_url: coverUrl,
      gp: {
        ...((dbCategory.metadata as any)?.gp ?? {}),
        market_id: marketId,
      },
    }

    if (collector) {
      collector.add({
        entityType: "category-media",
        handle,
        action: "update",
        note: "photo_url",
      })
    } else {
      await productModuleService.updateProductCategories(dbCategory.id, { metadata: mergedMetadata })
    }
    categoriesUpdated++
  }

  // 3) Products: products[].photo_url/gallery_urls -> Mercur Product.thumbnail + Product.images[]
  for (const product of catalog.products ?? []) {
    const media = computeProductMedia({
      photo_url: product.photo_url,
      gallery_urls: product.gallery_urls,
    })

    if (!media.thumbnail && !media.image_urls?.length) {
      collector?.add({
        entityType: "product-media",
        handle: (product.slug ?? product.product_id).trim(),
        action: "skip",
        note: "missing media",
      })
      productsSkipped++
      continue
    }

    const handle = product.slug?.trim()
    if (!handle) {
      warnings.push(`Product '${product.product_id}': missing slug; cannot resolve product`)
      collector?.add({
        entityType: "product-media",
        handle: product.product_id,
        action: "skip",
        note: "missing slug",
      })
      productsSkipped++
      continue
    }

    const matches = await productModuleService.listProducts(
      { handle },
      { relations: ["images"] }
    )
    const { match: dbProduct, reason: matchReason } = selectCollectionMatch(matches ?? [], marketId)
    if (!dbProduct?.id) {
      warnings.push(`Product '${product.product_id}': ${matchReason ?? `no Mercur product found with handle='${handle}'`}`)
      collector?.add({
        entityType: "product-media",
        handle,
        action: "skip",
        note: matchReason ?? "no Mercur product found",
      })
      continue
    }

    const existingImagesByUrl = new Map<string, ProductImageLike>()
    for (const img of (dbProduct.images ?? []) as ProductImageLike[]) {
      const url = img?.url?.trim()
      if (!url) continue
      if (!existingImagesByUrl.has(url)) {
        existingImagesByUrl.set(url, img)
      }
    }

    const desiredImagesPayload = (media.image_urls ?? []).map((url) => {
      const existing = existingImagesByUrl.get(url)
      return existing?.id ? { id: existing.id, url } : { url }
    })

    if (collector) {
      collector.add({
        entityType: "product-media",
        handle,
        action: "update",
        note: `thumbnail=${media.thumbnail ? "yes" : "no"}; images=${desiredImagesPayload.length}`,
      })
    } else {
      await productModuleService.updateProducts(dbProduct.id, {
        ...(media.thumbnail ? { thumbnail: media.thumbnail } : {}),
        ...(desiredImagesPayload.length ? { images: desiredImagesPayload } : {}),
      })
    }

    productsUpdated++
  }

  // 4) Vendor overrides: vendors/*/products.yaml photo_url/gallery_urls -> Product.metadata.gp.vendor_media[vendor_id]
  const vendorsDir = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "vendors"
  )

  const vendorDirEntries = await fs.readdir(vendorsDir, { withFileTypes: true }).catch((err: any) => {
    if (err?.code !== 'ENOENT') {
      warnings.push(`Vendor directory read failed (${vendorsDir}): ${err?.message ?? String(err)}`)
    }
    return []
  })
  const productCacheByHandle = new Map<
    string,
    { id: string; metadata?: Record<string, any> | null }
  >()

  for (const ent of vendorDirEntries) {
    if (!ent.isDirectory()) continue

    const vendorIdFromDir = ent.name.trim()
    const vendorProductsPath = path.resolve(vendorsDir, vendorIdFromDir, "products.yaml")

    let vendorCatalog: VendorProductsCatalog
    try {
      vendorCatalog = await readYamlFile<VendorProductsCatalog>(vendorProductsPath)
    } catch {
      // no vendor products.yaml (or invalid YAML) – ignore silently to keep script resilient
      continue
    }

    const vendorId = (vendorCatalog.vendor_id ?? vendorIdFromDir).trim()
    if (!vendorId) {
      warnings.push(`Vendor dir '${vendorIdFromDir}': missing vendor_id; skipping`)
      continue
    }

    if ((vendorCatalog.market_id ?? "").trim() && vendorCatalog.market_id !== marketId) {
      warnings.push(
        `Vendor '${vendorId}': market_id mismatch in ${vendorProductsPath}: expected '${marketId}', got '${vendorCatalog.market_id}'`
      )
      continue
    }

    for (const vp of vendorCatalog.products ?? []) {
      const explicitClear =
        vp.photo_url === null && Array.isArray(vp.gallery_urls) && vp.gallery_urls.length === 0

      const media = explicitClear
        ? null
        : computeProductMedia({
            photo_url: vp.photo_url,
            gallery_urls: vp.gallery_urls,
          })

      const hasMedia = !!(media && (media.thumbnail || media.image_urls?.length))
      if (!explicitClear && !hasMedia) {
        collector?.add({
          entityType: "vendor-media",
          handle: (handleByProductId.get(vp.product_id ?? "") ?? vp.product_id ?? "").trim() || vendorId,
          action: "skip",
          note: `vendor_id=${vendorId}; missing media`,
        })
        vendorMediaSkipped++
        continue
      }

      const productId = (vp.product_id ?? "").trim()
      if (!productId) {
        warnings.push(`Vendor '${vendorId}': product entry missing product_id; skipping`)
        collector?.add({
          entityType: "vendor-media",
          handle: vendorId,
          action: "skip",
          note: "missing product_id",
        })
        continue
      }

      const handle = (handleByProductId.get(productId) ?? productId).trim()
      if (!handle) {
        warnings.push(`Vendor '${vendorId}': cannot resolve handle for product_id='${productId}'`)
        collector?.add({
          entityType: "vendor-media",
          handle: productId,
          action: "skip",
          note: `vendor_id=${vendorId}; cannot resolve handle`,
        })
        continue
      }

      let dbProduct = productCacheByHandle.get(handle)
      if (!dbProduct) {
        const matches = await productModuleService.listProducts({ handle })
        const p = matches?.[0]
        if (!p?.id) {
          warnings.push(
            `Vendor '${vendorId}': no Mercur product found with handle='${handle}' (product_id='${productId}')`
          )
          collector?.add({
            entityType: "vendor-media",
            handle,
            action: "skip",
            note: `vendor_id=${vendorId}; no Mercur product found`,
          })
          continue
        }
        dbProduct = { id: p.id, metadata: (p as any).metadata ?? null }
        productCacheByHandle.set(handle, dbProduct)
      }

      const existingMetadata = (dbProduct.metadata ?? {}) as Record<string, any>
      const existingGp = (existingMetadata.gp ?? {}) as Record<string, any>
      const existingVendorMedia = (existingGp.vendor_media ?? {}) as Record<string, any>

      const nextVendorMedia = { ...existingVendorMedia }
      if (explicitClear) {
        if (vendorId in nextVendorMedia) {
          delete nextVendorMedia[vendorId]
        }
      } else {
        nextVendorMedia[vendorId] = {
          ...(media?.thumbnail ? { thumbnail: media.thumbnail } : {}),
          ...(media?.image_urls?.length ? { images: media.image_urls.map((url) => ({ url })) } : {}),
        }
      }

      const nextMetadata = {
        ...existingMetadata,
        gp: {
          ...existingGp,
          vendor_media: nextVendorMedia,
        },
      }

      if (collector) {
        collector.add({
          entityType: "vendor-media",
          handle,
          action: "update",
          note: explicitClear ? `vendor_id=${vendorId}; clear` : `vendor_id=${vendorId}; set`,
        })
      } else {
        await productModuleService.updateProducts(dbProduct.id, {
          metadata: nextMetadata,
        })
      }

      // Update cache only after successful DB write
      productCacheByHandle.set(handle, { ...dbProduct, metadata: nextMetadata })
      if (explicitClear) vendorMediaCleared++
      else vendorMediaUpdated++
    }
  }

  if (dryRun && collector) {
    console.log(collector.renderTable())
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: dryRun,
        instance_id: instanceId,
        market_id: marketId,
        config_root: configRoot,
        products_path: productsPath,
        collections: {
          updated: collectionsUpdated,
          skipped: collectionsSkipped,
        },
        categories: {
          updated: categoriesUpdated,
          skipped: categoriesSkipped,
        },
        products: {
          updated: productsUpdated,
          skipped: productsSkipped,
        },
        vendor_media: {
          updated: vendorMediaUpdated,
          cleared: vendorMediaCleared,
          skipped: vendorMediaSkipped,
        },
        warnings,
      },
      null,
      2
    )
  )
}
