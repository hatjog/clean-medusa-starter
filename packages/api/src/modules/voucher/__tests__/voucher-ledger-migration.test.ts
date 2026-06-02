/**
 * voucher-ledger-migration.test.ts — Story 2.6 AC1 (D1, migracja namespaced).
 *
 * Asercja na poziomie emitowanego DDL (bez live PG — quick-gate): tabele
 * namespaced, NOT NULL + CHECK kontraktu v1, entry_type WYŁĄCZNIE ENTITLEMENT_*,
 * market_id zdenormalizowany na entry, occurred_at ≠ created_at, dedup PK,
 * `down()` NON-DESTRUKCYJNY (NIE DROP / NIE DELETE — append-only finance).
 *
 * Wzorzec: wywołanie up()/down() na prototypie z przechwyconym addSql (omija
 * konstruktor bazowej klasy MikroORM Migration).
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1778927000000 } from "../migrations/1778927000000_create_voucher_ledger_tables"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // up/down są async, ale addSql jest synchroniczne — kolejność zachowana.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778927000000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("Story 2.6 AC1 — migracja voucher_ledger_* (ADR-139 D1)", () => {
  const up = collectSql("up")

  it("tworzy 3 namespaced tabele (separacja od money-ledger ledger_entry/ledger_transaction)", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS voucher_ledger_transaction/)
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS voucher_ledger_entry/)
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS ledger_posting_applied/)
    // NIE używa nazw money-ledger jako definiowanych tabel.
    expect(up).not.toMatch(/CREATE TABLE IF NOT EXISTS ledger_entry\b/)
    expect(up).not.toMatch(/CREATE TABLE IF NOT EXISTS ledger_transaction\b/)
  })

  it("entry_type CHECK = WYŁĄCZNIE ENTITLEMENT_* (allow-list, NIE money entry types)", () => {
    expect(up).toMatch(/entry_type\s+text NOT NULL CHECK \(entry_type IN \(/)
    for (const t of [
      "ENTITLEMENT_ISSUED",
      "ENTITLEMENT_REDEEMED",
      "ENTITLEMENT_EXPIRED",
      "ENTITLEMENT_BREAKAGE",
    ]) {
      expect(up).toContain(`'${t}'`)
    }
    expect(up).not.toContain("'ORDER_PAID'")
    expect(up).not.toContain("'CASH_SETTLED'")
  })

  it("posting_profile / vat_classification / lifecycle_event NOT NULL + CHECK", () => {
    expect(up).toMatch(/posting_profile\s+text NOT NULL CHECK \(posting_profile = 'voucher_liability_only_v1'\)/)
    expect(up).toMatch(/vat_classification\s+text NOT NULL CHECK \(vat_classification IN \('SPV','MPV'\)\)/)
    // lifecycle_event: superset (generator gruboziarnisty + golden granularny REDEEMED_*).
    expect(up).toMatch(/lifecycle_event\s+text NOT NULL CHECK \(lifecycle_event IN \(/)
    for (const ev of ["ISSUED", "REDEEMED", "REDEEMED_PARTIAL", "REDEEMED_FULL", "EXPIRED"]) {
      expect(up).toContain(`'${ev}'`)
    }
  })

  it("linia double-entry: dokładnie jedna strona dodatnia (CHECK)", () => {
    expect(up).toMatch(/CHECK \(\(debit_minor > 0\) <> \(credit_minor > 0\)\)/)
    expect(up).toMatch(/debit_minor\s+bigint NOT NULL CHECK \(debit_minor >= 0\)/)
    expect(up).toMatch(/credit_minor\s+bigint NOT NULL CHECK \(credit_minor >= 0\)/)
  })

  it("market_id ZDENORMALIZOWANY na voucher_ledger_entry (reconciliation bez JOIN)", () => {
    // sekcja voucher_ledger_entry zawiera własną kolumnę market_id NOT NULL
    const entryBlock = up.slice(up.indexOf("voucher_ledger_entry"))
    expect(entryBlock).toMatch(/market_id\s+text NOT NULL/)
  })

  it("occurred_at (epoch-ms bigint) ROZDZIELONY od created_at", () => {
    expect(up).toMatch(/occurred_at\s+bigint NOT NULL/)
    expect(up).toMatch(/created_at\s+bigint NOT NULL/)
  })

  it("ledger_posting_applied: transaction_id PK (dedup) + scan-index na entitlement_id", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS ledger_posting_applied \(\s*transaction_id\s+text PRIMARY KEY/)
    expect(up).toMatch(/ledger_posting_applied_entitlement_idx[\s\S]*entitlement_id, lifecycle_event/)
  })

  it("down() NON-DESTRUKCYJNY: NIE DROP TABLE / NIE DELETE / NIE TRUNCATE", () => {
    const down = collectSql("down")
    expect(down).not.toMatch(/DROP\s+TABLE/i)
    expect(down).not.toMatch(/\bDELETE\b/i)
    expect(down).not.toMatch(/\bTRUNCATE\b/i)
    expect(down.trim()).toBe("") // świadomy no-op (append-only finance)
  })
})
