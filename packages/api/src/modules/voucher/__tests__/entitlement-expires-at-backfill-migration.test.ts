/**
 * entitlement-expires-at-backfill-migration.test.ts —
 * v1.15.0 Story 5.9 review-fix cyklu 2 (C2-MEDIUM-3).
 *
 * Asercja na poziomie emitowanego SQL (bez live PG — quick-gate), wzorcem
 * `voucher-redemption-migration.test.ts`.
 *
 * Co jest tu mierzone: `down()` cofa WYŁĄCZNIE wiersze, które ta migracja
 * FAKTYCZNIE przestawiła, a nie wiersze spełniające predykat, który produkcja
 * wymusza sama. Poprzedni `down()` porównywał `v.expires_at = e.expires_at` —
 * a `computeValidityEnd` liczy oba nośniki JEDNYM wyrażeniem, więc każdy nowo
 * wystawiony voucher spełnia tę równość z konstrukcji. Rollback kasował więc
 * `expires_at` całej populacji, a sweeper filtruje po `expires_at IS NOT NULL`:
 * `down()` przywracał defekt naprawiony w tym samym commicie.
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1779010000000 } from "../migrations/1779010000000_backfill_entitlement_expires_at_from_voucher"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1779010000000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

const LEDGER = "entitlement_expires_at_backfill_1779010000000"

describe("C2-MEDIUM-3 — odcisk migracji nie jest niezmiennikiem produkcji", () => {
  const up = collectSql("up")
  const down = collectSql("down")

  it("up() zapisuje ODCISK: identyfikatory przestawionych wierszy + nadaną wartość", () => {
    expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${LEDGER}`)
    expect(up).toMatch(/RETURNING e\.id, e\.expires_at/)
    expect(up).toContain(`INSERT INTO ${LEDGER} (entitlement_id, set_expires_at)`)
    // Idempotencja obu nośników zachowana.
    expect(up).toMatch(/e\.expires_at IS NULL/)
    expect(up).toMatch(/ON CONFLICT \(entitlement_id\) DO NOTHING/)
  })

  it("down() cofa WYŁĄCZNIE po odcisku — NIE po równości z `voucher.expires_at`", () => {
    expect(down).toContain(`FROM ${LEDGER} b`)
    expect(down).toMatch(/b\.entitlement_id = e\.id/)
    // Wartość musi być NADAL ta, którą migracja nadała — termin przedłużony
    // później (`voucher.extend`) zostaje nietknięty.
    expect(down).toMatch(/e\.expires_at = b\.set_expires_at/)
    // KONTROLA, KTÓRA PĘKA po cofnięciu fixa: stary `down()` dołączał tabelę
    // `voucher` i porównywał `v.expires_at = e.expires_at`.
    expect(down).not.toMatch(/FROM voucher v/)
    expect(down).not.toMatch(/v\.expires_at = e\.expires_at/)
  })

  it("down() bez odcisku jest NO-OPEM, nie błędem `relation does not exist`", () => {
    // `CREATE TABLE IF NOT EXISTS` PRZED UPDATE-em — rollback na bazie, na
    // której `up()` nie przebiegł, ma nic nie zrobić, a nie się wywrócić.
    const createIdx = down.indexOf(`CREATE TABLE IF NOT EXISTS ${LEDGER}`)
    const updateIdx = down.indexOf("UPDATE entitlement_instance")
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(updateIdx).toBeGreaterThan(createIdx)
  })

  it("down() sprząta po sobie — rejestr nie zostaje jako powierzchnia", () => {
    expect(down).toContain(`DROP TABLE IF EXISTS ${LEDGER}`)
  })
})
