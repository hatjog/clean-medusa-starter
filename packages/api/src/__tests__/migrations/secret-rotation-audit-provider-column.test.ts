import {
  Migration20260527083000SecretRotationAuditProviderColumn,
  SECRET_ROTATION_AUDIT_PROVIDERS,
} from "../../migrations/Migration20260527083000SecretRotationAuditProviderColumn"

type RecordedSql = { sql: string; params: unknown[] }

class RecordingMigration extends Migration20260527083000SecretRotationAuditProviderColumn {
  public recorded: RecordedSql[] = []

  public override addSql(sql: string, ...args: unknown[]): void {
    const params = Array.isArray(args[0]) ? args[0] : []
    this.recorded.push({ sql, params })
  }

  reset(): void {
    this.recorded = []
  }
}

describe("Migration20260527083000SecretRotationAuditProviderColumn", () => {
  let migration: RecordingMigration

  beforeEach(() => {
    const TestMigration = RecordingMigration as unknown as new () => RecordingMigration
    migration = new TestMigration()
  })

  it("up() tworzy tabelę secret_rotation_audit z wymaganym provider", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS secret_rotation_audit/i)
    expect(sql).toMatch(/provider\s+VARCHAR\(32\)\s+NOT NULL/i)
    expect(sql).toMatch(/secret_rotation_audit_provider_check/i)
  })

  it("up() wymusza dokładnie 6 klas provider z D-100", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    for (const provider of SECRET_ROTATION_AUDIT_PROVIDERS) {
      expect(sql).toContain(`'${provider}'`)
    }
    expect(SECRET_ROTATION_AUDIT_PROVIDERS).toEqual([
      "stripe_webhook",
      "brevo_hmac",
      "mercur_api",
      "google_wallet",
      "map_signing",
      "apple_wallet",
    ])
  })

  it("up() zawiera bezpieczny backfill mercur_api przed NOT NULL", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(
      /UPDATE secret_rotation_audit\s+SET provider = 'mercur_api'\s+WHERE provider IS NULL/i
    )
    expect(sql).toMatch(/ALTER COLUMN provider SET NOT NULL/i)
  })

  it("down() cofa provider column i constraint", async () => {
    await migration.down()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS secret_rotation_audit_provider_check/i)
    expect(sql).toMatch(/DROP COLUMN IF EXISTS provider/i)
  })

  it("up -> down -> up odtwarza kolumnę provider", async () => {
    await migration.up()
    expect(
      migration.recorded.some((entry) =>
        /ADD COLUMN IF NOT EXISTS provider/i.test(entry.sql)
      )
    ).toBe(true)

    migration.reset()
    await migration.down()
    expect(
      migration.recorded.some((entry) =>
        /DROP COLUMN IF EXISTS provider/i.test(entry.sql)
      )
    ).toBe(true)

    migration.reset()
    await migration.up()
    expect(
      migration.recorded.some((entry) =>
        /ADD COLUMN IF NOT EXISTS provider/i.test(entry.sql)
      )
    ).toBe(true)
  })
})
