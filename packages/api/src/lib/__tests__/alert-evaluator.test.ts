import * as path from "node:path"

import { afterEach, describe, expect, it, jest } from "@jest/globals"

const ALERTING_CONFIG_PATH = path.resolve(
  process.cwd(),
  "../../gp-ops/alerting/multi-vendor-alerts.yaml",
)

describe("alert-evaluator", () => {
  afterEach(async () => {
    delete process.env.GP_ALERT_FORCE_FIRE
    delete process.env.GP_ALERTING_CONFIG_PATH
    delete process.env.GP_FLAG_FLIP_DATE
    delete process.env.GP_MV_FLAG_STATE
    const requestLog = await import("../request-log-aggregator.js")
    requestLog._resetForTest()
    jest.resetModules()
  })

  it("loads the v1.6.0 alerting config with eight thresholds", async () => {
    process.env.GP_ALERTING_CONFIG_PATH = ALERTING_CONFIG_PATH

    const { listConfiguredAlerts } = await import("../alert-evaluator.js")

    const alerts = listConfiguredAlerts()

    expect(alerts).toHaveLength(8)
    expect(alerts[0]).toMatchObject({
      id: "nfr_alert_1_p95_latency",
      severity: "P1",
      action: "auto_rollback",
    })
    expect(alerts[7]).toMatchObject({
      id: "nfr_alert_8_smoke_gate_drift",
      severity: "P2",
      action: "page",
    })
  })

  it("supports synthetic breach simulation through GP_ALERT_FORCE_FIRE", async () => {
    process.env.GP_ALERTING_CONFIG_PATH = ALERTING_CONFIG_PATH
    process.env.GP_ALERT_FORCE_FIRE =
      "nfr_alert_2_5xx_error_rate,nfr_alert_5_cache_invalidate_failures"

    const { evaluateAlerts } = await import("../alert-evaluator.js")
    const result = await evaluateAlerts()

    expect(result.firing).toHaveLength(2)
    expect(result.firing.map((alert) => alert.id)).toEqual([
      "nfr_alert_2_5xx_error_rate",
      "nfr_alert_5_cache_invalidate_failures",
    ])
    expect(result.firing.every((alert) => alert.evaluated_value === "synthetic_breach")).toBe(true)
  })

  it("evaluates real repo-backed alert conditions when metrics and operator state breach thresholds", async () => {
    process.env.GP_ALERTING_CONFIG_PATH = ALERTING_CONFIG_PATH
    process.env.GP_FLAG_FLIP_DATE = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    process.env.GP_MV_FLAG_STATE = "shadow"

    const requestLog = await import("../request-log-aggregator.js")
    const now = Date.now()
    ;[100, 200, 300, 400, 620].forEach((duration_ms, index) => {
      requestLog.recordRequest({
        ts: now - index * 1000,
        duration_ms,
        status_code: duration_ms === 620 ? 503 : 200,
      })
    })

    const { evaluateAlerts } = await import("../alert-evaluator.js")
    const result = await evaluateAlerts({
      scope: {
        resolve: () => ({
          list: async () => [
            { id: "seller_1", metadata: { gp: { lifecycle_status: "open" } } },
            { id: "seller_2", metadata: { gp: { lifecycle_status: "open" } } },
            { id: "seller_3", metadata: { gp: { lifecycle_status: "open" } } },
          ],
        }),
      },
    })

    expect(result.firing.map((alert) => alert.id)).toEqual([
      "nfr_alert_1_p95_latency",
      "nfr_alert_2_5xx_error_rate",
      "nfr_alert_3_zero_opted_in",
      "nfr_alert_7_kickoff_no_decision_breach",
    ])
  })
})