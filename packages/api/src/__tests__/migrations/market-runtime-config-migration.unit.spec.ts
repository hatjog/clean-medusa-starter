/**
 * market-runtime-config-migration.unit.spec.ts — Story 5.7 (AC1).
 *
 * Weryfikuje SQL migracji bez żywego Postgresa (wzorzec
 * `voucher-delivery-dispatch-migration.unit.spec.ts`: przechwycenie `addSql`).
 *
 * Co jest tu bronione:
 *   - tabela powstaje na powierzchni APLIKACYJNEJ (`packages/api/src/migrations`),
 *   - `CREATE TABLE IF NOT EXISTS` + komplet `ADD COLUMN IF NOT EXISTS`, więc
 *     migracja obsługuje bazę czystą, częściowo istniejącą tabelę i re-run,
 *   - `down()` jest DATA-PRESERVING (żadnego DROP/DELETE/TRUNCATE),
 *   - adoption probe runnera nie zaliczy tabeli bez kolumn kontraktu.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Migration20260730120000MarketRuntimeConfigTable } from "../../migrations/Migration20260730120000MarketRuntimeConfigTable"

type RecordedSql = { sql: string }

class RecordingMigration extends Migration20260730120000MarketRuntimeConfigTable {
  public recorded: RecordedSql[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override addSql(sql: string, ...args: any[]): any {
    void args
    this.recorded.push({ sql })
  }
}

const MIGRATION_SOURCE_PATH = resolve(
  __dirname,
  "../../migrations/Migration20260730120000MarketRuntimeConfigTable.ts",
)
const RUNNER_SOURCE_PATH = resolve(
  __dirname,
  "../../scripts/run-app-migrations.ts",
)

async function runUp(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const migration = new (RecordingMigration as any)() as RecordingMigration
  await migration.up()
  return migration.recorded.map((entry) => entry.sql).join("\n")
}

describe("Migration20260730120000MarketRuntimeConfigTable — market_runtime_config (AC1)", () => {
  it("tworzy tabelę idempotentnie, z kolumnami kontraktu", async () => {
    const sql = (await runUp()).replace(/\s+/g, " ")

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS market_runtime_config/i)
    expect(sql).toMatch(/market_id\s+TEXT PRIMARY KEY/i)
    expect(sql).toMatch(/locales\s+JSONB/i)
    expect(sql).toMatch(/support_email\s+TEXT/i)
    expect(sql).toMatch(/market_url\s+TEXT/i)
  })

  it("uzupełnia brakujące kolumny w tabeli CZĘŚCIOWO istniejącej", async () => {
    const sql = await runUp()

    // Wariant fixture'owy tej tabeli ma `locales`, ale nie ma kolumn 5.7 —
    // sam `CREATE TABLE IF NOT EXISTS` zostawiłby go bez nich.
    for (const column of ["locales", "support_email", "market_url"]) {
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE market_runtime_config ADD COLUMN IF NOT EXISTS ${column}\\b`,
          "i",
        ),
      )
    }
  })

  it("każdy DDL jest re-runnable (IF NOT EXISTS w KAŻDYM statemencie)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migration = new (RecordingMigration as any)() as RecordingMigration
    await migration.up()

    for (const statement of migration.recorded) {
      expect(statement.sql).toMatch(/IF NOT EXISTS/i)
    }
  })

  it("up() nie zawiera DROP/TRUNCATE/DELETE", async () => {
    const sql = await runUp()
    expect(sql).not.toMatch(/\bDROP\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    expect(sql).not.toMatch(/\bDELETE\b/i)
  })

  it("down() jest data-preserving — nie emituje ŻADNEGO SQL", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migration = new (RecordingMigration as any)() as RecordingMigration
    await migration.down()

    expect(migration.recorded).toHaveLength(0)
  })

  it("adoption probe runnera wymaga KOLUMN, nie samej obecności tabeli", () => {
    const runner = readFileSync(RUNNER_SOURCE_PATH, "utf8")
    const probeBlock = runner.slice(
      runner.indexOf("Migration20260730120000MarketRuntimeConfigTable:"),
    )

    // Probe po `tableExists` zaadoptowałby wariant fixture'owy i migracja
    // dokładająca `support_email`/`market_url` nigdy by nie poszła.
    expect(probeBlock).toContain("columnExists")
    for (const column of ["locales", "support_email", "market_url"]) {
      expect(probeBlock.slice(0, 600)).toContain(`"${column}"`)
    }
  })

  it("dokumentuje, że powierzchnią jest db:migrate:app, a nie medusa db:migrate", () => {
    const source = readFileSync(MIGRATION_SOURCE_PATH, "utf8")
    expect(source).toContain("db:migrate:app")
    // Docstring bywa łamany na wiele linii — normalizujemy białe znaki.
    expect(source.replace(/\s*\*\s*/g, " ")).toContain("medusa db:migrate")
  })
})
