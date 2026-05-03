/**
 * Story v160-8-5: Alert evaluator cron — every 60s evaluates thresholds,
 * persists firing history, invokes auto-rollback on P1 firings.
 *
 * Note: cron registration follows Medusa job conventions; in v1.6.0 this
 * baseline is invocable via direct call — wiring to scheduler-loader is
 * DEFER to v1.7.0+ (no scheduler currently active in baseline).
 */

import { evaluateAlerts } from "../lib/alert-evaluator"
import { triggerRollback } from "../lib/automated-rollback"

const _firingHistory: Array<{
  alert_id: string
  severity: string
  firing_since: string
}> = []

export async function runAlertEvaluatorTick(): Promise<{
  firing_count: number
  auto_rollbacks: number
}> {
  const result = await evaluateAlerts()
  let auto_rollbacks = 0
  for (const alert of result.firing) {
    _firingHistory.push({
      alert_id: alert.id,
      severity: alert.severity,
      firing_since: alert.firing_since,
    })
    if (alert.action === "auto_rollback") {
      const rb = await triggerRollback(alert.id, `Auto-rollback by ${alert.id}`)
      if (rb.rolled_back) auto_rollbacks++
    }
  }
  // Cap history to last 1000 entries.
  if (_firingHistory.length > 1000) {
    _firingHistory.splice(0, _firingHistory.length - 1000)
  }
  return { firing_count: result.firing.length, auto_rollbacks }
}

export function getFiringHistory24h(): typeof _firingHistory {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  return _firingHistory.filter((e) => Date.parse(e.firing_since) >= cutoff)
}

export const config = {
  name: "alert-evaluator-cron",
  schedule: "*/60 * * * * *",
}
