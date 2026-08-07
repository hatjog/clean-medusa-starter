/**
 * Story v160-8-4: GET /admin/operator/cohort-metrics — 4 cohorts × 4 KPIs.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { computeCohortMetrics } from "../../../../lib/cohort-metrics-aggregator"
import {
  MARKET_SCOPE_DENIED_COHORT,
  computeRangeStats,
} from "../../../../lib/request-log-aggregator"

let _cache: Awaited<ReturnType<typeof computeCohortMetrics>> | null = null
let _cacheAt = 0

/**
 * Okno odczytu licznika odmów scopingu katalogu. Zgodne z cache'em tej trasy
 * (60 s), żeby operator widział ten sam odcinek czasu co reszta odpowiedzi.
 */
const MARKET_SCOPE_DENIED_WINDOW_MS = 60 * 60_000

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  if (!_cache || Date.now() - _cacheAt > 60_000) {
    _cache = await computeCohortMetrics({ db })
    _cacheAt = Date.now()
  }

  // Story 2.3 review-fix HIGH-1: PRODUKCYJNY czytelnik kohorty
  // `market-scope-denied`. Bez niego metryka NFR-2 była zapisywana i przez
  // nikogo nieodczytywana poza testem story — czyli nie była kanałem
  // obserwowalności, tylko zapisem do kosza. Odczyt jest JAWNIE kohortowy,
  // więc nie miesza się z KPI ruchu (te kohortę wykluczają).
  const nowMs = Date.now()
  const marketScopeDenied = computeRangeStats(
    nowMs - MARKET_SCOPE_DENIED_WINDOW_MS,
    nowMs,
    MARKET_SCOPE_DENIED_COHORT,
  )

  res.json({
    ..._cache,
    market_scope_denied: {
      cohort: MARKET_SCOPE_DENIED_COHORT,
      window_ms: MARKET_SCOPE_DENIED_WINDOW_MS,
      denials: marketScopeDenied.sample_size,
      window_start_ms: marketScopeDenied.window_start_ms,
      window_end_ms: marketScopeDenied.window_end_ms,
    },
  })
}
