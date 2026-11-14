#!/usr/bin/env node
/**
 * story-4-2-apply-compensation-failure-migration — jedna powtarzalna komenda
 * doprowadzająca izolowaną bazę *_test do schematu Story 4.2
 * (money_path_compensation_failure + kolumny recovery, kwarantanna, RLS).
 * Wzorzec: scripts/story-11-1-apply-runtime-recovery-migration.cjs (ta sama
 * straż baz deweloperskich, jedna transakcja, wpis rewizji w mikro_orm_migrations;
 * migracja już zapisana jest pomijana).
 *
 * Użycie (hasło wyłącznie przez PGPASSWORD):
 *   DATABASE_URL=postgres://postgres@localhost:55432/gp_story_4_2_test \
 *     GP_INSTANCE_ID=<instancja> pnpm run db:migrate:story-4-2
 */
const path = require("node:path")

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs" } })

const { Client } = require("pg")

const STORY_4_2_MIGRATIONS = [
  {
    // Baza tabeli (v1.15.0 Story 3.5) — idempotentna (CREATE ... IF NOT EXISTS).
    name: "Migration20260818090000MoneyPathCompensationFailureTable",
    file: path.resolve(__dirname, "..", "packages/api/src/migrations/Migration20260818090000MoneyPathCompensationFailureTable.ts"),
    exportName: "Migration20260818090000MoneyPathCompensationFailureTable",
  },
  {
    name: "Migration20261114120000MoneyPathCompensationFailureRecoveryColumns",
    file: path.resolve(__dirname, "..", "packages/api/src/migrations/Migration20261114120000MoneyPathCompensationFailureRecoveryColumns.ts"),
    exportName: "Migration20261114120000MoneyPathCompensationFailureRecoveryColumns",
  },
]

const DEVELOPMENT_DATABASES = new Set(["gp_mercur", "gp_core", "gp_portal"])
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

function resolveTarget(raw) {
  if (!raw) throw new Error("[story-4-2-migrate] DATABASE_URL jest wymagany")
  const url = new URL(raw)
  const dbName = decodeURIComponent(url.pathname).replace(/^\//, "")
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("[story-4-2-migrate] DATABASE_URL musi używać schematu postgres")
  }
  if (DEVELOPMENT_DATABASES.has(dbName) || !/_test$/.test(dbName)) {
    throw new Error(`[story-4-2-migrate] odmowa: baza '${dbName}' nie jest izolowaną bazą *_test`)
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`[story-4-2-migrate] odmowa: host '${url.hostname}' nie jest lokalny`)
  }
  return { url, dbName }
}

async function collectUpSql(migration) {
  const mod = require(migration.file)
  const MigrationClass = mod[migration.exportName]
  if (typeof MigrationClass !== "function") {
    throw new Error(`[story-4-2-migrate] brak eksportu ${migration.exportName} w ${migration.file}`)
  }
  const statements = []
  await MigrationClass.prototype.up.call({ addSql: (sql) => statements.push(sql) })
  return statements
}

async function main() {
  const { url, dbName } = resolveTarget(process.env.DATABASE_URL)
  const client = new Client({
    connectionString: url.toString(),
    password: process.env.PGPASSWORD || decodeURIComponent(url.password) || undefined,
  })
  await client.connect()
  const report = { database: dbName, applied: [], already_recorded: [] }
  try {
    await client.query("BEGIN")
    for (const migration of STORY_4_2_MIGRATIONS) {
      const recorded = await client.query(
        "SELECT 1 FROM mikro_orm_migrations WHERE name = $1",
        [migration.name],
      )
      if (recorded.rowCount > 0) {
        report.already_recorded.push(migration.name)
        continue
      }
      for (const sql of await collectUpSql(migration)) {
        await client.query(sql)
      }
      await client.query("INSERT INTO mikro_orm_migrations (name) VALUES ($1)", [migration.name])
      report.applied.push(migration.name)
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}

module.exports = { resolveTarget, STORY_4_2_MIGRATIONS }
