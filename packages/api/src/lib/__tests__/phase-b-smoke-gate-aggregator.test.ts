import { describe, expect, it } from "@jest/globals"

import {
  computeSmokeGateState,
  getLastRatification,
  ratifyVerdict,
} from "../phase-b-smoke-gate-aggregator"

/**
 * Cleanup-21: injectable ADR-097 detectors for testing.
 * Avoids `jest.mock("node:fs")` hoisting issues with @swc/jest.
 */
const adr097Present = () => true
const adr097Absent = () => false

/**
 * Helper: cohort metrics with green status for AR55/AR56.
 */
const greenCohortMetrics = {
  cohorts: {
    pre_flip_baseline: {
      p95_latency_ms: { status: "green" },
      error_rate_pct: { status: "green" },
    },
  },
}

/**
 * Helper: cohort metrics with `unknown + insufficient_sample` (cleanup-22 whitelist case).
 */
const unknownInsufficientCohortMetrics = {
  cohorts: {
    pre_flip_baseline: {
      p95_latency_ms: { status: "unknown", reason: "insufficient_sample" },
      error_rate_pct: { status: "unknown", reason: "insufficient_sample" },
    },
  },
}

describe("phase-b-smoke-gate-aggregator", () => {
  it("returns null when the ratifications table is missing", async () => {
    const db = (() => ({
      select: () => ({
        orderBy: () => ({
          first: async () => {
            throw new Error(
              'select * from "phase_b_smoke_gate_ratifications" - relation "phase_b_smoke_gate_ratifications" does not exist'
            )
          },
        }),
      }),
    })) as never

    await expect(getLastRatification(db)).resolves.toBeNull()
  })

  it("has 11 checklist items (10 original + ADR-097 cleanup-21)", async () => {
    const result = await computeSmokeGateState(null)
    expect(result.items).toHaveLength(11)
  })

  it("treats missing cohort metrics as fail because unknown items block PASS", async () => {
    const result = await computeSmokeGateState(null, undefined, { adr097Detector: adr097Absent })

    expect(result.computed).toBe("fail")
    expect(result.last_ratified).toBeNull()
    expect(result.items.find((item) => item.key === "ar55_latency_baseline")).toMatchObject({
      status: "unknown",
    })
    expect(result.items.find((item) => item.key === "nfr_rel_10_auto_rollback")).toMatchObject({
      status: "pass",
    })
  })

  it("returns pass for AR55/AR56 when cohort metrics are green", async () => {
    const result = await computeSmokeGateState(null, greenCohortMetrics, { adr097Detector: adr097Absent })

    expect(result.items.find((item) => item.key === "ar55_latency_baseline")).toMatchObject({
      status: "pass",
    })
    expect(result.items.find((item) => item.key === "ar56_error_rate_baseline")).toMatchObject({
      status: "pass",
    })
  })

  it("cleanup-21: treats AR55/AR56 unknown+insufficient_sample as pass (reason-whitelist)", async () => {
    const result = await computeSmokeGateState(null, unknownInsufficientCohortMetrics, { adr097Detector: adr097Absent })

    expect(result.items.find((item) => item.key === "ar55_latency_baseline")).toMatchObject({
      status: "pass",
    })
    expect(result.items.find((item) => item.key === "ar56_error_rate_baseline")).toMatchObject({
      status: "pass",
    })
  })

  it("cleanup-21: treats AR55/AR56 unknown+no_baseline as pass (reason-whitelist)", async () => {
    const result = await computeSmokeGateState(null, {
      cohorts: {
        pre_flip_baseline: {
          p95_latency_ms: { status: "unknown", reason: "no_baseline" },
          error_rate_pct: { status: "unknown", reason: "no_baseline" },
        },
      },
    }, { adr097Detector: adr097Absent })

    expect(result.items.find((item) => item.key === "ar55_latency_baseline")).toMatchObject({
      status: "pass",
    })
    expect(result.items.find((item) => item.key === "ar56_error_rate_baseline")).toMatchObject({
      status: "pass",
    })
  })

  it("cleanup-21: treats AR55/AR56 unknown without whitelisted reason as unknown (not pass)", async () => {
    const result = await computeSmokeGateState(null, {
      cohorts: {
        pre_flip_baseline: {
          p95_latency_ms: { status: "unknown" },
          error_rate_pct: { status: "unknown" },
        },
      },
    }, { adr097Detector: adr097Absent })

    expect(result.items.find((item) => item.key === "ar55_latency_baseline")).toMatchObject({
      status: "unknown",
    })
    expect(result.computed).toBe("fail")
  })

  it("cleanup-21: ADR-097 item returns pass when detector returns true", async () => {
    const result = await computeSmokeGateState(null, greenCohortMetrics, { adr097Detector: adr097Present })

    expect(result.items.find((item) => item.key === "adr_097_metadata")).toMatchObject({
      status: "pass",
    })
  })

  it("cleanup-21: ADR-097 item returns unknown when detector returns false", async () => {
    const result = await computeSmokeGateState(null, greenCohortMetrics, { adr097Detector: adr097Absent })

    expect(result.items.find((item) => item.key === "adr_097_metadata")).toMatchObject({
      status: "unknown",
    })
  })

  it("cleanup-21: full 11/11 pass when cohort metrics whitelisted + ADR-097 present", async () => {
    const result = await computeSmokeGateState(null, unknownInsufficientCohortMetrics, { adr097Detector: adr097Present })

    expect(result.items).toHaveLength(11)
    expect(result.items.every((item) => item.status === "pass")).toBe(true)
    expect(result.computed).toBe("pass")
  })

  it("returns pass when cohort metrics are green and ADR-097 present", async () => {
    const result = await computeSmokeGateState(null, greenCohortMetrics, { adr097Detector: adr097Present })

    expect(result.computed).toBe("pass")
    expect(result.items.every((item) => item.status === "pass")).toBe(true)
  })

  it("rejects forced ratification without an explicit override reason", async () => {
    await expect(
      ratifyVerdict({} as never, {
        verdict: "pass",
        items: [],
        admin_id: "admin_1",
        force_override: true,
      })
    ).rejects.toThrow(
      "ratification_force_override_requires_reason: force_override=true requires force_override_reason"
    )
  })

  it("serializes items_json before inserting the ratification row", async () => {
    let capturedInsertRow: Record<string, unknown> | null = null
    const db = ((tableName: string) => {
      expect(tableName).toBe("phase_b_smoke_gate_ratifications")
      return {
        insert: (row: Record<string, unknown>) => {
          capturedInsertRow = row
          return {
            returning: async () => [
              {
                id: "rat_1",
                ...row,
                items_json: JSON.parse(String(row.items_json)),
                ratified_at: "2026-05-06T00:00:00.000Z",
              },
            ],
          }
        },
      }
    }) as never

    await ratifyVerdict(db, {
      verdict: "pass",
      items: [{ key: "ar55", label: "AR55", nfr_ref: "AR55", status: "pass", evidence_url: "/admin/operator/cohort-metrics", source: "cohort_metrics" }],
      admin_id: "admin_1",
    })

    expect(capturedInsertRow?.items_json).toBe(
      '[{"key":"ar55","label":"AR55","nfr_ref":"AR55","status":"pass","evidence_url":"/admin/operator/cohort-metrics","source":"cohort_metrics"}]'
    )
  })
})
