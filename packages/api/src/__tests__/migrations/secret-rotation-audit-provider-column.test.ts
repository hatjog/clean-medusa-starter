// Mockujemy framework Migration jako stub class z zero-arg ctor zeby test
// nie zalezal od wewnetrznego kontraktu Medusa Mikro-ORM Migration ctor.
jest.mock("@medusajs/framework/mikro-orm/migrations", () => {
  class MigrationStub {
    public addSql(_sql: string, ..._args: unknown[]): void {
      /* nadpisywane przez podklase rejestrujaca */
    }
  }
  return { Migration: MigrationStub }
})

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

function extractProviderCheckLiterals(sql: string): string[][] {
  // Wyciaga zawartosc kazdego CHECK (provider IN (...)) bloku osobno
  const matches = [
    ...sql.matchAll(
      /CHECK\s*\(\s*provider\s+IN\s*\(([^)]+)\)\s*\)/gi
    ),
  ]
  return matches.map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  )
}

describe("Migration20260527083000SecretRotationAuditProviderColumn", () => {
  let migration: RecordingMigration

  beforeEach(() => {
    // MikroORM Migration ctor wymaga (driver, config); runtime jest mockowany
    // zero-arg MigrationStub (patrz jest.mock powyzej), wiec przekazujemy stuby
    // tylko po to, by spelnic kontrakt typow bazowej klasy.
    migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<typeof Migration20260527083000SecretRotationAuditProviderColumn>[0],
      undefined as unknown as ConstructorParameters<typeof Migration20260527083000SecretRotationAuditProviderColumn>[1],
    )
  })

  it("up() tworzy tabele secret_rotation_audit z wymaganym provider", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(/CREATE TABLE\s+secret_rotation_audit/i)
    expect(sql).toMatch(/provider\s+VARCHAR\(32\)\s+NOT NULL/i)
    expect(sql).toMatch(/secret_rotation_audit_provider_check/i)
  })

  it("up() wymusza dokladnie 6 klas provider z D-100 set-wise w SQL", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    const providerCheckBlocks = extractProviderCheckLiterals(sql)
    expect(providerCheckBlocks.length).toBeGreaterThan(0)

    // Kazdy CHECK provider IN (...) blok MUSI zawierac dokladnie 6 klas D-100
    // bez nadmiarowych literalow ani duplikatow.
    const expected = new Set<string>([...SECRET_ROTATION_AUDIT_PROVIDERS])
    for (const block of providerCheckBlocks) {
      expect(new Set(block)).toEqual(expected)
      expect(block.length).toBe(expected.size)
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

  it("up() rejestruje marker COMMENT ON TABLE dla symetrycznego down()", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(/COMMENT ON TABLE secret_rotation_audit IS/i)
    expect(sql).toContain(
      "created_by:Migration20260527083000SecretRotationAuditProviderColumn"
    )
  })

  it("up() dodaje kolumne event_timestamp pod runtime activation w v1.16.0+", async () => {
    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(/event_timestamp\s+TIMESTAMPTZ/i)
  })

  it("down() symetrycznie cofa pelny up() gdy tabela byla utworzona przez migracje", async () => {
    await migration.down()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    expect(sql).toMatch(/DROP INDEX IF EXISTS secret_rotation_audit_market_provider_idx/i)
    // Sciezka "table_owned_by_migration" w down() MUSI dropowac cala tabele,
    // zeby v1.8.0 baseline (bez tabeli) byl rzeczywiscie odtworzony.
    expect(sql).toMatch(/DROP TABLE IF EXISTS secret_rotation_audit/i)
    // Sciezka defensywna dla pre-existing tabeli cofa wylacznie provider column + check.
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS secret_rotation_audit_provider_check/i)
    expect(sql).toMatch(/DROP COLUMN IF EXISTS provider/i)
    expect(sql).toMatch(/DROP COLUMN IF EXISTS event_timestamp/i)
  })

  it("up -> down -> up odtwarza kolumne provider", async () => {
    await migration.up()
    expect(
      migration.recorded.some((entry) =>
        /ADD COLUMN provider VARCHAR\(32\)/i.test(entry.sql)
      )
    ).toBe(true)

    migration.reset()
    await migration.down()
    expect(
      migration.recorded.some((entry) => /DROP COLUMN IF EXISTS provider/i.test(entry.sql))
    ).toBe(true)

    migration.reset()
    await migration.up()
    expect(
      migration.recorded.some((entry) =>
        /ADD COLUMN provider VARCHAR\(32\)/i.test(entry.sql)
      )
    ).toBe(true)
  })
})
