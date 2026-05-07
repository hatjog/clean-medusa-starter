/**
 * Story v160-8-5: GET /admin/operator/alerting — firing alerts + 24h history
 * + auto-rollback history. POST /run triggers re-evaluation.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import {
  evaluateAlerts,
  listConfiguredAlerts,
} from "../../../../lib/alert-evaluator"
import {
  getRollbackHistory24h,
  runAlertEvaluatorTick,
  getFiringHistory24h,
  getLastTick,
  getTickHistory24h,
  SCHEDULE_CRON,
  SCHEDULE_NAME,
} from "../../../../jobs/alert-evaluator-cron"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const current = await evaluateAlerts({
    db,
    scope: req.scope as { resolve: (key: string) => unknown },
  })
  const tick_history_24h = await getTickHistory24h(db)

  // Parse ?rollback_limit=<N> — clamp [1, 500], fallback to default 50 on invalid input.
  const rawLimit = Number.parseInt(String(req.query?.rollback_limit ?? ""), 10)
  const rollback_limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 500 ? rawLimit : 50

  res.json({
    firing: current.firing,
    history_24h: await getFiringHistory24h(db),
    auto_rollback_history: await getRollbackHistory24h(db, { limit: rollback_limit }),
    configured: listConfiguredAlerts(),
    computed_at: current.computed_at,
    tick_history_24h,
    last_tick: tick_history_24h[0] ?? (await getLastTick(db)),
    scheduler: {
      name: SCHEDULE_NAME,
      schedule: SCHEDULE_CRON,
    },
  })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const tick = await runAlertEvaluatorTick({
    db,
    scope: req.scope as { resolve: (key: string) => unknown },
    triggered_by: "manual",
  })
  res.json(tick)
}
