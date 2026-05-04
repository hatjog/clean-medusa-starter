import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /store/sellers/cities
 *
 * Returns distinct seller cities scoped to the current sales channel.
 *
 * NOTE: Mercur 2 seller entity no longer has a `city` column (removed in
 * Mercur 2 schema — the old `seller_seller_product_product` junction table
 * also no longer exists). This endpoint now returns an empty list.
 *
 * TODO(v1.7.0): Re-implement using address join or market config once the
 * city data model is clarified for Mercur 2.
 * Tracking: story v160-cleanup-1, AC2 + AC3, source: epic-1 CRITICAL-1.1
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  // seller.city column does not exist in Mercur 2 — return empty list to
  // prevent `relation does not exist` crash against fresh Mercur 2 DB.
  res.json({ cities: [] });
}
