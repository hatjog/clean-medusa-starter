/**
 * Kontrola DODATNIA i NEGATYWNA nośnika kontekstu systemowego na REALNYM
 * Postgresie z włączonym RLS (v1.15.0 Story 2.1, AC2; NFR-1, NFR-2).
 *
 * ── Dlaczego nie mock puli ──────────────────────────────────────────────────
 * NFR-1 nazywa dominującą klasą defektów tego repo „zabezpieczenie istnieje,
 * ale jest martwe". Test na atrapie puli dowodzi wyłącznie tego, że atrapa
 * zachowuje się tak, jak ją napisano. Tutaj lecą prawdziwe połączenia Knexa,
 * prawdziwy `installRlsPoolHook`, prawdziwa rola `medusa_store` i prawdziwa
 * polityka RLS — dokładnie ten sam mechanizm, którego używa łańcuch `/store/*`.
 *
 * ── Zakres dowodu (uczciwie) ────────────────────────────────────────────────
 * Tabela `gp_system_ctx_probe` jest fixture'em tej kontroli, a nie tabelą
 * produkcyjną: polityka ma DOKŁADNIE ten sam kształt co
 * `infra/postgres/migrations/005-rls-customer-market-isolation.sql`
 * (`USING` + `WITH CHECK` na `current_setting('app.gp_market_id', true)`),
 * ale sama tabela powstaje i znika w tym teście. Dowodzimy nośnika i łańcucha
 * izolacji, nie pokrycia politykami wszystkich tabel produkcyjnych.
 *
 * ── Uruchomienie ────────────────────────────────────────────────────────────
 *   docker run -d --name gp-story-2-1-rls -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_USER=postgres -e POSTGRES_DB=gp_mercur -p 54329:5432 \
 *     postgres:17.6-alpine
 *   cd GP/backend && DATABASE_URL=postgres://postgres:postgres@localhost:54329/gp_mercur \
 *     pnpm test:integration:modules -- packages/api/src/__tests__/rls/system-market-context-rls.integration.spec.ts
 */

import knex, { Knex } from "knex"

import { marketContextStorage } from "../../lib/market-context"
import { _resetRlsPoolHook, installRlsPoolHook } from "../../lib/rls-pool-hook"
import {
  SystemMarketContextError,
  _resetSystemMarketContextMetrics,
  getSystemMarketContextDenials,
  requireMarketContext,
  runInSystemMarketContext,
  type SystemExecutionOrigin,
} from "../../lib/system-market-context"

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:54329/gp_mercur"

const PROBE_TABLE = "gp_system_ctx_probe"
const ORIGIN: SystemExecutionOrigin = {
  surface: "subscriber",
  name: "system-market-context-rls-probe",
}

let db: Knex
/** Osobne połączenie superusera — do inspekcji poza RLS (postgres BYPASSRLS). */
let admin: Knex

beforeAll(async () => {
  _resetRlsPoolHook()

  admin = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 1, max: 2 },
  })

  await admin.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medusa_store') THEN
        CREATE ROLE medusa_store NOLOGIN;
      END IF;
    END
    $$;
  `)
  await admin.raw(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
  await admin.raw(`
    CREATE TABLE ${PROBE_TABLE} (
      id        TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      note      TEXT NOT NULL
    )
  `)
  await admin.raw(`GRANT USAGE ON SCHEMA public TO medusa_store`)
  await admin.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO medusa_store`,
  )
  await admin.raw(`ALTER TABLE ${PROBE_TABLE} ENABLE ROW LEVEL SECURITY`)
  // Ten sam kształt co polityka `customer` w infra/postgres/migrations/005.
  await admin.raw(`
    CREATE POLICY market_isolation ON ${PROBE_TABLE}
      USING (market_id = current_setting('app.gp_market_id', true))
      WITH CHECK (market_id = current_setting('app.gp_market_id', true))
  `)

  db = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 1, max: 2 },
  })
  installRlsPoolHook(db)
})

afterAll(async () => {
  await admin.raw(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
  await db.destroy()
  await admin.destroy()
  _resetRlsPoolHook()
})

beforeEach(async () => {
  _resetSystemMarketContextMetrics()
  await admin.raw(`DELETE FROM ${PROBE_TABLE}`)
})

/** Zapis „ścieżką asynchroniczną": strażnik kontekstu + INSERT przez pulę. */
async function systemWrite(id: string, note: string): Promise<void> {
  const context = requireMarketContext(`insert:${PROBE_TABLE}`)
  await db.raw(
    `INSERT INTO ${PROBE_TABLE} (id, market_id, note) VALUES (?, ?, ?)`,
    [id, context.market_id, note],
  )
}

describe("AC2 — kontrola DODATNIA: zapis z zadeklarowanym rynkiem przechodzi", () => {
  it("wiersz powstaje i jest widoczny WYŁĄCZNIE w zadeklarowanym rynku", async () => {
    await runInSystemMarketContext(
      { markets: ["bonbeauty"], origin: ORIGIN },
      async () => systemWrite("probe-positive", "zapis subscribera"),
    )

    // Widok superusera (poza RLS): wiersz istnieje i niesie właściwy rynek.
    const all = await admin.raw(`SELECT id, market_id FROM ${PROBE_TABLE}`)
    expect(all.rows).toEqual([{ id: "probe-positive", market_id: "bonbeauty" }])

    // Widok pod RLS w rynku zapisu: wiersz widoczny.
    const inMarket = await runInSystemMarketContext(
      { markets: ["bonbeauty"], origin: ORIGIN },
      async () => db.raw(`SELECT id FROM ${PROBE_TABLE}`),
    )
    expect(inMarket[0].rows).toHaveLength(1)

    // Widok pod RLS w INNYM rynku: zero wierszy — izolacja działa.
    const inOtherMarket = await runInSystemMarketContext(
      { markets: ["bonevent"], origin: ORIGIN },
      async () => db.raw(`SELECT id FROM ${PROBE_TABLE}`),
    )
    expect(inOtherMarket[0].rows).toHaveLength(0)

    expect(getSystemMarketContextDenials()).toBe(0)
  })

  it("zapis pod cudzy rynek jest odrzucony przez WITH CHECK", async () => {
    await expect(
      runInSystemMarketContext(
        { markets: ["bonbeauty"], origin: ORIGIN },
        async () =>
          db.raw(
            `INSERT INTO ${PROBE_TABLE} (id, market_id, note) VALUES (?, ?, ?)`,
            ["probe-cross", "bonevent", "zapis pod cudzy rynek"],
          ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})

describe("AC2 — kontrola NEGATYWNA: ten sam zapis bez kontekstu kończy się odmową", () => {
  it("odmowa jest głośna: wyjątek z kodem, wpis w logu i inkrementacja metryki", async () => {
    const logged: Array<Record<string, unknown> | undefined> = []
    const logger = {
      error: (_msg: string, meta?: Record<string, unknown>) => logged.push(meta),
    }

    // DOKŁADNIE ten sam zapis, tylko bez kontekstu systemowego.
    await expect(
      (async () => {
        requireMarketContext(`insert:${PROBE_TABLE}`, { logger })
        await db.raw(
          `INSERT INTO ${PROBE_TABLE} (id, market_id, note) VALUES (?, ?, ?)`,
          ["probe-negative", "bonbeauty", "zapis bez kontekstu"],
        )
      })(),
    ).rejects.toBeInstanceOf(SystemMarketContextError)

    // 1. Metryka (NFR-2) — asercja NA METRYCE, nie na treści logu.
    expect(getSystemMarketContextDenials({ reason: "context_missing" })).toBe(1)
    // 2. Log niesie kod błędu i nazwę metryki.
    expect(logged[0]?.error_code).toBe("GP_SYSTEM_MARKET_CONTEXT_DENIED")
    expect(logged[0]?.metric).toBe("gp_system_market_context_denied_total")
    // 3. NIC nie zostało zapisane — odmowa, a nie zapis poza izolacją.
    const all = await admin.raw(`SELECT id FROM ${PROBE_TABLE}`)
    expect(all.rows).toHaveLength(0)
  })

  it("zapis wykonany mimo braku kontekstu jest odrzucony także przez RLS", async () => {
    // Gdyby ktoś obszedł strażnik nośnika, druga linia obrony trzyma:
    // bez `app.gp_market_id` WITH CHECK nie ma prawdy.
    await expect(
      marketContextStorage.run({ market_id: "", sales_channel_id: undefined }, async () =>
        db.raw(
          `SET ROLE medusa_store; INSERT INTO ${PROBE_TABLE} (id, market_id, note) ` +
            `VALUES ('probe-bypass', 'bonbeauty', 'proba obejscia')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i)

    const all = await admin.raw(`SELECT id FROM ${PROBE_TABLE}`)
    expect(all.rows).toHaveLength(0)
  })
})
