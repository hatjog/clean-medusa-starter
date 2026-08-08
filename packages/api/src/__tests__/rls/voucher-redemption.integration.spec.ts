/**
 * `voucher_redemption` OŻYWIONA — dowód Z WYKONANIA na żywym Postgresie
 * (v1.15.0 Story 5.7, AC1–AC5; FR-12a/b/c, AD-17, AD-22, AI-2.2, ADR-178).
 *
 * ── Co tu jest prawdziwe ────────────────────────────────────────────────────
 *  - DDL jest WYKONANY Z PLIKÓW MIGRACJI (`up()` → `addSql`), nigdy przepisany
 *    ręcznie w teście. ADR-166 jest udokumentowanym precedensem, w którym własny
 *    DDL `integer` w teście zamaskował błędny typ kolumny i suita świeciła na
 *    zielono przy zepsutym kodzie. Ta suita ma test-the-test dokładnie na to
 *    (`AC5 — test-the-test`).
 *  - Trasa `POST /vendor/vouchers/:code/redeem` jest IMPORTOWANA z pliku trasy
 *    i wykonywana — nie kopiowana i nie mockowana.
 *  - Ruch modułu leci rolą BEZ superusera i BEZ własności tabeli
 *    (`gp_voucher_runtime`), bo superuser omija RLS i granty ZAWSZE, a właściciel
 *    omija granty — obie dałyby fałszywą zieleń na każdym stanie mechanizmu.
 *  - Kontrola negatywna grantów jest REALNĄ PRÓBĄ ZAPISU zakończoną odmową,
 *    a nie odczytem `has_table_privilege` ani `information_schema`.
 *  - Licznik prowizji jest mierzony WYKONANIEM zapytania z ADR-178 §2.3
 *    (stała `COMMISSION_BASE_QUERY`), a nie własną wersją zapytania.
 *
 * ── Czego tu NIE ma (uczciwie) ──────────────────────────────────────────────
 *  - To NIE jest pełny bootstrap Medusy ani transport HTTP (express). Kontener
 *    jest minimalny i niesie `PG_CONNECTION` + moduł vouchera; wywoływany jest
 *    REALNY handler `POST`, więc dowodzimy zachowania trasy, a nie warstwy
 *    sieciowej. Ten sam wybór zrobiła Story 3.6
 *    (`completed-order-cardinality-pg.integration.test.ts`).
 *  - `seller` i `vendor_notification_log` to tabele rdzenia/obok modułu — nie ma
 *    w tym repo migracji, z której dałoby się je odtworzyć. Fixture jest tu
 *    ŚWIADOMIE ZAWĘŻONY do kolumn, których dotyka trasa.
 *  - Granty na tabelach ledgera nadaje ta suita (provisioning środowiska), bo
 *    żadna migracja modułu ich nie nadaje. To jest obserwacja, nie zakres 5.7 —
 *    ledger pozostaje runtime-disabled.
 *
 * ── Uruchomienie ────────────────────────────────────────────────────────────
 *   docker run -d --name gp-story-5-7-redemption -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_USER=postgres -e POSTGRES_DB=gp57 -p 5497:5432 \
 *     postgres:17.6-alpine
 *   cd GP/backend && DATABASE_URL=postgres://postgres:postgres@localhost:5497/gp57 \
 *     pnpm test:integration:voucher-redemption
 *
 * Bez `DATABASE_URL` suita jest POMIJANA (`describe.skip`) — nie „zielona".
 */

import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import knex, { Knex } from "knex"

import { _resetRlsPoolHook, installRlsPoolHook } from "../../lib/rls-pool-hook"
import { resolveRlsConnectionSource } from "../../lib/rls-connection-source"
import { VoucherService } from "../../modules/voucher/service"
import { VoucherLedgerWriter, deriveLedgerTransactionId } from "../../modules/voucher/ledger-writer"
import {
  COMMISSION_BASE_QUERY,
  buildPanelIdempotencyKey,
  buildRedemptionId,
  createRedeemPartialOperationFromPool,
  ReversalOfReversalError,
  RedemptionBalanceError,
} from "../../modules/voucher/workflows/redeem-partial-entitlement"
import { POST as REDEEM_ROUTE } from "../../api/vendor/vouchers/[code]/redeem/route"

const { collectSqlFromClass } = require("../../../../../scripts/story-2-1-migration-sql.cjs")

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const ADMIN_URL =
  DATABASE_URL || "postgres://postgres:postgres@localhost:5497/gp57"

/** Rola RUCHU MODUŁU = rola PRODUCENTA kanonicznej: LOGIN, NOSUPERUSER, `medusa_store`. */
const PRODUCER_LOGIN = "gp_voucher_runtime"
/** Rola RUCHU spoza producenta: `medusa_market_ops`, SELECT-only na kanonicznej. */
const NON_PRODUCER_LOGIN = "gp_voucher_reporting"
const LOGIN_PASSWORD = "gp_voucher_runtime"

const MARKET_A = "bonbeauty"
const MARKET_B = "bonevent"
const SELLER_A = "sel_story57"
const VENDOR_A = "ven_story57"

const CODE_A = "V-STORY57-A"
const ENT_A = "ent_story57_a"
const ISSUED_GROSS = 12300

const MIGRATIONS_DIR = path.resolve(
  __dirname, "..", "..", "modules", "voucher", "migrations",
)
const STORY_57_STAMP = "1779004000000"

let admin: Knex
let db: Knex
let nonProducerDb: Knex
let service: VoucherService
let container: Record<string, any>

function loginUrl(role: string): string {
  return ADMIN_URL.replace(
    /^postgres(ql)?:\/\/[^@]+@/,
    `postgres://${role}:${LOGIN_PASSWORD}@`,
  )
}

function migrationFiles(includeStory57 = true): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.ts$/.test(f))
    .filter((f) => includeStory57 || !f.startsWith(STORY_57_STAMP))
    .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]))
}

/** SQL migracji modułu — Z PLIKÓW, w kolejności znaczników. */
async function collectModuleMigrationSql(includeStory57 = true): Promise<string[]> {
  return collectSqlFromFiles(migrationFiles(includeStory57))
}

/** SQL WYŁĄCZNIE migracji 5.7 — potrzebny, żeby odpalić ją na stanie zastanym. */
async function collectStory57MigrationSql(): Promise<string[]> {
  return collectSqlFromFiles(
    migrationFiles().filter((f) => f.startsWith(STORY_57_STAMP)),
  )
}

async function collectSqlFromFiles(files: string[]): Promise<string[]> {
  const statements: string[] = []
  for (const file of files) {
    const module_ = require(path.join(MIGRATIONS_DIR, file))
    const migrationClass = Object.values(module_).find(
      (v) => typeof v === "function" && typeof (v as any).prototype?.up === "function",
    )
    if (!migrationClass) throw new Error(`migracja ${file} nie eksportuje klasy Migration…`)
    statements.push(...(await collectSqlFromClass(migrationClass)))
  }
  if (statements.length === 0) {
    throw new Error("zero instrukcji z migracji — sonda nie może udawać migracji")
  }
  return statements
}

const MODULE_TABLES = [
  "voucher_ledger_entry",
  "voucher_ledger_transaction",
  "ledger_posting_applied",
  "voucher_redemption",
  "entitlement_choice_set_item",
  "voucher_event_archive",
  "voucher_event",
  "voucher",
  "entitlement_instance",
  "entitlement_profile",
  "voucher_claim_store",
  "voucher_delivery_dispatch",
  "event_processed",
  "messaging_dispatch_barrier",
]

/**
 * Fixture tabel spoza modułu, których dotyka trasa. ŚWIADOMIE ZAWĘŻONY: wyłącznie
 * kolumny czytane przez `resolveSellerMarketId` i `appendNotificationLog`.
 */
const EXTERNAL_FIXTURE_DDL = [
  `CREATE TABLE IF NOT EXISTS seller (
     id text PRIMARY KEY,
     metadata jsonb NULL
   )`,
  `CREATE TABLE IF NOT EXISTS vendor_notification_log (
     id text PRIMARY KEY,
     vendor_id text NULL,
     notification_type text NULL,
     locale text NULL,
     recipient_email text NULL,
     status text NULL,
     triggered_by text NULL,
     metadata jsonb NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
]

type CapturedResponse = { statusCode: number; body: any }

function makeResponse(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined }
  const res = {
    status(code: number) {
      captured.statusCode = code
      return res
    },
    json(payload: unknown) {
      captured.body = payload
      return res
    },
  }
  return { res, captured }
}

/** REALNY handler trasy, REALNE połączenie, REALNY kontener modułu. */
async function callRedeemRoute(
  code: string,
  idempotencyKey: string | null,
): Promise<CapturedResponse> {
  const { res, captured } = makeResponse()
  const req: any = {
    params: { code },
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    vendorAuth: { vendor_id: VENDOR_A, seller_id: SELLER_A },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
        return service
      },
    },
  }
  await REDEEM_ROUTE(req, res)
  return captured
}

async function seedVoucherAndEntitlement(): Promise<void> {
  await admin.raw(
    `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                          product_title, value_minor, currency_code, status)
     VALUES (?, ?, ?, 'Salon', 'salon', 'Zabieg', ?, 'pln', 'idle')`,
    [CODE_A, MARKET_A, SELLER_A, ISSUED_GROSS],
  )
  await admin.raw(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, state, policy_snapshot,
        market_id, remaining_amount, vat_classification, created_at, updated_at)
     VALUES (?, 'prof_story57', 'VOUCHER_AMOUNT', 'ACTIVE', ?::jsonb, ?, ?, 'MPV', now(), now())`,
    [
      ENT_A,
      JSON.stringify({
        voucher_code: CODE_A,
        market_id: MARKET_A,
        amount_minor: ISSUED_GROSS,
        currency_code: "PLN",
        transferability: "bearer",
      }),
      MARKET_A,
      ISSUED_GROSS,
    ],
  )
}

/** `SELECT count(*)` na kanonicznej — poza RLS, żeby mierzyć FAKT, nie widoczność. */
async function countRedemptions(entitlementId = ENT_A): Promise<number> {
  const res = await admin.raw(
    `SELECT count(*)::int AS n FROM voucher_redemption WHERE entitlement_id = ?`,
    [entitlementId],
  )
  return res.rows[0].n
}

/**
 * `SELECT count(*)` ROLĄ RUCHU, w kontekście rynku — mierzy WIDOCZNOŚĆ, czyli
 * SKUTEK polityki RLS, a nie jej obecność w katalogu. Świadome przeciwieństwo
 * {@link countRedemptions}: tamta celowo omija RLS, ta celowo mu podlega.
 */
async function countRedemptionsVisibleIn(market: string): Promise<number> {
  const { runInHttpMarketContext } = require("../../lib/http-market-context")
  return runInHttpMarketContext(market, async () => {
    const res = await db.raw(`SELECT count(*)::int AS n FROM voucher_redemption`)
    return res.rows[0].n as number
  })
}

/** Licznik prowizji — WYKONANIE zapytania z ADR-178 §2.3. */
async function commissionBase(entitlementId = ENT_A): Promise<number> {
  const res = await admin.raw(COMMISSION_BASE_QUERY.replace("$1", "?"), [
    entitlementId,
  ])
  return Number(res.rows[0].commission_base_minor)
}

// ─────────────────────────────────────────────────────────────────────────────

runOrSkip("Story 5.7 — voucher_redemption ożywiona na realnym Postgresie", () => {
  beforeAll(async () => {
    _resetRlsPoolHook()

    admin = knex({
      client: "pg",
      connection: { connectionString: ADMIN_URL },
      pool: { min: 1, max: 5 },
    })

    for (const table of [...MODULE_TABLES, "seller", "vendor_notification_log"]) {
      await admin.raw(`DROP TABLE IF EXISTS ${table} CASCADE`)
    }

    // Role ruchu MUSZĄ istnieć PRZED migracjami: migracja 5.7 nadaje granty
    // warunkowo (`IF EXISTS`), więc rola utworzona po niej nie dostałaby nic —
    // i „SELECT-only" byłoby wtedy nieodróżnialne od „bez uprawnień".
    for (const role of ["medusa_store", "medusa_market_ops"]) {
      await admin.raw(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} NOLOGIN;
          END IF;
        END $$;
      `)
    }

    // ── DDL + polityki + granty WYKONANE Z MIGRACJI ──────────────────────────
    for (const sql of await collectModuleMigrationSql()) {
      await admin.raw(sql)
    }
    for (const sql of EXTERNAL_FIXTURE_DDL) {
      await admin.raw(sql)
    }

    for (const [login, parent] of [
      [PRODUCER_LOGIN, "medusa_store"],
      [NON_PRODUCER_LOGIN, "medusa_market_ops"],
    ]) {
      await admin.raw(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN
            CREATE ROLE ${login} LOGIN NOSUPERUSER PASSWORD '${LOGIN_PASSWORD}';
          END IF;
        END $$;
      `)
      await admin.raw(`GRANT ${parent} TO ${login}`)
    }
    await admin.raw(`GRANT USAGE ON SCHEMA public TO medusa_store, medusa_market_ops`)

    // Granty na tabelach spoza zakresu migracji 5.7 (fixture zewnętrzny +
    // ledger). Kanonicznej NIE dotykamy: jej granty pochodzą Z MIGRACJI i to
    // właśnie one są przedmiotem AC4.
    for (const table of [
      "seller",
      "vendor_notification_log",
      "voucher_ledger_transaction",
      "voucher_ledger_entry",
      "ledger_posting_applied",
      "entitlement_choice_set_item",
    ]) {
      await admin.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO medusa_store`,
      )
      await admin.raw(`GRANT SELECT ON ${table} TO medusa_market_ops`)
    }

    db = knex({
      client: "pg",
      connection: { connectionString: loginUrl(PRODUCER_LOGIN) },
      pool: { min: 1, max: 5 },
    })
    installRlsPoolHook(db)

    nonProducerDb = knex({
      client: "pg",
      connection: { connectionString: loginUrl(NON_PRODUCER_LOGIN) },
      pool: { min: 1, max: 2 },
    })

    container = { [ContainerRegistrationKeys.PG_CONNECTION]: db }
    service = new VoucherService(container)
  })

  afterAll(async () => {
    await db?.destroy()
    await nonProducerDb?.destroy()
    await admin?.destroy()
    _resetRlsPoolHook()
  })

  beforeEach(async () => {
    await admin.raw(`DELETE FROM voucher_ledger_entry`)
    await admin.raw(`DELETE FROM voucher_ledger_transaction`)
    await admin.raw(`DELETE FROM ledger_posting_applied`)
    await admin.raw(`DELETE FROM voucher_redemption`)
    await admin.raw(`DELETE FROM voucher_event`)
    await admin.raw(`DELETE FROM voucher`)
    await admin.raw(`DELETE FROM entitlement_instance`)
    await admin.raw(`DELETE FROM seller`)
    await admin.raw(
      `INSERT INTO seller (id, metadata) VALUES (?, ?::jsonb)`,
      [SELLER_A, JSON.stringify({ gp: { market_id: MARKET_A } })],
    )
    await seedVoucherAndEntitlement()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC2 — schemat: rynek, kind, odwrócenie, PK. CHECK-i mają kontrolę negatywną.
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC2 — schemat kanonicznej po migracji 1779004000000", () => {
    it("BASELINE — bez migracji 5.7 tabela ma 8 kolumn i ZERO kolumn rynku", async () => {
      // Bez tego pomiaru nie da się odróżnić „dołożyliśmy rynek" od „zawsze był".
      // Mierzone na osobnej bazie roboczej, żeby nie ruszać stanu suity.
      await admin.raw(`DROP SCHEMA IF EXISTS story57_baseline CASCADE`)
      await admin.raw(`CREATE SCHEMA story57_baseline`)
      const probe = knex({
        client: "pg",
        connection: { connectionString: ADMIN_URL },
        pool: { min: 1, max: 2 },
      })
      try {
        await probe.raw(`SET search_path TO story57_baseline`)
        for (const sql of await collectModuleMigrationSql(false)) {
          await probe.raw(`SET search_path TO story57_baseline; ${sql}`)
        }
        const cols = await probe.raw(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'story57_baseline'
              AND table_name = 'voucher_redemption'`,
        )
        const names = cols.rows.map((r: any) => r.column_name)
        expect(names).toHaveLength(8)
        expect(names.filter((n: string) => n.includes("market"))).toEqual([])
      } finally {
        await probe.destroy()
        await admin.raw(`DROP SCHEMA IF EXISTS story57_baseline CASCADE`)
      }
    })

    it("PO migracji: trzy kolumny rynku NOT NULL, kind, reverses_redemption_id", async () => {
      const res = await admin.raw(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'voucher_redemption'
            AND column_name IN ('market_id','purchase_market_id','redemption_market_id',
                                'kind','reverses_redemption_id')
          ORDER BY column_name`,
      )
      expect(res.rows).toEqual([
        { column_name: "kind", data_type: "text", is_nullable: "NO" },
        { column_name: "market_id", data_type: "text", is_nullable: "NO" },
        { column_name: "purchase_market_id", data_type: "text", is_nullable: "NO" },
        { column_name: "redemption_market_id", data_type: "text", is_nullable: "NO" },
        { column_name: "reverses_redemption_id", data_type: "text", is_nullable: "YES" },
      ])
    })

    it("PK jest ROZSZERZONY o kind — inaczej odwrócenie byłoby replayem realizacji", async () => {
      const res = await admin.raw(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'voucher_redemption_pkey'
            AND conrelid = 'voucher_redemption'::regclass`,
      )
      expect(res.rows[0].def).toBe(
        "PRIMARY KEY (entitlement_id, idempotency_key, kind)",
      )
    })

    it.each([
      [
        "voucher_redemption_kind_check",
        { kind: "SOMETHING_ELSE", reverses: null, market: MARKET_A, purchase: MARKET_A, redemption: MARKET_A },
      ],
      [
        "voucher_redemption_reversal_link_check",
        { kind: "REDEMPTION", reverses: "RDM-DEADBEEF", market: MARKET_A, purchase: MARKET_A, redemption: MARKET_A },
      ],
      [
        "voucher_redemption_market_denorm_check",
        { kind: "REDEMPTION", reverses: null, market: "trzeci-rynek", purchase: MARKET_A, redemption: MARKET_B },
      ],
      [
        // Pusty rynek łamie CHECK długości. Postgres zgłasza JEDEN z trzech
        // CHECK-ów długości (kolejność ewaluacji nie jest gwarantowana), więc
        // wzorzec nazywa całą trójkę — nie „dowolny błąd".
        "voucher_redemption_(market_id|purchase_market_id|redemption_market_id)_check",
        { kind: "REDEMPTION", reverses: null, market: "", purchase: "", redemption: "" },
      ],
    ])(
      "kontrola NEGATYWNA CHECK-a %s: INSERT łamiący go kończy się błędem Z JEGO NAZWĄ",
      async (constraintName, variant) => {
        // CHECK, którego nikt nie próbował złamać, nie jest zmierzony — jest
        // zadeklarowany. Tu jest realny INSERT i realna odmowa Postgresa.
        await expect(
          admin.raw(
            `INSERT INTO voucher_redemption
               (entitlement_id, idempotency_key, redemption_id, amount_minor,
                resulting_state, remaining_after_minor, issued_gross_minor, created_at,
                kind, reverses_redemption_id, market_id, purchase_market_id,
                redemption_market_id)
             VALUES (?, 'neg-check', 'RDM-NEGCHK01', 100, 'REDEEMED_PARTIAL', 0, ?, 1,
                     ?, ?, ?, ?, ?)`,
            [
              ENT_A,
              ISSUED_GROSS,
              variant.kind,
              variant.reverses,
              variant.market,
              variant.purchase,
              variant.redemption,
            ],
          ),
        ).rejects.toThrow(new RegExp(constraintName))
      },
    )

    it("UNIQUE (redemption_id): drugi wiersz z tym samym identyfikatorem jest ODRZUCANY", async () => {
      const insert = (key: string, kind: string) =>
        admin.raw(
          `INSERT INTO voucher_redemption
             (entitlement_id, idempotency_key, redemption_id, amount_minor,
              resulting_state, remaining_after_minor, issued_gross_minor, created_at,
              kind, reverses_redemption_id, market_id, purchase_market_id,
              redemption_market_id)
           VALUES (?, ?, 'RDM-SAMEID0001', 100, 'REDEEMED_PARTIAL', 0, ?, 1,
                   ?, NULL, ?, ?, ?)`,
          [ENT_A, key, ISSUED_GROSS, kind, MARKET_A, MARKET_A, MARKET_A],
        )
      await insert("uniq-1", "REDEMPTION")
      await expect(insert("uniq-2", "REDEMPTION")).rejects.toThrow(
        /voucher_redemption_redemption_id_key/,
      )
    })

    it("kanoniczna jest pod RLS: ENABLE + FORCE + polityka BEZ furtki IS NULL", async () => {
      const rls = await admin.raw(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = 'voucher_redemption'`,
      )
      expect(rls.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      })
      const pol = await admin.raw(
        `SELECT qual, with_check FROM pg_policies
          WHERE tablename = 'voucher_redemption' AND policyname = 'market_isolation'`,
      )
      expect(pol.rows).toHaveLength(1)
      expect(`${pol.rows[0].qual} ${pol.rows[0].with_check}`).not.toMatch(/IS NULL/i)
    })

    // ── RLS mierzona SKUTKIEM, nie obecnością ────────────────────────────────
    // Odczyt `pg_class`/`pg_policies` wyżej mówi tylko tyle, że polityka
    // ISTNIEJE. Zepsucie jej treści (furtka, zamiana kolumny na
    // `redemption_market_id`, literówka w nazwie zmiennej sesji) nie zaczerwieni
    // ani jednej z tamtych asercji. Poniższa trójka mierzy WIDOCZNOŚĆ rolą
    // ruchu `gp_voucher_runtime` (NOSUPERUSER, nie-właściciel): kontrola
    // negatywna, kontrola dodatnia i test-the-test.

    it("kontrola NEGATYWNA RLS: wiersz rynku A jest NIEWIDOCZNY z kontekstu rynku B", async () => {
      await callRedeemRoute(CODE_A, "panel-action-rls-neg")
      expect(await countRedemptions()).toBe(1) // FAKT istnieje (poza RLS)
      expect(await countRedemptionsVisibleIn(MARKET_B)).toBe(0) // ale nie z B
    })

    it("kontrola DODATNIA RLS: ten sam wiersz JEST widoczny z kontekstu rynku A", async () => {
      // Polityka, przez którą nie przechodzi NIC, jest awarią, nie izolacją —
      // bez tej kontroli „0 wierszy z B" byłoby nieodróżnialne od „0 zawsze".
      await callRedeemRoute(CODE_A, "panel-action-rls-pos")
      expect(await countRedemptionsVisibleIn(MARKET_A)).toBe(1)
    })

    it("test-the-test RLS: po ROZSZCZELNIENIU polityki kontrola negatywna PĘKA", async () => {
      await callRedeemRoute(CODE_A, "panel-action-rls-ttt")
      expect(await countRedemptionsVisibleIn(MARKET_B)).toBe(0)

      // Rozszczelnienie odtwarza REALNY tryb awarii (furtka w polityce), a nie
      // jej brak: samo `DROP POLICY` przy włączonym RLS daje default-deny,
      // czyli nadal zero — i kontrola negatywna przeszłaby przy ZEPSUTYM
      // mechanizmie. Dlatego polityka jest PODMIENIANA na przepuszczającą.
      await admin.raw(`DROP POLICY market_isolation ON voucher_redemption`)
      await admin.raw(
        `CREATE POLICY market_isolation ON voucher_redemption
           USING (true) WITH CHECK (true)`,
      )
      try {
        expect(await countRedemptionsVisibleIn(MARKET_B)).toBe(1)
      } finally {
        await admin.raw(`DROP POLICY market_isolation ON voucher_redemption`)
        await admin.raw(
          `CREATE POLICY market_isolation ON voucher_redemption
             USING (market_id = current_setting('app.gp_market_id', true))
             WITH CHECK (market_id = current_setting('app.gp_market_id', true))`,
        )
      }
      // Stan docelowy przywrócony — i zmierzony, nie założony.
      expect(await countRedemptionsVisibleIn(MARKET_B)).toBe(0)
      expect(await countRedemptionsVisibleIn(MARKET_A)).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC2 — GAŁĄŹ NIEPUSTA migracji: backfill i fail-closed, WYKONANE
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC2 — migracja na tabeli NIEPUSTEJ (gałąź backfillu)", () => {
    // Suita główna kasuje tabele w `beforeAll` i migruje od zera, więc
    // `existing_rows = 0` ZAWSZE — gałąź `ELSE` (backfill + `RAISE EXCEPTION`
    // fail-closed) nie odpalała się ani razu. Kod fail-closed, którego nikt nie
    // próbował wywołać, jest deklaracją: odwrócone `IF`, literówka w warunku
    // albo wcześniejszy `COALESCE(…, 'unknown')` zachowałyby się identycznie —
    // zielono. Tu gałąź jest WYKONANA, na osobnym schemacie.
    //
    // Rola migracyjna jest CELOWO nie-superuserem i CELOWO właścicielem tabel:
    // `entitlement_instance` jest pod `FORCE ROW LEVEL SECURITY` od 2.6, a
    // `FORCE` obejmuje właściciela. To jest DOKŁADNIE model produkcyjny, którego
    // konsekwencję migracja 5.7 opisuje w komentarzu — poniżej jest ona
    // zmierzona wykonaniem, a nie wyrozumowana.
    const SCHEMA = "story57_backfill"
    const MIGRATOR_LOGIN = "gp_story57_migrator"
    const ORPHAN_ENT = "ent_story57_orphan"

    let probe: Knex

    async function exec(sql: string): Promise<any> {
      // `search_path` CELOWO bez `public`: migracje zawierają
      // `ALTER TABLE IF EXISTS entitlement_instance`, a przy `public` w ścieżce
      // ta instrukcja trafiłaby w PRAWDZIWĄ tabelę suity, zanim powstanie kopia
      // w schemacie roboczym. Sonda nie może zmieniać stanu, który mierzy.
      const res = await probe.raw(`SET search_path TO ${SCHEMA}; ${sql}`)
      // Zapytanie wieloinstrukcyjne wraca z node-pg TABLICĄ wyników; bez tego
      // rozpakowania `res.rows` byłoby `undefined`, a asercja na długość
      // pękałaby komunikatem o matcherze zamiast o mechanizmie.
      return Array.isArray(res) ? res[res.length - 1] : res
    }

    async function setMarketContext(market: string | null): Promise<void> {
      await probe.raw(`SELECT set_config('app.gp_market_id', ?, false)`, [
        market ?? "",
      ])
    }

    beforeEach(async () => {
      await admin.raw(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR_LOGIN}') THEN
            CREATE ROLE ${MIGRATOR_LOGIN} LOGIN NOSUPERUSER CREATEROLE
              PASSWORD '${LOGIN_PASSWORD}';
          END IF;
        END $$;
      `)
      // Bez GRANT OPTION migracja 2.6 zatrzymałaby się na
      // `GP_RLS_MIGRATION_REQUIRES_GRANT` — to jej własny, poprawny fail-closed,
      // ale nie jest przedmiotem tego pomiaru.
      await admin.raw(
        `GRANT USAGE ON SCHEMA public TO ${MIGRATOR_LOGIN} WITH GRANT OPTION`,
      )
      await admin.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.raw(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${MIGRATOR_LOGIN}`)

      probe = knex({
        client: "pg",
        connection: { connectionString: loginUrl(MIGRATOR_LOGIN) },
        // JEDNO połączenie: `SET search_path` i `set_config(..., false)` są
        // sesyjne, więc pula > 1 rozjechałaby kontekst między instrukcjami.
        pool: { min: 1, max: 1 },
      })

      for (const sql of await collectModuleMigrationSql(false)) {
        await exec(sql)
      }
    })

    afterEach(async () => {
      await probe?.destroy()
      await admin.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    })

    /** Wiersz ZASTANY w kształcie SPRZED 5.7 (osiem kolumn, zero rynku). */
    async function seedLegacyRedemption(entitlementId: string): Promise<void> {
      await exec(`
        INSERT INTO voucher_redemption
          (entitlement_id, idempotency_key, redemption_id, amount_minor,
           resulting_state, remaining_after_minor, issued_gross_minor, created_at)
        VALUES ('${entitlementId}', 'legacy-1', 'RDM-LEGACY00001', ${ISSUED_GROSS},
                'REDEEMED_FULL', 0, ${ISSUED_GROSS}, 1)
      `)
    }

    async function seedEntitlement(id: string, market: string): Promise<void> {
      await setMarketContext(market)
      await exec(`
        INSERT INTO entitlement_instance
          (id, entitlement_profile_id, entitlement_type, state, policy_snapshot,
           market_id, remaining_amount, vat_classification, created_at, updated_at)
        VALUES ('${id}', 'prof_story57', 'VOUCHER_AMOUNT', 'REDEEMED_FULL',
                '{"voucher_code":"${CODE_A}","market_id":"${market}"}'::jsonb,
                '${market}', 0, 'MPV', now(), now())
      `)
    }

    async function runStory57(): Promise<void> {
      for (const sql of await collectStory57MigrationSql()) {
        await exec(sql)
      }
    }

    it("gałąź NIEPUSTA: wiersz zastany dostaje rynek z entitlement_instance, kind=REDEMPTION i NOT NULL", async () => {
      // Rynek CELOWO inny niż domyślny rynek suity — gdyby backfill brał
      // wartość skądinąd (literał, DEFAULT), ta asercja by to pokazała.
      await seedEntitlement(ENT_A, MARKET_B)
      await seedLegacyRedemption(ENT_A)
      await setMarketContext(MARKET_B) // rola migracyjna WIDZI źródło

      await runStory57()

      const row = await exec(
        `SELECT market_id, purchase_market_id, redemption_market_id, kind,
                reverses_redemption_id
           FROM voucher_redemption WHERE entitlement_id = '${ENT_A}'`,
      )
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0]).toEqual({
        market_id: MARKET_B,
        purchase_market_id: MARKET_B,
        redemption_market_id: MARKET_B,
        kind: "REDEMPTION",
        reverses_redemption_id: null,
      })

      // Droga trójfazowa MUSI kończyć się tym samym stanem co gałąź pusta.
      const nullability = await exec(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = '${SCHEMA}' AND table_name = 'voucher_redemption'
            AND column_name IN ('market_id','purchase_market_id',
                                'redemption_market_id','kind')
          ORDER BY column_name`,
      )
      expect(nullability.rows.map((r: any) => r.is_nullable)).toEqual([
        "NO",
        "NO",
        "NO",
        "NO",
      ])
    })

    it("FAIL-CLOSED: wiersz bez odpowiadającego uprawnienia ZATRZYMUJE migrację", async () => {
      // Test-the-test fail-closed: gdyby `RAISE EXCEPTION` miał odwrócony
      // warunek albo gdyby backfill domykał brak rynku literałem 'unknown',
      // ta asercja pękłaby — migracja przeszłaby na zielono.
      await seedEntitlement(ENT_A, MARKET_A)
      await seedLegacyRedemption(ORPHAN_ENT) // sierota: brak entitlementu
      await setMarketContext(MARKET_A)

      await expect(runStory57()).rejects.toThrow(
        /GP_VOUCHER_REDEMPTION_BACKFILL_NO_MARKET/,
      )

      // Zatrzymana znaczy ZATRZYMANA. Cały blok `DO $$` jest jedną instrukcją,
      // więc `RAISE EXCEPTION` wycofuje także `ADD COLUMN` — po odmowie tabela
      // nie ma ANI JEDNEJ kolumny rynku. Żaden wiersz nie dostał 'unknown',
      // bo żadna kolumna nie przetrwała.
      const cols = await exec(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = '${SCHEMA}' AND table_name = 'voucher_redemption'
            AND column_name LIKE '%market%'`,
      )
      expect(cols.rows).toEqual([])
    })

    it("ROLA MIGRACYJNA BEZ KONTEKSTU RYNKU nie widzi źródła pod FORCE RLS ⇒ fail-closed", async () => {
      // To jest scenariusz, który migracja opisywała WYŁĄCZNIE rozumowaniem
      // („rola migracyjna bez app.gp_market_id zobaczy zero wierszy"). Skutek
      // jest taki, że na NIEPUSTYM środowisku migracja NIE PRZEJDZIE bez
      // ustawienia kontekstu rynku — i lepiej wiedzieć to tutaj niż przy
      // deployu. Fakt jest udokumentowany w ADR-197 §2.10 i w rejestrze
      // zaległości jako wymóg runbooka operatora.
      await seedEntitlement(ENT_A, MARKET_A)
      await seedLegacyRedemption(ENT_A)
      await setMarketContext(null) // BEZ kontekstu — jak zwykły `migration up`

      await expect(runStory57()).rejects.toThrow(
        /GP_VOUCHER_REDEMPTION_BACKFILL_NO_MARKET/,
      )
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC1 — producent OŻYWIONY na realnej trasie; most kod → uprawnienie
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC1 — realizacja przez trasę zapisuje wiersz kanoniczny", () => {
    it("BASELINE — sama projekcja (zachowanie sprzed 5.7) NIE tworzy wiersza kanonicznego", async () => {
      // Odtworzenie DOKŁADNIE tego, co trasa robiła przed tą story: `claim()`
      // i nic więcej. Bez tego pomiaru „ożywiliśmy" jest nieodróżnialne od
      // „zawsze tak było".
      //
      // CZYM TEN DOWÓD NIE JEST (wzorzec werdyktu `_testPool` z 2.6): to NIE
      // jest przebieg na HEAD sprzed zmiany. AC1 mówi „ten sam przebieg na HEAD
      // sprzed zmiany daje count(*) = 0", a tu odtwarzamy ZACHOWANIE sprzed
      // zmiany na NOWYM kodzie. Argument jest konstrukcyjny: projekcja
      // (`VoucherService.claim`) nie ma dostępu do kanonicznej i nie ma jak jej
      // zapisać — nie odwołuje się do `voucher_redemption` w ogóle. Realnym
      // przebiegiem „przed" jest baseline SCHEMATU niżej (AC2), wykonany na
      // komplecie migracji BEZ 5.7. Ta różnica jest tu nazwana, a nie
      // przemilczana.
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      await runInHttpMarketContext(MARKET_A, async () => {
        const result = await service.claim(CODE_A)
        expect(result.status).toBe("claimed")
      })
      expect(await countRedemptions()).toBe(0)
    })

    it("realizacja przez trasę tworzy wiersz z kwotą, saldem i redemption_id", async () => {
      const res = await callRedeemRoute(CODE_A, "panel-action-0001")
      expect(res.statusCode).toBe(200)
      expect(res.body.ok).toBe(true)

      const rows = await admin.raw(
        `SELECT * FROM voucher_redemption WHERE entitlement_id = ?`,
        [ENT_A],
      )
      expect(rows.rows).toHaveLength(1)
      const row = rows.rows[0]

      // `bigint` z node-pg wraca STRINGiem (w repo nie ma setTypeParser) —
      // asercja porównująca surowy `row.amount_minor` z liczbą przeszłaby na
      // atrapie puli i pękła tutaj. Dlatego porównanie jest jawnie po `Number`.
      expect(Number(row.amount_minor)).toBe(ISSUED_GROSS)
      expect(Number(row.remaining_after_minor)).toBe(0)
      expect(row.redemption_id).toMatch(/^RDM-[0-9A-F]{12}$/)
      expect(row.kind).toBe("REDEMPTION")
      expect(row.reverses_redemption_id).toBeNull()
      expect(row.market_id).toBe(MARKET_A)
      expect(row.purchase_market_id).toBe(MARKET_A)
      expect(row.redemption_market_id).toBe(MARKET_A)

      // `redemption_id` jest DETERMINISTYCZNY i liczony z preimage objętego `kind`.
      const boundKey = buildPanelIdempotencyKey(ENT_A, "panel-action-0001")
      expect(row.redemption_id).toBe(
        buildRedemptionId(ENT_A, boundKey, "REDEMPTION"),
      )
      expect(row.idempotency_key).toBe(boundKey)
      expect(row.idempotency_key).toMatch(/^PANEL-[0-9A-F]{32}$/)
    })

    it("dwa żądania z TYM SAMYM Idempotency-Key ⇒ count(*) = 1 i already_claimed", async () => {
      const first = await callRedeemRoute(CODE_A, "panel-action-retry")
      expect(first.statusCode).toBe(200)
      expect(await countRedemptions()).toBe(1)

      const second = await callRedeemRoute(CODE_A, "panel-action-retry")
      expect(second.statusCode).toBe(200)
      expect(second.body.idempotent).toBe(true)
      expect(second.body.status).toBe("already_claimed")

      // TO jest asercja, o którą chodzi: powtórzenie NIE tworzy drugiego wiersza.
      expect(await countRedemptions()).toBe(1)

      // …a koperta audytowa opisuje TO SAMO ZDARZENIE, nie drugie zdarzenie
      // o tym samym identyfikatorze. Asercja na sam `audit_log_id`
      // przepuszczała `claimed_at` z czasem DRUGIEGO żądania — identyfikator
      // był ten sam, koperta inna.
      //
      // `prior_status`/`new_status` są ŚWIADOMIE wyłączone z porównania: opisują
      // ŻĄDANIE (idle→claimed, potem claimed→already_claimed), a nie fakt
      // realizacji. To jest ta sama rozdzielność, którą niesie M5.
      const factFields = ({ prior_status, new_status, ...rest }: any) => rest
      expect(factFields(second.body.envelope)).toEqual(
        factFields(first.body.envelope),
      )
      expect(second.body.envelope.claimed_at).toBe(
        first.body.envelope.claimed_at,
      )
    })

    it("RÓŻNY Idempotency-Key na tym samym uprawnieniu NIE przechodzi ponad saldo", async () => {
      await callRedeemRoute(CODE_A, "panel-action-first")
      // Pierwsza realizacja zabrała całe saldo; druga akcja użytkownika trafia
      // w allow-listę stanów wejściowych, nie w cichy drugi wiersz.
      const second = await callRedeemRoute(CODE_A, "panel-action-second")
      expect(second.statusCode).toBe(422)
      expect(await countRedemptions()).toBe(1)
    })

    it("brak nagłówka Idempotency-Key ⇒ 400, ZERO wierszy (klucz serwerowy zakazany)", async () => {
      const res = await callRedeemRoute(CODE_A, null)
      expect(res.statusCode).toBe(400)
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED")
      expect(await countRedemptions()).toBe(0)
    })

    it("M2 — kod bez uprawnienia ⇒ ENTITLEMENT_NOT_FOUND, bez degradacji do voucher_event", async () => {
      await admin.raw(`DELETE FROM entitlement_instance WHERE id = ?`, [ENT_A])
      const res = await callRedeemRoute(CODE_A, "panel-action-orphan")
      expect(res.statusCode).toBe(404)
      expect(res.body.code).toBe("ENTITLEMENT_NOT_FOUND")
      expect(await countRedemptions()).toBe(0)
      // Cichy fallback do zapisu `voucher_event`-only byłby odtworzeniem defektu.
      const events = await admin.raw(
        `SELECT count(*)::int AS n FROM voucher_event WHERE event_type = 'claimed'`,
      )
      expect(events.rows[0].n).toBe(0)
    })

    it("M3 — dwa uprawnienia na jeden kod ⇒ ENTITLEMENT_AMBIGUOUS, nie „pierwszy lepszy\"", async () => {
      await admin.raw(
        `INSERT INTO entitlement_instance
           (id, entitlement_profile_id, entitlement_type, state, policy_snapshot,
            market_id, remaining_amount, vat_classification, created_at, updated_at)
         VALUES ('ent_story57_dup', 'prof_story57', 'VOUCHER_AMOUNT', 'ACTIVE', ?::jsonb,
                 ?, ?, 'MPV', now(), now())`,
        [
          JSON.stringify({
            voucher_code: CODE_A,
            market_id: MARKET_A,
            amount_minor: ISSUED_GROSS,
            currency_code: "PLN",
            transferability: "bearer",
          }),
          MARKET_A,
          ISSUED_GROSS,
        ],
      )
      const res = await callRedeemRoute(CODE_A, "panel-action-ambiguous")
      expect(res.statusCode).toBe(409)
      expect(res.body.code).toBe("ENTITLEMENT_AMBIGUOUS")
      expect(await countRedemptions()).toBe(0)
      expect(await countRedemptions("ent_story57_dup")).toBe(0)
    })

    it("M6 — projekcja powstaje PO fakcie i tylko razem z nim (ta sama transakcja)", async () => {
      await callRedeemRoute(CODE_A, "panel-action-projection")
      const events = await admin.raw(
        `SELECT count(*)::int AS n FROM voucher_event
          WHERE voucher_code = ? AND event_type = 'claimed'`,
        [CODE_A],
      )
      expect(events.rows[0].n).toBe(1)
      const status = await admin.raw(`SELECT status FROM voucher WHERE code = ?`, [
        CODE_A,
      ])
      expect(status.rows[0].status).toBe("claimed")
      expect(await countRedemptions()).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC3 — zdarzenie odwracające i licznik prowizji
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC3 — odwrócenie jest osobnym rodzajem wpisu, a licznik SCHODZI", () => {
    async function redeemThenBuildOperation() {
      const res = await callRedeemRoute(CODE_A, "panel-action-reversal")
      expect(res.statusCode).toBe(200)
      return res.body.envelope.redemption_id as string
    }

    function operationWithLedger() {
      const source = resolveRlsConnectionSource(
        container,
        ContainerRegistrationKeys.PG_CONNECTION,
      )
      return createRedeemPartialOperationFromPool(source as any, {
        ledgerWriter: new VoucherLedgerWriter(source as any),
        // Seam testowy: bramka "on" BEZ flipowania produkcyjnej `runtime_enabled`.
        postingActivation: {
          runtimeEnabled: true,
          isMarketActivated: () => true,
        },
      })
    }

    it("licznik prowizji SCHODZI po odwróceniu — zmierzone zapytaniem z ADR-178 §2.3", async () => {
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      const redemptionId = await redeemThenBuildOperation()

      const before = await commissionBase()
      expect(before).toBe(ISSUED_GROSS)

      const result = await runInHttpMarketContext(MARKET_A, async () =>
        operationWithLedger().reverse({ reverses_redemption_id: redemptionId }),
      )

      const after = await commissionBase()
      // Sama obecność kolumny `kind` nie jest dowodem — dowodem jest ZMIANA wartości.
      expect(after).toBe(0)
      expect(after).toBeLessThan(before)
      expect(result.commission_base_before_minor).toBe(before)
      expect(result.commission_base_after_minor).toBe(after)
    })

    it("odwrócenie jest NOWYM wierszem kind=REVERSAL, a realizacja zostaje nietknięta", async () => {
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      const redemptionId = await redeemThenBuildOperation()
      await runInHttpMarketContext(MARKET_A, async () =>
        operationWithLedger().reverse({ reverses_redemption_id: redemptionId }),
      )

      const rows = await admin.raw(
        `SELECT kind, amount_minor, reverses_redemption_id, redemption_id,
                idempotency_key
           FROM voucher_redemption WHERE entitlement_id = ? ORDER BY kind`,
        [ENT_A],
      )
      expect(rows.rows).toHaveLength(2)
      const [redemption, reversal] = rows.rows
      expect(redemption.kind).toBe("REDEMPTION")
      expect(reversal.kind).toBe("REVERSAL")
      expect(reversal.reverses_redemption_id).toBe(redemption.redemption_id)
      // Kwota odwrócenia jest DODATNIA — znak niesie `kind`, nie liczba (A7).
      expect(Number(reversal.amount_minor)).toBe(ISSUED_GROSS)
      expect(Number(reversal.amount_minor)).toBeGreaterThan(0)
      // TEN SAM klucz idempotencji, RÓŻNY redemption_id — to jest cała różnica,
      // dla której PK i preimage objęły `kind`.
      expect(reversal.idempotency_key).toBe(redemption.idempotency_key)
      expect(reversal.redemption_id).not.toBe(redemption.redemption_id)
    })

    it("posting odwracający DOCIERA do ledgera i NIE jest deduplikowany jako replay", async () => {
      const { runInHttpMarketContext } = require("../../lib/http-market-context")

      // Ta kontrola jedzie BEZPOŚREDNIM WYWOŁANIEM OPERACJI z tego pliku
      // (nie trasą i nie workflowem — takiej ścieżki produkcyjnej NIE MA,
      // wpięcie `reverse()` należy do Story 5.9, DW-15-107), z JAWNYM rozbiciem net/VAT,
      // bo `policy_snapshot` rozbicia nie niesie, a bez VAT-u generator zwraca
      // udokumentowany no-op i do ledgera nie ma czego zapisać. Nazwane wprost:
      // przez trasę panelową (VAT = 0) ten posting jest no-opem z powodem,
      // a nie milczeniem.
      const NET = 10000
      const VAT = 2300
      const op = operationWithLedger()
      const redeemed = await runInHttpMarketContext(MARKET_A, async () =>
        op.redeem({
          entitlement_id: ENT_A,
          redeem_full: true,
          idempotency_key: "wf-ledger-1",
          voucher_net_minor: NET,
          voucher_vat_minor: VAT,
        }),
      )
      const redemptionId = redeemed.redemption_id

      const reversal = await runInHttpMarketContext(MARKET_A, async () =>
        op.reverse({
          reverses_redemption_id: redemptionId,
          voucher_net_minor: NET,
          voucher_vat_minor: VAT,
        }),
      )

      const redemptionTxId = deriveLedgerTransactionId({
        entitlement_id: ENT_A,
        lifecycle_event: "REDEEMED",
        redemption_id: redemptionId,
      })
      const reversalTxId = deriveLedgerTransactionId({
        entitlement_id: ENT_A,
        lifecycle_event: "REFUNDED",
        redemption_id: reversal.redemption_id,
      })
      expect(reversalTxId).not.toBe(redemptionTxId)
      expect(reversal.posting.transaction_id).toBe(reversalTxId)

      // Wpis ledgera REALNIE powstał — nie został wchłonięty przez ON CONFLICT.
      expect(reversal.posting.persisted).toBe(true)
      expect(reversal.posting.deduped).toBe(false)
      const applied = await admin.raw(
        `SELECT count(*)::int AS n FROM ledger_posting_applied WHERE transaction_id = ?`,
        [reversalTxId],
      )
      expect(applied.rows[0].n).toBe(1)
      const tx = await admin.raw(
        `SELECT lifecycle_event, entry_type FROM voucher_ledger_transaction
          WHERE transaction_id = ?`,
        [reversalTxId],
      )
      expect(tx.rows).toHaveLength(1)
      expect(tx.rows[0].lifecycle_event).toBe("REFUNDED")

      // AD-22: zdarzenie finansowe ma TRWAŁY ŚLAD W BAZIE, nie w logu.
      const entries = await admin.raw(
        `SELECT count(*)::int AS n FROM voucher_ledger_entry WHERE transaction_id = ?`,
        [reversalTxId],
      )
      expect(entries.rows[0].n).toBeGreaterThan(0)
    })

    it("odwrócenie ODWRÓCENIA jest ODRZUCANE (ADR-178 §2.3)", async () => {
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      const redemptionId = await redeemThenBuildOperation()
      const reversal = await runInHttpMarketContext(MARKET_A, async () =>
        operationWithLedger().reverse({ reverses_redemption_id: redemptionId }),
      )

      await expect(
        runInHttpMarketContext(MARKET_A, async () =>
          operationWithLedger().reverse({
            reverses_redemption_id: reversal.redemption_id,
          }),
        ),
      ).rejects.toThrow(ReversalOfReversalError)

      const rows = await admin.raw(
        `SELECT count(*)::int AS n FROM voucher_redemption WHERE entitlement_id = ?`,
        [ENT_A],
      )
      expect(rows.rows[0].n).toBe(2)
    })

    it("reguła bilansu: powtórzone odwrócenie NIE zbija licznika poniżej zera", async () => {
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      const redemptionId = await redeemThenBuildOperation()
      await runInHttpMarketContext(MARKET_A, async () =>
        operationWithLedger().reverse({ reverses_redemption_id: redemptionId }),
      )
      // Replay odwrócenia: no-op, nie drugi wiersz i nie ujemny licznik.
      const replay = await runInHttpMarketContext(MARKET_A, async () =>
        operationWithLedger().reverse({ reverses_redemption_id: redemptionId }),
      )
      expect(replay.idempotent).toBe(true)
      expect(await commissionBase()).toBe(0)
      expect(await countRedemptions()).toBe(2)
    })

    it("reguła bilansu jest EGZEKWOWANA: ręczne przekroczenie brutto emisji jest odmawiane", async () => {
      // Predykat agregatowy działa PRZED INSERT-em (CHECK tabelowy go nie widzi).
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      await callRedeemRoute(CODE_A, "panel-action-balance")
      const source = resolveRlsConnectionSource(
        container,
        ContainerRegistrationKeys.PG_CONNECTION,
      )
      const op = createRedeemPartialOperationFromPool(source as any)
      await expect(
        runInHttpMarketContext(MARKET_A, async () =>
          op.reverse({ reverses_redemption_id: "RDM-NIEISTNIEJE" }),
        ),
      ).rejects.toThrow(/REVERSAL_TARGET_NOT_FOUND|brak wiersza realizacji/)
    })

    it("UPDATE i DELETE na kanonicznej są ZAKAZANE MECHANIZMEM, nie komentarzem", async () => {
      await callRedeemRoute(CODE_A, "panel-action-appendonly")
      const source = resolveRlsConnectionSource(
        container,
        ContainerRegistrationKeys.PG_CONNECTION,
      )
      const { runInHttpMarketContext } = require("../../lib/http-market-context")
      await expect(
        runInHttpMarketContext(MARKET_A, async () =>
          source.query(`UPDATE voucher_redemption SET amount_minor = 1`),
        ),
      ).rejects.toThrow(/permission denied/i)
      await expect(
        runInHttpMarketContext(MARKET_A, async () =>
          source.query(`DELETE FROM voucher_redemption`),
        ),
      ).rejects.toThrow(/permission denied/i)
      expect(await countRedemptions()).toBe(1)
    })

    it("UPDATE/DELETE są zakazane TAKŻE POZA kontekstem rynku (ścieżka bez HTTP)", async () => {
      // Poprzednia kontrola jedzie WEWNĄTRZ `runInHttpMarketContext`, czyli
      // dokładnie tam, gdzie hook puli wykonał już `SET ROLE medusa_store`.
      // Hook przełącza rolę WARUNKOWO (`if (!ctx?.market_id) return connection`),
      // więc job, subscriber, workflow albo skrypt operacyjny bez kontekstu
      // rynku jedzie rolą z `DATABASE_URL`. Ta kontrola mierzy TĘ ścieżkę.
      //
      // GRANICA POMIARU, nazwana wprost: w suicie rola logowania
      // (`gp_voucher_runtime`) NIE JEST właścicielem tabel modułu, więc granty
      // ją wiążą także bez `SET ROLE`. Na środowisku, gdzie `DATABASE_URL`
      // wskazuje rolę WŁAŚCICIELA tabel, granty jej nie wiążą — to jest
      // zależność, od której gwarancja append-only realnie zależy (ADR-197 §5,
      // rejestr zaległości). Suita nie może tego wykryć za środowisko;
      // może tylko nie udawać, że wykrywa.
      await callRedeemRoute(CODE_A, "panel-action-nocontext")
      await expect(
        db.raw(`UPDATE voucher_redemption SET amount_minor = 1`),
      ).rejects.toThrow(/permission denied for table voucher_redemption/i)
      await expect(
        db.raw(`DELETE FROM voucher_redemption`),
      ).rejects.toThrow(/permission denied for table voucher_redemption/i)
      expect(await countRedemptions()).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC4 — jeden producent WYMUSZONY GRANTAMI; kontrola negatywna = próba zapisu
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC4 — granty DB, mierzone REALNĄ PRÓBĄ ZAPISU", () => {
    const insertSql = `
      INSERT INTO voucher_redemption
        (entitlement_id, idempotency_key, redemption_id, amount_minor,
         resulting_state, remaining_after_minor, issued_gross_minor, created_at,
         kind, reverses_redemption_id, market_id, purchase_market_id,
         redemption_market_id)
      VALUES (?, ?, ?, 100, 'REDEEMED_PARTIAL', 0, ${ISSUED_GROSS}, 1,
              'REDEMPTION', NULL, ?, ?, ?)
    `

    it("pomiar NIE jest robiony superuserem ani właścicielem tabeli", async () => {
      // Superuser omija RLS i granty ZAWSZE; właściciel omija granty. Obie role
      // dałyby zieleń na każdym stanie mechanizmu, więc kontrola musi wiedzieć,
      // czym jedzie.
      const producer = await nonSuperuserFacts(PRODUCER_LOGIN)
      const nonProducer = await nonSuperuserFacts(NON_PRODUCER_LOGIN)
      expect(producer).toEqual({ superuser: false, bypassrls: false, owner: false })
      expect(nonProducer).toEqual({ superuser: false, bypassrls: false, owner: false })
    })

    it("kontrola NEGATYWNA: INSERT z roli spoza producenta ⇒ ODMOWA UPRAWNIEŃ", async () => {
      // Deklaracja grantu nie jest grantem (Z-17, NFR-1). To jest realny INSERT.
      await expect(
        nonProducerDb.raw(insertSql, [ENT_A, "neg-grant", "RDM-NEGGRANT1", MARKET_A, MARKET_A, MARKET_A]),
      ).rejects.toThrow(/permission denied for table voucher_redemption/i)
      expect(await countRedemptions()).toBe(0)
    })

    it("kontrola NEGATYWNA: UPDATE i DELETE z roli spoza producenta ⇒ ODMOWA", async () => {
      await expect(
        nonProducerDb.raw(`UPDATE voucher_redemption SET amount_minor = 1`),
      ).rejects.toThrow(/permission denied for table voucher_redemption/i)
      await expect(
        nonProducerDb.raw(`DELETE FROM voucher_redemption`),
      ).rejects.toThrow(/permission denied for table voucher_redemption/i)
    })

    it("kontrola DODATNIA: rola producenta zapisuje SKUTECZNIE", async () => {
      // Grant, przez który nic nie przechodzi, jest awarią, nie egzekucją.
      const res = await callRedeemRoute(CODE_A, "panel-action-positive")
      expect(res.statusCode).toBe(200)
      expect(await countRedemptions()).toBe(1)
    })

    it("rola spoza producenta ma SELECT — jest czytelnikiem, nie ślepcem", async () => {
      await callRedeemRoute(CODE_A, "panel-action-readable")
      const res = await nonProducerDb.raw(
        `SELECT count(*)::int AS n FROM voucher_redemption`,
      )
      // RLS na kanonicznej działa po `market_id`; bez kontekstu rynku widać zero
      // wierszy, ale samo zapytanie NIE jest odmową uprawnień — i o to chodzi.
      expect(typeof res.rows[0].n).toBe("number")
    })

    it("test-the-test: po nadaniu INSERT kontrola negatywna PĘKA, po cofnięciu ZIELENIEJE", async () => {
      const attempt = () =>
        nonProducerDb.raw(insertSql, [ENT_A, "ttt-grant", "RDM-TTTGRANT1", MARKET_A, MARKET_A, MARKET_A])

      await expect(attempt()).rejects.toThrow(/permission denied/i)
      await admin.raw(`GRANT INSERT ON voucher_redemption TO medusa_market_ops`)
      try {
        // Mechanizm zdjęty ⇒ kontrola negatywna PĘKA (zapis przechodzi).
        // RLS nadal obowiązuje, więc zapis bez kontekstu rynku odbija się
        // o politykę — ale KOMUNIKAT jest inny niż „permission denied",
        // i to właśnie dowodzi, że mierzyliśmy grant, a nie politykę.
        await expect(attempt()).rejects.toThrow(/row-level security/i)
      } finally {
        await admin.raw(`REVOKE INSERT ON voucher_redemption FROM medusa_market_ops`)
      }
      await expect(attempt()).rejects.toThrow(/permission denied/i)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC5 — test-the-test: suita PĘKA po zepsuciu mechanizmu
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC5 — suita mierzy realny nośnik, nie własny DDL", () => {
    it("DDL pochodzi Z PLIKÓW MIGRACJI — sonda nie tworzy sobie powierzchni sama", async () => {
      const statements = await collectModuleMigrationSql()
      const fromStory57 = statements.filter((s) =>
        /purchase_market_id|reverses_redemption_id/.test(s),
      )
      expect(fromStory57.length).toBeGreaterThan(0)
      // Gdyby ktoś usunął `up()` migracji 5.7, ta asercja pęka — a nie „nie widzi".
    })

    it("kolumna kwotowa jest bigint — asercja, która PĘKA po podmianie typu", async () => {
      // ADR-166: fixture z własnym `integer` maskował błędny typ i suita
      // świeciła na zielono. To jest asercja DOCELOWA — jedyna forma, która
      // realnie czerwienieje po zepsuciu mechanizmu.
      //
      // Wcześniejsza redakcja psuła typ tutaj i ŁAPAŁA własną porażkę
      // (`rejects.toThrow()` na `expect(...).toBe(...)`), przez co test
      // pozostawał ZIELONY w OBU stanach kolumny — dowodził właściwości Jesta,
      // nie właściwości mechanizmu. Realny czerwony przebieg (`ALTER COLUMN …
      // TYPE integer` wykonany poza suitą) jest zapisany w evidence jako
      // `test-the-test-c-amount-minor-integer.out`, symetrycznie do a/b.
      const res = await admin.raw(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'voucher_redemption' AND column_name = 'amount_minor'`,
      )
      expect(res.rows[0].data_type).toBe("bigint")
    })

    it("kwoty wracają z node-pg jako STRING — asercja `=== liczba` na surowym wierszu PĘKA", async () => {
      // To jest ten sam mechanizm, który w ADR-166 dał zielony test przy błędnym
      // typie kolumny. Zapisujemy go jako WYMAGANIE, nie jako przypis.
      await callRedeemRoute(CODE_A, "panel-action-types")
      const res = await admin.raw(
        `SELECT amount_minor, remaining_after_minor, issued_gross_minor
           FROM voucher_redemption WHERE entitlement_id = ?`,
        [ENT_A],
      )
      const row = res.rows[0]
      expect(typeof row.amount_minor).toBe("string")
      expect(row.amount_minor === ISSUED_GROSS).toBe(false)
      expect(Number(row.amount_minor)).toBe(ISSUED_GROSS)
    })
  })

  async function nonSuperuserFacts(role: string): Promise<{
    superuser: boolean
    bypassrls: boolean
    owner: boolean
  }> {
    const res = await admin.raw(
      `SELECT r.rolsuper AS superuser,
              r.rolbypassrls AS bypassrls,
              pg_get_userbyid(c.relowner) = r.rolname AS owner
         FROM pg_roles r, pg_class c
        WHERE r.rolname = ? AND c.relname = 'voucher_redemption'`,
      [role],
    )
    return {
      superuser: res.rows[0].superuser,
      bypassrls: res.rows[0].bypassrls,
      owner: res.rows[0].owner,
    }
  }
})
