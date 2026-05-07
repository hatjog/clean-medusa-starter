import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("../alert-evaluator", () => ({
  listConfiguredAlerts: jest.fn(() => new Array(8).fill({})),
}))

jest.mock("../security-gate-verifier", () => ({
  verifyAllGates: jest.fn(async () => ({
    overall: "pass",
    gates: [
      { status: "pass" },
      { status: "pass" },
      { status: "pass" },
      { status: "pass" },
    ],
  })),
}))

import { computeReadiness } from "../operator-readiness-aggregator"

function buildScope(sellers: Array<Record<string, unknown>>) {
  return {
    resolve: (_key: string) => ({
      list: async () => sellers,
    }),
  }
}

describe("operator-readiness-aggregator", () => {
  beforeEach(() => undefined)

  it("returns the six canonical readiness items and an overall verdict consistent with their statuses", async () => {
    const result = await computeReadiness(
      buildScope([
      { id: "seller_1", metadata: { gp: { lifecycle_status: "open", adr_097_track: "track_a" } } },
      { id: "seller_2", metadata: { gp: { lifecycle_status: "suspended", adr_097_track: "track_b" } } },
      { id: "seller_3", metadata: { gp: { lifecycle_status: "terminated", adr_097_track: "track_a" } } },
      { id: "seller_4", metadata: { gp: { lifecycle_status: "open", adr_097_track: "track_b" } } },
      { id: "seller_5", metadata: { gp: { lifecycle_status: "pending_approval", adr_097_track: "track_a" } } },
      ]),
    )

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
      status: "green",
      remediation_url: "/app/vendors/pause-gate",
      value: "4/5 terminal (open=2, suspended=1, terminated=1, pending=1)",
    })
    expect(
      result.items.find((item) => item.key === "adr_097_capacity_posture")
    ).toMatchObject({
      status: "green",
      value: "5/5 documented (A=3, B=2)",
    })

    const expectedOverall = result.items.some((item) => item.status === "red")
      ? "red"
      : result.items.every((item) => item.status === "green")
        ? "green"
        : "yellow"

    expect(result.overall).toBe(expectedOverall)
  })

  it("exposes alerting and security items with operator remediation links", async () => {
    const result = await computeReadiness(
      buildScope([
      { id: "seller_1", metadata: { gp: { lifecycle_status: "pending_approval" } } },
      { id: "seller_2", metadata: { gp: { lifecycle_status: "open" } } },
      ]),
    )

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
    ).toMatch(/\d\/4 PASS, \d\/4 SKIP/)
    expect(
      result.items.find((item) => item.key === "vendor_lifecycle_distribution")
    ).toMatchObject({
      status: "yellow",
    })
    expect(
      result.items.find((item) => item.key === "adr_097_capacity_posture")
    ).toMatchObject({
      status: "unknown",
      value: "0/2 vendors documented",
    })
  })
})