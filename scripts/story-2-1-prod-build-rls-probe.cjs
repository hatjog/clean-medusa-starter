/**
 * story-2-1-prod-build-rls-probe — kontrola dodatnia i negatywna nośnika
 * kontekstu systemowego na PROD-BUILDZIE (v1.15.0 Story 2.1, AC2).
 *
 * ── Dlaczego osobny skrypt, a nie test jestowy ──────────────────────────────
 * Jest uruchamia ŹRÓDŁO TypeScriptu przez transformację testową. AC2 wymaga
 * dowodu na BUILDZIE PRODUKCYJNYM, bo „działa w teście" i „działa w tym, co
 * faktycznie startuje" to dwa różne zdania — a to repo ma udokumentowaną
 * historię defektów, które żyją wyłącznie w drugim z nich. Ten skrypt ładuje
 * artefakty z `.medusa/server/**`, czyli DOKŁADNIE ten kod, który wykonuje
 * `medusa start`.
 *
 * Uruchomienie:
 *   cd GP/backend && pnpm build
 *   DATABASE_URL=postgres://postgres:postgres@localhost:54329/gp_mercur \
 *     node scripts/story-2-1-prod-build-rls-probe.cjs
 *
 * Kod wyjścia: 0 = obie kontrole zgodne z AC2, 1 = niezgodność (opisana).
 */

const path = require("node:path")

const BUILD_ROOT = path.resolve(__dirname, "..", ".medusa", "server", "packages", "api", "src")
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:54329/gp_mercur"
const PROBE_TABLE = "gp_system_ctx_probe_prod"

const knex = require("knex")
const { marketContextStorage } = require(path.join(BUILD_ROOT, "lib", "market-context.js"))
const { installRlsPoolHook, _resetRlsPoolHook } = require(
  path.join(BUILD_ROOT, "lib", "rls-pool-hook.js"),
)
const systemContext = require(path.join(BUILD_ROOT, "lib", "system-market-context.js"))

const checks = []
function assert(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail: detail ?? null })
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  console.log(`# Kontrola AC2 na PROD-BUILDZIE`)
  console.log(`# artefakt: ${BUILD_ROOT}`)
  console.log(`# baza:     ${DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`)
  console.log("")

  const admin = knex({ client: "pg", connection: { connectionString: DATABASE_URL }, pool: { min: 1, max: 2 } })
  await admin.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medusa_store') THEN
        CREATE ROLE medusa_store NOLOGIN;
      END IF;
    END $$;
  `)
  await admin.raw(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
  await admin.raw(
    `CREATE TABLE ${PROBE_TABLE} (id TEXT PRIMARY KEY, market_id TEXT NOT NULL, note TEXT NOT NULL)`,
  )
  await admin.raw(`GRANT USAGE ON SCHEMA public TO medusa_store`)
  await admin.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO medusa_store`)
  await admin.raw(`ALTER TABLE ${PROBE_TABLE} ENABLE ROW LEVEL SECURITY`)
  await admin.raw(`
    CREATE POLICY market_isolation ON ${PROBE_TABLE}
      USING (market_id = current_setting('app.gp_market_id', true))
      WITH CHECK (market_id = current_setting('app.gp_market_id', true))
  `)

  _resetRlsPoolHook()
  const db = knex({ client: "pg", connection: { connectionString: DATABASE_URL }, pool: { min: 1, max: 2 } })
  installRlsPoolHook(db)
  systemContext._resetSystemMarketContextMetrics()

  // ── KONTROLA DODATNIA ─────────────────────────────────────────────────────
  await systemContext.runInSystemMarketContext(
    { markets: ["bonbeauty"], origin: { surface: "subscriber", name: "prod-build-probe" } },
    async () => {
      const ctx = systemContext.requireMarketContext(`insert:${PROBE_TABLE}`)
      await db.raw(`INSERT INTO ${PROBE_TABLE} (id, market_id, note) VALUES (?, ?, ?)`, [
        "positive",
        ctx.market_id,
        "zapis z zadeklarowanym rynkiem",
      ])
    },
  )

  const written = await admin.raw(`SELECT id, market_id FROM ${PROBE_TABLE}`)
  assert(
    "dodatnia: zapis z zadeklarowanym rynkiem przeszedł",
    written.rows.length === 1 && written.rows[0].market_id === "bonbeauty",
    JSON.stringify(written.rows),
  )

  const sameMarket = await systemContext.runInSystemMarketContext(
    { markets: ["bonbeauty"], origin: { surface: "job", name: "prod-build-probe" } },
    async () => db.raw(`SELECT id FROM ${PROBE_TABLE}`),
  )
  const otherMarket = await systemContext.runInSystemMarketContext(
    { markets: ["bonevent"], origin: { surface: "job", name: "prod-build-probe" } },
    async () => db.raw(`SELECT id FROM ${PROBE_TABLE}`),
  )
  assert(
    "dodatnia: wiersz widoczny WYŁĄCZNIE w zadeklarowanym rynku",
    sameMarket[0].rows.length === 1 && otherMarket[0].rows.length === 0,
    `bonbeauty=${sameMarket[0].rows.length} bonevent=${otherMarket[0].rows.length}`,
  )

  // ── KONTROLA NEGATYWNA ────────────────────────────────────────────────────
  const logged = []
  const logger = { error: (_m, meta) => logged.push(meta) }
  let denial = null
  try {
    systemContext.requireMarketContext(`insert:${PROBE_TABLE}`, { logger })
    await db.raw(`INSERT INTO ${PROBE_TABLE} (id, market_id, note) VALUES (?, ?, ?)`, [
      "negative",
      "bonbeauty",
      "zapis bez kontekstu",
    ])
  } catch (error) {
    denial = error
  }

  assert(
    "negatywna: ten sam zapis bez kontekstu = ODMOWA z kodem błędu",
    denial && denial.error_code === "GP_SYSTEM_MARKET_CONTEXT_DENIED",
    denial ? `${denial.name}/${denial.error_code}` : "brak wyjątku",
  )
  assert(
    "negatywna: odmowa zapisana w logu",
    logged.length === 1 && logged[0].reason === "context_missing",
    JSON.stringify(logged[0] ?? null),
  )
  assert(
    "negatywna: metryka gp_system_market_context_denied_total zinkrementowana",
    systemContext.getSystemMarketContextDenials({ reason: "context_missing" }) === 1,
    JSON.stringify(systemContext.getSystemMarketContextMetrics()),
  )
  const after = await admin.raw(`SELECT id FROM ${PROBE_TABLE} WHERE id = 'negative'`)
  assert("negatywna: NIC nie zostało zapisane poza izolacją", after.rows.length === 0)

  await admin.raw(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
  await db.destroy()
  await admin.destroy()
  _resetRlsPoolHook()

  const failed = checks.filter((c) => !c.ok)
  console.log("")
  console.log(`Wynik: ${checks.length - failed.length}/${checks.length} kontroli zgodnych z AC2`)
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("probe crashed:", error)
    process.exit(1)
  },
)
