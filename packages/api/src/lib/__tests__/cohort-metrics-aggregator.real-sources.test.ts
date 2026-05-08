/**
 * Story v160-cleanup-22: Cohort metrics aggregator — real-sources test suite.
 *
 * Covers AC5 scenarios:
 *  (a) NPS happy path — 10 reviews, avg_rating=4.5 → green
 *  (b) NPS insufficient sample — 3 reviews → unknown + reason
 *  (c) Conversion happy path — 50 visits, 5 orders, baseline=10% → green
 *  (d) Conversion insufficient orders — 1 order → unknown + reason
 *  (e) Conversion zero baseline → all cohorts unknown (no_baseline reason)
 *  (f) p95/5xx regression test (cleanup-15f path) GREEN
 *
 * Also covers AC4 (seed scenario assertion) and AC6 (backward-compat
 * optional `reason` field).
 */

import { afterEach, describe, expect, it } from "@jest/globals"

import { _resetForTest, recordRequest } from "../request-log-aggregator.js"

type PersistedAuditRow = {
  id: string
  from_state: "off" | "shadow" | "on"
  to_state: "off" | "shadow" | "on"
  triggered_by: string
  reason: string | null
  alert_id: string | null
  smoke_gate_ref: string | null
  admin_note: null
  cache_invalidate_outcome: unknown
  at: string
}

/**
 * IMPORTANT (cleanup-21 review-fix [LOW]): reviewRows / orderRows are dispensed
 * in array index order, one per `db.raw` call. This implicitly relies on
 * `computeCohortMetrics` iterating cohorts sequentially in COHORTS declaration
 * order: [pre_flip_baseline, shadow_window, first_24h_on, sustained_on].
 * If the aggregator ever changes iteration order or parallelizes the per-cohort
 * DB calls, tests using cohort-specific row positions (e.g. test (e) below)
 * will silently shift their expected reasons. Refactor to a Record<Cohort, …>
 * keyed mock if that happens.
 */
function buildDb(
  auditRows: PersistedAuditRow[],
  reviewRows: Array<{ review_count: number; avg_rating: number | null }>,
  orderRows: Array<{ order_count: number }>,
) {
  let reviewIdx = 0
  let orderIdx = 0
  const rows = [...auditRows]

  const db = ((table: string) => {
    if (table !== "operator_multi_vendor_flag_audit") {
      throw new Error(`unexpected table ${table}`)
    }
    const builder = {
      select() { return this },
      orderBy() { return this },
      async first() {
        return [...rows].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
      },
      async limit(limit: number) {
        return [...rows]
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, limit)
      },
    }
    return builder
  }) as unknown as import("knex").Knex

  ;(db as unknown as {
    raw: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>
  }).raw = async (sql: string) => {
    if (/FROM review r/i.test(sql)) {
      const row = reviewRows[reviewIdx++] ?? { review_count: 0, avg_rating: null }
      return { rows: [row] }
    }
    if (/FROM event_store es/i.test(sql)) {
      const row = orderRows[orderIdx++] ?? { order_count: 0 }
      return { rows: [row] }
    }
    return { rows: [] }
  }

  return db
}

const SHADOW_AT = Date.parse("2026-05-01T10:00:00.000Z")
const ON_AT = Date.parse("2026-05-03T10:00:00.000Z")
const NOW = Date.parse("2026-05-05T10:00:00.000Z")

const BASE_AUDIT_ROWS: PersistedAuditRow[] = [
  {
    id: "a1",
    from_state: "off",
    to_state: "shadow",
    triggered_by: "op",
    reason: null,
    alert_id: null,
    smoke_gate_ref: null,
    admin_note: null,
    cache_invalidate_outcome: {},
    at: new Date(SHADOW_AT).toISOString(),
  },
  {
    id: "a2",
    from_state: "shadow",
    to_state: "on",
    triggered_by: "op",
    reason: null,
    alert_id: null,
    smoke_gate_ref: null,
    admin_note: null,
    cache_invalidate_outcome: {},
    at: new Date(ON_AT).toISOString(),
  },
]

/** Seed enough request-log samples to satisfy MIN_VISITS_FOR_CONVERSION=50 in each cohort window. */
function seedSufficientVisits(nowMs: number = NOW) {
  const shadowAtMs = SHADOW_AT
  const onAtMs = ON_AT

  // pre_flip_baseline window: [shadowAt - 7d, shadowAt) — 50 requests
  for (let i = 0; i < 50; i++) {
    recordRequest({
      ts: shadowAtMs - (i + 1) * 60 * 1000,
      duration_ms: 200 + i,
      status_code: 200,
    })
  }
  // shadow_window: [shadowAt, onAt) — 50 requests
  for (let i = 0; i < 50; i++) {
    recordRequest({
      ts: shadowAtMs + (i + 1) * 60 * 1000,
      duration_ms: 210 + i,
      status_code: 200,
    })
  }
  // first_24h_on: [onAt, onAt+24h) — 50 requests
  for (let i = 0; i < 50; i++) {
    recordRequest({
      ts: onAtMs + (i + 1) * 60 * 1000,
      duration_ms: 220 + i,
      status_code: 200,
    })
  }
  // sustained_on: [onAt+24h, now) — 50 requests
  for (let i = 0; i < 50; i++) {
    recordRequest({
      ts: onAtMs + 25 * 60 * 60 * 1000 + (i + 1) * 60 * 1000,
      duration_ms: 230 + i,
      status_code: 200,
    })
  }
}

describe("cohort-metrics-aggregator — real-sources (cleanup-22)", () => {
  afterEach(() => {
    _resetForTest()
  })

  // (a) NPS happy path: 10 reviews, avg_rating=4.5 → green (sample >= MIN_REVIEWS_FOR_NPS=5)
  it("(a) classifies nps green when sample_size >= MIN_REVIEWS_FOR_NPS (10 reviews, avg=4.5)", async () => {
    // avg_rating=4.5 → normalizeRatingToSatisfactionScore = ((4.5-1)/4)*100 = 87.5 → green (≥40)
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 10, avg_rating: 4.5 }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 0 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    expect(result.cohorts.pre_flip_baseline.nps).toMatchObject({
      value: 87.5,
      sample_size: 10,
      threshold: "≥ 40 (AR37; review-rating proxy)",
      status: "green",
    })
    // reason field should be absent for non-unknown status
    expect(result.cohorts.pre_flip_baseline.nps.reason).toBeUndefined()
    expect(result.cohorts.first_24h_on.nps).toMatchObject({
      value: 87.5,
      sample_size: 10,
      status: "green",
    })
  })

  // (b) NPS insufficient sample: 3 reviews → unknown + reason: "insufficient_sample"
  it("(b) returns nps unknown with reason insufficient_sample when sample_size < 5", async () => {
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 3, avg_rating: 4.5 }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 0 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    expect(result.cohorts.pre_flip_baseline.nps).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    expect(result.cohorts.shadow_window.nps).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    expect(result.cohorts.first_24h_on.nps).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    expect(result.cohorts.sustained_on.nps).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
  })

  // (c) Conversion happy path: 50 visits, 5 orders, baseline=10% → green
  // pre_flip_baseline: 50 visits × 5 orders = 10% rate → baseline=10%; all cohorts ratio=1.0 → green
  it("(c) classifies conversion green when orders >= 3 and visits >= 50 (baseline=10%)", async () => {
    // 5 orders / 50 visits = 10% → baseline; all cohorts same ratio → 1.0 → green
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 0, avg_rating: null }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 5 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)
    seedSufficientVisits()

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    expect(result.cohorts.pre_flip_baseline.conversion).toMatchObject({
      status: "green",
    })
    expect(result.cohorts.pre_flip_baseline.conversion.reason).toBeUndefined()
    expect(result.cohorts.first_24h_on.conversion).toMatchObject({
      status: "green",
    })
  })

  // (d) Conversion insufficient orders: 1 order → unknown + reason: "insufficient_sample"
  it("(d) returns conversion unknown with reason insufficient_sample when orders < 3", async () => {
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 0, avg_rating: null }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 1 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)
    seedSufficientVisits()

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    // cleanup-21 review-fix [MEDIUM]: raw computed rate (1/50 = 2%) is now
    // surfaced even when sample-size gate fails — operators see honest
    // numerator/denominator, status remains unknown to preserve gate semantics.
    expect(result.cohorts.pre_flip_baseline.conversion).toMatchObject({
      value: 2,
      sample_size: 50,
      status: "unknown",
      reason: "insufficient_sample",
    })
  })

  // (e) Conversion zero baseline → all cohorts unknown (no_baseline reason)
  it("(e) returns all cohorts conversion unknown with no_baseline when baseline is zero", async () => {
    // 3 orders / 50 visits → baseline has sufficient sample; but baseline cohort
    // itself has order_count=0 from DB mock → conversionRates.pre_flip_baseline = null (0 < MIN_ORDERS=3)
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 0, avg_rating: null }))
    // First cohort (pre_flip_baseline) gets 0 orders → insufficient_sample → baseline null
    // Other cohorts get 5 orders but baseline null → no_baseline
    const orderRows = [
      { order_count: 0 },
      { order_count: 5 },
      { order_count: 5 },
      { order_count: 5 },
    ]
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)
    seedSufficientVisits()

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    expect(result.cohorts.pre_flip_baseline.conversion).toMatchObject({
      status: "unknown",
      reason: "insufficient_sample",
    })
    expect(result.cohorts.shadow_window.conversion).toMatchObject({
      status: "unknown",
      reason: "no_baseline",
    })
    expect(result.cohorts.first_24h_on.conversion).toMatchObject({
      status: "unknown",
      reason: "no_baseline",
    })
  })

  // (f) p95/5xx regression test (cleanup-15f path) — AR55/AR56 wiring still works
  it("(f) p95 and error_rate_pct still classify from request-log samples (AR55/AR56 regression)", async () => {
    const now = Date.now()
    ;[100, 200, 300, 400, 600].forEach((duration_ms) => {
      recordRequest({
        ts: now - 1_000,
        duration_ms,
        status_code: duration_ms === 600 ? 500 : 200,
      })
    })

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics()

    expect(result.cohorts.first_24h_on.p95_latency_ms).toMatchObject({
      value: 600,
      sample_size: 5,
      status: "yellow",
      threshold: "≤ 500ms (AR55)",
    })
    expect(result.cohorts.first_24h_on.error_rate_pct).toMatchObject({
      value: 20,
      sample_size: 5,
      status: "red",
      threshold: "≤ 1.0% (AR56)",
    })
  })

  // AC4: Seed scenario — 16/16 KPI slots structurally valid (no false green on sample_size=0)
  it("AC4: all 16 KPI slots return structurally valid KPIMeasurement; no false green on zero samples", async () => {
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 0, avg_rating: null }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 0 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    const cohorts = ["pre_flip_baseline", "shadow_window", "first_24h_on", "sustained_on"] as const
    const kpis = ["nps", "conversion", "p95_latency_ms", "error_rate_pct"] as const

    for (const cohort of cohorts) {
      for (const kpi of kpis) {
        const m = result.cohorts[cohort][kpi]
        // Structural validity
        expect(m).toHaveProperty("value")
        expect(m).toHaveProperty("sample_size")
        expect(m).toHaveProperty("threshold")
        expect(m).toHaveProperty("status")
        // No false green on sample_size=0
        if (m.sample_size === 0) {
          expect(m.status).not.toBe("green")
          expect(m.status).not.toBe("yellow")
          expect(m.status).not.toBe("red")
        }
      }
    }
  })

  // AC6: KPIMeasurement backward compatibility — reason is optional
  it("AC6: reason field is optional — existing consumers can omit it without crash", async () => {
    // Green NPS measurement (10 reviews, no reason field)
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 10, avg_rating: 4.5 }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 0 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    const nps = result.cohorts.pre_flip_baseline.nps
    // status=green → reason should be absent (undefined)
    expect(nps.status).toBe("green")
    expect(nps.reason).toBeUndefined()

    // TypeScript type has reason?: string — can destructure without crash
    const { value, sample_size, threshold, status, reason } = nps
    expect(value).toBeDefined()
    expect(sample_size).toBeDefined()
    expect(threshold).toBeDefined()
    expect(status).toBeDefined()
    expect(reason).toBeUndefined()
  })

  // cleanup-21 review-fix [HIGH]: AR55/AR56 unknown branches MUST emit
  // reason field so the smoke-gate aggregator's reason-whitelist applies
  // to real cohort metrics (not just hand-crafted test fixtures).
  it("cleanup-21 review-fix [HIGH]: p95/error_rate unknown branches emit reason: insufficient_sample on zero samples", async () => {
    const reviewRows = Array.from({ length: 4 }, () => ({ review_count: 0, avg_rating: null }))
    const orderRows = Array.from({ length: 4 }, () => ({ order_count: 0 }))
    const db = buildDb(BASE_AUDIT_ROWS, reviewRows, orderRows)

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator.js")
    const result = await computeCohortMetrics({ db, nowMs: NOW })

    expect(result.cohorts.pre_flip_baseline.p95_latency_ms).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    expect(result.cohorts.pre_flip_baseline.error_rate_pct).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
  })
})
