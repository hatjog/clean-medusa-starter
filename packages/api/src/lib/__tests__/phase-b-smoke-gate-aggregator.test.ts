import { describe, expect, it } from "@jest/globals"

import {
  computeSmokeGateState,
  ratifyVerdict,
} from "../phase-b-smoke-gate-aggregator"

describe("phase-b-smoke-gate-aggregator", () => {
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
})