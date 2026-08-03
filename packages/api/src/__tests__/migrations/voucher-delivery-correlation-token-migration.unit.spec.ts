import { Migration1778938000000 } from "../../modules/voucher/migrations/1778938000000_add_correlation_token_to_voucher_delivery_dispatch"

class RecordingMigration extends Migration1778938000000 {
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
    undefined as unknown as ConstructorParameters<typeof Migration1778938000000>[0],
    undefined as unknown as ConstructorParameters<typeof Migration1778938000000>[1],
  )
  await migration.up()
  return recordedSql(migration.recorded)
}

/**
 * OGRANICZENIE (jak w siostrzanych specach migracji): ten plik przechwytuje SQL
 * jako STRING i asertuje podciągi — NIE wykonuje go przeciw Postgresowi, więc
 * nie wykryje błędu składni. Dowodem poprawności jest wykonanie na żywej bazie.
 *
 * Chroni własności BEZPIECZEŃSTWA DANYCH sprawdzalne na tekście.
 */
describe("Migration1778938000000 — token korelacji w ledgerze dostaw", () => {
  it("dodaje kolumnę do tabeli podsumowania dostaw", async () => {
    const sql = await runUp()

    expect(sql).toContain("ALTER TABLE voucher_delivery_dispatch")
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS correlation_token text")
  })

  it("jest CZYSTO ADDYTYWNA — zero DROP, zero ALTER TYPE, zero przepisywania wierszy", async () => {
    const sql = await runUp()

    expect(sql).not.toMatch(/DROP\s+COLUMN/i)
    expect(sql).not.toMatch(/DROP\s+TABLE/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    expect(sql).not.toMatch(/ALTER\s+COLUMN/i)
  })

  it("kolumna jest NULL-owalna — historyczne wiersze nie dostają zmyślonego wiązania", async () => {
    const sql = await runUp()

    // Backfill oznaczałby wpisanie powiązania, którego nikt nie zaobserwował.
    // `NOT NULL`/`DEFAULT` wymusiłyby dokładnie to.
    expect(sql).not.toMatch(/NOT\s+NULL/i)
    expect(sql).not.toMatch(/\bDEFAULT\b/i)
    expect(sql).not.toMatch(/\bUPDATE\b/i)
  })

  it("jest IDEMPOTENTNA — ADD COLUMN zawsze warunkowy, zero osobnego ADD CONSTRAINT", async () => {
    const sql = await runUp()

    // `ADD CONSTRAINT` w tym repo NIE przyjmuje `IF NOT EXISTS` (znany dług),
    // więc constraint deklarowany osobno wywracałby powtórny przebieg migracji.
    expect(sql).not.toMatch(/ADD\s+CONSTRAINT/i)
    const addColumns = sql.match(/ADD COLUMN/g) ?? []
    const guardedAddColumns = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []
    expect(addColumns).toHaveLength(guardedAddColumns.length)
    expect(addColumns.length).toBeGreaterThan(0)
  })

  it("down() jest no-op — ledger jest forward-only", async () => {
    const migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<typeof Migration1778938000000>[0],
      undefined as unknown as ConstructorParameters<typeof Migration1778938000000>[1],
    )
    await migration.down()
    expect(migration.recorded).toHaveLength(0)
  })
})
