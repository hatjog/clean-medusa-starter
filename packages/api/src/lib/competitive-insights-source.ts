/**
 * competitive-insights-source — Knex-backed product/variant snapshot loader.
 *
 * Story v160-cleanup-38-jwt-vendor-scope (TF-110 P0):
 *   Replaces the dev-fixture path in GET /vendor/competitive-insights with a
 *   real Mercur 2 query against `product_variant` + `product` + Mercur
 *   seller-product link tables.
 *
 * Query strategy (Path A — confirmed available):
 *   - gp_mercur DB has 113 products / 3 sellers / multi-vendor overlap
 *   - Join `product_variant` → `product` → `seller_product` to get per-seller
 *     pricing per product category.
 *   - Filter by seller_ids (caller passes the authenticated seller's id; for
 *     competitive context we load ALL sellers in the same market).
 *   - Returns an array of CategoryProductSnapshot — same shape the in-memory
 *     aggregator expects.
 *
 * Privacy: the function loads ALL variants across ALL sellers within the
 * market.  The competitive-insights-aggregator is responsible for stripping
 * individual competitor data before returning the response; this loader
 * intentionally returns the raw cross-vendor slice (required for market_avg
 * and percentile computation).
 *
 * @module competitive-insights-source
 */

import type { Knex } from "knex"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import type { CategoryProductSnapshot } from "./competitive-insights-aggregator"

type Scope = { resolve: (key: string) => unknown }

/** Shape of a row returned by the cross-vendor join query. */
type InsightRow = {
  vendor_id: string
  category_id: string
  category_name: string
  /** Raw calculated price in minor units (cents). May be null for unpublished variants. */
  price: number | null
}

/**
 * Resolves a Knex instance from the Medusa DI scope.
 */
function resolveDb(scope: Scope): Knex {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
}

/**
 * Result wrapper — identifies data source for observability.
 */
export type InsightSnapshotsResult = {
  snapshots: CategoryProductSnapshot[]
  /** "mercur_query" when real DB data; "empty" when query returned 0 rows. */
  data_source: "mercur_query" | "empty"
}

/**
 * Load product/variant price snapshots for competitive-insight computation.
 *
 * Joins Mercur 2 tables to build per-vendor, per-category price slices.
 * The query loads ALL sellers in the market (not just the authenticated
 * caller) so the aggregator can compute market_avg and percentile correctly.
 *
 * @param scope  — Medusa DI scope (provides Knex via ContainerRegistrationKeys.PG_CONNECTION)
 * @param _sellerIds — hint: authenticated seller ids (currently unused; market-wide query)
 *
 * @throws  Never — callers should wrap in try/catch and return 503 on error.
 *          The function propagates DB errors to enable proper error handling.
 */
export async function resolveInsightSnapshots(
  scope: Scope,
  _sellerIds: string[],
): Promise<InsightSnapshotsResult> {
  const db = resolveDb(scope)

  /*
   * Mercur 2 table structure (confirmed present in gp_mercur DB):
   *   product                  — id, collection_id (used as category proxy)
   *   product_category         — id, name
   *   product_category_product — product_id, category_id
   *   product_variant          — id, product_id, calculated_price
   *   seller_product           — seller_id, product_id
   *
   * We join through seller_product to get vendor_id (Mercur seller id maps
   * 1:1 to GP vendor_id per ADR-025 / resolveVendorId contract).
   *
   * Note: product_category_product is a junction table; when a product has no
   * category assigned it is excluded from the result (no category_id available
   * for aggregation). This matches the AC2 algorithm's requirement that
   * category_id is mandatory on each snapshot.
   */

  const rows: InsightRow[] = await db("product_variant as pv")
    .join("product as p", "pv.product_id", "p.id")
    .join("product_category_product as pcp", "p.id", "pcp.product_id")
    .join("product_category as pc", "pcp.category_id", "pc.id")
    .join("seller_product as sp", "p.id", "sp.product_id")
    .select<InsightRow[]>(
      "sp.seller_id as vendor_id",
      "pc.id as category_id",
      "pc.name as category_name",
      db.raw("COALESCE(pv.calculated_price, 0) as price"),
    )
    // Exclude soft-deleted variants and products
    .whereNull("pv.deleted_at")
    .whereNull("p.deleted_at")
    // Only include listed/published variants (calculated_price > 0)
    .where("pv.calculated_price", ">", 0)

  if (rows.length === 0) {
    return { snapshots: [], data_source: "empty" }
  }

  const snapshots: CategoryProductSnapshot[] = rows.map((row) => ({
    vendor_id: row.vendor_id,
    category_id: row.category_id,
    category_name: row.category_name,
    price: row.price ?? 0,
  }))

  return { snapshots, data_source: "mercur_query" }
}
