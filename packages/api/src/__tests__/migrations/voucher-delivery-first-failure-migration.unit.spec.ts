import { Migration1778935000000 } from "../../modules/voucher/migrations/1778935000000_preserve_voucher_delivery_first_failure"

class RecordingMigration extends Migration1778935000000 {
  readonly recorded: string[] = []

  public override addSql(sql: string): void {
    this.recorded.push(sql)
  }
}

/**
 * OGRANICZENIE TEGO TESTU — nazwane wprost, bo już raz kosztowało przebieg.
 *
 * Ten spec przechwytuje SQL jako STRING i asertuje podciągi. NIE wykonuje go
 * przeciw Postgresowi, więc **nie może wykryć niepoprawnej składni**. Pierwsza
 * wersja tej migracji używała `UPDATE ... SET ... FROM LATERAL (…)` z referencją
 * do aliasu tabeli docelowej — konstrukcji, którą PostgreSQL odrzuca
 * ("invalid reference to FROM-clause entry for table d"). Ten test świecił
 * ZIELONO, a `medusa db:migrate` padał. Dowodem poprawności migracji jest jej
 * wykonanie na żywej bazie, nie ten plik.
 *
 * Dlatego poniżej asertujemy nie tylko obecność elementów backfillu, ale też
 * BRAK konstrukcji, która ten konkretny błąd wprowadziła.
 */
describe("Migration1778935000000 — pierwsza porażka dispatchu", () => {
  it("dodaje trwałe pola i backfilluje je z najwcześniejszego append-only audytu", async () => {
    const migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<typeof Migration1778935000000>[0],
      undefined as unknown as ConstructorParameters<typeof Migration1778935000000>[1]
    )
    await migration.up()
    const sql = migration.recorded.join("\n").replace(/\s+/g, " ")

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS first_error_code text NULL")
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS first_failed_at timestamptz NULL")
    expect(sql).toContain("voucher_delivery_dispatch_audit")
    expect(sql).toContain("a.to_status = 'failed'")
    // Najwcześniejsza porażka per dispatch: DISTINCT ON + deterministyczny tie-break.
    expect(sql).toContain("DISTINCT ON (a.dispatch_id)")
    expect(sql).toContain("ORDER BY a.dispatch_id, a.occurred_at ASC, a.audit_id ASC")
    // Backfill nie może nadpisywać już ustalonej pierwotnej przyczyny.
    expect(sql).toContain("d.first_error_code IS NULL")
  })

  it("nie używa UPDATE ... FROM LATERAL z referencją do tabeli docelowej (PostgreSQL to odrzuca)", async () => {
    const migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<typeof Migration1778935000000>[0],
      undefined as unknown as ConstructorParameters<typeof Migration1778935000000>[1]
    )
    await migration.up()
    const sql = migration.recorded.join("\n").replace(/\s+/g, " ")

    expect(sql).not.toMatch(/FROM\s+LATERAL/i)
  })
})
