import { describe, expect, it } from "@jest/globals"

import { computeReadiness } from "../operator-readiness-aggregator"

describe("operator-readiness-aggregator", () => {
  it("returns the six canonical readiness items and an overall verdict consistent with their statuses", async () => {
    const result = await computeReadiness()

    expect(result.items).toHaveLength(6)
    expect(result.items.map((item) => item.key)).toEqual([
      "phase_a1_gate",
      "phase_a2_gate",
      "vendor_lifecycle_distribution",
      "adr_097_capacity_posture",
      "alerting_wired",
      "security_gates_verified",
    ])
    expect(
      result.items.find((item) => item.key === "vendor_lifecycle_distribution")
    ).toMatchObject({
      status: "yellow",
      remediation_url: "/app/vendors/pause-gate",
    })

    const expectedOverall = result.items.some((item) => item.status === "red")
      ? "red"
      : result.items.every((item) => item.status === "green")
        ? "green"
        : "yellow"

    expect(result.overall).toBe(expectedOverall)
  })

  it("exposes alerting and security items with operator remediation links", async () => {
    const result = await computeReadiness()

    expect(result.items.find((item) => item.key === "alerting_wired")).toMatchObject({
      remediation_url: "/app/operator/alerting",
      threshold: "8 thresholds present",
    })
    expect(
      result.items.find((item) => item.key === "security_gates_verified")
    ).toMatchObject({
      remediation_url: "/app/operator/security-gates",
      threshold: "All 4 gates PASS",
    })
    expect(
      result.items.find((item) => item.key === "security_gates_verified")?.value
    ).toMatch(/\/4 PASS, \d\/4 SKIP/)
  })
})