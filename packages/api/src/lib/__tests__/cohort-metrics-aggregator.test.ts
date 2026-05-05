import { afterEach, describe, expect, it } from "@jest/globals"

import { _resetForTest, recordRequest } from "../request-log-aggregator"

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