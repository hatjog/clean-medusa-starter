/**
 * claim-token-ttl-migration.test.ts — Story 7.4 AC1-a (ADR-138 DEC-1).
 *
 * Asercja na poziomie emitowanego DDL (bez live PG — quick-gate), spójnie z
 * voucher-redemption-migration.test / voucher-ledger-migration.test:
 *   - ADD COLUMN `claim_token_issued_at timestamptz` (idempotentnie).
 *   - Funkcja + trigger stempla issued_at przy nadaniu/zmianie claim_token.
 *   - Brak BACKFILL (grandfather — legacy rows nie wygasają retroaktywnie).
 *   - down() NON-destrukcyjny dla `claim_token` (zdejmuje tylko net-new stempel).
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1778930000000 } from "../migrations/1778930000000_add_claim_token_ttl_to_entitlement_instance"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778930000000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("Story 7.4 AC1-a — migracja claim_token_issued_at (TTL magic-link)", () => {
  const up = collectSql("up")
  const down = collectSql("down")

  it("dodaje kolumnę claim_token_issued_at timestamptz (idempotentnie)", () => {
    expect(up).toMatch(
      /ADD COLUMN IF NOT EXISTS claim_token_issued_at timestamptz/
    )
  })

  it("tworzy funkcję stempla issued_at", () => {
    expect(up).toMatch(
      /CREATE OR REPLACE FUNCTION entitlement_instance_stamp_claim_token_issued_at/
    )
    expect(up).toMatch(/NEW\.claim_token_issued_at\s*:=\s*NOW\(\)/)
  })

  it("stempluje przy INSERT i przy zmianie tokenu (re-issue), z poszanowaniem ręcznej wartości", () => {
    // Warunek: token niepusty AND (INSERT OR token zmieniony) AND issued_at jeszcze NULL.
    expect(up).toMatch(/NEW\.claim_token IS NOT NULL/)
    expect(up).toMatch(/TG_OP = 'INSERT'/)
    expect(up).toMatch(/NEW\.claim_token IS DISTINCT FROM OLD\.claim_token/)
    expect(up).toMatch(/NEW\.claim_token_issued_at IS NULL/)
  })

  it("podpina trigger BEFORE INSERT OR UPDATE", () => {
    expect(up).toMatch(
      /CREATE TRIGGER trg_entitlement_instance_stamp_claim_token_issued_at/
    )
    expect(up).toMatch(/BEFORE INSERT OR UPDATE ON entitlement_instance/)
  })

  it("NIE backfilluje istniejących wierszy (grandfather — brak baseline, ADR-138 M-4)", () => {
    expect(up).not.toMatch(/UPDATE\s+entitlement_instance\s+SET\s+claim_token_issued_at/i)
  })

  it("down() jest NON-destrukcyjny dla claim_token (zdejmuje tylko net-new stempel)", () => {
    expect(down).toMatch(/DROP TRIGGER IF EXISTS trg_entitlement_instance_stamp_claim_token_issued_at/)
    expect(down).toMatch(/DROP FUNCTION IF EXISTS entitlement_instance_stamp_claim_token_issued_at/)
    expect(down).toMatch(/DROP COLUMN IF EXISTS claim_token_issued_at/)
    // NIE wolno zdejmować samego claim_token ani jego unikalnego indeksu.
    expect(down).not.toMatch(/DROP COLUMN IF EXISTS claim_token\b/)
    expect(down).not.toMatch(/entitlement_instance_claim_token_uniq_idx/)
  })
})
