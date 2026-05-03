/**
 * Story v160-8-4: GET /admin/operator/cohort-metrics — 4 cohorts × 4 KPIs.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { computeCohortMetrics } from "../../../../lib/cohort-metrics-aggregator"

let _cache: Awaited<ReturnType<typeof computeCohortMetrics>> | null = null
let _cacheAt = 0

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!_cache || Date.now() - _cacheAt > 60_000) {
    _cache = await computeCohortMetrics()
    _cacheAt = Date.now()
  }
  res.json(_cache)
}
