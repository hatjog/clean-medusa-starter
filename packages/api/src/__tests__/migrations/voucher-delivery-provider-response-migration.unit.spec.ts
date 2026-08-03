import { Migration1778937000000 } from "../../modules/voucher/migrations/1778937000000_add_provider_response_to_voucher_delivery_dispatch"

class RecordingMigration extends Migration1778937000000 {
  readonly recorded: string[] = []

  public override addSql(sql: string): void {
    this.recorded.push(sql)
  }
}

function recordedSql(recorded: string[]): string {
  return recorded.join("\n").replace(/\s+/g, " ")
}

async function runUp(): Promise<string> {
  const migration = new RecordingMigration(
    undefined as unknown as ConstructorParameters<typeof Migration1778937000000>[0],
    undefined as unknown as ConstructorParameters<typeof Migration1778937000000>[1],
  )
  await migration.up()
  return recordedSql(migration.recorded)
}

/**
 * OGRANICZENIE (to samo, co w `voucher-delivery-first-failure-migration`):
 * ten spec przechwytuje SQL jako STRING i asertuje podciągi — NIE wykonuje go
 * przeciw Postgresowi, więc nie wykryje błędu składni. Dowodem poprawności
 * migracji jest jej wykonanie na żywej bazie.
 *
 * To, co ten spec REALNIE chroni, to własności BEZPIECZEŃSTWA DANYCH, które
 * da się sprawdzić na tekście: brak destrukcyjnych operacji i idempotencja.
 */
describe("Migration1778937000000 — odpowiedź providera w ledgerze dostaw", () => {
  it("dodaje parę kolumn do podsumowania ORAZ do append-only audytu", async () => {
    const sql = await runUp()

    for (const table of [
      "voucher_delivery_dispatch",
      "voucher_delivery_dispatch_audit",
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table}`)
    }
    expect(
      sql.match(/ADD COLUMN IF NOT EXISTS provider_status_code integer NULL/g),
    ).toHaveLength(2)
    expect(
      sql.match(/ADD COLUMN IF NOT EXISTS provider_message text NULL/g),
    ).toHaveLength(2)
  })

  it("jest CZYSTO ADDYTYWNA — zero DROP, zero ALTER TYPE, zero przepisywania wierszy", async () => {
    const sql = await runUp()

    // Dokładnie ta klasa migracji zniszczyła dane w `20260606_224249_localize_pages.ts`
    // (drop kolumn bez backfillu, PR #696). Bramka jest tekstowa, ale trafia
    // w konstrukcje, które jako jedyne mogą tu skasować dane.
    expect(sql).not.toMatch(/DROP\s+COLUMN/i)
    expect(sql).not.toMatch(/DROP\s+TABLE/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    expect(sql).not.toMatch(/ALTER\s+COLUMN/i)
    // Kolumny są NULL-owalne, więc ALTER nie przepisuje istniejących wierszy
    // i nie potrzebuje wartości domyślnej.
    expect(sql).not.toMatch(/NOT\s+NULL/i)
    expect(sql).not.toMatch(/\bDEFAULT\b/i)
  })

  it("jest IDEMPOTENTNA — CHECK inline w ADD COLUMN, nigdy osobny ADD CONSTRAINT", async () => {
    const sql = await runUp()

    // `ADD CONSTRAINT` w tym repo NIE przyjmuje `IF NOT EXISTS` (znany dług),
    // więc constraint deklarowany osobno wywracałby powtórny przebieg migracji.
    // Inline CHECK powstaje razem z kolumną i jest pomijany dokładnie wtedy,
    // gdy kolumna już istnieje.
    expect(sql).not.toMatch(/ADD\s+CONSTRAINT/i)
    expect(sql).toContain("CHECK (provider_status_code IS NULL")
    expect(sql).toContain("CHECK (provider_message IS NULL")
    // Każdy `ADD COLUMN` musi być warunkowy.
    const addColumns = sql.match(/ADD COLUMN/g) ?? []
    const guardedAddColumns = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []
    expect(addColumns).toHaveLength(guardedAddColumns.length)
    expect(addColumns.length).toBeGreaterThan(0)
  })

  it("ogranicza długość komunikatu providera (trzecia bariera po redaktorze i ledgerze)", async () => {
    const sql = await runUp()
    expect(sql).toContain("char_length(provider_message) <= 512")
  })

  it("waliduje zakres kodu HTTP zamiast przyjmować dowolny integer", async () => {
    const sql = await runUp()
    expect(sql).toContain("provider_status_code >= 100 AND provider_status_code <= 599")
  })

  it("down() jest no-op — ledger jest forward-only", async () => {
    const migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<typeof Migration1778937000000>[0],
      undefined as unknown as ConstructorParameters<typeof Migration1778937000000>[1],
    )
    await migration.down()
    expect(migration.recorded).toHaveLength(0)
  })
})
