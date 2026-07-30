import { Migration1778935000000 } from "../../modules/voucher/migrations/1778935000000_preserve_voucher_delivery_first_failure"

class RecordingMigration extends Migration1778935000000 {
  readonly recorded: string[] = []

  public override addSql(sql: string): void {
    this.recorded.push(sql)
  }
}

describe("Migration1778935000000 — pierwsza porażka dispatchu", () => {
  it("dodaje trwałe pola i backfilluje je z najwcześniejszego append-only audytu", async () => {
    const migration = new RecordingMigration()
    await migration.up()
    const sql = migration.recorded.join("\n").replace(/\s+/g, " ")

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS first_error_code text NULL")
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS first_failed_at timestamptz NULL")
    expect(sql).toContain("voucher_delivery_dispatch_audit")
    expect(sql).toContain("ORDER BY a.occurred_at ASC, a.audit_id ASC")
    expect(sql).toContain("AND a.to_status = 'failed'")
  })
})
