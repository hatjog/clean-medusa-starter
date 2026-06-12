/**
 * reference-price-choice-set-migration.test.ts — v1.12.0 Story 3.2.
 *
 * Quick-gate na emitowanym DDL: `reference_price_minor`, dedykowana tabela
 * `entitlement_choice_set_item`, CHECK-i finansowe, store-RLS na `app.gp_market_id`
 * (ENABLE + FORCE — fail-closed dla wlasciciela tabeli), trigger updated_at,
 * rozszerzony `posting_profile` CHECK oraz non-destrukcyjny `down()`.
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1778932000000 } from "../migrations/1778932000000_add_reference_price_and_choice_set"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = Object.create(Migration1778932000000.prototype)
  fakeThis.addSql = (s: string) => sqls.push(s)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778932000000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("v1.12.0 Story 3.2 — reference_price + choice_set schema", () => {
  const up = collectSql("up")

  it("dodaje nullable reference_price_minor na entitlement_instance idempotentnie", () => {
    expect(up).toMatch(
      /ALTER TABLE IF EXISTS entitlement_instance\s+ADD COLUMN IF NOT EXISTS reference_price_minor bigint NULL/
    )
  })

  it("tworzy dedykowana tabele entitlement_choice_set_item, nie JSONB", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS entitlement_choice_set_item/)
    expect(up).toMatch(/instance_id\s+text NOT NULL\s+REFERENCES entitlement_instance\(id\)/)
    expect(up).toMatch(/market_id\s+text NOT NULL/)
    expect(up).toMatch(/reference_amount_minor\s+bigint NOT NULL/)
    expect(up).toMatch(/remaining_minor\s+bigint NOT NULL/)
    expect(up).toMatch(/vat_classification\s+text NOT NULL/)
    expect(up).toMatch(/status\s+text NOT NULL/)
    expect(up).toMatch(/redemption_id\s+text NULL/)
    expect(up).not.toMatch(/choice_set\s+jsonb/i)
  })

  it("dodaje lookup indexy per instance_id i market_id", () => {
    expect(up).toMatch(/entitlement_choice_set_item_instance_id_idx[\s\S]*ON entitlement_choice_set_item \(instance_id\)/)
    expect(up).toMatch(/entitlement_choice_set_item_market_id_idx[\s\S]*ON entitlement_choice_set_item \(market_id\)/)
  })

  it("CHECK-i per item sa NOT VALID i guardowane przez pg_catalog.pg_constraint", () => {
    for (const constraint of [
      "entitlement_choice_set_item_market_id_chk",
      "entitlement_choice_set_item_reference_amount_chk",
      "entitlement_choice_set_item_remaining_chk",
      "entitlement_choice_set_item_vat_classification_chk",
      "entitlement_choice_set_item_status_chk",
    ]) {
      expect(up).toContain(`conname = '${constraint}'`)
      expect(up).toContain(`ADD CONSTRAINT ${constraint}`)
    }

    expect(up).toMatch(/CHECK \(char_length\(market_id\) > 0\)/)
    expect(up).toMatch(/CHECK \(reference_amount_minor > 0\)/)
    expect(up).toMatch(/CHECK \(remaining_minor >= 0 AND remaining_minor <= reference_amount_minor\)/)
    expect(up).toMatch(/CHECK \(vat_classification IN \('SPV','MPV'\)\)/)
    expect(up).toMatch(/CHECK \(status IN \('ACTIVE','REDEEMED'\)\)/)
    expect(up).toMatch(/SELECT 1 FROM pg_catalog\.pg_constraint/)
    expect((up.match(/NOT VALID/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it("wlacza store-RLS policy na market_id przez app.gp_market_id — ENABLE + FORCE (fail-closed)", () => {
    // ENABLE: polityka dostepna
    expect(up).toMatch(/ALTER TABLE entitlement_choice_set_item ENABLE ROW LEVEL SECURITY/)
    // FORCE: polityka obowiazuje takze wlasciciela tabeli i role bez SET ROLE —
    // bez FORCE sciezka bez market-context bylaby fail-open (dostep do sald wszystkich rynkow)
    expect(up).toMatch(/ALTER TABLE entitlement_choice_set_item FORCE ROW LEVEL SECURITY/)
    expect(up).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON entitlement_choice_set_item TO medusa_store/)
    expect(up).toMatch(/CREATE POLICY entitlement_choice_set_item_market_isolation/)
    expect(up).toMatch(/USING \(market_id = NULLIF\(current_setting\('app\.gp_market_id', true\), ''\)\)/)
    expect(up).toMatch(/WITH CHECK \(market_id = NULLIF\(current_setting\('app\.gp_market_id', true\), ''\)\)/)
  })

  it("instaluje trigger auto-touch updated_at (wymagany dla redeem 3.7 UPDATE remaining_minor)", () => {
    expect(up).toMatch(/CREATE OR REPLACE FUNCTION fn_entitlement_choice_set_item_touch_updated_at/)
    expect(up).toMatch(/CREATE TRIGGER trg_entitlement_choice_set_item_touch_updated_at/)
    expect(up).toMatch(/BEFORE UPDATE ON entitlement_choice_set_item/)
  })

  it("rozszerza posting_profile CHECK o profile capability CREDIT_PACK/BUNDLE bez ruszania entry_type", () => {
    expect(up).toMatch(/voucher_ledger_transaction_posting_profile_chk/)
    expect(up).toContain("'voucher_liability_only_v1'")
    expect(up).toContain("'voucher_credit_pack_v1'")
    expect(up).toContain("'voucher_bundle_v1'")
    expect(up).not.toMatch(/entry_type\s+IN/i)
  })

  it("DROP oryginalnego inline-constraintu uzywa precyzyjnego match po nazwie (nie LIKE substring)", () => {
    // Precyzyjny drop po nazwie voucher_ledger_transaction_posting_profile_check
    // zapobiega przypadkowemu usunieciu kompozytowych constraintow
    expect(up).toMatch(/conname = 'voucher_ledger_transaction_posting_profile_check'/)
    expect(up).not.toMatch(/pg_get_constraintdef.*LIKE.*posting_profile/)
  })

  it("down() jest non-destrukcyjny", () => {
    const down = collectSql("down")
    expect(down).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|POLICY)/i)
    expect(down).not.toMatch(/\bDELETE\b/i)
    expect(down).not.toMatch(/\bTRUNCATE\b/i)
    expect(down.trim()).toBe("")
  })
})
