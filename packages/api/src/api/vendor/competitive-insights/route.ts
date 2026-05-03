/**
 * Story v160-7-7: GET /vendor/competitive-insights — vendor's per-category metrics.
 *
 * Vendor scope endpoint. Real Mercur 2 product/variant query DEFERRED — Wave 15
 * ships handler skeleton + aggregator module; in production env, replace
 * `loadDevFixture()` with SQL query against Mercur 2 product/variant tables.
 *
 * Privacy: returns ONLY aggregates + vendor's own metrics (zero competitor PII).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  getCompetitiveInsights,
  type CategoryProductSnapshot,
  type CompetitiveInsightsData,
} from "../../../lib/competitive-insights-aggregator"

function loadDevFixture(): CategoryProductSnapshot[] {
  const raw = process.env.GP_INSIGHTS_DEV_FIXTURE_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as CategoryProductSnapshot[]
  } catch {
    return []
  }
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<CompetitiveInsightsData>,
): Promise<void> {
  // Vendor scope JWT resolution DEFERRED. Stub vendor_id from header.
  const vendorId =
    (req.headers["x-vendor-id"] as string | undefined) ?? "vendor_dev"

  // Production: cross-vendor query against Mercur 2 product/variant tables
  // grouped by category, filtered to vendor's market.
  // Wave 15: dev fixture from env var.
  const snapshots = loadDevFixture()

  const data = getCompetitiveInsights(vendorId, snapshots)

  res.json(data)
}
