import { describe, expect, it } from "@jest/globals"

import { ensureOperatorRuntimeSchema } from "../operator-runtime-schema"

describe("operator-runtime-schema", () => {
  it("creates missing operator tables and refreshes append-only guards idempotently", async () => {
    const executedSql: string[] = []
    let checkedTables = 0
    const db = {
      raw: async (sql: string, bindings?: unknown[]) => {
        executedSql.push(sql)
        if (sql.includes("to_regclass")) {
          checkedTables += 1
          return { rows: [{ regclass: null }] }
        }

        return { rows: [] }
      },
    } as unknown as Parameters<typeof ensureOperatorRuntimeSchema>[0]

    await ensureOperatorRuntimeSchema(db)

    expect(checkedTables).toBe(3)
    expect(executedSql.some((sql) => sql.includes("CREATE TABLE phase_b_smoke_gate_ratifications"))).toBe(true)
    expect(executedSql.some((sql) => sql.includes("CREATE TABLE operator_multi_vendor_flag_audit"))).toBe(true)
    expect(executedSql.some((sql) => sql.includes("CREATE TABLE operator_alert_evaluator_tick_history"))).toBe(true)
    expect(executedSql.some((sql) => sql.includes("CREATE OR REPLACE FUNCTION fn_phase_b_ratifications_immutable()"))).toBe(true)
    expect(executedSql.some((sql) => sql.includes("CREATE TRIGGER trg_operator_mv_flag_audit_no_mutation"))).toBe(true)
  })

  it("skips table creation when operator tables already exist", async () => {
    const executedSql: string[] = []
    const db = {
      raw: async (sql: string) => {
        executedSql.push(sql)
        if (sql.includes("to_regclass")) {
          return { rows: [{ regclass: "already_there" }] }
        }

        return { rows: [] }
      },
    } as unknown as Parameters<typeof ensureOperatorRuntimeSchema>[0]

    await ensureOperatorRuntimeSchema(db)

    expect(executedSql.some((sql) => sql.includes("CREATE TABLE phase_b_smoke_gate_ratifications"))).toBe(false)
    expect(executedSql.some((sql) => sql.includes("CREATE TABLE operator_multi_vendor_flag_audit"))).toBe(false)
    expect(executedSql.some((sql) => sql.includes("CREATE TABLE operator_alert_evaluator_tick_history"))).toBe(false)
    expect(executedSql.some((sql) => sql.includes("CREATE INDEX IF NOT EXISTS idx_phase_b_ratifications_ratified_at"))).toBe(true)
  })
})