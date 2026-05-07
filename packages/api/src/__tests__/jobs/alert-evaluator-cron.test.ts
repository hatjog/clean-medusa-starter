import { afterEach, describe, expect, it, jest } from "@jest/globals"

const ALERTING_CONFIG_PATH = "/home/robsz/prj/GP/gp-ops/alerting/multi-vendor-alerts.yaml"

function buildContainer(loggerOverride?: {
  info: jest.Mock
  warn?: jest.Mock
  error?: jest.Mock
}) {
  const logger = loggerOverride ?? {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }

  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "sellerModuleService") {
        return {
          list: async () => [],
        }
      }
      return null
    }),
    logger,
  }
}

describe("alert-evaluator-cron", () => {
  afterEach(() => {
    delete process.env.GP_ALERTING_CONFIG_PATH
    delete process.env.GP_ALERT_FORCE_FIRE
    jest.resetModules()
  })

  it("exports real Medusa schedule metadata for an every-minute scheduler job", async () => {
    const { SCHEDULE_CRON, SCHEDULE_NAME, config } = await import(
      "../../jobs/alert-evaluator-cron.js"
    )

    expect(SCHEDULE_NAME).toBe("alert-evaluator-cron")
    expect(SCHEDULE_CRON).toBe("* * * * *")
    expect(config).toMatchObject({
      name: SCHEDULE_NAME,
      schedule: SCHEDULE_CRON,
    })
  })

  it("records a successful manual heartbeat even when no alerts are firing", async () => {
    process.env.GP_ALERTING_CONFIG_PATH = ALERTING_CONFIG_PATH

    const {
      runAlertEvaluatorTick,
      getLastTick,
      getTickHistory24h,
    } = await import("../../jobs/alert-evaluator-cron.js")

    const result = await runAlertEvaluatorTick()
    const lastTick = await getLastTick()

    expect(result).toMatchObject({
      status: "pass",
      triggered_by: "manual",
      firing_count: 0,
      auto_rollbacks: 0,
    })
    expect(lastTick).toMatchObject({
      schedule_name: "alert-evaluator-cron",
      triggered_by: "manual",
      status: "pass",
      firing_count: 0,
    })
    await expect(getTickHistory24h()).resolves.toHaveLength(1)
  })

  it("scheduler entrypoint records scheduler-triggered heartbeats", async () => {
    process.env.GP_ALERTING_CONFIG_PATH = ALERTING_CONFIG_PATH

    const alertEvaluatorCronModule = await import("../../jobs/alert-evaluator-cron.js")
    const container = buildContainer()

    await (alertEvaluatorCronModule.default as any)(container)

    const lastTick = await alertEvaluatorCronModule.getLastTick()
    expect(lastTick).toMatchObject({
      triggered_by: "scheduler",
      status: "pass",
    })
    expect(container.logger.warn).toHaveBeenCalledWith(
      "no DB connection resolved — heartbeat will be in-memory only",
    )
  })
})