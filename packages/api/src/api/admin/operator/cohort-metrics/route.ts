/**
 * Story v160-8-4: GET /admin/operator/cohort-metrics — 4 cohorts × 4 KPIs.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { computeCohortMetrics } from "../../../../lib/cohort-metrics-aggregator"

let _cache: Awaited<ReturnType<typeof computeCohortMetrics>> | null = null
let _cacheAt = 0

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  if (!_cache || Date.now() - _cacheAt > 60_000) {
    _cache = await computeCohortMetrics({ db })
    _cacheAt = Date.now()
  }
  res.json(_cache)
}
