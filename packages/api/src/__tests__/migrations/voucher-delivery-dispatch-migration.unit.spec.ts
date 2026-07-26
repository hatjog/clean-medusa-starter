/**
 * voucher-delivery-dispatch-migration.unit.spec.ts — Story 2.3 (AC1).
 *
 * Weryfikuje SQL migracji ledgera bez żywego Postgresa (wzorzec
 * `locales-roundtrip.test.ts`: przechwycenie `addSql`).
 *
 * Co jest tu bronione:
 *   - UNIQUE (entitlement_id, template_key, recipient_hash) jako klucz idempotencji,
 *   - CHECK kształtu `recipient_hash` = `sha256:<64 hex>` (zero surowego PII),
 *   - BRAK jakiejkolwiek kolumny na adres e-mail w ledgerze i w audycie,
 *   - enum `status` wygenerowany ze stałej zapożyczonej z kontraktu (nie drugi literał),
 *   - `down()` non-destrukcyjny (żadnego DROP/DELETE/TRUNCATE),
 *   - komentarz opisujący relację do zastanej `voucher_delivery_decision` (D-72).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Migration1778933000000 } from "../../modules/voucher/migrations/1778933000000_create_voucher_delivery_dispatch"
import { DELIVERY_DISPATCH_STATES } from "../../modules/voucher-delivery/delivery-state"

type RecordedSql = { sql: string; params: unknown[] }

class RecordingMigration extends Migration1778933000000 {
  public recorded: RecordedSql[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override addSql(sql: string, ...args: any[]): any {
    this.recorded.push({ sql, params: (args[0] as unknown[]) ?? [] })
  }
}

const MIGRATION_SOURCE_PATH = resolve(
  __dirname,
  "../../modules/voucher/migrations/1778933000000_create_voucher_delivery_dispatch.ts",
)

async function runUp(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const migration = new (RecordingMigration as any)() as RecordingMigration
  await migration.up()
  return migration.recorded.map((r) => r.sql).join("\n")
}

describe("Migration1778933000000 — voucher_delivery_dispatch (AC1)", () => {
  it("tworzy obie tabele idempotentnie (IF NOT EXISTS)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migration = new (RecordingMigration as any)() as RecordingMigration
    await migration.up()
    const sql = migration.recorded.map((r) => r.sql).join("\n")

    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+voucher_delivery_dispatch\b/i,
    )
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+voucher_delivery_dispatch_audit\b/i,
    )
    for (const statement of migration.recorded) {
      if (/CREATE (TABLE|INDEX)/i.test(statement.sql)) {
        expect(statement.sql).toMatch(/IF NOT EXISTS/i)
      }
    }
  })

  it("R-2.3-INFO11: DEFAULT `attempt_count` zgadza się z semantyką „liczba prób\" (od 1)", async () => {
    const sql = (await runUp()).replace(/\s+/g, " ")
    // INSERT ledgera podaje 1 jawnie; DEFAULT 0 sugerowałby licznik retry,
    // czyli inną semantykę niż faktyczna.
    expect(sql).toMatch(/attempt_count\s+integer NOT NULL DEFAULT 1 CHECK \(attempt_count >= 1\)/i)
    expect(sql).not.toMatch(/attempt_count\s+integer NOT NULL DEFAULT 0/i)
  })

  it("klucz idempotencji to UNIQUE (entitlement_id, template_key, recipient_hash)", async () => {
    const sql = (await runUp()).replace(/\s+/g, " ")
    expect(sql).toMatch(
      /UNIQUE\s*\(\s*entitlement_id\s*,\s*template_key\s*,\s*recipient_hash\s*\)/i,
    )
  })

  it("recipient_hash ma CHECK kształtu sha256:<64 hex> w OBU tabelach", async () => {
    const sql = await runUp()
    const checks = sql.match(
      /recipient_hash\s*~\s*'\^sha256:\[a-f0-9\]\{64\}\$'/g,
    )
    // Jeden w ledgerze, jeden w audycie — audit bez CHECK-u byłby tylną furtką.
    expect(checks).toHaveLength(2)
  })

  it("ŻADNA kolumna nie trzyma adresu e-mail ani innego PII", async () => {
    const sql = (await runUp()).toLowerCase()
    for (const forbidden of [
      "email",
      "recipient_email",
      "buyer_email",
      "phone",
      "recipient_name",
      "buyer_name",
      "to_address",
    ]) {
      expect(sql).not.toContain(forbidden)
    }
  })

  it("enum `status` pochodzi ze stałej zapożyczonej z kontraktu (zero drugiego literału)", async () => {
    const sql = await runUp()
    for (const state of DELIVERY_DISPATCH_STATES) {
      expect(sql).toContain(`'${state}'`)
    }

    // Test-the-test: LISTA enumu nie jest wklepana w migrację — jest generowana
    // ze stałej. Migracja wolno używa pojedynczych stanów w CHECK-ach pary
    // (status↔sent_at / status↔error_code), ale NIE wolno jej zawierać
    // przepisanej listy ani stanów, których w tych CHECK-ach nie ma.
    const source = readFileSync(MIGRATION_SOURCE_PATH, "utf8")
    expect(source).toContain("DELIVERY_DISPATCH_STATES.map")
    expect(source).not.toContain(
      DELIVERY_DISPATCH_STATES.map((state) => `'${state}'`).join(", "),
    )
    for (const state of ["queued", "delivered", "retrying", "dead_lettered", "degraded"]) {
      expect(source).not.toContain(`'${state}'`)
    }
  })

  it("wymusza spójność pary status↔znacznik: `sent` bez sent_at i `failed` bez error_code są niemożliwe", async () => {
    const sql = (await runUp()).replace(/\s+/g, " ")
    expect(sql).toMatch(/CHECK \(status <> 'sent' OR sent_at IS NOT NULL\)/i)
    expect(sql).toMatch(/CHECK \(status <> 'failed' OR error_code IS NOT NULL\)/i)
  })

  it("indeksuje ścieżkę skanu sweepa 2.5 (status, market_id, queued_at)", async () => {
    const sql = (await runUp()).replace(/\s+/g, " ")
    expect(sql).toMatch(/ON voucher_delivery_dispatch \(status, market_id, queued_at\)/i)
  })

  it("down() jest no-op — nie kasuje ani nie czyści niczego", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migration = new (RecordingMigration as any)() as RecordingMigration
    await migration.down()

    expect(migration.recorded).toHaveLength(0)
  })

  it("up() nie zawiera DROP/TRUNCATE/DELETE (ledger jest trwałym śladem)", async () => {
    const sql = await runUp()
    expect(sql).not.toMatch(/\bDROP\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    expect(sql).not.toMatch(/\bDELETE\b/i)
  })

  it("dokumentuje relację do zastanej voucher_delivery_decision (D-72) i politykę retencji", () => {
    const source = readFileSync(MIGRATION_SOURCE_PATH, "utf8")
    expect(source).toContain("voucher_delivery_decision")
    expect(source).toContain("D-72")
    expect(source).toMatch(/Retencja/i)
    // Nowa tabela NIE modyfikuje zastanej.
    expect(source).not.toMatch(
      /(ALTER|DROP)\s+TABLE[^\n]*voucher_delivery_decision/i,
    )
  })
})
