import { afterEach, describe, expect, it } from "@jest/globals"

import { _resetForTest, recordRequest } from "../request-log-aggregator"

type PersistedAuditRow = {
  id: string
  from_state: "off" | "shadow" | "on"
  to_state: "off" | "shadow" | "on"
  triggered_by: string
  reason: string | null
  alert_id: string | null
  smoke_gate_ref: string | null
  admin_note: string | null
  cache_invalidate_outcome: unknown
  at: string
}

function createFlagAuditDb(initialRows: PersistedAuditRow[] = []) {
  const rows = [...initialRows]
  const rawHandlers: Array<{
    match: RegExp
    resolve: () => Array<Record<string, unknown>>
  }> = []

  const db = ((table: string) => {
    if (table !== "operator_multi_vendor_flag_audit") {
      throw new Error(`unexpected table ${table}`)
    }

    const builder = {
      select() {
        return this
      },
      orderBy() {
        return this
      },
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

  ;(db as unknown as { raw: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }).raw =
    async (sql: string) => {
      const handler = rawHandlers.find(({ match }) => match.test(sql))
      return { rows: handler ? handler.resolve() : [] }
    }

  return {
    db,
    onRaw(match: RegExp, resolve: () => Array<Record<string, unknown>>) {
      rawHandlers.push({ match, resolve })
    },
  }
}

describe("cohort-metrics-aggregator", () => {
  afterEach(() => {
    _resetForTest()
  })

  it("returns unknown KPI states when no request samples exist", async () => {
    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator")
    const result = await computeCohortMetrics()

    expect(result.cohorts.first_24h_on.p95_latency_ms).toMatchObject({
      value: null,
      sample_size: 0,
      status: "unknown",
    })
    expect(result.cohorts.first_24h_on.error_rate_pct).toMatchObject({
      value: null,
      sample_size: 0,
      status: "unknown",
    })
  })

  it("classifies p95 latency and 5xx rate from real request-log samples", async () => {
    const now = Date.now()
    ;[100, 200, 300, 400, 600].forEach((duration_ms) => {
      recordRequest({
        ts: now - 1_000,
        duration_ms,
        status_code: duration_ms === 600 ? 500 : 200,
      })
    })

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator")
    const result = await computeCohortMetrics()
    const cohort = result.cohorts.first_24h_on

    expect(cohort.p95_latency_ms).toMatchObject({
      value: 600,
      sample_size: 5,
      status: "yellow",
      threshold: "≤ 500ms (AR55)",
    })
    expect(cohort.error_rate_pct).toMatchObject({
      value: 20,
      sample_size: 5,
      status: "red",
      threshold: "≤ 1.0% (AR56)",
    })
  })

  it("derives cohort windows from the persisted flag audit trail", async () => {
    const shadowAt = Date.parse("2026-05-01T10:00:00.000Z")
    const onAt = Date.parse("2026-05-03T10:00:00.000Z")
    const now = Date.parse("2026-05-05T10:00:00.000Z")

    const { db } = createFlagAuditDb([
      {
        id: "db_1",
        from_state: "off",
        to_state: "shadow",
        triggered_by: "operator_a",
        reason: null,
        alert_id: null,
        smoke_gate_ref: null,
        admin_note: null,
        cache_invalidate_outcome: {},
        at: new Date(shadowAt).toISOString(),
      },
      {
        id: "db_2",
        from_state: "shadow",
        to_state: "on",
        triggered_by: "operator_b",
        reason: null,
        alert_id: null,
        smoke_gate_ref: "rat_1",
        admin_note: null,
        cache_invalidate_outcome: {},
        at: new Date(onAt).toISOString(),
      },
    ])

    recordRequest({
      ts: shadowAt - 60 * 60 * 1000,
      duration_ms: 450,
      status_code: 200,
    })
    recordRequest({
      ts: shadowAt + 60 * 60 * 1000,
      duration_ms: 650,
      status_code: 200,
    })
    recordRequest({
      ts: onAt + 60 * 60 * 1000,
      duration_ms: 200,
      status_code: 503,
    })
    recordRequest({
      ts: onAt + 30 * 60 * 60 * 1000,
      duration_ms: 300,
      status_code: 200,
    })

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator")
    const result = await computeCohortMetrics({ db, nowMs: now })

    expect(result.cohorts.pre_flip_baseline.p95_latency_ms).toMatchObject({
      value: 450,
      sample_size: 1,
      status: "green",
    })
    expect(result.cohorts.shadow_window.p95_latency_ms).toMatchObject({
      value: 650,
      sample_size: 1,
      status: "yellow",
    })
    expect(result.cohorts.first_24h_on.error_rate_pct).toMatchObject({
      value: 100,
      sample_size: 1,
      status: "red",
    })
    expect(result.cohorts.sustained_on.p95_latency_ms).toMatchObject({
      value: 300,
      sample_size: 1,
      status: "green",
    })
  })

  it("returns unknown nps with reason when sample_size is below MIN_REVIEWS_FOR_NPS threshold", async () => {
    // cleanup-22: 4 reviews < MIN_REVIEWS_FOR_NPS=5 → unknown + reason
    const shadowAt = Date.parse("2026-05-01T10:00:00.000Z")
    const onAt = Date.parse("2026-05-03T10:00:00.000Z")
    const now = Date.parse("2026-05-05T10:00:00.000Z")

    const { db, onRaw } = createFlagAuditDb([
      {
        id: "db_1",
        from_state: "off",
        to_state: "shadow",
        triggered_by: "operator_a",
        reason: null,
        alert_id: null,
        smoke_gate_ref: null,
        admin_note: null,
        cache_invalidate_outcome: {},
        at: new Date(shadowAt).toISOString(),
      },
      {
        id: "db_2",
        from_state: "shadow",
        to_state: "on",
        triggered_by: "operator_b",
        reason: null,
        alert_id: null,
        smoke_gate_ref: null,
        admin_note: null,
        cache_invalidate_outcome: {},
        at: new Date(onAt).toISOString(),
      },
    ])

    // Insufficient sample: 4, 2, 3, 1 reviews — all below MIN_REVIEWS_FOR_NPS=5
    const reviewRows = [
      { review_count: 4, avg_rating: 4.2 },
      { review_count: 2, avg_rating: 4.4 },
      { review_count: 3, avg_rating: 4.6 },
      { review_count: 1, avg_rating: 3.8 },
    ]
    const orderRows = [
      { order_count: 2 },
      { order_count: 1 },
      { order_count: 2 },
      { order_count: 1 },
    ]

    onRaw(/FROM review r/i, () => [reviewRows.shift() ?? { review_count: 0, avg_rating: null }])
    onRaw(/FROM event_store es/i, () => [orderRows.shift() ?? { order_count: 0 }])

    recordRequest({ ts: shadowAt - 2 * 60 * 60 * 1000, duration_ms: 120, status_code: 200 })
    recordRequest({ ts: shadowAt - 60 * 60 * 1000, duration_ms: 140, status_code: 200 })
    recordRequest({ ts: shadowAt + 60 * 60 * 1000, duration_ms: 160, status_code: 200 })
    recordRequest({ ts: onAt + 60 * 60 * 1000, duration_ms: 180, status_code: 200 })
    recordRequest({ ts: onAt + 2 * 60 * 60 * 1000, duration_ms: 200, status_code: 200 })
    recordRequest({ ts: onAt + 30 * 60 * 60 * 1000, duration_ms: 220, status_code: 200 })

    const { computeCohortMetrics } = await import("../cohort-metrics-aggregator")
    const result = await computeCohortMetrics({ db, nowMs: now })

    // NPS: all cohorts have insufficient reviews → unknown + reason
    expect(result.cohorts.pre_flip_baseline.nps).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    expect(result.cohorts.first_24h_on.nps).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    // Conversion: < MIN_VISITS_FOR_CONVERSION (2 requests) → unknown
    expect(result.cohorts.pre_flip_baseline.conversion).toMatchObject({
      value: null,
      status: "unknown",
      reason: "insufficient_sample",
    })
    // p95/5xx wiring preserved (AR55/AR56 regression test)
    expect(result.cohorts.pre_flip_baseline.p95_latency_ms).toMatchObject({
      value: expect.any(Number),
      status: expect.stringMatching(/^(green|yellow|red)$/),
    })
  })

  it("activates the zero-opt-in cascade for shadow/on flag states", async () => {
    const { computeZeroOptInCascade } = await import("../cohort-metrics-aggregator")
    const result = await computeZeroOptInCascade(0, "shadow")

    expect(result).toMatchObject({
      opted_in_count: 0,
      cascade_active: true,
      current_step: "retrigger_t30",
      remediation_url: "/app/operator/kickoff",
    })
  })
})