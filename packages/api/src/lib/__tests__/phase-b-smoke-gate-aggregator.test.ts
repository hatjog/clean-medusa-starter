import { describe, expect, it } from "@jest/globals"

import {
  computeSmokeGateState,
  getLastRatification,
  ratifyVerdict,
} from "../phase-b-smoke-gate-aggregator"

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

  it("treats missing cohort metrics as fail because unknown items block PASS", async () => {
    const result = await computeSmokeGateState(null)

    expect(result.items).toHaveLength(10)
    expect(result.computed).toBe("fail")
    expect(result.last_ratified).toBeNull()
    expect(result.items.find((item) => item.key === "ar55_latency_baseline")).toMatchObject({
      status: "unknown",
    })
    expect(result.items.find((item) => item.key === "nfr_rel_10_auto_rollback")).toMatchObject({
      status: "pass",
    })
  })

  it("returns pass when cohort metrics are green for both AR55 and AR56", async () => {
    const result = await computeSmokeGateState(null, {
      cohorts: {
        pre_flip_baseline: {
          p95_latency_ms: { status: "green" },
          error_rate_pct: { status: "green" },
        },
      },
    })

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