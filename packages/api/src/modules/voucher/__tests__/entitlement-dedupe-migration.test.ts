/**
 * entitlement-dedupe-migration.test.ts — Story 3.3 AC4 (migracja pól net-new).
 *
 * Asercja na poziomie emitowanego DDL (bez live PG — quick-gate, wzorzec
 * `entitlement-ontology-migration.test.ts`): kolumny `entitlement_dedupe_key` +
 * `recipient_index`, PARTIAL UNIQUE index (target ON CONFLICT), CHECK recipient_index,
 * single-module, bezpieczeństwo aplikacji (IF NOT EXISTS / NOT VALID), `down()`
 * NON-DESTRUKCYJNY (finance-adjacent — NIE DROP klucza idempotencji).
 *
 * Kontrakt: ADR-137 DEC-5 pkt 3.ii, finding H-2 (net-new), finding L-2 (digest),
 * FR10, NFR6 (single-module).
 */
import { describe, it, expect } from "@jest/globals"
import { Migration1778928200000 } from "../migrations/1778928200000_add_entitlement_dedupe_key_and_recipient_index"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778928200000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("Story 3.3 AC4 — migracja entitlement_dedupe_key + recipient_index", () => {
  const up = collectSql("up")

  it("dodaje entitlement_dedupe_key (per-entitlement dedupe) — idempotentnie", () => {
    expect(up).toMatch(
      /ALTER TABLE IF EXISTS entitlement_instance\s+ADD COLUMN IF NOT EXISTS entitlement_dedupe_key text NULL/
    )
  })

  it("dodaje recipient_index (deterministyczny indeks recipienta) — idempotentnie", () => {
    expect(up).toMatch(
      /ALTER TABLE IF EXISTS entitlement_instance\s+ADD COLUMN IF NOT EXISTS recipient_index integer NULL/
    )
  })

  it("PARTIAL UNIQUE index na entitlement_dedupe_key (target ON CONFLICT, FR10)", () => {
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS entitlement_instance_dedupe_key_uq\s+ON entitlement_instance \(entitlement_dedupe_key\)\s+WHERE entitlement_dedupe_key IS NOT NULL/
    )
  })

  it("CHECK recipient_index >= 0 jako NOT VALID (domena nieujemna, bez walidacji wstecznej)", () => {
    expect(up).toMatch(/CHECK \(recipient_index IS NULL OR recipient_index >= 0\)/)
    expect(up).toMatch(/NOT VALID/)
  })

  it("guard idempotentny CHECK przez pg_constraint (re-run up() bezpieczny)", () => {
    expect(up).toMatch(/pg_catalog\.pg_constraint/)
    expect(up).toMatch(/entitlement_instance_recipient_index_chk/)
  })

  it("SINGLE-MODULE: dotyka WYŁĄCZNIE entitlement_instance (NFR6 — brak cross-modułu)", () => {
    const tables = up.match(/(ALTER TABLE|CREATE UNIQUE INDEX[^\n]*ON|INTO)\s+(IF EXISTS\s+)?(\w+)/gi) ?? []
    // jedyną tabelą dotykaną przez DDL jest entitlement_instance
    expect(up).not.toMatch(/\b(event_processed|voucher_ledger|order|payment|sales_channel|market)\b/)
    expect(tables.length).toBeGreaterThan(0)
  })

  it("down() NON-DESTRUKCYJNY: NIE DROP COLUMN/INDEX/CONSTRAINT (klucz idempotencji)", () => {
    const down = collectSql("down")
    expect(down).not.toMatch(/DROP\s+(COLUMN|INDEX|CONSTRAINT|TABLE)/i)
    expect(down).not.toMatch(/\bDELETE\b/i)
    expect(down.trim()).toBe("")
  })
})
