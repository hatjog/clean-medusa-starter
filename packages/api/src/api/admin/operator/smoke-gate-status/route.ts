/**
 * Story v160-8-7: GET /admin/operator/smoke-gate-status — Phase B aggregator.
 * Story v160-cleanup-15f — AC1+AC2 wiring: pass real cohort metrics + DB
 *   handle so smoke gate items reflect real p95/5xx + last ratification
 *   reads from DB.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { computeCohortMetrics } from "../../../../lib/cohort-metrics-aggregator"
import { computeSmokeGateState } from "../../../../lib/phase-b-smoke-gate-aggregator"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const cohortMetrics = await computeCohortMetrics({ db })
  const state = await computeSmokeGateState(db, cohortMetrics)
  res.json(state)
}
