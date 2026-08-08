/**
 * `redeemForSeller` — JEDNA operacja przyjmująca najemcę, allow-lista stanów
 * i idempotencja z rozróżnieniem. Dowód Z WYKONANIA na żywym Postgresie
 * (v1.15.0 Story 5.8, AC1/AC4/AC5/AC6/AC7; FR-10a/d/e/f, AD-17, AD-20, ADR-199).
 *
 * ── Co tu jest prawdziwe ────────────────────────────────────────────────────
 *  - DDL modułu jest WYKONANY Z PLIKÓW MIGRACJI. ADR-166 jest udokumentowanym
 *    precedensem, w którym własny DDL w teście zamaskował błędny typ kolumny
 *    i suita świeciła zielono przy zepsutym kodzie.
 *  - Trasa `POST /vendor/vouchers/:code/redeem` jest IMPORTOWANA i WYKONYWANA.
 *  - Kontrola TOCTOU jest RÓWNOLEGŁA albo wstrzykuje zmianę `seller_id` MIĘDZY
 *    odczytem trasy a mutacją. Test sekwencyjny nie złapałby tego defektu —
 *    powiedziała to wprost Story 5.8 w Dev Notes.
 *  - Każda kontrola allow-listy ma DOWÓD CZERWIENI wykonany w tej samej suicie:
 *    ten sam fixture jest uderzany SQL-em w starym kształcie (`status <>
 *    'claimed'`) i pokazuje, że stary kształt BY PRZESZEDŁ. Bez tego członu
 *    „withdrawn odmawia" byłoby zdaniem o fixture, a nie o mechanizmie.
 *  - Rezolucja `resolveVendorId` idzie po REALNEJ tabeli `gp_core.
 *    vendor_seller_mappings` założonej z DDL-a produkcyjnego
 *    (`infra/postgres/init/05-gp-core-vendors-verticals.sql` — fragment tabeli),
 *    a nie po mocku puli.
 *
 * ── Czego tu NIE ma (uczciwie) ──────────────────────────────────────────────
 *  - To NIE jest bootstrap Medusy ani transport HTTP: wywoływany jest REALNY
 *    handler trasy, więc dowodzimy zachowania trasy, nie warstwy sieciowej.
 *    Uwierzytelnienie (łańcuch Mercura) leży PRZED handlerem i jego dowodem
 *    jest kontrola wykonaniem na prod-buildzie (AC2/AC3), nie ta suita.
 *  - `gp_core.vendor_seller_mappings` powstaje tu w tej samej bazie co moduł
 *    (produkcyjnie to osobna baza). Przedmiotem pomiaru jest ZAPYTANIE
 *    i zakres `instance_id`, a nie topologia baz.
 *
 * ── Uruchomienie ────────────────────────────────────────────────────────────
 *   docker exec gp-postgres-1 psql -U postgres -c "CREATE DATABASE gp58"
 *   cd GP/backend && DATABASE_URL=postgres://postgres:postgres@localhost:5432/gp58 \
 *     pnpm test:integration:redeem-for-seller
 *
 * Bez `DATABASE_URL` suita jest POMIJANA (`describe.skip`) — nie „zielona".
 */

import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import knex, { Knex } from "knex"
import { Pool } from "pg"

import { _resetRlsPoolHook, installRlsPoolHook } from "../../lib/rls-pool-hook"
import GpCoreService, { VendorNotMappedError } from "../../modules/gp-core/service"
import { VoucherService } from "../../modules/voucher/service"
import { POST as REDEEM_ROUTE } from "../../api/vendor/vouchers/[code]/redeem/route"
import { GET as LOOKUP_ROUTE } from "../../api/vendor/vouchers/[code]/lookup/route"

const { collectSqlFromClass } = require("../../../../../scripts/story-2-1-migration-sql.cjs")

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip
const ADMIN_URL = DATABASE_URL || "postgres://postgres:postgres@localhost:5432/gp58"

const RUNTIME_LOGIN = "gp_voucher_runtime"
const LOGIN_PASSWORD = "gp_voucher_runtime"

const MARKET = "bonbeauty"
const SELLER_MINE = "sel_story58_mine"
const SELLER_OTHER = "sel_story58_other"
const VENDOR_MINE = "ven_story58_mine"
const INSTANCE_ID = "gp-dev"

const CODE_IDLE = "V-STORY58-IDLE"
const CODE_WITHDRAWN = "V-STORY58-WITHDRAWN"
const CODE_EXPIRED_STATE = "V-STORY58-EXPIRED-STATE"
const CODE_OTHER = "V-STORY58-OTHER"
const ISSUED_GROSS = 10000

const MIGRATIONS_DIR = path.resolve(
  __dirname, "..", "..", "modules", "voucher", "migrations",
)

let admin: Knex
let db: Knex
let service: VoucherService
let corePool: Pool

function loginUrl(role: string): string {
  return ADMIN_URL.replace(
    /^postgres(ql)?:\/\/[^@]+@/,
    `postgres://${role}:${LOGIN_PASSWORD}@`,
  )
}

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
    if (!migrationClass) throw new Error(`migracja ${file} nie eksportuje klasy Migration`)
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

/**
 * Fragment DDL-a produkcyjnego `infra/postgres/init/05-gp-core-vendors-verticals.sql`
 * — WYŁĄCZNIE kolumny i unikalność, po których czyta `resolveVendorId`.
 * `vendor_id` jest tu bez FK do `gp_core.vendors`, bo tamta tabela nie należy do
 * mierzonego zapytania; zawężenie jest ŚWIADOME i nazwane, a nie przeoczone.
 */
const GP_CORE_FIXTURE_DDL = [
  `CREATE SCHEMA IF NOT EXISTS gp_core`,
  `CREATE TABLE IF NOT EXISTS gp_core.vendor_seller_mappings (
     id               uuid primary key default gen_random_uuid(),
     instance_id      text not null,
     vendor_id        uuid not null,
     mercur_seller_id text not null,
     sync_status      text not null default 'SYNCED',
     synced_at        timestamptz,
     created_at       timestamptz not null default now(),
     unique (instance_id, mercur_seller_id)
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

function makeScope(voucherService: VoucherService = service) {
  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      if (key === "gp_core") {
        return { resolveVendorId: async () => VENDOR_MINE }
      }
      return voucherService
    },
  }
}

/** REALNY handler trasy realizacji, REALNE połączenie. */
async function callRedeemRoute(
  code: string,
  idempotencyKey: string | null,
  sellerId: string = SELLER_MINE,
  voucherService: VoucherService = service,
): Promise<CapturedResponse> {
  const { res, captured } = makeResponse()
  const req: any = {
    params: { code },
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    seller_context: { seller_id: sellerId },
    scope: makeScope(voucherService),
  }
  await REDEEM_ROUTE(req, res)
  return captured
}

async function callLookupRoute(
  code: string,
  sellerId: string = SELLER_MINE,
): Promise<CapturedResponse> {
  const { res, captured } = makeResponse()
  const req: any = {
    params: { code },
    headers: {},
    seller_context: { seller_id: sellerId },
    scope: makeScope(),
  }
  await LOOKUP_ROUTE(req, res)
  return captured
}

async function seedVoucher(
  code: string,
  status: string,
  sellerId: string,
  expiresAt: string | null = null,
): Promise<void> {
  await admin.raw(
    `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                          product_title, value_minor, currency_code, status, expires_at)
     VALUES (?, ?, ?, 'Salon', 'salon', 'Zabieg', ?, 'pln', ?, ?)`,
    [code, MARKET, sellerId, ISSUED_GROSS, status, expiresAt],
  )
}

async function seedEntitlementFor(code: string, entId: string): Promise<void> {
  await admin.raw(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, state, policy_snapshot,
        market_id, remaining_amount, vat_classification, created_at, updated_at)
     VALUES (?, 'prof_story58', 'VOUCHER_AMOUNT', 'ACTIVE', ?::jsonb, ?, ?, 'MPV', now(), now())`,
    [
      entId,
      JSON.stringify({
        voucher_code: code,
        market_id: MARKET,
        amount_minor: ISSUED_GROSS,
        currency_code: "PLN",
        transferability: "bearer",
      }),
      MARKET,
      ISSUED_GROSS,
    ],
  )
}

async function voucherStatus(code: string): Promise<string> {
  const res = await admin.raw(`SELECT status FROM voucher WHERE code = ?`, [code])
  return res.rows[0].status as string
}

async function countRedemptions(): Promise<number> {
  const res = await admin.raw(`SELECT count(*)::int AS n FROM voucher_redemption`)
  return res.rows[0].n as number
}

async function countClaimedEvents(code: string): Promise<number> {
  const res = await admin.raw(
    `SELECT count(*)::int AS n FROM voucher_event
      WHERE voucher_code = ? AND event_type = 'claimed'`,
    [code],
  )
  return res.rows[0].n as number
}

/**
 * DOWÓD CZERWIENI wykonany, nie opisany: ten sam fixture uderzony SQL-em
 * w KSZTAŁCIE SPRZED 5.8. Zwraca liczbę wierszy, które stary `UPDATE` by
 * przestawił. Rollback jest bezwarunkowy — pomiar nie może zmienić stanu suity.
 */
async function rowsOldNegationWouldFlip(code: string): Promise<number> {
  const tx = await admin.transaction()
  try {
    const res = await tx.raw(
      `UPDATE voucher SET status = 'claimed' WHERE code = ? AND status <> 'claimed'`,
      [code],
    )
    return res.rowCount as number
  } finally {
    await tx.rollback()
  }
}

// ─────────────────────────────────────────────────────────────────────────────

runOrSkip("Story 5.8 — redeemForSeller na realnym Postgresie", () => {
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
    await admin.raw(`DROP SCHEMA IF EXISTS gp_core CASCADE`)

    for (const role of ["medusa_store", "medusa_market_ops"]) {
      await admin.raw(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} NOLOGIN;
          END IF;
        END $$;
      `)
    }

    for (const sql of await collectModuleMigrationSql()) {
      await admin.raw(sql)
    }
    for (const sql of [...EXTERNAL_FIXTURE_DDL, ...GP_CORE_FIXTURE_DDL]) {
      await admin.raw(sql)
    }

    await admin.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_LOGIN}') THEN
          CREATE ROLE ${RUNTIME_LOGIN} LOGIN NOSUPERUSER PASSWORD '${LOGIN_PASSWORD}';
        END IF;
      END $$;
    `)
    await admin.raw(`GRANT medusa_store TO ${RUNTIME_LOGIN}`)
    await admin.raw(`GRANT USAGE ON SCHEMA public TO medusa_store, medusa_market_ops`)
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
    }

    db = knex({
      client: "pg",
      connection: { connectionString: loginUrl(RUNTIME_LOGIN) },
      pool: { min: 1, max: 8 },
    })
    installRlsPoolHook(db)

    corePool = new Pool({ connectionString: ADMIN_URL })
    service = new VoucherService({ [ContainerRegistrationKeys.PG_CONNECTION]: db })
  })

  afterAll(async () => {
    await corePool?.end()
    await db?.destroy()
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
    await admin.raw(`DELETE FROM vendor_notification_log`)
    await admin.raw(`DELETE FROM seller`)
    await admin.raw(`DELETE FROM gp_core.vendor_seller_mappings`)

    for (const sellerId of [SELLER_MINE, SELLER_OTHER]) {
      await admin.raw(
        `INSERT INTO seller (id, metadata) VALUES (?, ?::jsonb)`,
        [sellerId, JSON.stringify({ gp: { market_id: MARKET } })],
      )
    }

    await seedVoucher(CODE_IDLE, "idle", SELLER_MINE)
    await seedEntitlementFor(CODE_IDLE, "ent_story58_idle")
    await seedVoucher(CODE_WITHDRAWN, "withdrawn", SELLER_MINE)
    await seedEntitlementFor(CODE_WITHDRAWN, "ent_story58_withdrawn")
    // `expired` JAKO STAN, z PUSTYM `expires_at` — dokładnie przypadek, którego
    // gałąź oparta wyłącznie na kolumnie czasu NIE widziała.
    await seedVoucher(CODE_EXPIRED_STATE, "expired", SELLER_MINE, null)
    await seedEntitlementFor(CODE_EXPIRED_STATE, "ent_story58_expired")
    await seedVoucher(CODE_OTHER, "idle", SELLER_OTHER)
    await seedEntitlementFor(CODE_OTHER, "ent_story58_other")
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC5 — allow-lista stanów wejściowych (AD-17)
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC5 — allow-lista stanów, nie negacja", () => {
    it("DOWÓD CZERWIENI: stary kształt (`status <> 'claimed'`) BY PRZESTAWIŁ withdrawn i expired", async () => {
      // Bez tego członu asercje poniżej mówiłyby o fixture, a nie o mechanizmie:
      // „withdrawn odmawia" jest ciekawe TYLKO wtedy, gdy poprzedni kształt by
      // go przepuścił. Tu to jest ZMIERZONE, nie założone.
      expect(await rowsOldNegationWouldFlip(CODE_WITHDRAWN)).toBe(1)
      expect(await rowsOldNegationWouldFlip(CODE_EXPIRED_STATE)).toBe(1)
      // Kontrola dodatnia tej samej sondy: stan spoza allow-listy i stan na
      // niej mają dawać RÓŻNY wynik, inaczej sonda mierzy „wiersz istnieje".
      expect(await rowsOldNegationWouldFlip(CODE_IDLE)).toBe(1)
    })

    it("withdrawn: odmowa z powodem, ZERO wierszy kanonicznych, stan nietknięty", async () => {
      const out = await callRedeemRoute(CODE_WITHDRAWN, "idem-withdrawn-1")
      expect(out.statusCode).toBe(409)
      expect(out.body.code).toBe("VOUCHER_WITHDRAWN")
      expect(out.body.reason).toBe("withdrawn")
      expect(await voucherStatus(CODE_WITHDRAWN)).toBe("withdrawn")
      // Odmowa MUSI wycofać całą transakcję — inaczej zostaje wiersz kanoniczny
      // opisujący realizację, która nie zaszła.
      expect(await countRedemptions()).toBe(0)
      expect(await countClaimedEvents(CODE_WITHDRAWN)).toBe(0)
    })

    it("expired JAKO STAN (przy pustym expires_at): odmowa 410", async () => {
      const out = await callRedeemRoute(CODE_EXPIRED_STATE, "idem-expired-1")
      expect(out.statusCode).toBe(410)
      expect(out.body.code).toBe("VOUCHER_EXPIRED")
      expect(out.body.reason).toBe("expired")
      expect(await voucherStatus(CODE_EXPIRED_STATE)).toBe("expired")
      expect(await countRedemptions()).toBe(0)
    })

    it("idle: przechodzi (kontrola dodatnia — odmowa nie może być odpowiedzią na wszystko)", async () => {
      const out = await callRedeemRoute(CODE_IDLE, "idem-idle-1")
      expect(out.statusCode).toBe(200)
      expect(out.body.outcome).toBe("redeemed_now")
      expect(await voucherStatus(CODE_IDLE)).toBe("claimed")
      expect(await countRedemptions()).toBe(1)
      expect(await countClaimedEvents(CODE_IDLE)).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC4 — JEDNA operacja przyjmująca najemcę (AD-20)
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC4 — zakres najemcy i mutacja na TYM SAMYM zablokowanym wierszu", () => {
    it("cudzy voucher: odmowa nieodróżnialna od nieznanego, stan nietknięty", async () => {
      const out = await callRedeemRoute(CODE_OTHER, "idem-cross-1")
      expect(out.statusCode).toBe(404)
      expect(await voucherStatus(CODE_OTHER)).toBe("idle")
      expect(await countRedemptions()).toBe(0)
    })

    it("TOCTOU: podmiana seller_id MIĘDZY odczytem trasy a mutacją nie przechodzi", async () => {
      // Serwis z podstawionym `getForSeller`: early-out trasy widzi voucher jako
      // WŁASNY (stan sprzed), a zaraz potem właściciel zmienia się w bazie.
      // To jest DOKŁADNIE okno, które istniało przed 5.8 — wtedy `claim(code)`
      // przestawiał stan, bo najemcy nie znał.
      const racy = new VoucherService({
        [ContainerRegistrationKeys.PG_CONNECTION]: db,
      })
      const realGetForSeller = racy.getForSeller.bind(racy)
      ;(racy as any).getForSeller = async (sellerId: string, code: string) => {
        const view = await realGetForSeller(sellerId, code)
        await admin.raw(`UPDATE voucher SET seller_id = ? WHERE code = ?`, [
          SELLER_OTHER,
          code,
        ])
        return view
      }

      const out = await callRedeemRoute(
        CODE_IDLE, "idem-toctou-1", SELLER_MINE, racy,
      )
      expect(out.statusCode).toBe(404)
      expect(await voucherStatus(CODE_IDLE)).toBe("idle")
      expect(await countRedemptions()).toBe(0)
    })

    it("dwaj najemcy równolegle na ten sam kod: dokładnie JEDNA realizacja i tylko dla właściciela", async () => {
      // Równolegle, nie sekwencyjnie: sekwencyjny przebieg przechodzi także
      // przy defekcie, bo drugi odczyt widzi już skutek pierwszego.
      const [mine, other] = await Promise.all([
        callRedeemRoute(CODE_IDLE, "idem-par-mine", SELLER_MINE),
        callRedeemRoute(CODE_IDLE, "idem-par-other", SELLER_OTHER),
      ])
      expect(mine.statusCode).toBe(200)
      expect(other.statusCode).toBe(404)
      expect(await voucherStatus(CODE_IDLE)).toBe("claimed")
      expect(await countRedemptions()).toBe(1)
      expect(await countClaimedEvents(CODE_IDLE)).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC6 — klucz idempotencji klienta i TRZY rozróżnialne wyniki (UX-DR8)
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC6 — idempotencja z rozróżnieniem", () => {
    it("dwa żądania z TYM SAMYM kluczem: jedna realizacja, jedno zdarzenie, TA SAMA koperta", async () => {
      const key = "idem-retry-po-utracie-sieci"
      const first = await callRedeemRoute(CODE_IDLE, key)
      const second = await callRedeemRoute(CODE_IDLE, key)

      expect(first.statusCode).toBe(200)
      expect(first.body.outcome).toBe("redeemed_now")
      expect(second.statusCode).toBe(200)
      expect(second.body.outcome).toBe("replayed_same_request")

      expect(await countRedemptions()).toBe(1)
      expect(await countClaimedEvents(CODE_IDLE)).toBe(1)
      // CAŁA koperta, bajt w bajt — nie tylko `audit_log_id`. Świeży `new Date()`
      // przy replayu dawałby ten sam identyfikator i INNY czas.
      expect(JSON.stringify(second.body.envelope)).toBe(
        JSON.stringify(first.body.envelope),
      )
    })

    it("INNY klucz na już zrealizowanym voucherze: ODMOWA z powodem, nie „powtórka”", async () => {
      // To jest TRZECI przypadek UX-DR8: „już było, ale nie to żądanie".
      // Przed 5.8 był nieodróżnialny od powtórki po utracie sieci.
      await callRedeemRoute(CODE_IDLE, "idem-pierwsza")
      const out = await callRedeemRoute(CODE_IDLE, "idem-cudza-druga")

      expect(out.statusCode).toBe(409)
      expect(out.body.code).toBe("VOUCHER_ALREADY_REDEEMED")
      expect(out.body.reason).toBe("already_redeemed")
      expect(await countRedemptions()).toBe(1)
      expect(await countClaimedEvents(CODE_IDLE)).toBe(1)
    })

    it("brak klucza: odmowa 400, ZERO skutków", async () => {
      const out = await callRedeemRoute(CODE_IDLE, null)
      expect(out.statusCode).toBe(400)
      expect(out.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED")
      expect(await voucherStatus(CODE_IDLE)).toBe("idle")
      expect(await countRedemptions()).toBe(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC7 — rozróżnialny powód odmowy, nieodróżnialne „nie twój” / „nieznany”
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC7 — nieodróżnialność „nie twój” / „nieznany”", () => {
    it("realizacja: odpowiedzi obu przypadków są IDENTYCZNE co do statusu i ciała", async () => {
      const unknown = await callRedeemRoute("V-STORY58-NIE-MA", "idem-unknown")
      const notMine = await callRedeemRoute(CODE_OTHER, "idem-notmine")

      expect(unknown.statusCode).toBe(notMine.statusCode)
      // Porównanie CAŁEGO ciała, nie samego pola `code`: dopisanie do jednej
      // z gałęzi pola diagnostycznego ma tę asercję zerwać.
      expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(notMine.body))
      expect(unknown.statusCode).toBe(404)
    })

    it("lookup: ta sama para przypadków daje tę samą odpowiedź co realizacja", async () => {
      const unknown = await callLookupRoute("V-STORY58-NIE-MA")
      const notMine = await callLookupRoute(CODE_OTHER)
      expect(unknown.statusCode).toBe(404)
      expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(notMine.body))
    })

    it("każdy powód odmowy jest ROZRÓŻNIALNY (a nie jednym „nie można”)", async () => {
      const withdrawn = await callRedeemRoute(CODE_WITHDRAWN, "idem-r-withdrawn")
      const expired = await callRedeemRoute(CODE_EXPIRED_STATE, "idem-r-expired")
      await callRedeemRoute(CODE_IDLE, "idem-r-first")
      const already = await callRedeemRoute(CODE_IDLE, "idem-r-second")

      const reasons = [withdrawn, expired, already].map((r) => r.body.reason)
      expect(new Set(reasons).size).toBe(3)
      expect(reasons).toEqual(["withdrawn", "expired", "already_redeemed"])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AC1 — resolveVendorId na REALNEJ tabeli mapowań
  // ───────────────────────────────────────────────────────────────────────────

  describe("AC1 — rezolucja vendora z gp_core.vendor_seller_mappings", () => {
    const VENDOR_UUID = "11111111-1111-5111-8111-111111111111"

    function gpCore(): GpCoreService {
      const svc = new GpCoreService({}, { instanceId: INSTANCE_ID })
      ;(svc as any).corePool_ = corePool
      return svc
    }

    it("mapowanie istnieje: zwraca vendor_id", async () => {
      await admin.raw(
        `INSERT INTO gp_core.vendor_seller_mappings (instance_id, vendor_id, mercur_seller_id)
         VALUES (?, ?::uuid, ?)`,
        [INSTANCE_ID, VENDOR_UUID, SELLER_MINE],
      )
      await expect(gpCore().resolveVendorId(SELLER_MINE)).resolves.toBe(VENDOR_UUID)
    })

    it("brak mapowania: ODMOWA, nie 501 i nie zgadywany identyfikator", async () => {
      await expect(gpCore().resolveVendorId(SELLER_MINE)).rejects.toBeInstanceOf(
        VendorNotMappedError,
      )
    })

    it("mapowanie z INNEJ instancji nie rozwiązuje się (zakres instance_id)", async () => {
      // Unikalność w DDL to `(instance_id, mercur_seller_id)`, więc ten sam
      // `seller_id` MOŻE istnieć w dwóch instancjach. Zapytanie bez zakresu
      // rozwiązałoby go na cudzego vendora — i nic by tego nie pokazało.
      await admin.raw(
        `INSERT INTO gp_core.vendor_seller_mappings (instance_id, vendor_id, mercur_seller_id)
         VALUES (?, ?::uuid, ?)`,
        ["gp-inna-instancja", VENDOR_UUID, SELLER_MINE],
      )
      await expect(gpCore().resolveVendorId(SELLER_MINE)).rejects.toBeInstanceOf(
        VendorNotMappedError,
      )
    })
  })
})
