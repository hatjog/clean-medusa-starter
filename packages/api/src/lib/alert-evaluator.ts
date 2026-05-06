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

import yaml from "js-yaml"
import type { Knex } from "knex"

import * as cohortMetricsModule from "./cohort-metrics-aggregator"
import * as flagModule from "./feature-flag-tri-state"
import * as smokeGateModule from "./phase-b-smoke-gate-aggregator"
import {
  buildDecisionListEntry,
  listSellers,
} from "./vendor-decision-store"

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

type ScopeResolver = {
  resolve: (key: string) => unknown
}

export type EvaluateAlertsOptions = {
  db?: Knex | null
  scope?: ScopeResolver | null
}

let _configCache: AlertConfig[] | null = null

function loadConfig(): AlertConfig[] {
  if (_configCache) return _configCache
  const candidates = [
    path.resolve(process.cwd(), "../../gp-ops/alerting/multi-vendor-alerts.yaml"),
    path.resolve(process.cwd(), "../../../gp-ops/alerting/multi-vendor-alerts.yaml"),
    path.resolve(process.cwd(), "../../../../gp-ops/alerting/multi-vendor-alerts.yaml"),
    path.resolve(process.cwd(), "../gp-ops/alerting/multi-vendor-alerts.yaml"),
    path.resolve(process.cwd(), "gp-ops/alerting/multi-vendor-alerts.yaml"),
    process.env.GP_ALERTING_CONFIG_PATH || "",
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
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
export async function evaluateAlerts(
  options: EvaluateAlertsOptions = {},
): Promise<EvaluationResult> {
  return evaluateAlertsWithOptions(options)
}

function daysToFlagFlip(): number | null {
  const raw = process.env.GP_FLAG_FLIP_DATE
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return Math.floor((parsed.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
}

function buildFiringAlert(
  alert: AlertConfig,
  computedAt: string,
  evaluatedValue: string | number | null,
): FiringAlert {
  return {
    ...alert,
    firing_since: computedAt,
    evaluated_value: evaluatedValue,
  }
}

export async function evaluateAlertsWithOptions(
  options: EvaluateAlertsOptions = {},
): Promise<EvaluationResult> {
  const config = loadConfig()
  const force = (process.env.GP_ALERT_FORCE_FIRE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const computed_at = new Date().toISOString()

  const [cohortMetrics, currentState, sellers, persistedAudit, smokeGateState] =
    await Promise.all([
      cohortMetricsModule.computeCohortMetrics({ db: options.db ?? null }),
      flagModule.getCurrentState(options.db ?? null),
      options.scope ? listSellers(options.scope) : Promise.resolve([]),
      options.db
        ? flagModule.getPersistedAuditTrail(options.db, 200)
        : Promise.resolve(flagModule.getAuditTrail(200)),
      smokeGateModule.computeSmokeGateState(options.db ?? null),
    ])

  const decisionEntries = sellers.map(buildDecisionListEntry)
  const optedInCount = decisionEntries.filter(
    (seller) => seller.decision_status === "opted_in",
  ).length
  const pendingDecisionCount = decisionEntries.filter(
    (seller) => seller.decision_status === "pending",
  ).length
  const openSellerCount = decisionEntries.filter(
    (seller) => seller.lifecycle_status === "open",
  ).length
  const suspendedSellerCount = decisionEntries.filter(
    (seller) => seller.lifecycle_status === "suspended",
  ).length
  const pendingDecisionPct =
    openSellerCount > 0 ? (pendingDecisionCount / openSellerCount) * 100 : 0
  const daysRemaining = daysToFlagFlip()

  const cacheInvalidateFailures1h = persistedAudit.filter((entry) => {
    const errorCount = Array.isArray(
      (entry.cache_invalidate_outcome as { errors?: unknown[] } | undefined)
        ?.errors,
    )
      ? ((entry.cache_invalidate_outcome as { errors?: unknown[] }).errors?.length ?? 0)
      : 0

    return Date.parse(entry.at) >= Date.now() - 60 * 60 * 1000 && errorCount > 0
  }).length

  const smokeGateDrift =
    smokeGateState.last_ratified?.verdict === "pass" &&
    smokeGateState.computed === "fail"

  const first24h = cohortMetrics.cohorts.first_24h_on
  const firing: FiringAlert[] = []

  for (const alert of config) {
    if (force.includes(alert.id)) {
      firing.push(buildFiringAlert(alert, computed_at, "synthetic_breach"))
      continue
    }

    switch (alert.id) {
      case "nfr_alert_1_p95_latency":
        if (
          typeof first24h.p95_latency_ms.value === "number" &&
          first24h.p95_latency_ms.value > 500
        ) {
          firing.push(
            buildFiringAlert(alert, computed_at, first24h.p95_latency_ms.value),
          )
        }
        break
      case "nfr_alert_2_5xx_error_rate":
        if (
          typeof first24h.error_rate_pct.value === "number" &&
          first24h.error_rate_pct.value > 1.0
        ) {
          firing.push(
            buildFiringAlert(alert, computed_at, first24h.error_rate_pct.value),
          )
        }
        break
      case "nfr_alert_3_zero_opted_in":
        if (
          optedInCount === 0 &&
          (currentState === "shadow" || currentState === "on")
        ) {
          firing.push(buildFiringAlert(alert, computed_at, optedInCount))
        }
        break
      case "nfr_alert_4_conversion_drop":
        if (
          typeof first24h.conversion.value === "number" &&
          typeof cohortMetrics.cohorts.pre_flip_baseline.conversion.value === "number"
        ) {
          const baselineConversion = cohortMetrics.cohorts.pre_flip_baseline.conversion.value
          const dropPct =
            baselineConversion > 0
              ? Number(
                  (((baselineConversion - first24h.conversion.value) / baselineConversion) * 100).toFixed(2),
                )
              : 0

          if (dropPct > 20) {
            firing.push(buildFiringAlert(alert, computed_at, dropPct))
          }
        }
        break
      case "nfr_alert_5_cache_invalidate_failures":
        if (cacheInvalidateFailures1h > 5) {
          firing.push(
            buildFiringAlert(alert, computed_at, cacheInvalidateFailures1h),
          )
        }
        break
      case "nfr_alert_6_vendor_lifecycle_anomaly":
        if (suspendedSellerCount > 3) {
          firing.push(
            buildFiringAlert(alert, computed_at, suspendedSellerCount),
          )
        }
        break
      case "nfr_alert_7_kickoff_no_decision_breach":
        if (
          daysRemaining !== null &&
          daysRemaining < 5 &&
          pendingDecisionPct > 30
        ) {
          firing.push(
            buildFiringAlert(
              alert,
              computed_at,
              Number(pendingDecisionPct.toFixed(2)),
            ),
          )
        }
        break
      case "nfr_alert_8_smoke_gate_drift":
        if (smokeGateDrift) {
          firing.push(buildFiringAlert(alert, computed_at, "post_pass_fail"))
        }
        break
      default:
        break
    }
  }

  return { firing, computed_at }
}

export function listConfiguredAlerts(): AlertConfig[] {
  return loadConfig()
}
