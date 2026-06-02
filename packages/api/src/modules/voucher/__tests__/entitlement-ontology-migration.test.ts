/**
 * entitlement-ontology-migration.test.ts — Story 3.2 AC1/AC2/AC3.
 *
 * Asercja na poziomie emitowanego DDL (bez live PG — quick-gate, wzorzec
 * `voucher-ledger-migration.test.ts`): kolumny `sales_channel_id` +
 * `vat_classification`, domena VAT SPV/MPV, izolacja per market FAIL-CLOSED
 * (CHECK na live-issued), bezpieczeństwo aplikacji (NOT VALID, idempotentny guard),
 * `down()` NON-DESTRUKCYJNY (finance-adjacent — NIE DROP).
 *
 * Kontrakt: FR21 (ontologia / izolacja), NFR3 (multi-tenant fail-closed),
 * FR32 (VAT snapshot — kolumna teraz, logika 3.3).
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1778928100000 } from "../migrations/1778928100000_add_vat_classification_and_ontology_fk"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778928100000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("Story 3.2 AC1 — kolumny ontologii + vat_classification na entitlement_instance", () => {
  const up = collectSql("up")

  it("dodaje sales_channel_id (ontologia scope) — idempotentnie", () => {
    expect(up).toMatch(
      /ALTER TABLE IF EXISTS entitlement_instance\s+ADD COLUMN IF NOT EXISTS sales_channel_id text NULL/
    )
  })

  it("dodaje vat_classification (kolumna teraz; snapshot = Story 3.3) — idempotentnie", () => {
    expect(up).toMatch(
      /ALTER TABLE IF EXISTS entitlement_instance\s+ADD COLUMN IF NOT EXISTS vat_classification text NULL/
    )
  })

  it("vat_classification: domena SPV/MPV lub NULL (do snapshotu w 3.3)", () => {
    expect(up).toMatch(
      /CHECK \(vat_classification IS NULL OR vat_classification IN \('SPV','MPV'\)\)/
    )
  })
})

describe("Story 3.2 AC2 — izolacja per market FAIL-CLOSED (FR21/NFR3)", () => {
  const up = collectSql("up")

  it("CHECK scope: live-issued (order_id NOT NULL) MUSI mieć niepusty market_id", () => {
    // encja live bez market_id ⇒ odrzucona; legacy (order_id NULL) zwolniona.
    expect(up).toMatch(/entitlement_instance_market_scope_chk/)
    expect(up).toMatch(/order_id IS NULL\s*OR \(/)
    expect(up).toMatch(/market_id IS NOT NULL AND char_length\(market_id\) > 0/)
  })

  it("AI-01 (HIGH): CHECK NIE wymaga sales_channel_id na live-issued (aktywny writer go nie wypełnia; wymóg → 3.3)", () => {
    // sales_channel_id NOT NULL w CHECK złamałby realny db:migrate live-issue.
    // Kolumna jest dodana (warstwa danych pod 3.3), ale NIE w CHECK market_scope.
    const scopeCheck =
      up.match(/entitlement_instance_market_scope_chk[\s\S]*?NOT VALID/)?.[0] ?? ""
    expect(scopeCheck).not.toMatch(/sales_channel_id/)
  })

  it("kolumna sales_channel_id dodana mimo braku w CHECK (warstwa danych pod 3.3)", () => {
    expect(up).toMatch(
      /ALTER TABLE IF EXISTS entitlement_instance\s+ADD COLUMN IF NOT EXISTS sales_channel_id text NULL/
    )
  })

  it("indeksy lookup per scope (market_id / sales_channel_id)", () => {
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS entitlement_instance_market_id_idx/)
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS entitlement_instance_sales_channel_id_idx/
    )
  })
})

describe("Story 3.2 — bezpieczeństwo aplikacji na realnym PG (z danymi legacy)", () => {
  const up = collectSql("up")

  it("CHECK-i dodane jako NOT VALID (egzekwowane na nowych zapisach, brak walidacji wstecznej)", () => {
    const notValidCount = (up.match(/NOT VALID/g) ?? []).length
    expect(notValidCount).toBe(2) // vat_classification + market_scope
  })

  it("CHECK-i owinięte idempotentnym guardem pg_catalog.pg_constraint (re-run up() bezpieczny)", () => {
    expect(up).toMatch(/SELECT 1 FROM pg_catalog\.pg_constraint/)
    expect(up).toMatch(/WHERE conname = 'entitlement_instance_vat_classification_chk'/)
    expect(up).toMatch(/WHERE conname = 'entitlement_instance_market_scope_chk'/)
  })
})

describe("Story 3.2 T1 — down() NON-DESTRUKCYJNY (finance-adjacent, 2.6 D1)", () => {
  it("NIE DROP COLUMN / NIE DROP CONSTRAINT / NIE DROP INDEX / NIE DELETE", () => {
    const down = collectSql("down")
    expect(down).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i)
    expect(down).not.toMatch(/\bDELETE\b/i)
    expect(down).not.toMatch(/\bTRUNCATE\b/i)
    expect(down.trim()).toBe("")
  })
})
