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
  CLOSE_DEFERRED_ISSUANCE_TRACE_SQL,
  deferredIssuanceTraceBackfillSql,
  readDeferredIssuanceTraceSlaSeconds,
} from "../../lib/recovery/deferred-issuance-trace"
import {
  assertDeferredIssuanceTraceSla,
  DEFERRED_ISSUANCE_TRACE_SLA,
  DEFERRED_ISSUANCE_TRACE_SLA_SECONDS,
} from "../../lib/recovery/recovery-config"

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
  })

  it("R-1: termin SLA = jedna nazwana wartość w config-as-code (D-35 p.9), bez zmiennej środowiskowej", () => {
    // Domyślne źródło działa bez ŻADNEJ zmiennej — rekord powstaje w każdym wdrożeniu.
    expect(readDeferredIssuanceTraceSlaSeconds()).toBe(DEFERRED_ISSUANCE_TRACE_SLA.seconds)
    expect(DEFERRED_ISSUANCE_TRACE_SLA_SECONDS).toBe(24 * 60 * 60)
    expect(DEFERRED_ISSUANCE_TRACE_SLA.owner_id).toBe("ops-recovery")
    expect(DEFERRED_ISSUANCE_TRACE_SLA.source).toMatch(/decisions-2026-11-14\.md#D-35 p\.9/)
    for (const file of ["deferred-issuance-trace.ts", "deferred-issuance-trace-runtime.ts"]) {
      const src = readFileSync(join(__dirname, "../../lib/recovery", file), "utf8")
      expect(src).not.toMatch(/GP_DEFERRED_ISSUANCE_TRACE_SLA_SECONDS|process\.env/)
    }
  })

  it("R-1: brak albo niepoprawna wartość SLA = fail-loud, nigdy null/ciche pominięcie", () => {
    expect(() => assertDeferredIssuanceTraceSla(undefined)).toThrow(/recovery-config/)
    const ok = { owner_id: "ops-recovery", source: "D-35 p.9" }
    for (const bad of [null, {}, { ...ok, seconds: 0 }, { ...ok, seconds: -1 }, { ...ok, seconds: 1.5 },
      { ...ok, seconds: "86400" as unknown as number }, { seconds: 86400, owner_id: "", source: "x" },
      { seconds: 86400, owner_id: "ops-recovery", source: "" }]) {
      expect(() => readDeferredIssuanceTraceSlaSeconds(bad)).toThrow(/recovery-config/)
      if (bad && "seconds" in bad && bad.seconds !== 86400) {
        expect(() => assertDeferredIssuanceTraceSla(bad)).toThrow(/seconds musi byc dodatnia/)
      }
      expect(() => assertDeferredIssuanceTraceSla(bad)).toThrow(/recovery-config/)
    }
  })

  it("R-6: UPDATE domknięcia ma predykat rynku i instancji (obrona w głąb obok RLS)", () => {
    const flat = CLOSE_DEFERRED_ISSUANCE_TRACE_SQL.replace(/\s+/g, " ")
    expect(flat).toContain("WHERE trace_id = $1 AND market_id = $5 AND instance_id = $6 AND")
  })

  it("backfill wykonuje krok dit-backfill bez granic transakcji i pomija już zapisane rekordy", () => {
    const sql = deferredIssuanceTraceBackfillSql()
    expect(sql.startsWith("WITH instance_mapping")).toBe(true)
    expect(sql).not.toMatch(/\bCOMMIT\b|^BEGIN/)
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM deferred_issuance_trace t WHERE t.trace_id = w.event_id\)/)
    expect(sql).not.toMatch(/::regtype/)
  })
})
