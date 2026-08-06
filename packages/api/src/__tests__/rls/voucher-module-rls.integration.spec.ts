/**
 * Moduł voucher pod RLS — dowód Z WYKONANIA na żywym Postgresie
 * (v1.15.0 Story 2.6, AC1/AC2/AC4; FR-14e, AD-22, NFR-1, NFR-5, ADR-192).
 *
 * ── Co tu jest prawdziwe ────────────────────────────────────────────────────
 *  - DDL tabel modułu jest WYKONANY Z PLIKÓW MIGRACJI (`up()` → `addSql`),
 *    nie przepisany ręcznie. Rozjazd migracji względem sondy jest niemożliwy —
 *    ADR-166 jest udokumentowanym precedensem, w którym własny DDL w teście
 *    zamaskował różnicę typu kolumny.
 *  - Polityki RLS pochodzą z tej samej drogi: `Migration1779000000000`.
 *  - Połączenia idą przez `resolveRlsConnectionSource` — DOKŁADNIE to wywołanie,
 *    które robi `VoucherService.getPool()` — nad pulą Knexa załataną prawdziwym
 *    `installRlsPoolHook`.
 *  - Ruch modułu leci jako rola BEZ superusera (`gp_voucher_runtime`), bo
 *    superuser omija RLS ZAWSZE i dałby fałszywą zieleń na każdym stanie polityk.
 *  - Odczyty AC2 idą przez PUBLICZNE metody `VoucherService`, nie przez surowy SQL.
 *
 * ── Czego tu NIE ma (uczciwie) ──────────────────────────────────────────────
 * To nie jest pełny bootstrap Medusy: kontener jest minimalny i niesie tylko
 * `PG_CONNECTION`. Dowodzimy nośnika połączeń i polityk, nie całego łańcucha
 * HTTP `/store/*` (ten ma własne suity RLS obok).
 *
 * ── Uruchomienie ────────────────────────────────────────────────────────────
 *   docker run -d --name gp-story-2-6-rls -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_USER=postgres -e POSTGRES_DB=gp_mercur -p 54326:5432 \
 *     postgres:17.6-alpine
 *   cd GP/backend && DATABASE_URL=postgres://postgres:postgres@localhost:54326/gp_mercur \
 *     pnpm test:integration:voucher-rls
 */

import fs from "node:fs"
import path from "node:path"

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import knex, { Knex } from "knex"
import { Pool } from "pg"

import { marketContextStorage } from "../../lib/market-context"
import { _resetRlsPoolHook, installRlsPoolHook } from "../../lib/rls-pool-hook"
import { resolveRlsConnectionSource } from "../../lib/rls-connection-source"
import { runInSystemMarketContext } from "../../lib/system-market-context"
import { VoucherService } from "../../modules/voucher/service"

const { collectSqlFromClass } = require("../../../../../scripts/story-2-1-migration-sql.cjs")

const ADMIN_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:54326/gp_mercur"

/** Rola ruchu modułu: LOGIN, NOSUPERUSER, członek `medusa_store`. */
const RUNTIME_ROLE = "gp_voucher_runtime"
const RUNTIME_PASSWORD = "gp_voucher_runtime"
const RUNTIME_URL = ADMIN_URL.replace(
  /^postgres(ql)?:\/\/[^@]+@/,
  `postgres://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@`,
)

const MARKET_A = "bonbeauty"
const MARKET_B = "bonevent"

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "voucher",
  "migrations",
)

const RLS_TABLES = ["voucher", "voucher_event", "entitlement_instance"]

let admin: Knex
let db: Knex
let service: VoucherService
let container: Record<string, any>

/** SQL wszystkich migracji modułu, w kolejności znaczników — z PLIKÓW. */
async function collectModuleMigrationSql(): Promise<string[]> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.ts$/.test(f))
    .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]))

  const statements: string[] = []
  for (const file of files) {
    const module_ = require(path.join(MIGRATIONS_DIR, file))
    const migrationClass = Object.values(module_).find(
      (v) => typeof v === "function" && typeof (v as any).prototype?.up === "function",
    )
    if (!migrationClass) {
      throw new Error(`migracja ${file} nie eksportuje klasy Migration…`)
    }
    statements.push(...(await collectSqlFromClass(migrationClass)))
  }
  if (statements.length === 0) {
    throw new Error("zero instrukcji z migracji — sonda nie może udawać migracji")
  }
  return statements
}

/**
 * Instrukcje migracji dotyczące JEDNEJ tabeli — do PRZYWRACANIA stanu docelowego
 * w test-the-teście.
 *
 * v1.15.0 Story 2.6 cykl 1 (finding LOW): blok `finally` odtwarzał politykę
 * RĘCZNIE WPISANYM SQL-em, dokładnie tam, gdzie reszta suity świadomie tego
 * unika (precedens ADR-166: własny DDL w teście zamaskował różnicę typu kolumny).
 * Gdyby migracja zmieniła predykat, kolejne testy mierzyłyby POLITYKĘ Z TESTU —
 * i robiłyby to na zielono. Przywracanie idzie więc TĄ SAMĄ DROGĄ co setup.
 */
async function migrationStatementsForTable(table: string): Promise<string[]> {
  const statements = await collectModuleMigrationSql()
  const onTable = new RegExp(
    `(ALTER TABLE|CREATE POLICY market_isolation ON|DROP POLICY IF EXISTS market_isolation ON)\\s+${table}\\b`,
    "i",
  )
  const matched = statements.filter(
    (sql) =>
      onTable.test(sql) &&
      // TYLKO instrukcje RLS: `ALTER TABLE voucher ADD COLUMN …` z wcześniejszych
      // migracji nie da się bezpiecznie odtworzyć na istniejącej tabeli.
      /(ROW LEVEL SECURITY|POLICY)/i.test(sql) &&
      !/NO FORCE|DISABLE ROW LEVEL SECURITY/i.test(sql),
  )
  if (matched.length === 0) {
    throw new Error(
      `zero instrukcji migracji dla tabeli ${table} — przywracanie stanu ` +
        "docelowego udawałoby migrację zamiast jej używać",
    )
  }
  return matched
}

/** Zapytanie wykonane DROGĄ MODUŁU (to samo wywołanie co `getPool()`). */
async function moduleQuery<R = any>(
  sql: string,
  params?: unknown[],
): Promise<R[]> {
  const source = resolveRlsConnectionSource(
    container,
    ContainerRegistrationKeys.PG_CONNECTION,
  )
  const result = await source.query<any>(sql, params)
  return result.rows as R[]
}

async function seedMarketRow(market: string, code: string): Promise<void> {
  await admin.raw(
    `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                          product_title, value_minor, currency_code, status)
     VALUES (?, ?, 'sel_1', 'Salon', 'salon', 'Zabieg', 10000, 'pln', 'idle')`,
    [code, market],
  )
  await admin.raw(
    `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at)
     VALUES (?, ?, 'created', now())`,
    [`ev_${code}`, code],
  )
}

beforeAll(async () => {
  _resetRlsPoolHook()

  admin = knex({
    client: "pg",
    connection: { connectionString: ADMIN_URL },
    pool: { min: 1, max: 3 },
  })

  for (const table of [...RLS_TABLES].reverse()) {
    await admin.raw(`DROP TABLE IF EXISTS ${table} CASCADE`)
  }
  await admin.raw(`DROP TABLE IF EXISTS voucher_event_archive CASCADE`)

  // ── DDL + polityki WYKONANE Z MIGRACJI ────────────────────────────────────
  for (const sql of await collectModuleMigrationSql()) {
    await admin.raw(sql)
  }

  // Rola ruchu: bez superusera, więc RLS jej DOTYCZY.
  await admin.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER
          PASSWORD '${RUNTIME_PASSWORD}';
      END IF;
    END
    $$;
  `)
  await admin.raw(`GRANT medusa_store TO ${RUNTIME_ROLE}`)
  await admin.raw(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`)
  for (const table of RLS_TABLES) {
    await admin.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${RUNTIME_ROLE}`,
    )
  }

  db = knex({
    client: "pg",
    connection: { connectionString: RUNTIME_URL },
    pool: { min: 1, max: 3 },
  })
  installRlsPoolHook(db)

  container = { [ContainerRegistrationKeys.PG_CONNECTION]: db }
  service = new VoucherService(container)
})

afterAll(async () => {
  await db?.destroy()
  await admin?.destroy()
  _resetRlsPoolHook()
})

beforeEach(async () => {
  await admin.raw(`DELETE FROM voucher_event`)
  await admin.raw(`DELETE FROM voucher`)
  await seedMarketRow(MARKET_A, "V-A")
  await seedMarketRow(MARKET_B, "V-B")
})

// ─────────────────────────────────────────────────────────────────────────────

describe("T2 — uprawnienia i stan polityk są ZMIERZONE, nie założone", () => {
  it("medusa_store ma grant na każdej tabeli modułu", async () => {
    for (const table of RLS_TABLES) {
      const res = await admin.raw(
        `SELECT has_table_privilege('medusa_store', ?, 'SELECT') AS s,
                has_table_privilege('medusa_store', ?, 'INSERT') AS i`,
        [table, table],
      )
      expect({ table, ...res.rows[0] }).toEqual({ table, s: true, i: true })
    }
  })

  it("każda tabela ma ENABLE *i* FORCE oraz politykę market_isolation", async () => {
    const res = await admin.raw(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY(?) ORDER BY relname`,
      [RLS_TABLES],
    )
    expect(res.rows).toEqual(
      [...RLS_TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        // `ENABLE` bez `FORCE` jest pomijane dla właściciela tabeli.
        relforcerowsecurity: true,
      })),
    )

    const pol = await admin.raw(
      `SELECT tablename FROM pg_policies
        WHERE policyname = 'market_isolation' AND tablename = ANY(?)
        ORDER BY tablename`,
      [RLS_TABLES],
    )
    expect(pol.rows.map((r: any) => r.tablename)).toEqual([...RLS_TABLES].sort())
  })

  it("polityka NIE zawiera furtki `OR market_id IS NULL` (ADR-141 §4)", async () => {
    const res = await admin.raw(
      `SELECT tablename, qual, with_check FROM pg_policies
        WHERE policyname = 'market_isolation' AND tablename = ANY(?)`,
      [RLS_TABLES],
    )
    for (const row of res.rows) {
      expect(`${row.qual} ${row.with_check}`).not.toMatch(/IS NULL/i)
    }
  })
})

describe("AC1 — połączenia modułu niosą kontekst RLS", () => {
  it("w kontekście rynku: current_user = medusa_store i app.gp_market_id = <rynek>", async () => {
    const [rows] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ac1-probe" } },
      async () =>
        moduleQuery(
          `SELECT current_user AS role,
                  current_setting('app.gp_market_id', true) AS market`,
        ),
    )
    expect(rows[0]).toEqual({ role: "medusa_store", market: MARKET_A })
  })

  it("BASELINE — własna pula (wzorzec usunięty tą story) nie niesie kontekstu", async () => {
    // Odtworzenie DOKŁADNIE tego, co stało w `service.ts:437`. Bez tego pomiaru
    // nie da się odróżnić „naprawiliśmy" od „zawsze tak było".
    const legacyPool = new Pool({ connectionString: RUNTIME_URL })
    try {
      const res = await runInSystemMarketContext(
        { markets: [MARKET_A], origin: { surface: "job", name: "baseline" } },
        async () =>
          legacyPool.query(
            `SELECT current_user AS role,
                    current_setting('app.gp_market_id', true) AS market`,
          ),
      )
      // Ten sam kontekst ALS, ta sama chwila — a hook nie ma czego załatać.
      expect(res[0].rows[0].role).toBe(RUNTIME_ROLE)
      expect(res[0].rows[0].market).toBeNull()
    } finally {
      await legacyPool.end()
    }
  })

  it("`service.ts` nie zawiera już `new Pool(`", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "modules", "voucher", "service.ts"),
      "utf8",
    )
    expect(source).not.toMatch(/new Pool\(/)
  })
})

describe("AC2 — izolacja rynkowa na ścieżce modułu", () => {
  it("kontrola DODATNIA: wiersz rynku A jest widoczny w kontekście rynku A", async () => {
    const [found] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ac2-pos" } },
      async () => service.getByCode("V-A"),
    )
    expect(found?.code).toBe("V-A")
    // Polityka, przez którą nic nie przechodzi, jest awarią, nie izolacją.
    expect(found?.events?.length).toBeGreaterThan(0)
  })

  it("kontrola NEGATYWNA: wiersz rynku B jest niewidoczny w kontekście rynku A", async () => {
    const [found] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ac2-neg" } },
      async () => service.getByCode("V-B"),
    )
    expect(found).toBeNull()

    // …a wiersz NAPRAWDĘ istnieje — widać go poza RLS.
    const all = await admin.raw(`SELECT code FROM voucher ORDER BY code`)
    expect(all.rows.map((r: any) => r.code)).toEqual(["V-A", "V-B"])
  })

  it("kontrola NEGATYWNA (listing): moduł widzi wyłącznie kody swojego rynku", async () => {
    const [codes] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ac2-list" } },
      async () => service.listCodes(),
    )
    expect(codes).toEqual(["V-A"])
  })

  it("kontrola NEGATYWNA (zapis): INSERT pod cudzy rynek odrzucony przez WITH CHECK", async () => {
    await expect(
      runInSystemMarketContext(
        { markets: [MARKET_A], origin: { surface: "job", name: "ac2-write" } },
        async () =>
          moduleQuery(
            `INSERT INTO voucher (code, market_id, seller_id, seller_name,
                                  seller_handle, product_title, value_minor,
                                  currency_code, status)
             VALUES ('V-X', $1, 'sel_1', 'Salon', 'salon', 'Zabieg', 1, 'pln', 'idle')`,
            [MARKET_B],
          ),
      ),
    ).rejects.toThrow(/row-level security/i)

    const all = await admin.raw(`SELECT code FROM voucher WHERE code = 'V-X'`)
    expect(all.rows).toHaveLength(0)
  })

  it("voucher_event jest scope'owany przez FK (EXISTS), nie po cichu otwarty", async () => {
    const [rows] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ac2-events" } },
      async () => moduleQuery<{ id: string }>(`SELECT id FROM voucher_event`),
    )
    expect(rows.map((r) => r.id)).toEqual(["ev_V-A"])
  })

  it("wiersz z market_id IS NULL jest NIEWIDOCZNY (zakaz furtki, ADR-141 §4)", async () => {
    await admin.raw(
      `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                            product_title, value_minor, currency_code, status)
       VALUES ('V-GLOBAL', NULL, 'sel_1', 'S', 's', 'P', 1, 'pln', 'idle')`,
    )
    const [codes] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ac2-null" } },
      async () => service.listCodes(),
    )
    expect(codes).toEqual(["V-A"])
  })
})

describe("AC2 — test-the-test: kontrola PĘKA po zdjęciu mechanizmu", () => {
  const readOtherMarket = async (): Promise<string[]> => {
    const [codes] = await runInSystemMarketContext(
      { markets: [MARKET_A], origin: { surface: "job", name: "ttt" } },
      async () => service.listCodes(),
    )
    return codes
  }

  it("zdjęcie RLS → kontrola negatywna CZERWIENIEJE; przywrócenie → ZIELENIEJE", async () => {
    // Uwaga metodologiczna: SAM `DROP POLICY` przy włączonym RLS daje
    // default-deny (zero wierszy), więc NIE odróżnia „polityka działa" od
    // „polityki nie ma" — obie odpowiedzi wyglądałyby jak izolacja. Żeby
    // kontrola faktycznie pękła, mechanizm zdejmujemy w całości (DISABLE).
    expect(await readOtherMarket()).toEqual(["V-A"]) // przebieg 1: stan docelowy

    await admin.raw(`DROP POLICY market_isolation ON voucher`)
    try {
      // przebieg 2a: brak polityki przy włączonym RLS = default-deny.
      expect(await readOtherMarket()).toEqual([])

      await admin.raw(`ALTER TABLE voucher DISABLE ROW LEVEL SECURITY`)
      // przebieg 2b: mechanizm zdjęty — kontrola negatywna PĘKA.
      expect(await readOtherMarket()).toEqual(["V-A", "V-B"])
    } finally {
      // przebieg 3: przywrócenie stanu docelowego — Z PLIKÓW MIGRACJI, nie
      // z ręcznie przepisanego SQL-a (cykl 1, finding LOW).
      for (const sql of await migrationStatementsForTable("voucher")) {
        await admin.raw(sql)
      }
    }
    expect(await readOtherMarket()).toEqual(["V-A"])
  })

  it("NO FORCE → WŁAŚCICIEL tabeli omija politykę (dlatego FORCE nie jest ozdobnikiem)", async () => {
    // Mierzone rolą WŁAŚCICIELA i BEZ hooka: hook robi `SET ROLE medusa_store`,
    // czyli przestaje być właścicielem — a to właśnie właściciela dotyczy
    // różnica ENABLE vs FORCE. `admin` (superuser) też się nie nadaje: omija
    // RLS zawsze i dałby zieleń na każdym stanie polityk.
    await admin.raw(`ALTER TABLE voucher OWNER TO ${RUNTIME_ROLE}`)
    const owner = new Pool({ connectionString: RUNTIME_URL })
    const ownerRead = async (): Promise<string[]> => {
      const client = await owner.connect()
      try {
        await client.query(`SELECT set_config('app.gp_market_id', $1, false)`, [
          MARKET_A,
        ])
        const rows = await client.query(`SELECT code FROM voucher ORDER BY code`)
        return rows.rows.map((r: any) => r.code)
      } finally {
        client.release()
      }
    }

    try {
      expect(await ownerRead()).toEqual(["V-A"]) // FORCE trzyma właściciela

      await admin.raw(`ALTER TABLE voucher NO FORCE ROW LEVEL SECURITY`)
      expect(await ownerRead()).toEqual(["V-A", "V-B"]) // bez FORCE — zerowa izolacja
    } finally {
      await admin.raw(`ALTER TABLE voucher FORCE ROW LEVEL SECURITY`)
      await admin.raw(`ALTER TABLE voucher OWNER TO CURRENT_USER`)
      await owner.end()
    }
    expect(await readOtherMarket()).toEqual(["V-A"])
  })
})

describe("AC4 — wykonanie BEZ kontekstu rynku jest fail-closed, nie cichym sukcesem", () => {
  it("bez kontekstu moduł widzi ZERO wierszy, a nie wszystkie", async () => {
    // Hook bez `market_id` w ALS zwraca połączenie SUROWE (rls-pool-hook.ts:83).
    // Fail-closed nie bierze się więc z hooka — bierze się z polityki: bez
    // `app.gp_market_id` predykat nie ma prawdy.
    expect(marketContextStorage.getStore()).toBeUndefined()
    const codes = await service.listCodes()
    expect(codes).toEqual([])
  })

  it("bez kontekstu ZAPIS też nie przechodzi", async () => {
    await expect(
      moduleQuery(
        `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                              product_title, value_minor, currency_code, status)
         VALUES ('V-NOCTX', $1, 'sel_1', 'S', 's', 'P', 1, 'pln', 'idle')`,
        [MARKET_A],
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})
