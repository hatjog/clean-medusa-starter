/**
 * Multi-vendor resolver for /store/products responses.
 *
 * Story: v160-cleanup-12a — backend /store/products multi-vendor resolver
 * Gate: MULTI_VENDOR_PRICING_ENABLED env var (must equal "true" exactly)
 *
 * Design:
 * - Single batched Knex query joining product_seller + seller + product_variant_price
 * - No N+1: one query per request for all product IDs in the page
 * - Deterministic sort: (price_pln ASC, seller_id ASC)
 * - Seller eligibility: status = 'open' AND not in active time-off window
 *
 * @see specs/architecture — product_seller Mercur 2 link table
 * @see patches/@mercurjs__core@2.1.1.patch — traversal pattern reference
 */

import type { Knex } from "knex"

export type VendorOfferOption = {
  seller_id: string
  seller_name: string
  seller_handle: string
  price_pln: number
  lat: number | null
  lng: number | null
}

export type ProductVendorMeta = {
  vendor_count: number
  lowest_price_pln: number | null
  vendor_offers: VendorOfferOption[]
}

type SellerPriceRow = {
  product_id: string
  seller_id: string
  seller_name: string
  seller_handle: string
  /** calculated_amount in cents (number or string from DB) */
  min_price: string | number | null
}

/** Seller open-status filter (Mercur 2 — 'open' is lowercase). */
const SELLER_OPEN_STATUS = "open"

/**
 * Resolve vendor metadata for a batch of product IDs.
 *
 * Returns a Map<product_id, ProductVendorMeta>.
 * Products not in the map have no open sellers.
 */
export async function resolveVendorMeta(
  db: Knex,
  productIds: string[],
): Promise<Map<string, ProductVendorMeta>> {
  if (!productIds.length) return new Map()

  const now = new Date().toISOString()

  /**
   * Subquery strategy:
   *  - Join product_product_seller_seller (ppss) → seller (s)
   *  - Left join product_variant (pv) → product_variant_price_set (pvps) → price (p)
   *  - Filter seller: status = 'open' AND not in closed_from..closed_to window
   *  - Group by (product_id, seller_id) → take MIN(p.amount) as min_price
   *
   * Table names (Mercur 2 / Medusa 2):
   *   - product_product_seller_seller: cross-module link table (product ↔ seller)
   *   - product_variant_price_set: variant → price_set bridge
   *   - price: actual price amounts (price_set_id, currency_code, amount)
   *
   * NOTE: The code-comment "product_seller" in seller/route.ts was stale docs;
   * the real table is product_product_seller_seller per actual DB schema.
   */
  const rows = await db("product_product_seller_seller as ppss")
    .select<SellerPriceRow[]>([
      "ppss.product_id",
      "ppss.seller_id",
      "s.name as seller_name",
      "s.handle as seller_handle",
      db.raw("MIN(p.amount) as min_price"),
    ])
    .innerJoin("seller as s", "ppss.seller_id", "s.id")
    .leftJoin("product_variant as pv", "ppss.product_id", "pv.product_id")
    .leftJoin("product_variant_price_set as pvps", function () {
      this.on("pv.id", "=", "pvps.variant_id").andOnNull("pvps.deleted_at")
    })
    .leftJoin("price as p", function () {
      this.on("pvps.price_set_id", "=", "p.price_set_id").andOnNull("p.deleted_at")
    })
    .whereIn("ppss.product_id", productIds)
    .where("s.status", SELLER_OPEN_STATUS)
    // Not in active time-off window: closed_from is null OR closed_from > now
    .where(function () {
      this.whereNull("s.closed_from").orWhere("s.closed_from", ">", now)
    })
    // closed_to is null OR closed_to < now
    .where(function () {
      this.whereNull("s.closed_to").orWhere("s.closed_to", "<", now)
    })
    .whereNull("ppss.deleted_at")
    .whereNull("s.deleted_at")
    .whereNull("pv.deleted_at")
    .groupBy("ppss.product_id", "ppss.seller_id", "s.name", "s.handle")

  // Build product → [offer, ...] map
  const offersByProduct = new Map<string, VendorOfferOption[]>()

  for (const row of rows) {
    const pricePln =
      row.min_price != null ? Number(row.min_price) : 0

    const offer: VendorOfferOption = {
      seller_id: row.seller_id,
      seller_name: row.seller_name,
      seller_handle: row.seller_handle,
      price_pln: pricePln,
      lat: null,
      lng: null,
    }

    const existing = offersByProduct.get(row.product_id)
    if (existing) {
      existing.push(offer)
    } else {
      offersByProduct.set(row.product_id, [offer])
    }
  }

  // Deterministic sort: price_pln ASC, seller_id ASC (closes review F2)
  const result = new Map<string, ProductVendorMeta>()

  for (const [productId, offers] of offersByProduct.entries()) {
    const sorted = [...offers].sort((a, b) => {
      if (a.price_pln !== b.price_pln) return a.price_pln - b.price_pln
      return a.seller_id < b.seller_id ? -1 : a.seller_id > b.seller_id ? 1 : 0
    })

    const lowestPrice =
      sorted.length > 0 ? sorted[0].price_pln : null

    result.set(productId, {
      vendor_count: sorted.length,
      lowest_price_pln: lowestPrice,
      vendor_offers: sorted,
    })
  }

  return result
}

/**
 * Augment a product list with vendor metadata in-place.
 *
 * Products with no open sellers get:
 *   vendor_count: 0, lowest_price_pln: null, vendor_offers: []
 *
 * @param products - array of product objects (mutated)
 * @param db - Knex connection
 */
export async function augmentProductsWithVendorMeta(
  products: Array<Record<string, unknown>>,
  db: Knex,
): Promise<void> {
  const productIds = products
    .map((p) => p.id as string)
    .filter(Boolean)

  if (!productIds.length) return

  const metaMap = await resolveVendorMeta(db, productIds)

  for (const product of products) {
    const id = product.id as string
    const meta = metaMap.get(id)
    if (meta) {
      product.vendor_count = meta.vendor_count
      product.lowest_price_pln = meta.lowest_price_pln
      product.vendor_offers = meta.vendor_offers
    } else {
      // No open sellers — explicit empty state (closes review F4)
      product.vendor_count = 0
      product.lowest_price_pln = null
      product.vendor_offers = []
    }
  }
}

/**
 * Check if the multi-vendor pricing feature is enabled.
 * Reads MULTI_VENDOR_PRICING_ENABLED env var — must be exactly "true".
 */
export function isMultiVendorPricingEnabled(): boolean {
  return process.env.MULTI_VENDOR_PRICING_ENABLED === "true"
}
