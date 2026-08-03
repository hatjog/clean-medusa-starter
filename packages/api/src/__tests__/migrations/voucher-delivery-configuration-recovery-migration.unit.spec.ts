import { Migration1778936000000 } from "../../modules/voucher/migrations/1778936000000_limit_voucher_delivery_configuration_recovery"

class RecordingMigration extends Migration1778936000000 {
  readonly recorded: string[] = []

  public override addSql(sql: string): void {
    this.recorded.push(sql)
  }
}

describe("Migration1778936000000 — granica odzyskiwania budżetu konfiguracji", () => {
  it("dodaje trwały, nieujemny licznik z bezpiecznym domyślnym zerem", async () => {
    const migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<typeof Migration1778936000000>[0],
      undefined as unknown as ConstructorParameters<typeof Migration1778936000000>[1]
    )
    await migration.up()

    const sql = migration.recorded.join("\n").replace(/\s+/g, " ")
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS configuration_recovery_count integer NOT NULL DEFAULT 0")
    expect(sql).toContain("CHECK (configuration_recovery_count >= 0)")
  })
})
