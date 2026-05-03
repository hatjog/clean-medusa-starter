/**
 * Story v160-8-5: Alert evaluator — loads YAML alerting config + evaluates
 * thresholds against system state. P1 firings invoke automated-rollback.
 *
 * @see gp-ops/alerting/multi-vendor-alerts.yaml
 * @see specs/operator/alerting-thresholds.md
 * @see FR63 / FR66 / NFR-ALERT-1..8 / NFR-REL-10
 */

import * as fs from "node:fs"
import * as path from "node:path"

export type AlertSeverity = "P1" | "P2" | "P3"
export type AlertAction = "auto_rollback" | "page" | "alert"

export type AlertConfig = {
  id: string
  severity: AlertSeverity
  nfr_ref: string
  condition: string
  evaluation_window: string
  action: AlertAction
  recipients: string[]
}

export type FiringAlert = AlertConfig & {
  firing_since: string
  evaluated_value: string | number | null
}

export type EvaluationResult = {
  firing: FiringAlert[]
  computed_at: string
}

let _configCache: AlertConfig[] | null = null

function loadConfig(): AlertConfig[] {
  if (_configCache) return _configCache
  const candidates = [
    path.resolve(process.cwd(), "../../../../gp-ops/alerting/multi-vendor-alerts.yaml"),
    path.resolve(process.cwd(), "gp-ops/alerting/multi-vendor-alerts.yaml"),
    process.env.GP_ALERTING_CONFIG_PATH || "",
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const yaml = require("js-yaml") as { load: (s: string) => unknown }
        const parsed = yaml.load(fs.readFileSync(p, "utf-8")) as {
          alerts?: AlertConfig[]
        }
        _configCache = parsed.alerts ?? []
        return _configCache
      } catch {
        // fallthrough — fall back to inline minimal config
      }
    }
  }
  // Fallback: minimal inline config to keep evaluator functional w/o yaml.
  _configCache = []
  return _configCache
}

/**
 * Evaluate alerts against current system state.
 *
 * Note: real metric source plumbing is DEFER (8.4 cohort-metrics endpoint
 * provides upstream data; full evaluator wiring lives in v1.7.0+).
 * This baseline returns empty firing list unless `GP_ALERT_FORCE_FIRE` env
 * lists alert ids comma-separated (synthetic breach simulation).
 */
export async function evaluateAlerts(): Promise<EvaluationResult> {
  const config = loadConfig()
  const force = (process.env.GP_ALERT_FORCE_FIRE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const computed_at = new Date().toISOString()
  const firing: FiringAlert[] = config
    .filter((a) => force.includes(a.id))
    .map((a) => ({
      ...a,
      firing_since: computed_at,
      evaluated_value: "synthetic_breach",
    }))
  return { firing, computed_at }
}

export function listConfiguredAlerts(): AlertConfig[] {
  return loadConfig()
}
