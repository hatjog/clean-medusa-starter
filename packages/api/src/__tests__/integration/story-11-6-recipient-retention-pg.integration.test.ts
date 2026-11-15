/**
 * v1.16.0 Story 11.6 (FR-20, AD-49, AD-51, NFR-2, NFR-3; DW-15-040, DW-15-049,
 * DW-15-360, DW-15-362; D-35 p.15) — retencja danych obdarowanego na REALNYM
 * PostgreSQL (baza `*_test`, profil `test:integration:story-11-6-recipient-retention-pg`).
 *
 * Dowodzi:
 *   AC2.a — joby retencji są ODKRYWANE przez loader jobów Medusy (`JobLoader`
 *           z `@medusajs/framework/jobs` na katalogu `src/jobs`) i przechodzą
 *           pod rolą `medusa_store` w `runInSystemMarketContext`, w tym
 *           `cleanupOrphans` bez `permission denied` na `voucher_pii_consent_audit`;
 *   AC2.b — wynik per nośnik (liczniki) w wyniku joba i w logu bez PII;
 *   AC2.c — rynki A/B: usunięcie/redakcja wyłącznie w rynku z kontekstu; dane
 *           w horyzoncie retry (≤ 7 dni skanu sweepa, ≪ 365 dni) nienaruszone —
 *           `evaluateGiftHandoff` dalej zwraca `eligible`; RLS ENABLE + FORCE na
 *           tabelach towarzyszących.
 *
 * Suita pracuje na WŁASNYCH danych (prefiks RUN) w `public` i sprząta je w
 * `afterAll`; nie wykonuje `DROP TABLE`. Wartości PII są syntetyczne
 * (`example.invalid`) i nie trafiają do linii podsumowania.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import knexFactory, { type Knex } from "knex"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import voucherPiiOrphanCleanup from "../../jobs/voucher-pii-orphan-cleanup"
import voucherPiiRetentionSweep from "../../jobs/voucher-pii-retention-sweep"
import { SWEEP_GAP_LOOKBACK_MS } from "../../jobs/voucher-delivery-reconciliation-sweep"
import {
  Migration20261115160000VoucherPiiCompanionTablesRls,
  VOUCHER_PII_COMPANION_TABLES,
} from "../../migrations/Migration20261115160000VoucherPiiCompanionTablesRls"
import { evaluateGiftHandoff } from "../../modules/voucher-delivery/gift-handoff"
import {
  RETENTION_CARRIERS,
  runRecipientRetentionForMarket,
} from "../../modules/voucher-pii/recipient-retention-runtime"
import { RETENTION_NO_MARKETS_ERROR_CODE } from "../../modules/voucher-pii/recipient-retention-markets"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const isTestDb = /\/[A-Za-z0-9_]*_test(\?|$)/.test(DATABASE_URL)
const maybe = DATABASE_URL && isTestDb ? describe : describe.skip

const RUN = `s116_${Date.now().toString(36)}`
const MARKET_A = `${RUN}_mkta`
const MARKET_B = `${RUN}_mktb`
const DAY = 24 * 60 * 60 * 1000
const OLD = new Date(Date.now() - 400 * DAY)
const RECENT = new Date(Date.now() - 1 * DAY)

function collectSql(direction: "up" | "down"): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration20261115160000VoucherPiiCompanionTablesRls.prototype as any)[direction].call(fakeThis)
  return sqls
}

type Seeded = {
  pii: Record<string, string>
  lineItems: Record<string, string>
  cartLineItems: Record<string, string>
  notifications: Record<string, string>
}

/**
 * Fix R-1: źródło rynków = realna ścieżka konfiguracji instancji
 * (`<GP_CONFIG_ROOT>/<GP_INSTANCE_ID>/markets/<m>/market.yaml`), bez env
 * `VOUCHER_PII_RETENTION_MARKETS`. Każdy wariant to osobny katalog-projekcja.
 */
function makeConfigRoot(base: string, name: string, markets: string[]): string {
  const root = path.join(base, name)
  const marketsDir = path.join(root, "gp_test", "markets")
  mkdirSync(marketsDir, { recursive: true })
  for (const m of markets) {
    mkdirSync(path.join(marketsDir, m), { recursive: true })
    writeFileSync(path.join(marketsDir, m, "market.yaml"), `market_id: ${m}\n`)
  }
  return root
}

maybe("Story 11.6 — retencja danych obdarowanego (realny PG, rynki A/B, rola medusa_store)", () => {
  let db: Knex
  const logs: string[] = []
  const seeded: Seeded = { pii: {}, lineItems: {}, cartLineItems: {}, notifications: {} }
  const savedEnv = {
    markets: process.env.VOUCHER_PII_RETENTION_MARKETS,
    instance: process.env.GP_INSTANCE_ID,
    configRoot: process.env.GP_CONFIG_ROOT,
    days: process.env.VOUCHER_PII_RETENTION_DAYS,
  }
  const tmpBase = mkdtempSync(path.join(os.tmpdir(), "s116-gp-config-"))
  const configRoots = {
    onlyA: makeConfigRoot(tmpBase, "only-a", [MARKET_A]),
    onlyB: makeConfigRoot(tmpBase, "only-b", [MARKET_B]),
    empty: makeConfigRoot(tmpBase, "empty", []),
  }

  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      if (key === "logger") {
        return {
          info: (m: string) => logs.push(`info ${m}`),
          warn: (m: string) => logs.push(`warn ${m}`),
          error: (m: string, e?: unknown) => logs.push(`error ${m} ${(e as Error)?.message ?? ""}`),
        }
      }
      throw new Error(`unresolved ${key}`)
    },
  }

  async function applyUp(): Promise<void> {
    for (const sql of collectSql("up")) await db.raw(sql)
  }

  async function seedMarket(market: string, tag: string): Promise<void> {
    // voucher_recipient_pii: stary tombstone (termin), świeży tombstone sierota,
    // świeży tombstone z audytem (nie sierota), świeży aktywny (horyzont retry).
    const rows = [
      { key: "old_tomb", created_at: OLD, tombstoned_at: OLD },
      { key: "orphan", created_at: RECENT, tombstoned_at: RECENT },
      { key: "audited", created_at: RECENT, tombstoned_at: RECENT },
      { key: "active", created_at: RECENT, tombstoned_at: null },
    ]
    for (const r of rows) {
      const [ins] = await db("voucher_recipient_pii")
        .insert({
          market_id: market,
          entitlement_id: `${RUN}_${tag}_${r.key}_ent`,
          order_id: `${RUN}_${tag}_${r.key}`,
          recipient_email: `${tag}-${r.key}@example.invalid`,
          locale: "pl",
          is_gift: true,
          created_at: r.created_at,
          tombstoned_at: r.tombstoned_at,
        })
        .returning("id")
      seeded.pii[`${tag}_${r.key}`] = String(ins.id ?? ins)
    }
    const auditId = (
      await db.raw(
        `INSERT INTO voucher_pii_consent_audit (market_id, current_row_hash, payload)
         VALUES (?, decode('00', 'hex'), ?::jsonb) RETURNING id`,
        [market, JSON.stringify({ action: "CONSENT", recipient_pii_id: seeded.pii[`${tag}_audited`], run: RUN })]
      )
    ).rows[0].id as string
    await db("voucher_delivery_decision").insert({ consent_audit_id: auditId, market_id: market, outcome: "pending" })

    // order_line_item + entitlement_instance (rynek), stary i świeży prezent.
    for (const age of ["old", "recent"] as const) {
      const liId = `${RUN}_${tag}_li_${age}`
      await db("order_line_item").insert({
        id: liId,
        title: "s116",
        unit_price: 1,
        raw_unit_price: JSON.stringify({ value: "1" }),
        created_at: age === "old" ? OLD : RECENT,
        metadata: JSON.stringify({
          purchase_mode: "gift",
          gift_recipient_bound_to_voucher_issue: true,
          gift_recipient_send_timing: "now",
          gift_recipient_email: `${tag}-${age}-gift@example.invalid`,
          gift_recipient_name: `Name ${tag}`,
          gift_recipient_message: `Msg ${tag}`,
        }),
      })
      await db("entitlement_instance").insert({
        id: `${RUN}_${tag}_ei_${age}`,
        entitlement_profile_id: `${RUN}_profile`,
        entitlement_type: "VOUCHER_SERVICE",
        market_id: market,
        policy_snapshot: JSON.stringify({}),
        line_item_id: liId,
      })
      seeded.lineItems[`${tag}_${age}`] = liId

      const nId = `${RUN}_${tag}_n_${age}`
      await db("notification").insert({
        id: nId,
        to: `${tag}-${age}-n@example.invalid`,
        channel: "email",
        created_at: age === "old" ? OLD : RECENT,
        data: JSON.stringify({ market_id: market, customer_first_name: `First ${tag}`, salon_address: `Street ${tag}`, voucher_code: "X" }),
      })
      seeded.notifications[`${tag}_${age}`] = nId
    }

    // Fix R-2: koszyk (także porzucony) z danymi obdarowanej; rynek koszyka
    // przez sales_channel.metadata.gp_market_id.
    const scId = `${RUN}_${tag}_sc`
    await db("sales_channel").insert({ id: scId, name: `s116 ${tag}`, metadata: JSON.stringify({ gp_market_id: market }) })
    const cartId = `${RUN}_${tag}_cart`
    await db("cart").insert({ id: cartId, currency_code: "pln", sales_channel_id: scId })
    for (const age of ["old", "recent"] as const) {
      const cliId = `${RUN}_${tag}_cli_${age}`
      await db("cart_line_item").insert({
        id: cliId,
        cart_id: cartId,
        title: "s116",
        quantity: 1,
        unit_price: 1,
        raw_unit_price: JSON.stringify({ value: "1" }),
        created_at: age === "old" ? OLD : RECENT,
        updated_at: age === "old" ? OLD : RECENT,
        metadata: JSON.stringify({
          purchase_mode: "gift",
          gift_recipient_email: `${tag}-${age}-cart@example.invalid`,
          gift_recipient_name: `Name ${tag}`,
          gift_recipient_message: `Msg ${tag}`,
        }),
      })
      seeded.cartLineItems[`${tag}_${age}`] = cliId
    }
  }

  async function cartMeta(): Promise<Record<string, Record<string, unknown>>> {
    const rows = await db("cart_line_item").where("id", "like", `${RUN}%`).select("id", "metadata")
    return Object.fromEntries(rows.map((x: { id: string; metadata: Record<string, unknown> }) => [x.id, x.metadata]))
  }

  beforeAll(async () => {
    db = knexFactory({ client: "pg", connection: DATABASE_URL, pool: { min: 0, max: 4 } })
    await applyUp()
    await seedMarket(MARKET_A, "a")
    await seedMarket(MARKET_B, "b")
    process.env.GP_INSTANCE_ID = "gp_test"
    delete process.env.VOUCHER_PII_RETENTION_MARKETS
    delete process.env.VOUCHER_PII_RETENTION_DAYS
  })

  afterAll(async () => {
    if (savedEnv.markets === undefined) delete process.env.VOUCHER_PII_RETENTION_MARKETS
    else process.env.VOUCHER_PII_RETENTION_MARKETS = savedEnv.markets
    if (savedEnv.instance === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = savedEnv.instance
    if (savedEnv.configRoot === undefined) delete process.env.GP_CONFIG_ROOT
    else process.env.GP_CONFIG_ROOT = savedEnv.configRoot
    if (savedEnv.days === undefined) delete process.env.VOUCHER_PII_RETENTION_DAYS
    else process.env.VOUCHER_PII_RETENTION_DAYS = savedEnv.days
    rmSync(tmpBase, { recursive: true, force: true })
    await db.transaction(async (trx) => {
      // Tabele append-only mają triggery niezmienności — sprzątanie WŁASNYCH
      // wierszy suity wyłącznie w tej transakcji (replica = triggery wyłączone).
      await trx.raw("SET LOCAL session_replication_role = replica")
      await trx("voucher_delivery_decision").where("market_id", "like", `${RUN}%`).delete()
      await trx("voucher_pii_consent_audit").where("market_id", "like", `${RUN}%`).delete()
    })
    await db("voucher_recipient_pii").where("market_id", "like", `${RUN}%`).delete()
    await db("entitlement_instance").where("id", "like", `${RUN}%`).delete()
    await db("order_line_item").where("id", "like", `${RUN}%`).delete()
    await db("notification").where("id", "like", `${RUN}%`).delete()
    await db("cart_line_item").where("id", "like", `${RUN}%`).delete()
    await db("cart").where("id", "like", `${RUN}%`).delete()
    await db("sales_channel").where("id", "like", `${RUN}%`).delete()
    await db.destroy()
  })

  it("AC2.a: JobLoader Medusy odkrywa oba joby retencji (config.name + schedule) w src/jobs", async () => {
    const { JobLoader } = await import("@medusajs/framework/jobs")
    const registered: Array<{ name: string; schedule: unknown }> = []
    class CapturingJobLoader extends (JobLoader as unknown as new (dir: string | string[], c: unknown) => {
      load(): Promise<void>
    }) {
      register(args: { config: { name: string; schedule: unknown } }): void {
        registered.push({ name: args.config.name, schedule: args.config.schedule })
      }
    }
    const jobsDir = path.resolve(__dirname, "../../jobs")
    const loaderContainer = {
      resolve: (k: string) => {
        if (k === ContainerRegistrationKeys.LOGGER || k === "logger") {
          return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
        }
        return undefined
      },
    }
    await new CapturingJobLoader(jobsDir, loaderContainer).load()
    const byName = Object.fromEntries(registered.map((r) => [r.name, r.schedule]))
    console.log(`S116_SCHEDULER ${JSON.stringify({ jobs_dir: "packages/api/src/jobs", registered_total: registered.length, retention: { "voucher-pii-retention-sweep": byName["voucher-pii-retention-sweep"] ?? null, "voucher-pii-orphan-cleanup": byName["voucher-pii-orphan-cleanup"] ?? null } })}`)
    expect(byName["voucher-pii-retention-sweep"]).toBe("0 3 * * *")
    expect(byName["voucher-pii-orphan-cleanup"]).toBe("0 * * * *")
  })

  it("AC2.c: tabele towarzyszące mają ENABLE + FORCE RLS i jedną politykę slug-text; medusa_store ma SELECT", async () => {
    for (const t of VOUCHER_PII_COMPANION_TABLES) {
      const cls = await db.raw(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ?`, [t.table])
      expect(cls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
      const pol = await db.raw(`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = ?`, [t.table])
      expect(pol.rows).toHaveLength(1)
      expect(pol.rows[0].policyname).toBe(t.policy)
      expect(pol.rows[0].qual).toBe("(market_id = NULLIF(current_setting('app.gp_market_id'::text, true), ''::text))")
      expect(pol.rows[0].with_check).toBe(pol.rows[0].qual)
      const priv = await db.raw(`SELECT has_table_privilege('medusa_store', ?, 'SELECT') AS s`, [t.table])
      expect(priv.rows[0].s).toBe(true)
    }
  })

  it("AC2.c: pod medusa_store rynek A widzi wyłącznie swoje wiersze audytu i decyzji", async () => {
    const trx = await db.transaction()
    try {
      await trx.raw("SET LOCAL ROLE medusa_store")
      await trx.raw("SELECT set_config('app.gp_market_id', ?, true)", [MARKET_A])
      const a = await trx.raw(
        `SELECT (SELECT count(*)::int FROM voucher_pii_consent_audit WHERE market_id LIKE ?) AS audit,
                (SELECT count(*)::int FROM voucher_delivery_decision WHERE market_id LIKE ?) AS decision`,
        [`${RUN}%`, `${RUN}%`]
      )
      expect(a.rows[0]).toEqual({ audit: 1, decision: 1 })
    } finally {
      await trx.rollback()
    }
  })

  it.each(["abc", "0", "3"])(
    "R-4: VOUCHER_PII_RETENTION_DAYS=%s ⇒ nazwana odmowa, zero redakcji na realnym PG",
    async (days) => {
      process.env.GP_CONFIG_ROOT = configRoots.onlyA
      process.env.VOUCHER_PII_RETENTION_DAYS = days
      logs.length = 0
      try {
        const run = await voucherPiiRetentionSweep(container as never)
        expect(run.results).toEqual([])
        expect(run.alarms.term_invalid).toBe(1)
        expect(run.term_refusal?.error_code).toBe("GP_RECIPIENT_RETENTION_TERM_INVALID")
        expect(logs.some((l) => l.startsWith("error") && l.includes("GP_RECIPIENT_RETENTION_TERM_INVALID"))).toBe(true)
      } finally {
        delete process.env.VOUCHER_PII_RETENTION_DAYS
      }
      const left = await db("voucher_recipient_pii").whereIn("id", [seeded.pii.a_old_tomb, seeded.pii.a_orphan]).count<{ n: string }[]>({ n: "*" })
      expect(Number(left[0].n)).toBe(2)
      const li = await db("order_line_item").where("id", seeded.lineItems.a_recent).first("metadata")
      expect(li.metadata.gift_recipient_email).toBe("a-recent-gift@example.invalid")
      expect((await cartMeta())[seeded.cartLineItems.a_old].gift_recipient_email).toBe("a-old-cart@example.invalid")
    }
  )

  it("R-1: puste źródło rynków (projekcja bez rynków) ⇒ nazwany alarm error, licznik w wyniku, zero pracy", async () => {
    process.env.GP_CONFIG_ROOT = configRoots.empty
    logs.length = 0
    const run = await voucherPiiRetentionSweep(container as never)
    expect(run.results).toEqual([])
    expect(run.markets).toEqual([])
    expect(run.alarms.no_markets).toBe(1)
    expect(run.markets_source).toBe("gp_config_projection")
    expect(logs.some((l) => l.startsWith("error") && l.includes(RETENTION_NO_MARKETS_ERROR_CODE))).toBe(true)
  })

  it("AC2.a/b/c: sweep dzienny BEZ env rynków (źródło: projekcja gp-config z rynkiem A) — wynik per nośnik, rola medusa_store, rynek B i horyzont retry nienaruszone", async () => {
    delete process.env.VOUCHER_PII_RETENTION_MARKETS
    process.env.GP_CONFIG_ROOT = configRoots.onlyA
    logs.length = 0
    const run = await voucherPiiRetentionSweep(container as never)
    expect(run.markets_source).toBe("gp_config_projection")
    expect(run.markets).toEqual([MARKET_A])
    expect(run.alarms.no_markets).toBe(0)
    const results = run.results
    expect(results).toHaveLength(1)
    const [r] = results
    expect(r.market_id).toBe(MARKET_A)
    // Fix R-3: sonda zmierzona wewnątrz transakcji joba.
    expect(r.session).toEqual({ current_user: "medusa_store", row_security_active: true, market_setting: MARKET_A })
    expect(r.carriers).toEqual({
      [RETENTION_CARRIERS.recipientPiiPurged]: 1,
      [RETENTION_CARRIERS.recipientPiiOrphans]: 1,
      [RETENTION_CARRIERS.lineItemMetadata]: 1,
      [RETENTION_CARRIERS.cartLineItemMetadata]: 1,
      [RETENTION_CARRIERS.notificationData]: 1,
    })
    expect(logs.some((l) => l.startsWith("error"))).toBe(false)
    const carrierLog = logs.find((l) => l.includes(`market=${MARKET_A}`) && l.includes("voucher_recipient_pii.purged=1"))
    expect(carrierLog).toBeDefined()
    expect(logs.join("\n")).not.toMatch(/@example\.invalid|First a|Street a|Name a/)

    const pii = await db("voucher_recipient_pii").where("market_id", "like", `${RUN}%`).select("id", "market_id")
    const left = new Set(pii.map((p: { id: string }) => String(p.id)))
    expect(left.has(seeded.pii.a_old_tomb)).toBe(false)
    expect(left.has(seeded.pii.a_orphan)).toBe(false)
    expect(left.has(seeded.pii.a_audited)).toBe(true)
    expect(left.has(seeded.pii.a_active)).toBe(true)
    for (const k of ["b_old_tomb", "b_orphan", "b_audited", "b_active"]) expect(left.has(seeded.pii[k])).toBe(true)

    const li = await db("order_line_item").where("id", "like", `${RUN}%`).select("id", "metadata")
    const meta = Object.fromEntries(li.map((x: { id: string; metadata: Record<string, unknown> }) => [x.id, x.metadata]))
    const aOld = meta[seeded.lineItems.a_old]
    expect(aOld.gift_recipient_email).toBeUndefined()
    expect(aOld.gift_recipient_name).toBeUndefined()
    expect(aOld.gift_recipient_message).toBeUndefined()
    expect(aOld.gp_recipient_pii_redacted_at).toBeDefined()
    expect(aOld.purchase_mode).toBe("gift")
    // Retriable handoff link: świeży prezent rynku A ma adres i jest `eligible`.
    expect(evaluateGiftHandoff(meta[seeded.lineItems.a_recent] as never)).toEqual({
      eligible: true,
      recipient_email: "a-recent-gift@example.invalid",
    })
    expect(meta[seeded.lineItems.b_old].gift_recipient_email).toBe("b-old-gift@example.invalid")

    const ns = await db("notification").where("id", "like", `${RUN}%`).select("id", "data")
    const data = Object.fromEntries(ns.map((x: { id: string; data: Record<string, unknown> }) => [x.id, x.data]))
    expect(data[seeded.notifications.a_old].customer_first_name).toBeUndefined()
    expect(data[seeded.notifications.a_old].salon_address).toBeUndefined()
    expect(data[seeded.notifications.a_old].voucher_code).toBe("X")
    expect(data[seeded.notifications.a_recent].customer_first_name).toBe("First a")
    expect(data[seeded.notifications.b_old].customer_first_name).toBe("First b")

    const carts = await cartMeta()
    expect(carts[seeded.cartLineItems.a_old].gift_recipient_email).toBeUndefined()
    expect(carts[seeded.cartLineItems.a_old].gift_recipient_name).toBeUndefined()
    expect(carts[seeded.cartLineItems.a_old].gift_recipient_message).toBeUndefined()
    expect(carts[seeded.cartLineItems.a_old].gp_recipient_pii_redacted_at).toBeDefined()
    expect(carts[seeded.cartLineItems.a_old].purchase_mode).toBe("gift")
    expect(carts[seeded.cartLineItems.a_recent].gift_recipient_email).toBe("a-recent-cart@example.invalid")
    expect(carts[seeded.cartLineItems.b_old].gift_recipient_email).toBe("b-old-cart@example.invalid")

    console.log(`S116_RESULT ${JSON.stringify({ job: "voucher-pii-retention-sweep", markets_source: run.markets_source, markets_env_set: false, results, retry_horizon_days: SWEEP_GAP_LOOKBACK_MS / DAY, retention_days: 365, market_b_untouched: true })}`)
  })

  it("AC2.b: drugi przebieg jest idempotentny (zero na każdym nośniku)", async () => {
    process.env.GP_CONFIG_ROOT = configRoots.onlyA
    const [r] = (await voucherPiiRetentionSweep(container as never)).results
    expect(Object.values(r.carriers)).toEqual([0, 0, 0, 0, 0])
  })

  it("R-3: odebrany GRANT na tabeli towarzyszącej ⇒ nazwany błąd joba GP_RECIPIENT_RETENTION_PERMISSION_DENIED (nie połknięty)", async () => {
    process.env.GP_CONFIG_ROOT = configRoots.onlyA
    logs.length = 0
    await db.raw("REVOKE SELECT ON voucher_pii_consent_audit FROM medusa_store")
    try {
      const run = await voucherPiiRetentionSweep(container as never)
      expect(run.results).toEqual([])
      expect(run.markets_failed).toBe(1)
      expect(run.failures).toEqual([{ market_id: MARKET_A, error_code: "GP_RECIPIENT_RETENTION_PERMISSION_DENIED" }])
      expect(logs.some((l) => l.startsWith("error") && l.includes("error_code=GP_RECIPIENT_RETENTION_PERMISSION_DENIED"))).toBe(true)
    } finally {
      await applyUp()
    }
    const priv = await db.raw(`SELECT has_table_privilege('medusa_store', 'voucher_pii_consent_audit', 'SELECT') AS s`)
    expect(priv.rows[0].s).toBe(true)
  })

  it("R-3: runtime bez kontekstu ALS odmawia (missing_market_context) przed jakąkolwiek pracą", async () => {
    await expect(
      runRecipientRetentionForMarket(db, { market_id: MARKET_A, cutoff: new Date(), batch_size: 1 })
    ).rejects.toMatchObject({ reason: "missing_market_context" })
  })

  it("AC2.a (DW-15-360 scope_extension_6_5): orphan cleanup dla rynku B pod medusa_store bez permission denied", async () => {
    process.env.GP_CONFIG_ROOT = configRoots.onlyB
    logs.length = 0
    const run = await voucherPiiOrphanCleanup(container as never)
    expect(run.markets).toEqual([MARKET_B])
    const results = run.results
    expect(logs.filter((l) => l.startsWith("error"))).toEqual([])
    expect(results).toHaveLength(1)
    // Cutoff = epoch: termin jest no-opem, więc oba tombstony rynku B bez audytu są sierotami.
    expect(results[0].carriers[RETENTION_CARRIERS.recipientPiiOrphans]).toBe(2)
    expect(results[0].carriers[RETENTION_CARRIERS.recipientPiiPurged]).toBe(0)
    expect(results[0].carriers[RETENTION_CARRIERS.lineItemMetadata]).toBe(0)
    const left = await db("voucher_recipient_pii").whereIn("id", [seeded.pii.b_old_tomb, seeded.pii.b_orphan, seeded.pii.b_audited]).select("id")
    expect(left.map((x: { id: string }) => String(x.id))).toEqual([seeded.pii.b_audited])
    console.log(`S116_ORPHAN ${JSON.stringify({ job: "voucher-pii-orphan-cleanup", results })}`)
  })

  it("AC2.c: zawężenie env do rynku spoza konfiguracji ⇒ zero pracy, nazwany alarm error (nie przekrojowy sweep)", async () => {
    process.env.GP_CONFIG_ROOT = configRoots.onlyA
    process.env.VOUCHER_PII_RETENTION_MARKETS = MARKET_B
    logs.length = 0
    try {
      const run = await voucherPiiRetentionSweep(container as never)
      expect(run.results).toEqual([])
      expect(run.alarms).toMatchObject({ no_markets: 1, narrowing_rejected: 1 })
      expect(logs.some((l) => l.startsWith("error") && l.includes("GP_RECIPIENT_RETENTION_NO_MARKETS"))).toBe(true)
    } finally {
      delete process.env.VOUCHER_PII_RETENTION_MARKETS
    }
  })

  it("migracja 20261115160000: up idempotentny, down zdejmuje RLS i polityki, ponowny up przywraca", async () => {
    await applyUp()
    await applyUp()
    for (const sql of collectSql("down")) await db.raw(sql)
    for (const sql of collectSql("down")) expect(sql).not.toMatch(/REVOKE/i)
    const down = await db.raw(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('voucher_pii_consent_audit','voucher_delivery_decision') ORDER BY relname`
    )
    expect(down.rows.map((r: { relrowsecurity: boolean }) => r.relrowsecurity)).toEqual([false, false])
    await applyUp()
    const up = await db.raw(
      `SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('voucher_pii_consent_audit','voucher_delivery_decision')`
    )
    expect(up.rows[0].n).toBe(2)
  })
})
