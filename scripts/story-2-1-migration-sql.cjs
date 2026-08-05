/**
 * story-2-1-migration-sql — SQL powierzchni migracji WZIĘTY Z MIGRACJI
 * (v1.15.0 Story 2.1, review-fix MEDIUM-5).
 *
 * ── Problem, który to rozwiązuje ────────────────────────────────────────────
 * Sonda AC4 tworzyła sobie powierzchnię sama:
 *
 *     CREATE TABLE IF NOT EXISTS market_runtime_config ( … )
 *     ALTER TABLE market_runtime_config ADD COLUMN IF NOT EXISTS money_path_brakes JSONB NULL
 *
 * To był RĘCZNIE PRZEPISANY kształt dwóch migracji, nie ich wykonanie. Zielona
 * sonda dowodziła wtedy kodu aplikacji, a nie tego, że migracja się wykonuje —
 * a w tym repo jest udokumentowany precedens, w którym własny DDL w teście
 * zamaskował rozjazd typu kolumny względem migracji (ADR-166).
 *
 * Ten moduł czyta SQL Z PLIKU MIGRACJI (`this.addSql(…)`), więc zmiana kształtu
 * migracji natychmiast zmienia to, co wykonuje sonda. Kopii nie ma.
 *
 * Preferuje artefakt PROD-BUILDU (`.medusa/server/**`), gdy istnieje — wtedy
 * mierzony jest ten sam plik, który uruchamia `medusa start`. Gdy buildu nie
 * ma, czyta źródło TS (kształt `addSql` jest w obu identyczny).
 *
 * Użycie jako moduł:
 *   const { collectMigrationSql } = require("./story-2-1-migration-sql.cjs")
 *   for (const sql of await collectMigrationSql(["Migration20260805120000MoneyPathBrakesColumn"])) {
 *     await db.raw(sql)
 *   }
 *
 * Użycie jako CLI (wypisuje SQL na stdout — nadaje się dla `psql -f -`):
 *   node scripts/story-2-1-migration-sql.cjs Migration20260730120000MarketRuntimeConfigTable
 */

const fs = require("node:fs")
const path = require("node:path")

const API_SRC = path.resolve(__dirname, "..", "packages", "api", "src")
const BUILD_SRC = path.resolve(
  __dirname,
  "..",
  ".medusa",
  "server",
  "packages",
  "api",
  "src",
)

/** Znajdź plik migracji o danej nazwie klasy — najpierw prod-build, potem źródło. */
function resolveMigrationFile(className) {
  const candidates = [
    path.join(BUILD_SRC, "migrations", `${className}.js`),
    path.join(API_SRC, "migrations", `${className}.ts`),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    `story-2-1-migration-sql: nie znaleziono migracji ${className} (${candidates.join(", ")})`,
  )
}

/**
 * Uruchom `up()` klasy migracji z podstawionym `addSql` i zbierz SQL.
 *
 * WYKONANIE, nie parsowanie tekstu: `Migration20260730120000MarketRuntimeConfigTable`
 * generuje część instrukcji w pętli (`ADD COLUMN IF NOT EXISTS ${column}`), więc
 * ekstrakcja regexem po cichu gubiłaby pięć `ALTER TABLE` — czyli produkowałaby
 * dokładnie ten rozjazd sondy względem migracji, który MEDIUM-5 zamyka.
 *
 * `Object.create(prototype)` omija konstruktor MikroORM-owej `Migration`
 * (potrzebuje drivera i configu); `up()` używa wyłącznie `this.addSql`.
 */
function collectSqlFromClass(migrationClass) {
  const statements = []
  const instance = Object.create(migrationClass.prototype)
  instance.addSql = (sql) => {
    const text = String(sql).trim()
    if (text) {
      statements.push(text)
    }
  }
  const result = instance.up()
  if (result && typeof result.then === "function") {
    // `up()` jest async, ale nic nie awaituje — rozwiązana obietnica wystarczy.
    return result.then(() => statements)
  }
  return statements
}

/** SQL `up()` wskazanych migracji, w podanej kolejności. */
async function collectMigrationSql(classNames) {
  const statements = []
  for (const className of classNames) {
    const file = resolveMigrationFile(className)
    const module_ = require(file)
    const migrationClass = module_[className] ?? module_.default
    if (typeof migrationClass !== "function") {
      throw new Error(
        `story-2-1-migration-sql: ${file} nie eksportuje klasy ${className}`,
      )
    }
    const found = await collectSqlFromClass(migrationClass)
    if (found.length === 0) {
      throw new Error(
        `story-2-1-migration-sql: migracja ${className} (${file}) nie wyprodukowała ani jednej instrukcji — ` +
          "sonda nie może udawać, że wykonała migrację",
      )
    }
    statements.push(...found)
  }
  return statements
}

module.exports = { collectMigrationSql, collectSqlFromClass, resolveMigrationFile }

if (require.main === module) {
  const names = process.argv.slice(2)
  if (names.length === 0) {
    console.error("uzycie: node scripts/story-2-1-migration-sql.cjs <NazwaKlasyMigracji> …")
    process.exit(2)
  }
  collectMigrationSql(names)
    .then((statements) => {
      for (const sql of statements) {
        process.stdout.write(`${sql.replace(/;\s*$/, "")};\n`)
      }
    })
    .catch((error) => {
      console.error(String(error && error.message ? error.message : error))
      process.exit(1)
    })
}
