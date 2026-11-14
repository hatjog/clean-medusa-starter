/**
 * v1.16.0 Story 4.4 — kształt migracji `deferred_issuance_trace` zgodny
 * z planem `dit-create-table` / `dit-create-quarantine` (kontrakt 4.1/11.1),
 * migracja wyłącznie CREATE (D-35 p.16), brak literału progu wieku (4.5).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Migration20261114100000DeferredIssuanceTraceTable } from "../../migrations/Migration20261114100000DeferredIssuanceTraceTable"
import { RECOVERY_MIGRATION_PLAN } from "../../lib/recovery/recovery-migration-plan"
import {
  deferredIssuanceTraceBackfillSql,
  readDeferredIssuanceTraceSlaSeconds,
} from "../../lib/recovery/deferred-issuance-trace"

function collectUp(): string[] {
  const statements: string[] = []
  const migration = Object.create(Migration20261114100000DeferredIssuanceTraceTable.prototype) as {
    addSql: (sql: string) => void
    up: () => Promise<void>
  }
  migration.addSql = (sql) => statements.push(sql)
  void migration.up()
  return statements
}

function columnsOf(createSql: string): string[] {
  const body = createSql.slice(createSql.indexOf("(") + 1, createSql.lastIndexOf(")"))
  return body
    .split(/,(?![^(]*\))/)
    .map((part) => part.trim())
    .filter((part) => part && !/^CONSTRAINT\b/i.test(part))
    .map((part) => part.split(/\s+/)[0])
}

const plan = RECOVERY_MIGRATION_PLAN.find((c) => c.population_type === "deferred_issuance_trace")!
const step = (id: string) => plan.up.find((s) => s.id === id)!.sql_shape.split(";")[0]

describe("Story 4.4 — kształt deferred_issuance_trace", () => {
  const up = collectUp()

  it("kolumny tabeli i kwarantanny są dokładnie tymi z planu migracji", () => {
    const table = up.find((s) => /CREATE TABLE IF NOT EXISTS deferred_issuance_trace \(/.test(s))!
    const quarantine = up.find((s) => /CREATE TABLE IF NOT EXISTS deferred_issuance_trace_backfill_quarantine/.test(s))!
    expect(columnsOf(table).sort()).toEqual(columnsOf(step("dit-create-table")).sort())
    expect(columnsOf(quarantine).sort()).toEqual(columnsOf(step("dit-create-quarantine")).sort())
  })

  it("migracja nie zmienia żadnej istniejącej tabeli", () => {
    for (const sql of up) {
      const altered = [...sql.matchAll(/ALTER TABLE\s+([a-z_]+)/gi)].map((m) => m[1])
      for (const name of altered) {
        expect(["deferred_issuance_trace", "deferred_issuance_trace_backfill_quarantine"]).toContain(name)
      }
    }
  })

  it("ENABLE + FORCE RLS i polityka market_isolation na obu osiach scope", () => {
    const joined = up.join("\n")
    expect(joined).toMatch(/ALTER TABLE deferred_issuance_trace ENABLE ROW LEVEL SECURITY/)
    expect(joined).toMatch(/ALTER TABLE deferred_issuance_trace FORCE ROW LEVEL SECURITY/)
    expect(joined).toMatch(/CREATE POLICY market_isolation ON deferred_issuance_trace TO medusa_store/)
    expect(joined).toMatch(/instance_id = current_setting\('app.gp_instance_id', true\)/)
  })

  it("brak literału progu wieku w kodzie Story 4.4 — termin z konfiguracji runtime", () => {
    for (const file of ["deferred-issuance-trace.ts", "deferred-issuance-trace-runtime.ts"]) {
      const src = readFileSync(join(__dirname, "../../lib/recovery", file), "utf8")
      expect(src).not.toMatch(/\b(86400|24\s*\*\s*60|'24 hours'|interval '24)/)
    }
    expect(readDeferredIssuanceTraceSlaSeconds({})).toBeNull()
    expect(readDeferredIssuanceTraceSlaSeconds({ GP_DEFERRED_ISSUANCE_TRACE_SLA_SECONDS: "0" })).toBeNull()
    expect(readDeferredIssuanceTraceSlaSeconds({ GP_DEFERRED_ISSUANCE_TRACE_SLA_SECONDS: "12h" })).toBeNull()
    expect(readDeferredIssuanceTraceSlaSeconds({ GP_DEFERRED_ISSUANCE_TRACE_SLA_SECONDS: "7200" })).toBe(7200)
  })

  it("backfill wykonuje krok dit-backfill bez granic transakcji i pomija już zapisane rekordy", () => {
    const sql = deferredIssuanceTraceBackfillSql()
    expect(sql.startsWith("WITH instance_mapping")).toBe(true)
    expect(sql).not.toMatch(/\bCOMMIT\b|^BEGIN/)
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM deferred_issuance_trace t WHERE t.trace_id = w.event_id\)/)
    expect(sql).not.toMatch(/::regtype/)
  })
})
