/**
 * Story v160-8-5: GET /admin/operator/alerting — firing alerts + 24h history
 * + auto-rollback history. POST /run triggers re-evaluation.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  evaluateAlerts,
  listConfiguredAlerts,
} from "../../../../lib/alert-evaluator"
import {
  runAlertEvaluatorTick,
  getFiringHistory24h,
} from "../../../../jobs/alert-evaluator-cron"

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const current = await evaluateAlerts()
  res.json({
    firing: current.firing,
    history_24h: getFiringHistory24h(),
    auto_rollback_history: [], // populated by automated-rollback module via audit log; surface DEFER
    configured: listConfiguredAlerts(),
    computed_at: current.computed_at,
  })
}

export async function POST(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const tick = await runAlertEvaluatorTick()
  res.json(tick)
}
