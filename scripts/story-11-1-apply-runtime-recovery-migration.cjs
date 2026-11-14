#!/usr/bin/env node
/**
 * story-11-1-apply-runtime-recovery-migration — JEDNA, powtarzalna komenda
 * doprowadzająca izolowaną bazę testową do schematu Story 11.1 (C5-PG-002).
 *
 * Dlaczego nie `db:migrate:all` / `db:migrate:app`: pierwsza zatrzymuje się na
 * braku REDIS_URL (bootstrap całej Medusy), druga na braku tabeli `seller`
 * w kolejności migracji aplikacji. Ta komenda wykonuje WYŁĄCZNIE migracje
 * Story 11.1, czytając SQL z klasy migracji (`this.addSql(...)`) — bez kopii DDL.
 *
 * Kontrakt:
 *   - cel z DATABASE_URL; odmowa dla baz deweloperskich, nazw bez sufiksu `_test`
 *     i hostów nielokalnych (ta sama straż co integration-tests/setup.js, Story 7.2);
 *   - całość w JEDNEJ transakcji (porażka = ROLLBACK, baza bez zmian);
 *   - idempotentne: migracja używa IF NOT EXISTS / DROP ... IF EXISTS, a wpis
 *     rewizji w `mikro_orm_migrations` powstaje tylko, gdy go brak;
 *   - po wykonaniu rewizja jest zapisana, więc testy mogą sprawdzić, że baza
 *     niesie schemat 11.1 (kontrola rewizji migracji).
 *
 * Użycie (hasło wyłącznie przez PGPASSWORD, nigdy w URI w śledzonych plikach):
 *   DATABASE_URL=postgres://postgres@localhost:55432/gp_story_11_1_w0_test \
 *     pnpm run db:migrate:story-11-1
 */
const path = require("node:path")

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs" } })

const { Client } = require("pg")

const STORY_11_1_MIGRATIONS = [
  {
    name: "1779016000000_runtime_recovery_rls_boundary",
    file: path.resolve(
      __dirname,
      "..",
      "packages/api/src/modules/voucher/migrations/1779016000000_runtime_recovery_rls_boundary.ts",
    ),
    exportName: "Migration1779016000000",
  },
]

const DEVELOPMENT_DATABASES = new Set(["gp_mercur", "gp_core", "gp_portal"])
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

function resolveTarget(raw) {
  if (!raw) throw new Error("[story-11-1-migrate] DATABASE_URL jest wymagany")
  const url = new URL(raw)
  const dbName = decodeURIComponent(url.pathname).replace(/^\//, "")
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("[story-11-1-migrate] DATABASE_URL musi używać schematu postgres")
  }
  if (DEVELOPMENT_DATABASES.has(dbName) || !/_test$/.test(dbName)) {
    throw new Error(`[story-11-1-migrate] odmowa: baza '${dbName}' nie jest izolowaną bazą *_test`)
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`[story-11-1-migrate] odmowa: host '${url.hostname}' nie jest lokalny`)
  }
  return { url, dbName }
}

async function collectUpSql(migration) {
  const mod = require(migration.file)
  const MigrationClass = mod[migration.exportName]
  if (typeof MigrationClass !== "function") {
    throw new Error(`[story-11-1-migrate] brak eksportu ${migration.exportName} w ${migration.file}`)
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
    for (const migration of STORY_11_1_MIGRATIONS) {
      for (const sql of await collectUpSql(migration)) {
        await client.query(sql)
      }
      const recorded = await client.query(
        "SELECT 1 FROM mikro_orm_migrations WHERE name = $1",
        [migration.name],
      )
      if (recorded.rowCount === 0) {
        await client.query("INSERT INTO mikro_orm_migrations (name) VALUES ($1)", [migration.name])
        report.applied.push(migration.name)
      } else {
        report.already_recorded.push(migration.name)
      }
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

module.exports = { resolveTarget, STORY_11_1_MIGRATIONS }
