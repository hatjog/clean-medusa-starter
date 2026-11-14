/**
 * Uprząż PG dla v1.16.0 Story 5.4 (FR-19, AD-34, AD-17, ADR-212, ADR-237).
 *
 * Wspólna dla trzech suit profilu `voucher-service-redeem-pg`
 * (`pnpm run test:integration:voucher-service-redeem`):
 *   - `voucher-service-redeem-single-act.integration.spec.ts`   (AC1)
 *   - `voucher-service-redeem-atomicity.integration.spec.ts`    (AC2)
 *   - `voucher-redeem-branch-disjointness.integration.spec.ts`  (AC3)
 *
 * ── Co tu jest prawdziwe ────────────────────────────────────────────────────
 *  - DDL WYKONANY Z PLIKÓW MIGRACJI modułu voucher (`up()` → `addSql`), nie
 *    przepisany ręcznie — ten sam mechanizm co `rls/voucher-redemption.integration.spec.ts`.
 *  - Ruch modułu leci rolą BEZ superusera i BEZ własności tabel
 *    (`gp_voucher_runtime` ∈ `medusa_store`), pod hookiem RLS — superuser
 *    omija RLS, więc dawałby zieleń na każdym stanie mechanizmu.
 *  - Trasa `POST /vendor/vouchers/:code/redeem` jest IMPORTOWANA i WYKONYWANA.
 *
 * ── Czego tu NIE ma (uczciwie) ──────────────────────────────────────────────
 *  - Łańcucha Mercura `authenticate("member", …)` + `ensureSellerMiddleware`.
 *    Żądanie jest budowane w kształcie, jaki ten łańcuch PRODUKUJE dla aktora
 *    `member` z nagłówkiem `x-seller-id` (`auth_context.actor_type = "member"`,
 *    `headers["x-seller-id"]`, `seller_context.seller_id`). Sama weryfikacja
 *    sesji członka przez Mercura wymaga żywego backendu — to NEEDS-LIVE-RUN
 *    zapisany w `evidence/5-4/ac1-service-single-act.md`.
 *  - `gp_core.resolveVendorId` jest podstawiony (gp_core mieszka w innej bazie).
 *
 * Bez `DATABASE_URL` suity są POMIJANE (`describe.skip`), nigdy „zielone".
 * Baza MUSI być `*_test` stacka gp-test — guard `integration-tests/setup.js`.
 */

import fs from "node:fs"
import path from "node:path"

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import knex, { Knex } from "knex"

import { _resetRlsPoolHook, installRlsPoolHook } from "../../../lib/rls-pool-hook"
import { VoucherService } from "../../../modules/voucher/service"
import { POST as REDEEM_ROUTE } from "../../../api/vendor/vouchers/[code]/redeem/route"

const { collectSqlFromClass } = require("../../../../../../scripts/story-2-1-migration-sql.cjs")

export const DATABASE_URL = process.env.DATABASE_URL
export const runOrSkip = DATABASE_URL ? describe : describe.skip

/** Instancja runtime jest WYMAGANA przez `runInHttpMarketContext` (Story 11.1). */
export const TEST_INSTANCE_ID = "gp-test-5-4"

export const PRODUCER_LOGIN = "gp_voucher_runtime"
const LOGIN_PASSWORD = "gp_voucher_runtime"

export const MARKET = "bonbeauty"
export const SELLER = "sel_story54"
export const VENDOR = "ven_story54"
export const MEMBER = "mem_story54"

const MIGRATIONS_DIR = path.resolve(
  __dirname, "..", "..", "..", "modules", "voucher", "migrations",
)

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

const EXTERNAL_FIXTURE_DDL = [
  `CREATE TABLE IF NOT EXISTS seller (
     id text PRIMARY KEY,
     metadata jsonb NULL
   )`,
  `CREATE TABLE IF NOT EXISTS vendor_notification_log (
     id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
     vendor_id text NULL,
     vendor_handle text NULL,
     notification_type text NULL,
     locale text NULL,
     recipient_email text NULL,
     status text NULL,
     error_message text NULL,
     triggered_by text NULL,
     forced boolean NULL,
     metadata jsonb NULL,
     sent_at timestamptz NULL,
     created_at timestamptz NOT NULL DEFAULT clock_timestamp()
   )`,
]

/** Konfiguracja połączenia jako OBIEKT — bez URI z segmentem hasła. */
function connectionFor(role?: { user: string; password: string }): Knex.PgConnectionConfig {
  const url = new URL(DATABASE_URL as string)
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ""),
    user: role ? role.user : decodeURIComponent(url.username),
    password: role ? role.password : decodeURIComponent(url.password),
  }
}

async function moduleMigrationSql(): Promise<string[]> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.ts$/.test(f))
    .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]))
  const statements: string[] = []
  for (const file of files) {
    const mod = require(path.join(MIGRATIONS_DIR, file))
    const cls = Object.values(mod).find(
      (v) => typeof v === "function" && typeof (v as any).prototype?.up === "function",
    )
    if (!cls) throw new Error(`migracja ${file} nie eksportuje klasy Migration`)
    statements.push(...(await collectSqlFromClass(cls)))
  }
  if (statements.length === 0) {
    throw new Error("zero instrukcji z migracji — uprząż nie może udawać migracji")
  }
  return statements
}

export type Harness = {
  admin: Knex
  db: Knex
  /** Pula BEZ hooka RLS — wyłącznie do odczytu `seller` przed kontekstem rynku. */
  sellerLookupDb: Knex
  service: VoucherService
  container: Record<string, any>
}

let previousInstanceId: string | undefined

export async function setUpHarness(): Promise<Harness> {
  previousInstanceId = process.env.GP_INSTANCE_ID
  process.env.GP_INSTANCE_ID = TEST_INSTANCE_ID
  _resetRlsPoolHook()

  const admin = knex({ client: "pg", connection: connectionFor(), pool: { min: 1, max: 5 } })

  for (const table of [...MODULE_TABLES, "seller", "vendor_notification_log"]) {
    await admin.raw(`DROP TABLE IF EXISTS ${table} CASCADE`)
  }
  for (const role of ["medusa_store", "medusa_market_ops"]) {
    await admin.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN;
        END IF;
      END $$;
    `)
  }
  for (const sql of await moduleMigrationSql()) {
    await admin.raw(sql)
  }
  for (const sql of EXTERNAL_FIXTURE_DDL) {
    await admin.raw(sql)
  }
  await admin.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PRODUCER_LOGIN}') THEN
        CREATE ROLE ${PRODUCER_LOGIN} LOGIN NOSUPERUSER PASSWORD '${LOGIN_PASSWORD}';
      END IF;
    END $$;
  `)
  await admin.raw(`GRANT medusa_store TO ${PRODUCER_LOGIN}`)
  await admin.raw(`GRANT USAGE ON SCHEMA public TO medusa_store, medusa_market_ops`)
  for (const table of [
    "seller",
    "vendor_notification_log",
    "voucher_ledger_transaction",
    "voucher_ledger_entry",
    "ledger_posting_applied",
    "entitlement_choice_set_item",
  ]) {
    await admin.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO medusa_store`)
  }

  const db = knex({
    client: "pg",
    connection: connectionFor({ user: PRODUCER_LOGIN, password: LOGIN_PASSWORD }),
    pool: { min: 1, max: 5 },
  })
  installRlsPoolHook(db)
  const sellerLookupDb = knex({
    client: "pg",
    connection: connectionFor({ user: PRODUCER_LOGIN, password: LOGIN_PASSWORD }),
    pool: { min: 0, max: 2 },
  })

  const container = { [ContainerRegistrationKeys.PG_CONNECTION]: db }
  const service = new VoucherService(container)
  return { admin, db, sellerLookupDb, service, container }
}

export async function tearDownHarness(h: Harness | undefined): Promise<void> {
  await h?.db?.destroy()
  await h?.sellerLookupDb?.destroy()
  await h?.admin?.destroy()
  _resetRlsPoolHook()
  if (previousInstanceId === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = previousInstanceId
}

/** Czysty stan + sprzedawca z rynkiem (źródło `resolveSellerMarketId`). */
export async function resetState(admin: Knex): Promise<void> {
  for (const table of [
    "voucher_ledger_entry",
    "voucher_ledger_transaction",
    "ledger_posting_applied",
    "voucher_redemption",
    "voucher_event",
    "voucher",
    "entitlement_instance",
    "vendor_notification_log",
    "seller",
  ]) {
    await admin.raw(`DELETE FROM ${table}`)
  }
  await admin.raw(`INSERT INTO seller (id, metadata) VALUES (?, ?::jsonb)`, [
    SELLER,
    JSON.stringify({ gp: { market_id: MARKET } }),
  ])
}

export type SeedEntitlement = {
  code: string
  entitlementId: string
  type: "VOUCHER_SERVICE" | "VOUCHER_AMOUNT"
  grossMinor: number
  /** `null` = brak salda (tak wygląda realny wiersz VOUCHER_SERVICE). */
  remainingAmount: number | null
}

/** Voucher (projekcja) + uprawnienie — wstawione rolą administracyjną. */
export async function seedVoucherWithEntitlement(
  admin: Knex,
  seed: SeedEntitlement,
): Promise<void> {
  await admin.raw(
    `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                          product_title, value_minor, currency_code, status)
     VALUES (?, ?, ?, 'Salon', 'salon', 'Zabieg', ?, 'pln', 'idle')`,
    [seed.code, MARKET, SELLER, seed.grossMinor],
  )
  await admin.raw(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, state, policy_snapshot,
        market_id, remaining_amount, vat_classification, created_at, updated_at)
     VALUES (?, 'prof_story54', ?, 'ACTIVE', ?::jsonb, ?, ?, 'MPV', now(), now())`,
    [
      seed.entitlementId,
      seed.type,
      JSON.stringify({
        voucher_code: seed.code,
        market_id: MARKET,
        amount_minor: seed.grossMinor,
        currency_code: "PLN",
        transferability: "bearer",
      }),
      MARKET,
      seed.remainingAmount,
    ],
  )
}

export type CapturedResponse = { statusCode: number; body: any }

/**
 * REALNY handler trasy. Żądanie ma kształt produkowany przez łańcuch Mercura
 * dla aktora `member` z nagłówkiem `x-seller-id` (patrz nagłówek pliku).
 */
export async function callRedeemRoute(
  h: Harness,
  code: string,
  idempotencyKey: string,
  pgConnection: unknown = h.db,
): Promise<CapturedResponse> {
  const captured: CapturedResponse = { statusCode: 200, body: undefined }
  const res: any = {
    status(c: number) {
      captured.statusCode = c
      return res
    },
    json(payload: unknown) {
      captured.body = payload
      return res
    },
  }
  const req: any = {
    params: { code },
    headers: { "idempotency-key": idempotencyKey, "x-seller-id": SELLER },
    auth_context: { actor_type: "member", actor_id: MEMBER, auth_identity_id: "authid_story54" },
    seller_context: { seller_id: SELLER },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return withSellerLookup(h, pgConnection)
        if (key === "gp_core") return { resolveVendorId: async () => VENDOR }
        if (key === "voucher" || key === "voucherModuleService") return h.service
        throw new Error(`not registered: ${key}`)
      },
    },
  }
  await REDEEM_ROUTE(req, res)
  return captured
}

/**
 * OBEJŚCIE ZNANEGO DEFEKTU, nazwane (DW zapisane przez Story 5.4): trasa woła
 * `resolveSellerMarketId(db, …)` PRZED `runInHttpMarketContext`, a hook RLS
 * na `PG_CONNECTION` (instalowany globalnie loaderem `market-context-cache`)
 * odmawia każdego połączenia bez kontekstu (`missing_market_context`). Na
 * puli z hookiem trasa nie dochodzi do realizacji w ogóle — to jest zastana
 * czerwień profili `voucher-redemption` / `redeem-for-seller`.
 *
 * Tu WYŁĄCZNIE wywołanie Knexa jako funkcji (`db("seller")`, jedyne użycie
 * w `resolveSellerMarketId`) idzie pulą bez hooka; `.client` — czyli cała
 * ścieżka realizacji przez `resolveRlsConnectionSource` — zostaje pod hookiem.
 */
function withSellerLookup(h: Harness, pgConnection: any): unknown {
  return new Proxy(pgConnection, {
    apply(_target, _this, args) {
      return (h.sellerLookupDb as any)(...args)
    },
  })
}

/**
 * Wstrzyknięcie awarii WYŁĄCZNIE w teście: owija PG_CONNECTION (Knex) tak, że
 * surowe połączenia wydane przez klienta rzucają na zapytaniu pasującym do
 * `failOn`. Produkcja nie ma żadnej flagi ani punktu wstrzyknięcia.
 *
 * `divert` (kontrola negatywna, mutant „ślad poza transakcją"): zapytanie
 * pasujące jest wykonywane NIE w transakcji aktu, tylko osobnym połączeniem
 * administracyjnym w autocommit — dokładnie to, czego AD-34 zakazuje.
 */
export function faultingPgConnection(
  db: Knex,
  opts: { failOn?: RegExp; divert?: { match: RegExp; via: Knex } },
): { connection: unknown; failures: () => number; diverted: () => number } {
  let failures = 0
  let diverted = 0
  const realClient = (db as any).client
  const unwrap = (c: any) => (c && c.__raw) || c
  const client = {
    acquireConnection: async () => {
      const raw = await realClient.acquireConnection()
      const proxy = {
        __raw: raw,
        query: async (sql: any, params?: any) => {
          const text = typeof sql === "string" ? sql : sql?.text ?? ""
          if (opts.failOn && opts.failOn.test(text)) {
            failures += 1
            throw new Error(`[story-5.4 fault injection] ${opts.failOn}`)
          }
          if (opts.divert && opts.divert.match.test(text)) {
            diverted += 1
            // Autocommit na OSOBNYM połączeniu administracyjnym: zapis przeżyje
            // ROLLBACK transakcji aktu — to jest mutant, nie produkcja.
            const viaClient = (opts.divert.via as any).client
            const adminRaw = await viaClient.acquireConnection()
            try {
              return await adminRaw.query(text, params)
            } finally {
              await viaClient.releaseConnection(adminRaw)
            }
          }
          return raw.query(sql, params)
        },
      }
      return proxy
    },
    releaseConnection: (c: any) => realClient.releaseConnection(unwrap(c)),
    destroyRawConnection: (c: any) =>
      typeof realClient.destroyRawConnection === "function"
        ? realClient.destroyRawConnection(unwrap(c))
        : realClient.releaseConnection(unwrap(c)),
  }
  const connection = new Proxy(db as any, {
    get(target, prop, receiver) {
      if (prop === "client") return client
      return Reflect.get(target, prop, receiver)
    },
  })
  return { connection, failures: () => failures, diverted: () => diverted }
}

/** Liczniki mierzone rolą administracyjną (poza RLS) — FAKT w bazie. */
export async function measure(admin: Knex, code: string, entitlementId: string) {
  const one = async (sql: string, params: any[]) =>
    (await admin.raw(sql, params)).rows[0]
  const voucher = await one(`SELECT status FROM voucher WHERE code = ?`, [code])
  const ent = await one(
    `SELECT state, remaining_amount FROM entitlement_instance WHERE id = ?`,
    [entitlementId],
  )
  const redemptions = await one(
    `SELECT count(*)::int AS n FROM voucher_redemption WHERE entitlement_id = ?`,
    [entitlementId],
  )
  const voucherEvents = await one(
    `SELECT count(*)::int AS n FROM voucher_event
      WHERE voucher_code = ? OR entitlement_id = ?`,
    [code, entitlementId],
  )
  const ledgerTx = await one(
    `SELECT count(*)::int AS n FROM voucher_ledger_transaction WHERE instance_id = ?`,
    [entitlementId],
  )
  const ledgerEntries = await one(
    `SELECT count(*)::int AS n FROM voucher_ledger_entry e
       JOIN voucher_ledger_transaction t USING (transaction_id)
      WHERE t.instance_id = ?`,
    [entitlementId],
  )
  const applied = await one(
    `SELECT count(*)::int AS n FROM ledger_posting_applied`,
    [],
  )
  return {
    voucher_status: voucher?.status as string,
    entitlement_state: ent?.state as string,
    remaining_amount: ent?.remaining_amount == null ? null : Number(ent.remaining_amount),
    redemption_rows: redemptions.n as number,
    voucher_event_rows: voucherEvents.n as number,
    ledger_transactions: ledgerTx.n as number,
    ledger_entries: ledgerEntries.n as number,
    ledger_posting_applied_rows: applied.n as number,
  }
}
