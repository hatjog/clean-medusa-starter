/**
 * Story v160-7-7: Vendor competitive insights aggregator.
 *
 * Computes per-category metrics for a vendor: avg market price, vendor's
 * avg price, percentile rank. Privacy-preserving: returns aggregates only
 * (NEVER individual competitor prices or names).
 *
 * Per AC2 DEFER acceptable — Wave 15 ships an in-memory aggregator that
 * accepts pre-shaped data (production wiring queries Mercur 2 product/variant
 * tables in Sprint 5 polish).
 */

export interface CategoryProductSnapshot {
  vendor_id: string
  category_id: string
  category_name: string
  price: number // in minor units; 0 = excluded from avg
}

export interface CategoryInsight {
  category_id: string
  category_name: string
  product_count: number // for the calling vendor only
  vendor_avg_price: number
  market_avg_price: number
  percentile: number | null // null = solo vendor
  position_label:
    | "top_quartile"
    | "above_average"
    | "below_average"
    | "bottom_quartile"
    | "solo_vendor"
}

export interface CompetitiveInsightsData {
  vendor_id: string
  generated_at: string
  categories: CategoryInsight[]
}

function deriveLabel(
  percentile: number | null,
  totalVendorsInCategory: number,
): CategoryInsight["position_label"] {
  if (percentile === null || totalVendorsInCategory <= 1) return "solo_vendor"
  if (percentile >= 75) return "top_quartile"
  if (percentile >= 50) return "above_average"
  if (percentile >= 25) return "below_average"
  return "bottom_quartile"
}

/**
 * Aggregates vendor's competitive insights.
 *
 * Algorithm per AC2:
 *  (a) Identify vendor's categories (via vendor's product → category links)
 *  (b) Per category: collect ALL variants (across all vendors) with price > 0
 *  (c) Compute market_avg_price (entire market, all vendors)
 *  (d) Compute vendor_avg_price (filter to vendor_id)
 *  (e) Compute percentile: count(other_vendors with avg < vendor_avg) / total_other_vendors * 100
 *  (f) Return per-category result
 *
 * @param vendorId - the calling vendor
 * @param snapshots - all variants in the same market (production: SQL query result)
 */
export function getCompetitiveInsights(
  vendorId: string,
  snapshots: CategoryProductSnapshot[],
): CompetitiveInsightsData {
  // Filter out free / promotional products (price = 0 → exclude per AC4 edge case)
  const filtered = snapshots.filter((s) => s.price > 0)

  // Group by category
  const byCategory = new Map<
    string,
    { name: string; entries: CategoryProductSnapshot[] }
  >()
  for (const s of filtered) {
    const ent = byCategory.get(s.category_id)
    if (ent) {
      ent.entries.push(s)
    } else {
      byCategory.set(s.category_id, {
        name: s.category_name,
        entries: [s],
      })
    }
  }

  const vendorCategories = new Set<string>()
  for (const s of filtered) {
    if (s.vendor_id === vendorId) vendorCategories.add(s.category_id)
  }

  const categories: CategoryInsight[] = []

  for (const catId of vendorCategories) {
    const entry = byCategory.get(catId)
    if (!entry) continue

    // Per-vendor avg in this category
    const perVendor = new Map<string, number[]>()
    for (const s of entry.entries) {
      const arr = perVendor.get(s.vendor_id) ?? []
      arr.push(s.price)
      perVendor.set(s.vendor_id, arr)
    }

    const vendorPrices = perVendor.get(vendorId) ?? []
    const vendorAvg =
      vendorPrices.length > 0
        ? vendorPrices.reduce((a, b) => a + b, 0) / vendorPrices.length
        : 0

    // Market avg = mean of all vendor avgs (per-vendor weighted equally)
    const allAvgs: number[] = []
    for (const [, prices] of perVendor) {
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length
      allAvgs.push(avg)
    }
    const marketAvg =
      allAvgs.length > 0 ? allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length : 0

    // Percentile: count of other vendors with avg < this vendor's avg
    const totalVendors = perVendor.size
    let percentile: number | null
    if (totalVendors <= 1) {
      percentile = null
    } else {
      const otherVendorsBelow = Array.from(perVendor.entries())
        .filter(([id]) => id !== vendorId)
        .map(([, prices]) => prices.reduce((a, b) => a + b, 0) / prices.length)
        .filter((avg) => avg < vendorAvg).length
      percentile = (otherVendorsBelow / (totalVendors - 1)) * 100
    }

    categories.push({
      category_id: catId,
      category_name: entry.name,
      product_count: vendorPrices.length,
      vendor_avg_price: Math.round(vendorAvg),
      market_avg_price: Math.round(marketAvg),
      percentile: percentile === null ? null : Math.round(percentile),
      position_label: deriveLabel(percentile, totalVendors),
    })
  }

  return {
    vendor_id: vendorId,
    generated_at: new Date().toISOString(),
    categories,
  }
}
