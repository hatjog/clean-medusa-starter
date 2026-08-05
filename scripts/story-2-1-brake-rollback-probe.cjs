/**
 * story-2-1-brake-rollback-probe — dowód WYCOFYWALNOŚCI hamulca WYKONANIEM
 * (v1.15.0 Story 2.1, AC4; NFR-8, AD-25, ADR-177).
 *
 * ── Co ten skrypt dowodzi ───────────────────────────────────────────────────
 * Że zmiana wartości hamulca w warstwie SOURCE zmienia OBSERWOWALNE zachowanie
 * kodu BEZ REBUILDU i BEZ REDEPLOYA. Dlatego cały łańcuch leci na artefaktach
 * PROD-BUILDU (`.medusa/server/**`), które nie są w międzyczasie przebudowywane:
 *
 *   RUNTIME GP/config/<instance>/markets/<market>/market.yaml
 *     -> buildMarketRuntimeRecord()      (REALNY kod etapu sync, nie atrapa)
 *     -> applyMarketRuntimeSync()        (REALNY zapis do market_runtime_config)
 *     -> createMoneyPathBrakeReader()    (JEDYNY helper odczytu)
 *
 * Między dwoma odczytami zmienia się WYŁĄCZNIE zawartość konfiguracji.
 * Proces nie jest restartowany, moduły nie są przeładowywane, kod nie jest
 * kompilowany ponownie.
 *
 * Uruchomienie:
 *   cd GP/backend && pnpm build
 *   DATABASE_URL=postgres://postgres:postgres@localhost:54329/gp_mercur \
 *     node scripts/story-2-1-brake-rollback-probe.cjs
 */

const fs = require("node:fs")
const path = require("node:path")

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")
const BUILD_ROOT = path.resolve(__dirname, "..", ".medusa", "server", "packages", "api", "src")
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:54329/gp_mercur"
const INSTANCE = process.env.GP_INSTANCE_ID || "gp-dev"
const MARKET = process.env.GP_MARKET_ID || "bonbeauty"
const BRAKE = "fr_9_delivery_idempotency"

const knex = require("knex")
const yaml = require(path.join(REPO_ROOT, "GP", "backend", "node_modules", "js-yaml"))
const sync = require(path.join(BUILD_ROOT, "scripts", "gp-config-sync-market-runtime.js"))
const brakes = require(path.join(BUILD_ROOT, "lib", "money-path-brakes.js"))

const checks = []
function assert(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok) })
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

function readRuntimeMarketYaml() {
  const file = path.join(REPO_ROOT, "GP", "config", INSTANCE, "markets", MARKET, "market.yaml")
  return yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.JSON_SCHEMA })
}

async function syncFromRuntime(db) {
  const record = sync.buildMarketRuntimeRecord(MARKET, readRuntimeMarketYaml())
  await sync.applyMarketRuntimeSync(db, record)
  return record
}

async function main() {
  console.log("# AC4 — dowód wycofywalności hamulca WYKONANIEM (prod-build)")
  console.log(`# artefakt: ${BUILD_ROOT}`)
  console.log(`# rynek:    ${MARKET}@${INSTANCE}  hamulec: ${BRAKE}`)
  console.log("")

  const db = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 1, max: 2 },
  })

  // Powierzchnia migracji aplikacyjnych: tabela + kolumna nośnika hamulca
  // (Migration20260730120000MarketRuntimeConfigTable + Migration20260805120000MoneyPathBrakesColumn).
  await db.raw(`
    CREATE TABLE IF NOT EXISTS market_runtime_config (
      market_id      TEXT PRIMARY KEY,
      locales        JSONB NULL,
      support_email  TEXT NULL,
      market_url     TEXT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await db.raw(
    `ALTER TABLE market_runtime_config ADD COLUMN IF NOT EXISTS money_path_brakes JSONB NULL`,
  )

  const reader = brakes.createMoneyPathBrakeReader(db)

  // ── 0. Fail-closed PRZED jakąkolwiek synchronizacją ────────────────────────
  await db.raw(`DELETE FROM market_runtime_config WHERE market_id = ?`, [MARKET])
  const beforeSync = await reader.read(MARKET, BRAKE)
  assert(
    "brak wiersza konfiguracji => wartość BEZPIECZNA `engaged` + degraded",
    beforeSync.state === "engaged" && beforeSync.degraded === true,
    `${beforeSync.state}/degraded=${beforeSync.degraded}/${beforeSync.reason}`,
  )

  // ── 1. Stan po synchronizacji bieżącego RUNTIME ───────────────────────────
  const initial = await syncFromRuntime(db)
  const readInitial = await reader.read(MARKET, BRAKE)
  console.log(`   RUNTIME market.yaml -> ${JSON.stringify(initial.money_path_brakes)}`)
  assert(
    "wartość pochodzi z konfiguracji rynku, nie z domyślnej",
    readInitial.degraded === false,
    `state=${readInitial.state}`,
  )
  assert(
    "isReleased() dla hamulca `engaged` = false (nowe zachowanie WYŁĄCZONE)",
    (await reader.isReleased(MARKET, BRAKE)) === false,
  )

  // ── 2. ZWOLNIENIE hamulca — zmiana WYŁĄCZNIE w konfiguracji ───────────────
  // Symulujemy wynik `gp-ops brake set --state released --apply` na warstwie
  // RUNTIME, po czym puszczamy REALNY etap sync. Kod się nie zmienia.
  const runtimeYaml = readRuntimeMarketYaml()
  runtimeYaml.money_path_brakes = { ...runtimeYaml.money_path_brakes, [BRAKE]: "released" }
  const releasedRecord = sync.buildMarketRuntimeRecord(MARKET, runtimeYaml)
  await sync.applyMarketRuntimeSync(db, releasedRecord)

  const readReleased = await reader.read(MARKET, BRAKE)
  assert(
    "po zwolnieniu: TEN SAM proces, TEN SAM build, odczyt = `released`",
    readReleased.state === "released" && readReleased.degraded === false,
    `state=${readReleased.state}`,
  )
  assert(
    "isReleased() = true (nowe zachowanie WŁĄCZONE bez rebuildu i redeploya)",
    (await reader.isReleased(MARKET, BRAKE)) === true,
  )

  // ── 3. WYCOFANIE — droga powrotna bez wdrożenia kodu ──────────────────────
  await syncFromRuntime(db)
  const readRolledBack = await reader.read(MARKET, BRAKE)
  assert(
    "wycofanie: odczyt wraca do `engaged` — bez rebuildu, bez restartu procesu",
    readRolledBack.state === "engaged" && readRolledBack.degraded === false,
    `state=${readRolledBack.state}`,
  )

  // ── 4. Niepoprawna wartość zatrzymuje sync PRZED zapisem ──────────────────
  let rejected = null
  try {
    sync.buildMarketRuntimeRecord(MARKET, {
      ...readRuntimeMarketYaml(),
      money_path_brakes: { ...runtimeYaml.money_path_brakes, [BRAKE]: "relesed" },
    })
  } catch (error) {
    rejected = error
  }
  assert(
    "literówka w stanie hamulca = błąd konfiguracji, nie cicha podmiana",
    rejected && rejected.error_code === "GP_CONFIG_MARKET_RUNTIME_INVALID",
    rejected ? rejected.message : "brak wyjątku",
  )

  await db.destroy()

  const failed = checks.filter((c) => !c.ok)
  console.log("")
  console.log(`Wynik: ${checks.length - failed.length}/${checks.length} kontroli zgodnych z AC4`)
  console.log("Procedura wycofania NIE wymaga restartu procesu: helper czyta wartość")
  console.log("przy każdym wywołaniu, więc kolejne żądanie widzi już nowy stan.")
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("probe crashed:", error)
    process.exit(1)
  },
)
