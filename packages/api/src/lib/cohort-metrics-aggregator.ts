/**
 * Story v160-8-4: Post-flip cohort metrics aggregator (4 cohorts × 4 KPIs).
 * Story v160-cleanup-15f — AC1 fix: p95 latency + 5xx rate now read from
 *   request-log-aggregator (real in-process samples) and apply AR55/AR56
 *   thresholds to produce real `green`/`yellow`/`red`/`unknown` status.
 *   NPS + conversion remain `unknown` (need real data sources — separate
 *   v1.7.0 backlog).
 *
 * @see specs/operator/cohort-definitions.md
 * @see FR53 / FR55 / FR56 / FR57 / AR37 / AR40 / AR55 / AR56
 */

import { computeWindowStats } from "./request-log-aggregator"

export type Cohort =
  | "pre_flip_baseline"
  | "shadow_window"
  | "first_24h_on"
  | "sustained_on"

export type KPI = "nps" | "conversion" | "p95_latency_ms" | "error_rate_pct"

export type KPIStatus = "green" | "yellow" | "red" | "unknown"

export type KPIMeasurement = {
  value: number | null
  sample_size: number
  threshold: string
  status: KPIStatus
}

export type CohortMetricsResult = {
  cohorts: Record<Cohort, Record<KPI, KPIMeasurement>>
  computed_at: string
}

const COHORTS: Cohort[] = [
  "pre_flip_baseline",
  "shadow_window",
  "first_24h_on",
  "sustained_on",
]

const KPIS: KPI[] = ["nps", "conversion", "p95_latency_ms", "error_rate_pct"]

const THRESHOLDS: Record<KPI, string> = {
  nps: "≥ 40 (AR37)",
  conversion: "≥ 90% baseline (AR40)",
  p95_latency_ms: "≤ 500ms (AR55)",
  error_rate_pct: "≤ 1.0% (AR56)",
}

// AR55: p95 latency green ≤ 500ms, yellow ≤ 750ms, red > 750ms.
const P95_GREEN_MAX_MS = 500
const P95_YELLOW_MAX_MS = 750

// AR56: 5xx error rate green ≤ 1.0%, yellow ≤ 2.0%, red > 2.0%.
const ERROR_RATE_GREEN_MAX_PCT = 1.0
const ERROR_RATE_YELLOW_MAX_PCT = 2.0

// Cohort time windows (ms) — used to slice the request-log aggregator.
const WINDOW_MS_BY_COHORT: Record<Cohort, number> = {
  pre_flip_baseline: 7 * 24 * 60 * 60 * 1000, // last 7 days
  shadow_window: 48 * 60 * 60 * 1000, // 48h shadow phase
  first_24h_on: 24 * 60 * 60 * 1000,
  sustained_on: 7 * 24 * 60 * 60 * 1000,
}

function unknown(): KPIMeasurement {
  return { value: null, sample_size: 0, threshold: "", status: "unknown" }
}

function classifyP95(p95Ms: number): KPIStatus {
  if (p95Ms <= P95_GREEN_MAX_MS) return "green"
  if (p95Ms <= P95_YELLOW_MAX_MS) return "yellow"
  return "red"
}

function classifyErrorRate(errPct: number): KPIStatus {
  if (errPct <= ERROR_RATE_GREEN_MAX_PCT) return "green"
  if (errPct <= ERROR_RATE_YELLOW_MAX_PCT) return "yellow"
  return "red"
}

export async function computeCohortMetrics(): Promise<CohortMetricsResult> {
  const cohorts: Partial<Record<Cohort, Record<KPI, KPIMeasurement>>> = {}
  for (const cohort of COHORTS) {
    const stats = computeWindowStats(WINDOW_MS_BY_COHORT[cohort])
    const kpis: Partial<Record<KPI, KPIMeasurement>> = {}
    for (const kpi of KPIS) {
      if (kpi === "p95_latency_ms") {
        if (stats.sample_size === 0 || stats.p95_latency_ms === null) {
          kpis[kpi] = { ...unknown(), threshold: THRESHOLDS[kpi] }
        } else {
          kpis[kpi] = {
            value: stats.p95_latency_ms,
            sample_size: stats.sample_size,
            threshold: THRESHOLDS[kpi],
            status: classifyP95(stats.p95_latency_ms),
          }
        }
      } else if (kpi === "error_rate_pct") {
        if (stats.sample_size === 0 || stats.error_rate_5xx_pct === null) {
          kpis[kpi] = { ...unknown(), threshold: THRESHOLDS[kpi] }
        } else {
          kpis[kpi] = {
            value: stats.error_rate_5xx_pct,
            sample_size: stats.sample_size,
            threshold: THRESHOLDS[kpi],
            status: classifyErrorRate(stats.error_rate_5xx_pct),
          }
        }
      } else {
        // NPS + conversion — real data sources deferred to v1.7.0.
        kpis[kpi] = { ...unknown(), threshold: THRESHOLDS[kpi] }
      }
    }
    cohorts[cohort] = kpis as Record<KPI, KPIMeasurement>
  }
  return {
    cohorts: cohorts as Record<Cohort, Record<KPI, KPIMeasurement>>,
    computed_at: new Date().toISOString(),
  }
}

export type CascadeStep =
  | "none"
  | "retrigger_t30"
  | "escalate"
  | "suspend"
  | "rollback_to_shadow"

export type CascadeState = {
  opted_in_count: number
  cascade_active: boolean
  current_step: CascadeStep
  recommended_action: string
  remediation_url: string
}

export async function computeZeroOptInCascade(
  opted_in_count: number,
  flag_state: "off" | "shadow" | "on",
): Promise<CascadeState> {
  const cascade_active =
    opted_in_count === 0 && (flag_state === "shadow" || flag_state === "on")
  if (!cascade_active) {
    return {
      opted_in_count,
      cascade_active: false,
      current_step: "none",
      recommended_action: "No action required.",
      remediation_url: "",
    }
  }
  return {
    opted_in_count,
    cascade_active: true,
    current_step: "retrigger_t30",
    recommended_action: "Re-trigger T-30 kickoff for non-decided vendors.",
    remediation_url: "/app/operator/kickoff",
  }
}
