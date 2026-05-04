/**
 * Story v160-8-4: Post-flip cohort metrics aggregator (4 cohorts × 4 KPIs).
 *
 * @see specs/operator/cohort-definitions.md
 * @see FR53 / FR55 / FR56 / FR57 / AR37 / AR40 / AR55 / AR56
 */

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

function unknown(): KPIMeasurement {
  return { value: null, sample_size: 0, threshold: "", status: "unknown" }
}

export async function computeCohortMetrics(): Promise<CohortMetricsResult> {
  const cohorts: Partial<Record<Cohort, Record<KPI, KPIMeasurement>>> = {}
  for (const cohort of COHORTS) {
    const kpis: Partial<Record<KPI, KPIMeasurement>> = {}
    for (const kpi of KPIS) {
      // Baseline: data sources not yet plumbed (DEFER per AC1 note).
      kpis[kpi] = { ...unknown(), threshold: THRESHOLDS[kpi] }
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
