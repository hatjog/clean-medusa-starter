import { ExecArgs } from "@medusajs/framework/types"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

type ProductsCatalogCategory = {
  category_id: string
  slug: string
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

function parseArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")).trim()

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

export default async function gpConfigSyncMedia({ container, args }: ExecArgs) {
  const { instanceId, marketId, configRoot } = parseArgs(args)
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

  const productCategoryService = resolveService(container, [
    "productCategoryService",
    "productCategory",
    "product_category",
  ])

  const warnings: string[] = []
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

  // 1) Categories: categories[].photo_url -> Mercur ProductCategory.metadata.photo_url
  for (const category of catalog.categories ?? []) {
    const coverUrl = category.photo_url?.trim()
    if (!coverUrl) {
      categoriesSkipped++
      continue
    }

    const handle = (category.handle ?? category.slug)?.trim()
    if (!handle) {
      warnings.push(`Category '${category.category_id}': missing slug/handle; cannot resolve category`)
      continue
    }

    const matches = await productCategoryService.list({ handle })
    const dbCategory = matches?.[0]
    if (!dbCategory?.id) {
      warnings.push(
        `Category '${category.category_id}': no Mercur category found with handle='${handle}'`
      )
      continue
    }

    const mergedMetadata = {
      ...(dbCategory.metadata ?? {}),
      photo_url: coverUrl,
    }

    await productCategoryService.update([{ id: dbCategory.id, metadata: mergedMetadata }])
    categoriesUpdated++
  }

  // 2) Products: products[].photo_url/gallery_urls -> Mercur Product.thumbnail + Product.images[]
  for (const product of catalog.products ?? []) {
    const media = computeProductMedia({
      photo_url: product.photo_url,
      gallery_urls: product.gallery_urls,
    })

    if (!media.thumbnail && !media.image_urls?.length) {
      productsSkipped++
      continue
    }

    const handle = product.slug?.trim()
    if (!handle) {
      warnings.push(`Product '${product.product_id}': missing slug; cannot resolve product`)
      continue
    }

    const matches = await productModuleService.listProducts(
      { handle },
      { relations: ["images"] }
    )
    const dbProduct = matches?.[0]
    if (!dbProduct?.id) {
      warnings.push(`Product '${product.product_id}': no Mercur product found with handle='${handle}'`)
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

    await productModuleService.updateProducts(dbProduct.id, {
      ...(media.thumbnail ? { thumbnail: media.thumbnail } : {}),
      ...(desiredImagesPayload.length ? { images: desiredImagesPayload } : {}),
    })

    productsUpdated++
  }

  // 3) Vendor overrides: vendors/*/products.yaml photo_url/gallery_urls -> Product.metadata.gp.vendor_media[vendor_id]
  const vendorsDir = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "vendors"
  )

  const vendorDirEntries = await fs.readdir(vendorsDir, { withFileTypes: true }).catch(() => [])
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
        vendorMediaSkipped++
        continue
      }

      const productId = (vp.product_id ?? "").trim()
      if (!productId) {
        warnings.push(`Vendor '${vendorId}': product entry missing product_id; skipping`)
        continue
      }

      const handle = (handleByProductId.get(productId) ?? productId).trim()
      if (!handle) {
        warnings.push(`Vendor '${vendorId}': cannot resolve handle for product_id='${productId}'`)
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

      await productModuleService.updateProducts(dbProduct.id, {
        metadata: nextMetadata,
      })

      dbProduct.metadata = nextMetadata
      if (explicitClear) vendorMediaCleared++
      else vendorMediaUpdated++
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        instance_id: instanceId,
        market_id: marketId,
        config_root: configRoot,
        products_path: productsPath,
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
