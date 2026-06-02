/**
 * voucher-redemption-migration.test.ts — Story 4.1 AC2 (warstwa domeny dedupe).
 *
 * Asercja na poziomie emitowanego DDL (bez live PG — quick-gate): tabela
 * `voucher_redemption`, composite PK (entitlement_id, idempotency_key), CHECK
 * resulting_state ∈ {REDEEMED_PARTIAL, REDEEMED_FULL} (taksonomia D-5), saldo
 * nieujemne, `down()` NON-DESTRUKCYJNY (NIE DROP — dedupe append-only).
 *
 * Wzorzec: wywołanie up()/down() na prototypie z przechwyconym addSql (omija
 * konstruktor bazowej klasy MikroORM Migration) — spójnie z voucher-ledger-migration.test.
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1778929000000 } from "../migrations/1778929000000_create_voucher_redemption_table"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778929000000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("Story 4.1 AC2 — migracja voucher_redemption (dedupe domeny)", () => {
  const up = collectSql("up")

  it("tworzy tabelę voucher_redemption (idempotentnie)", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS voucher_redemption/)
  })

  it("composite PK (entitlement_id, idempotency_key) = klucz idempotencji AC2", () => {
    expect(up).toMatch(
      /PRIMARY KEY \(entitlement_id, idempotency_key\)/
    )
  })

  it("resulting_state CHECK = WYŁĄCZNIE REDEEMED_PARTIAL / REDEEMED_FULL (D-5)", () => {
    expect(up).toMatch(
      /resulting_state\s+text NOT NULL\s+CHECK \(resulting_state IN \('REDEEMED_PARTIAL','REDEEMED_FULL'\)\)/
    )
    // NIE wprowadza nowych stanów taksonomii.
    expect(up).not.toContain("'REDEEMED'")
  })

  it("amount_minor > 0 i remaining_after_minor >= 0 (NIGDY < 0, AC1)", () => {
    expect(up).toMatch(/amount_minor\s+bigint NOT NULL CHECK \(amount_minor > 0\)/)
    expect(up).toMatch(
      /remaining_after_minor\s+bigint NOT NULL CHECK \(remaining_after_minor >= 0\)/
    )
  })

  it("redemption_id NOT NULL (dyskryminator transaction_id writera, ADR-139 D3)", () => {
    expect(up).toMatch(/redemption_id\s+text NOT NULL/)
  })

  it("down() NON-DESTRUKCYJNY — NIE DROP/DELETE/TRUNCATE (dedupe append-only)", () => {
    const down = collectSql("down")
    expect(down).not.toMatch(/DROP TABLE/i)
    expect(down).not.toMatch(/DELETE FROM/i)
    expect(down).not.toMatch(/TRUNCATE/i)
  })
})
