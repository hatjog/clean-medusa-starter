/**
 * v1.16.0 Story 11.3 AC-2 — trzy typowane adaptery runtime alarmu recovery.
 *
 * Każda populacja ma NAZWANY test zdolności (loader, deadline, eskalacja,
 * deduplikacja). Cofnięcie adaptera (mutant w `evidence/11-3/mutation-adapters.md`)
 * czerwieni jego test. Kanał alarmu mierzony bez żywego env `GP_ALERT_*`.
 */
import { describe, expect, it } from "@jest/globals"

import {
  ALERT_CHANNEL_ENV_VARS,
  ALERT_CHANNEL_KINDS,
  ALERT_CODE_CHANNEL_NOT_CONFIGURED,
  deliverAlert,
  resolveAlertChannels,
  type AlertChannel,
} from "../../lib/alert-channel"
import type { StructuredAlertPayload } from "../../lib/alert-emit"
import {
  aggregateRecoveryAlarm,
  COMPENSATION_FAILURE_ADAPTER,
  createRecoveryPopulationAdapterRegistry,
  DEFAULT_RECOVERY_ALARM_ADAPTERS,
  DEFAULT_RECOVERY_POPULATION_ADAPTERS,
  DEFERRED_ISSUANCE_TRACE_ADAPTER,
  DLQ_ENTRY_ADAPTER,
  RECOVERY_ALARM_MAX_IDS_PER_ALARM,
  RECOVERY_POPULATION_ADAPTER_MISSING,
  RecoveryPopulationAdapterMissingError,
  validateRecoveryAlarmRegistryAtStartup,
  type OverduePopulationRow,
} from "../../lib/recovery/recovery-population-adapters"
import { ALERT_CODE_RUN_FAILED, runRecoveryPopulationAlarm, MARKETS_ENV_VAR } from "../../jobs/recovery-population-alarm"

function client(rows: Record<string, unknown>[], seen: Array<{ sql: string; values: unknown[] }> = []) {
  return {
    query: async <T>(sql: string, values?: ReadonlyArray<unknown>) => {
      seen.push({ sql, values: [...(values ?? [])] })
      return { rows: rows as T[], rowCount: rows.length }
    },
  }
}

function row(id: string, over: Partial<OverduePopulationRow> = {}): OverduePopulationRow {
  return {
    population_id: id,
    instance_id: "gp_test",
    market_id: "mkt_a",
    owner_type: "operator_role",
    owner_id: "ops-recovery",
    deadline: "2026-11-14T00:00:00.000Z",
    state: "awaiting_order",
    overdue_seconds: 60,
    ...over,
  }
}

describe("Story 11.3 AC-2 — test zdolności: compensation_failure", () => {
  it("compensation_failure: loader stanów nieterminalnych + kwarantanna, deadline z bazy, alarm z bezpiecznym id", async () => {
    const seen: Array<{ sql: string; values: unknown[] }> = []
    const rows = await COMPENSATION_FAILURE_ADAPTER.loader(
      client([{ failure_id: "mpcf_1", instance_id: "gp_test", market_id: "mkt_a", owner_type: "operator_role", owner_id: "ops-recovery", deadline: "2026-11-14T00:00:00Z", resolution_state: "open" }], seen)
    )
    expect(seen[0].sql).toMatch(/money_path_compensation_failure_backfill_quarantine/)
    expect(seen[0].sql).toMatch(/deadline < statement_timestamp\(\)/)
    expect(seen[0].values).toEqual([["open", "recovery_in_progress"]])
    expect(COMPENSATION_FAILURE_ADAPTER.deadlineOf(rows[0])).toBe("2026-11-14T00:00:00.000Z")
    expect(DEFAULT_RECOVERY_POPULATION_ADAPTERS.get("compensation_failure")).toBe(COMPENSATION_FAILURE_ADAPTER)
  })
})

describe("Story 11.3 AC-2 — test zdolności: deferred_issuance_trace", () => {
  it("deferred_issuance_trace: loader, deadline, eskalacja (escalated=ERROR, >24h po terminie=CRITICAL), deduplikacja", async () => {
    const adapter = DEFAULT_RECOVERY_ALARM_ADAPTERS.get("deferred_issuance_trace")
    expect(adapter).toBe(DEFERRED_ISSUANCE_TRACE_ADAPTER)
    const seen: Array<{ sql: string; values: unknown[] }> = []
    await DEFERRED_ISSUANCE_TRACE_ADAPTER.loader(client([], seen))
    expect(seen[0].sql).toMatch(/FROM deferred_issuance_trace/)
    expect(seen[0].sql).toMatch(/deadline < statement_timestamp\(\)/)
    expect(seen[0].values).toEqual([["awaiting_order", "escalated"]])
    expect(DEFERRED_ISSUANCE_TRACE_ADAPTER.escalationOf!(row("t1"))).toBe("WARN")
    expect(DEFERRED_ISSUANCE_TRACE_ADAPTER.escalationOf!(row("t1", { state: "escalated" }))).toBe("ERROR")
    expect(DEFERRED_ISSUANCE_TRACE_ADAPTER.escalationOf!(row("t1", { overdue_seconds: "90000" }))).toBe("CRITICAL")
    const agg = aggregateRecoveryAlarm(DEFERRED_ISSUANCE_TRACE_ADAPTER, [row("t1"), row("t1"), row("t2", { state: "escalated" })], {
      market_id: "mkt_a",
      instance_id: "gp_test",
    })
    expect(agg).toEqual(
      expect.objectContaining({ population_type: "deferred_issuance_trace", overdue_count: 2, population_ids: ["t1", "t2"], severity: "ERROR", alarm_code: "RECOVERY_DEFERRED_ISSUANCE_TRACE_OVERDUE" })
    )
  })
})

describe("Story 11.3 AC-2 — test zdolności: dlq_entry", () => {
  it("dlq_entry: loader stanów nieterminalnych DLQ, deadline, eskalacja ops_review=ERROR, deduplikacja", async () => {
    const adapter = DEFAULT_RECOVERY_ALARM_ADAPTERS.get("dlq_entry")
    expect(adapter).toBe(DLQ_ENTRY_ADAPTER)
    const seen: Array<{ sql: string; values: unknown[] }> = []
    await DLQ_ENTRY_ADAPTER.loader(client([], seen))
    expect(seen[0].sql).toMatch(/FROM mor_policy_dlq_entry/)
    expect(seen[0].values).toEqual([["dlq_pending_retry", "dlq_pending_ops_review"]])
    expect(DLQ_ENTRY_ADAPTER.escalationOf!(row("d1", { state: "dlq_pending_retry" }))).toBe("WARN")
    expect(DLQ_ENTRY_ADAPTER.escalationOf!(row("d1", { state: "dlq_pending_ops_review" }))).toBe("ERROR")
    expect(DLQ_ENTRY_ADAPTER.deadlineOf(row("d1"))).toBe("2026-11-14T00:00:00.000Z")
    const agg = aggregateRecoveryAlarm(DLQ_ENTRY_ADAPTER, [row("d1"), row("d1")], { market_id: "mkt_a", instance_id: "gp_test" })
    expect(agg?.population_ids).toEqual(["d1"])
  })
})

describe("Story 11.3 AC-2 — walidacja rejestru przy starcie i agregacja per przebieg", () => {
  it("rejestr bez adaptera dlq_entry ⇒ RECOVERY_POPULATION_ADAPTER_MISSING przy starcie", () => {
    const partial = createRecoveryPopulationAdapterRegistry([DEFERRED_ISSUANCE_TRACE_ADAPTER])
    expect(() => validateRecoveryAlarmRegistryAtStartup(partial)).toThrow(RecoveryPopulationAdapterMissingError)
    try {
      validateRecoveryAlarmRegistryAtStartup(partial)
    } catch (err) {
      expect((err as RecoveryPopulationAdapterMissingError).code).toBe(RECOVERY_POPULATION_ADAPTER_MISSING)
      expect((err as RecoveryPopulationAdapterMissingError).missing).toEqual(["dlq_entry"])
    }
  })

  it("adapter bez eskalacji/deduplikacji ⇒ odmowa startu", () => {
    const { escalationOf: _e, ...noEscalation } = DLQ_ENTRY_ADAPTER
    const registry = createRecoveryPopulationAdapterRegistry([DEFERRED_ISSUANCE_TRACE_ADAPTER, noEscalation])
    expect(() => validateRecoveryAlarmRegistryAtStartup(registry)).toThrow(RecoveryPopulationAdapterMissingError)
  })

  it("job z niekompletnym rejestrem rzuca przed odczytem", async () => {
    await expect(
      runRecoveryPopulationAlarm({} as never, { registry: createRecoveryPopulationAdapterRegistry([]), clientForMarket: () => { throw new Error("odczyt") } })
    ).rejects.toThrow(RecoveryPopulationAdapterMissingError)
  })

  it("N wierszy jednej populacji ⇒ 1 dostarczenie; limit identyfikatorów w alarmie", async () => {
    const many = Array.from({ length: RECOVERY_ALARM_MAX_IDS_PER_ALARM + 5 }, (_, i) => row(`t${i}`))
    const delivered: StructuredAlertPayload[] = []
    const result = await runRecoveryPopulationAlarm({} as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" } as NodeJS.ProcessEnv,
      emit: () => undefined,
      deliver: async (p) => {
        delivered.push(p)
        return { status: "delivered", delivered_via: "webhook", attempts: [{ channel: "webhook", ok: true }] }
      },
      clientForMarket: () => ({
        query: async <T>(sql: string) => ({ rows: (/deferred_issuance_trace/.test(sql) ? many : []) as T[], rowCount: 0 }),
      }),
    })
    expect(result.evaluated).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].context).toEqual(expect.objectContaining({ overdue_count: many.length, truncated: true }))
    expect((delivered[0].context as { population_ids: string[] }).population_ids).toHaveLength(RECOVERY_ALARM_MAX_IDS_PER_ALARM)
  })

  it("porażka odczytu jednej populacji ⇒ RUN_FAILED przez deliver z oczyszczonym context.error; druga populacja oceniona", async () => {
    const delivered: StructuredAlertPayload[] = []
    const result = await runRecoveryPopulationAlarm({} as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" } as NodeJS.ProcessEnv,
      emit: () => undefined,
      deliver: async (p) => {
        delivered.push(p)
        return { status: "delivered", delivered_via: "webhook", attempts: [{ channel: "webhook", ok: true }] }
      },
      clientForMarket: () => ({
        query: async <T>(sql: string) => {
          if (/mor_policy_dlq_entry/.test(sql)) throw new Error("connect failed postgres://db.internal:5432/gp")
          return { rows: [] as T[], rowCount: 0 }
        },
      }),
    })
    expect(result.evaluated).toBe(false)
    expect(result.outcomes.map((o) => [o.population_type, o.evaluated])).toEqual([
      ["deferred_issuance_trace", true],
      ["dlq_entry", false],
    ])
    expect(delivered.map((d) => d.code)).toEqual([ALERT_CODE_RUN_FAILED])
    expect(JSON.stringify(delivered[0].context)).not.toContain("db.internal")
  })
})

describe("Story 11.3 AC-2 — kanał alarmu bez żywego env GP_ALERT_*", () => {
  it("pusty env ⇒ brak kanałów, deliverAlert = failed ALERT_CHANNEL_NOT_CONFIGURED + ERROR (fail-loud), bez sieci", async () => {
    expect(resolveAlertChannels({} as NodeJS.ProcessEnv).channels).toEqual([])
    const emitted: StructuredAlertPayload[] = []
    const result = await deliverAlert(
      { severity: "ERROR", code: "X", message: "m" },
      { env: {} as NodeJS.ProcessEnv, emit: (p) => emitted.push(p), fetch: async () => { throw new Error("sieć zabroniona") } }
    )
    expect(result).toEqual(expect.objectContaining({ status: "failed", code: ALERT_CODE_CHANNEL_NOT_CONFIGURED }))
    expect(emitted.map((e) => [e.severity, e.code])).toEqual([["ERROR", ALERT_CODE_CHANNEL_NOT_CONFIGURED]])
    for (const name of ALERT_CHANNEL_ENV_VARS) expect(name.startsWith("GP_ALERT_")).toBe(true)
  })

  it("kanał alarmu nie zależy od Brevo (słownik sentry/webhook)", () => {
    expect([...ALERT_CHANNEL_KINDS]).toEqual(["sentry", "webhook"])
  })

  it("DW-15-342 p.7: rzucający emit śladu ⇒ dokładnie 1 dostarczenie, brak duplikatu fallbackiem", async () => {
    const calls: string[] = []
    const channels: AlertChannel[] = [
      { kind: "sentry", deliver: async () => void calls.push("sentry") },
      { kind: "webhook", deliver: async () => void calls.push("webhook") },
    ]
    const result = await deliverAlert({ severity: "ERROR", code: "X", message: "m" }, {
      channels,
      emit: () => {
        throw new Error("ring buffer down")
      },
    })
    expect(calls).toEqual(["sentry"])
    expect(result.status).toBe("delivered")
  })
})
