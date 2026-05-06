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

import type { Knex } from "knex"

import { getPersistedAuditTrail } from "./feature-flag-tri-state"
import { computeRangeStats, computeWindowStats } from "./request-log-aggregator"

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
const NPS_GREEN_MIN = 40
const NPS_YELLOW_MIN = 30
const CONVERSION_RATIO_GREEN_MIN = 0.9
const CONVERSION_RATIO_YELLOW_MIN = 0.75

// Cohort time windows (ms) — used to slice the request-log aggregator.
const WINDOW_MS_BY_COHORT: Record<Cohort, number> = {
  pre_flip_baseline: 7 * 24 * 60 * 60 * 1000, // last 7 days
  shadow_window: 48 * 60 * 60 * 1000, // 48h shadow phase
  first_24h_on: 24 * 60 * 60 * 1000,
  sustained_on: 7 * 24 * 60 * 60 * 1000,
}

type CohortWindow = {
  startMs: number
  endMs: number
}

type CohortMetricsOptions = {
  db?: Knex | null
  nowMs?: number
}

type RatingStats = {
  sample_size: number
  avg_rating: number | null
}

type OrderStats = {
  order_count: number
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

function classifyNps(score: number): KPIStatus {
  if (score >= NPS_GREEN_MIN) return "green"
  if (score >= NPS_YELLOW_MIN) return "yellow"
  return "red"
}

function classifyConversionRatio(ratioToBaseline: number): KPIStatus {
  if (ratioToBaseline >= CONVERSION_RATIO_GREEN_MIN) return "green"
  if (ratioToBaseline >= CONVERSION_RATIO_YELLOW_MIN) return "yellow"
  return "red"
}

function normalizeRatingToSatisfactionScore(avgRating: number): number {
  return Number((((avgRating - 1) / 4) * 100).toFixed(2))
}

async function readReviewStats(
  db: Knex | null | undefined,
  startMs: number,
  endMs: number,
): Promise<RatingStats | null> {
  if (!db) {
    return null
  }

  try {
    const result = await db.raw(
      `SELECT
         COUNT(r.id)::int AS review_count,
         AVG(r.rating)::float AS avg_rating
       FROM review r
       WHERE r.deleted_at IS NULL
         AND r.created_at >= ?::timestamptz
         AND r.created_at < ?::timestamptz`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    )
    const row = Array.isArray(result?.rows) ? result.rows[0] : result?.[0]
    if (!row) {
      return null
    }
    return {
      sample_size: Number(row.review_count ?? 0),
      avg_rating:
        row.avg_rating === null || row.avg_rating === undefined
          ? null
          : Number(row.avg_rating),
    }
  } catch {
    return null
  }
}

async function readOrderStats(
  db: Knex | null | undefined,
  startMs: number,
  endMs: number,
): Promise<OrderStats | null> {
  if (!db) {
    return null
  }

  try {
    const result = await db.raw(
      `SELECT COUNT(*)::int AS order_count
       FROM event_store es
       WHERE es.occurred_at >= ?::timestamptz
         AND es.occurred_at < ?::timestamptz
         AND es.event_type IN ('gp.commerce.order_placed.v1', 'gp.commerce.order_placed.v2')`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    )
    const row = Array.isArray(result?.rows) ? result.rows[0] : result?.[0]
    if (!row) {
      return null
    }
    return {
      order_count: Number(row.order_count ?? 0),
    }
  } catch {
    return null
  }
}

function buildFallbackWindows(nowMs: number): Record<Cohort, CohortWindow> {
  return {
    pre_flip_baseline: {
      startMs: nowMs - WINDOW_MS_BY_COHORT.pre_flip_baseline,
      endMs: nowMs,
    },
    shadow_window: {
      startMs: nowMs - WINDOW_MS_BY_COHORT.shadow_window,
      endMs: nowMs,
    },
    first_24h_on: {
      startMs: nowMs - WINDOW_MS_BY_COHORT.first_24h_on,
      endMs: nowMs,
    },
    sustained_on: {
      startMs: nowMs - WINDOW_MS_BY_COHORT.sustained_on,
      endMs: nowMs,
    },
  }
}

async function resolveCohortWindows(
  db: Knex | null | undefined,
  nowMs: number,
): Promise<Record<Cohort, CohortWindow>> {
  const fallback = buildFallbackWindows(nowMs)
  if (!db) {
    return fallback
  }

  const auditTrail = (await getPersistedAuditTrail(db, 200))
    .slice()
    .reverse()
  const firstShadowTransition = auditTrail.find((entry) => entry.to === "shadow")

  if (!firstShadowTransition) {
    return fallback
  }

  const shadowStartMs = Date.parse(firstShadowTransition.at)
  if (Number.isNaN(shadowStartMs)) {
    return fallback
  }

  const firstOnTransition = auditTrail.find(
    (entry) => entry.to === "on" && Date.parse(entry.at) >= shadowStartMs,
  )
  const onStartMs = firstOnTransition ? Date.parse(firstOnTransition.at) : null
  if (onStartMs !== null && Number.isNaN(onStartMs)) {
    return fallback
  }

  const shadowEndMs = onStartMs ?? nowMs
  const first24hEndMs =
    onStartMs === null ? nowMs : Math.min(onStartMs + WINDOW_MS_BY_COHORT.first_24h_on, nowMs)
  const sustainedStartMs =
    onStartMs === null ? nowMs : Math.min(onStartMs + WINDOW_MS_BY_COHORT.first_24h_on, nowMs)

  return {
    pre_flip_baseline: {
      startMs: shadowStartMs - WINDOW_MS_BY_COHORT.pre_flip_baseline,
      endMs: shadowStartMs,
    },
    shadow_window: {
      startMs: shadowStartMs,
      endMs: shadowEndMs,
    },
    first_24h_on: {
      startMs: onStartMs ?? nowMs,
      endMs: first24hEndMs,
    },
    sustained_on: {
      startMs: sustainedStartMs,
      endMs: nowMs,
    },
  }
}

export async function computeCohortMetrics(
  options: CohortMetricsOptions = {},
): Promise<CohortMetricsResult> {
  const nowMs = options.nowMs ?? Date.now()
  const cohortWindows = await resolveCohortWindows(options.db, nowMs)
  const cohorts: Partial<Record<Cohort, Record<KPI, KPIMeasurement>>> = {}
  const conversionRates: Partial<Record<Cohort, number | null>> = {}
  for (const cohort of COHORTS) {
    const window = cohortWindows[cohort]
    const stats = window
      ? computeRangeStats(window.startMs, window.endMs)
      : computeWindowStats(WINDOW_MS_BY_COHORT[cohort], undefined, nowMs)
    const [reviewStats, orderStats] = await Promise.all([
      window
        ? readReviewStats(options.db, window.startMs, window.endMs)
        : Promise.resolve(null),
      window
        ? readOrderStats(options.db, window.startMs, window.endMs)
        : Promise.resolve(null),
    ])

    const normalizedNps =
      reviewStats && reviewStats.sample_size > 0 && reviewStats.avg_rating !== null
        ? normalizeRatingToSatisfactionScore(reviewStats.avg_rating)
        : null
    const conversionRate =
      orderStats && stats.sample_size > 0
        ? Number(((orderStats.order_count / stats.sample_size) * 100).toFixed(2))
        : null

    conversionRates[cohort] = conversionRate
    const kpis: Partial<Record<KPI, KPIMeasurement>> = {}
    for (const kpi of KPIS) {
      if (kpi === "nps") {
        if (normalizedNps === null) {
          kpis[kpi] = { ...unknown(), threshold: THRESHOLDS[kpi] }
        } else {
          kpis[kpi] = {
            value: normalizedNps,
            sample_size: reviewStats?.sample_size ?? 0,
            threshold: THRESHOLDS[kpi],
            status: classifyNps(normalizedNps),
          }
        }
      } else if (kpi === "conversion") {
        kpis[kpi] = {
          ...unknown(),
          threshold: THRESHOLDS[kpi],
        }
      } else if (kpi === "p95_latency_ms") {
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
      }
    }
    cohorts[cohort] = kpis as Record<KPI, KPIMeasurement>
  }

  const baselineConversion = conversionRates.pre_flip_baseline ?? null
  for (const cohort of COHORTS) {
    const conversionRate = conversionRates[cohort] ?? null
    if (conversionRate === null || baselineConversion === null || baselineConversion <= 0) {
      cohorts[cohort]!.conversion = {
        ...unknown(),
        threshold: THRESHOLDS.conversion,
      }
      continue
    }

    const ratioToBaseline = cohort === "pre_flip_baseline" ? 1 : conversionRate / baselineConversion
    cohorts[cohort]!.conversion = {
      value: conversionRate,
      sample_size: cohorts[cohort]!.p95_latency_ms.sample_size,
      threshold: `${THRESHOLDS.conversion}; baseline=${baselineConversion.toFixed(2)}%`,
      status: classifyConversionRatio(ratioToBaseline),
    }
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
