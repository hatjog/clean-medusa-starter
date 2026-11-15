/**
 * v1.16.0 Story 4.3 AC1/AC2/AC4 — rejestr adaptera populacji i job alarmu
 * kompensacji (scheduled, niezależny od push), fail-loud przy braku adaptera.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

import { ALERT_CODE_CHANNEL_DELIVERED_AFTER_FAILURE, type AlertDeliveryResult } from "../../lib/alert-channel"
import { _resetRingBuffer, getRingBuffer, type StructuredAlertPayload } from "../../lib/alert-emit"
import { marketContextStorage } from "../../lib/market-context"
import type { TraceQueryClient } from "../../lib/recovery/deferred-issuance-trace"
import {
  ALERT_CODE_COMPENSATION_FAILURE_OVERDUE,
  assertRecoveryPopulationAdapters,
  COMPENSATION_FAILURE_SOURCE_QUARANTINE,
  COMPENSATION_FAILURE_ADAPTER,
  COMPENSATION_FAILURE_ALARMABLE_STATES,
  createRecoveryPopulationAdapterRegistry,
  DEFAULT_RECOVERY_POPULATION_ADAPTERS,
  LIST_OVERDUE_COMPENSATION_FAILURES_SQL,
  RECOVERY_POPULATION_ADAPTER_MISSING,
  RecoveryPopulationAdapterMissingError,
} from "../../lib/recovery/recovery-population-adapters"
import {
  ALERT_CODE_RUN_FAILED,
  config,
  default as compensationFailureRecoveryAlarm,
  MARKETS_ENV_VAR,
  runCompensationFailureRecoveryAlarm,
} from "../compensation-failure-recovery-alarm"

const SOURCE = readFileSync(join(__dirname, "..", "compensation-failure-recovery-alarm.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

const ROW = {
  failure_id: "mpcf_1",
  instance_id: "gp_test",
  market_id: "mkt_a",
  owner_type: "operator_role" as const,
  owner_id: "ops-recovery",
  deadline: new Date("2026-11-01T00:00:00.000Z"),
  resolution_state: "open",
}

function container() {
  return {
    resolve: (key: string) => {
      if (key === "logger") return { info: () => undefined, warn: () => undefined, error: () => undefined }
      throw new Error(`unresolved ${key}`)
    },
  }
}

function client(rows: unknown[] | Error, calls: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []): TraceQueryClient {
  return {
    query: async <T,>(sql: string, values: ReadonlyArray<unknown> = []) => {
      calls.push({ sql, values })
      if (rows instanceof Error) throw rows
      return { rows: rows as T[], rowCount: rows.length }
    },
  }
}

const delivered: AlertDeliveryResult = { status: "delivered", delivered_via: "webhook", attempts: [{ channel: "webhook", ok: true }] }

describe("Story 4.3 AC1 — rejestr adaptera populacji", () => {
  it("domyślny rejestr ma adapter compensation_failure z loaderem, deadline i nazwanym alarmem", () => {
    const adapter = DEFAULT_RECOVERY_POPULATION_ADAPTERS.get("compensation_failure")
    expect(adapter).toBe(COMPENSATION_FAILURE_ADAPTER)
    expect(typeof adapter!.loader).toBe("function")
    expect(adapter!.deadlineOf(ROW as never)).toBe("2026-11-01T00:00:00.000Z")
    expect(adapter!.alarmCode).toBe(ALERT_CODE_COMPENSATION_FAILURE_OVERDUE)
    // 11.3 dostarcza pozostałe dwie populacje — 4.3 ich nie rejestruje.
    expect([...DEFAULT_RECOVERY_POPULATION_ADAPTERS.keys()]).toEqual(["compensation_failure"])
  })

  it("stany alarmowane = nieterminalne stany kontraktu 4.1", () => {
    expect([...COMPENSATION_FAILURE_ALARMABLE_STATES].sort()).toEqual(["open", "recovery_in_progress"])
  })

  it("brak adaptera ⇒ wyjątek startu z nazwanym kodem, zero odczytu", async () => {
    const empty = createRecoveryPopulationAdapterRegistry([])
    expect(() => assertRecoveryPopulationAdapters(empty, ["compensation_failure"])).toThrow(RecoveryPopulationAdapterMissingError)
    const calls: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const run = runCompensationFailureRecoveryAlarm(container() as never, {
      registry: empty,
      env: { [MARKETS_ENV_VAR]: "mkt_a" },
      emit: () => undefined,
      clientForMarket: () => client([], calls),
    })
    await expect(run).rejects.toMatchObject({ code: RECOVERY_POPULATION_ADAPTER_MISSING })
    expect(calls).toEqual([])
  })

  it("podwójna rejestracja tej samej populacji jest błędem", () => {
    expect(() => createRecoveryPopulationAdapterRegistry([COMPENSATION_FAILURE_ADAPTER, COMPENSATION_FAILURE_ADAPTER])).toThrow(/podwójna/)
  })
})

describe("Story 4.3 AC2/AC4 — job compensation-failure-recovery-alarm", () => {
  it("ma config.schedule (cron Medusy) i nie zależy od pre-push/.husky ani order.placed", () => {
    expect(config).toEqual({ name: "compensation-failure-recovery-alarm", schedule: expect.stringMatching(/^\S+ \S+ \S+ \S+ \S+$/) })
    expect(SOURCE).not.toMatch(/husky|pre-push|order\.placed|brevo/i)
  })

  it("SQL porównuje deadline w bazie; jedyny binding to stany nieterminalne", async () => {
    const calls: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    await COMPENSATION_FAILURE_ADAPTER.loader(client([], calls))
    expect(calls[0].sql).toBe(LIST_OVERDUE_COMPENSATION_FAILURES_SQL)
    expect(calls[0].sql).toMatch(/deadline < statement_timestamp\(\)/)
    expect(calls[0].values).toEqual([[...COMPENSATION_FAILURE_ALARMABLE_STATES]])
  })

  it("fix R2: SQL czyta też kwarantannę backfillu 4.2 (quarantined_pending_review, deadline w bazie)", () => {
    const sql = LIST_OVERDUE_COMPENSATION_FAILURES_SQL.replace(/\s+/g, " ")
    expect(sql).toMatch(/FROM money_path_compensation_failure_backfill_quarantine q/)
    expect(sql).toMatch(/q\.backfill_state = 'quarantined_pending_review' AND q\.deadline < statement_timestamp\(\)/)
  })

  it("fix R2: wiersz kwarantanny ⇒ alarm z rozróżnialnym source", () => {
    const alarm = COMPENSATION_FAILURE_ADAPTER.toAlarm({ ...ROW, source: COMPENSATION_FAILURE_SOURCE_QUARANTINE, resolution_state: "quarantined_pending_review" })
    expect(alarm).toEqual(expect.objectContaining({ source: "backfill_quarantine", state: "quarantined_pending_review" }))
  })

  it("wiersz po terminie ⇒ alarm z typem populacji, failure_id, instance_id, ownerem, deadline + dostarczenie", async () => {
    const alerts: StructuredAlertPayload[] = []
    const result = await runCompensationFailureRecoveryAlarm(container() as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" },
      emit: (p) => alerts.push(p),
      deliver: async () => delivered,
      clientForMarket: () => client([ROW]),
    })
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: "ERROR",
        code: ALERT_CODE_COMPENSATION_FAILURE_OVERDUE,
        context: {
          population_type: "compensation_failure",
          source: "compensation_failure",
          failure_id: "mpcf_1",
          instance_id: "gp_test",
          market_id: "mkt_a",
          owner_type: "operator_role",
          owner_id: "ops-recovery",
          deadline: "2026-11-01T00:00:00.000Z",
          state: "open",
        },
      }),
    ])
    expect(result.evaluated).toBe(true)
    expect(result.overdue_count).toBe(1)
    expect(result.alarms[0].delivery).toBe(delivered)
  })

  it("pusta populacja = evaluated:true, overdue_count:0 (odróżnialne od porażki)", async () => {
    const result = await runCompensationFailureRecoveryAlarm(container() as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" },
      emit: () => undefined,
      clientForMarket: () => client([]),
    })
    expect(result).toEqual(expect.objectContaining({ evaluated: true, overdue_count: 0, alarms: [] }))
  })

  it("izolacja per rynek: porażka rynku A = ERROR + evaluated:false, rynek B oceniony", async () => {
    const alerts: StructuredAlertPayload[] = []
    const result = await runCompensationFailureRecoveryAlarm(container() as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a,mkt_b", GP_INSTANCE_ID: "gp_test" },
      emit: (p) => alerts.push(p),
      deliver: async () => delivered,
      clientForMarket: (_c, ctx) => (ctx.market_id === "mkt_a" ? client(new Error("connection refused")) : client([{ ...ROW, market_id: "mkt_b" }])),
    })
    expect(result.per_market).toEqual([
      { market_id: "mkt_a", evaluated: false, reason: "read_failed", error: "connection refused" },
      { market_id: "mkt_b", evaluated: true, overdue_count: 1 },
    ])
    expect(result.evaluated).toBe(false)
    expect(alerts.map((a) => a.code)).toEqual([ALERT_CODE_RUN_FAILED, ALERT_CODE_COMPENSATION_FAILURE_OVERDUE])
  })

  it("fix R3: porażka odczytu rynku ⇒ RUN_FAILED dostarczany kanałem (nie tylko log)", async () => {
    const sent: StructuredAlertPayload[] = []
    const result = await runCompensationFailureRecoveryAlarm(container() as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" },
      emit: () => undefined,
      deliver: async (p) => {
        sent.push(p)
        return delivered
      },
      clientForMarket: () => client(new Error("connection refused")),
    })
    expect(sent).toEqual([expect.objectContaining({ code: ALERT_CODE_RUN_FAILED, context: expect.objectContaining({ reason: "read_failed", market_id: "mkt_a" }) })])
    expect(result.run_failed_alarms).toEqual([{ reason: "read_failed", market_id: "mkt_a", delivery: delivered }])
  })

  it("brak deklaracji rynków = ERROR, evaluated:false z nazwaną przyczyną", async () => {
    const alerts: StructuredAlertPayload[] = []
    const result = await runCompensationFailureRecoveryAlarm(container() as never, {
      env: { GP_INSTANCE_ID: "gp_test" },
      emit: (p) => alerts.push(p),
      clientForMarket: () => client([]),
    })
    expect(result.evaluated).toBe(false)
    expect(result.failure?.reason).toBe("market_context_denied:markets_not_declared")
    // fix R3: RUN_FAILED idzie też kanałem; bez kanału w env ⇒ nazwany ERROR ALERT_CHANNEL_NOT_CONFIGURED
    expect(alerts.map((a) => a.code)).toEqual([ALERT_CODE_RUN_FAILED, "ALERT_CHANNEL_NOT_CONFIGURED"])
  })

  it("fix R3: brak deklaracji rynków ⇒ RUN_FAILED dostarczany kanałem z nazwanym kodem", async () => {
    const sent: StructuredAlertPayload[] = []
    const result = await runCompensationFailureRecoveryAlarm(container() as never, {
      env: { GP_INSTANCE_ID: "gp_test" },
      emit: () => undefined,
      deliver: async (p) => {
        sent.push(p)
        return delivered
      },
      clientForMarket: () => client([]),
    })
    expect(sent).toEqual([
      expect.objectContaining({ code: ALERT_CODE_RUN_FAILED, context: expect.objectContaining({ reason: "market_context_denied:markets_not_declared" }) }),
    ])
    expect(result.run_failed_alarms.map((a) => a.reason)).toEqual(["market_context_denied:markets_not_declared"])
  })
})

describe("Story 4.3 fix R1 — domyślny eksport joba zapisuje porażkę próby przy sukcesie fallbacku", () => {
  let server: Server
  let base: string
  const saved: Record<string, string | undefined> = {}
  const KEYS = [MARKETS_ENV_VAR, "GP_INSTANCE_ID", "GP_ALERT_CHANNELS", "GP_ALERT_SENTRY_DSN", "GP_ALERT_WEBHOOK_URL"]

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.statusCode = req.url?.includes("down") ? 503 : 200
        res.end("{}")
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const k of KEYS) saved[k] = process.env[k]
  })
  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await new Promise<void>((r) => server.close(() => r()))
  })

  it("sentry pada, webhook dostarcza ⇒ WARN ALERT_CHANNEL_DELIVERED_AFTER_FAILURE w ring bufferze + log z attempts", async () => {
    process.env[MARKETS_ENV_VAR] = "mkt_a"
    process.env.GP_INSTANCE_ID = "gp_test"
    process.env.GP_ALERT_CHANNELS = "sentry,webhook"
    process.env.GP_ALERT_SENTRY_DSN = `${base.replace("http://", "http://pubkey@")}/down`
    process.env.GP_ALERT_WEBHOOK_URL = `${base}/hook`
    _resetRingBuffer()
    const logs: Array<[string, string]> = []
    const pgClient = {
      query: async (sql: string) => {
        if (/current_setting/.test(sql)) {
          const store = marketContextStorage.getStore()
          return { rows: [{ market_id: store?.market_id, instance_id: store?.instance_id }] }
        }
        return { rows: [ROW] }
      },
      release: () => undefined,
    }
    const realContainer = {
      resolve: (key: string) => {
        if (key === "logger") {
          return {
            info: (m: string) => logs.push(["info", m]),
            warn: (m: string) => logs.push(["warn", m]),
            error: (m: string) => logs.push(["error", m]),
          }
        }
        if (key === "__pg_pool__") return { connect: async () => pgClient }
        throw new Error(`unresolved ${key}`)
      },
    }
    const result = await compensationFailureRecoveryAlarm(realContainer as never)
    expect(result.alarms.map((a) => a.delivery.status)).toEqual(["delivered"])
    const trail = getRingBuffer().filter((e) => e.code === ALERT_CODE_CHANNEL_DELIVERED_AFTER_FAILURE)
    expect(trail).toEqual([
      expect.objectContaining({
        severity: "WARN",
        context: expect.objectContaining({
          alert_code: ALERT_CODE_COMPENSATION_FAILURE_OVERDUE,
          delivered_via: "webhook",
          attempts: [
            { channel: "sentry", ok: false, error: "http_status_503" },
            { channel: "webhook", ok: true },
          ],
        }),
      }),
    ])
    const warnLine = logs.find(([lvl, m]) => lvl === "warn" && m.startsWith("alarm failure_id=mpcf_1"))
    expect(warnLine?.[1]).toMatch(/delivered_via=webhook attempts=.*"channel":"sentry","ok":false,"error":"http_status_503"/)
    expect(JSON.stringify(trail) + JSON.stringify(logs)).not.toMatch(/pubkey/)
  })
})
