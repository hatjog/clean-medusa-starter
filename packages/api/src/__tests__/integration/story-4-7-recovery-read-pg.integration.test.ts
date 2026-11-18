/**
 * v1.16.0 Story 4.7 AC1/AC2 (FR-11/FR-12/FR-14, AD-31, AD-22, NFR-3) — jedno wejście
 * odczytu trzech populacji pod RLS, na realnym PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-4-7-recovery-read-pg`
 * Baza: izolowana `gp_story_4_7_test` (stack gp-test, port 55432); odmowa startu
 * na bazie bez sufiksu `_test`.
 *
 * Ścieżka produkcyjna bez skrótów: Knex z zainstalowanym `installRlsPoolHook`
 * (SET ROLE medusa_store + GUC rynku/instancji przy acquire) → `queryUnderMarketContext`
 * → `handleRecoveryRead`. Seed po jednym wierszu każdej populacji w rynkach A i B.
 *
 * Także: DW-15-333 p.(2) — job 4.5 z DOMYŚLNYM klientem (`defaultClientForMarket`
 * → `queryUnderMarketContext`) pod `medusa_store` na dwóch rynkach; DW-15-321 p.(1)
 * — wykluczenie zdarzenia z DLQ z wyboru pracy (`isEventDeadLettered`).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { readFileSync } from "fs"
import knexFactory, { type Knex } from "knex"
import path from "path"
import { Pool, type PoolClient } from "pg"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import { Migration20261114120000MoneyPathCompensationFailureRecoveryColumns } from "../../migrations/Migration20261114120000MoneyPathCompensationFailureRecoveryColumns"
import { Migration20261114100000DeferredIssuanceTraceTable } from "../../migrations/Migration20261114100000DeferredIssuanceTraceTable"
import { Migration1779018600000 } from "../../modules/voucher/migrations/1779018600000_create_mor_policy_dlq_entry"
import {
  Migration20261115100000RecoveryPopulationReadEntry,
  QUARANTINE_RETENTION_DAYS,
} from "../../migrations/Migration20261115100000RecoveryPopulationReadEntry"
import { handleRecoveryRead, RECOVERY_READ_CODES } from "../../api/admin/recovery/route"
import { recordDeferredIssuanceTrace } from "../../lib/recovery/deferred-issuance-trace"
import { __setKnexForAdminMarketTests } from "../../lib/admin-market-context"
import { installRlsPoolHook } from "../../lib/rls-pool-hook"
import { dlqEntryId, isEventDeadLettered } from "../../lib/events/event-dead-letter"
import { runDeferredIssuanceTraceAgeEscalation, MARKETS_ENV_VAR } from "../../jobs/deferred-issuance-trace-age-escalation"
import { DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS } from "../../lib/recovery/recovery-config"
import { STRIPE_RETRY_DLQ_SOURCE, closePathYRecoveryTrace } from "../../subscribers/on-order-placed-stripe-retry"

const INSTANCE = process.env.GP_INSTANCE_ID ?? ""
const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL && !!INSTANCE
const MKT_A = "mkt_4_7_a"
const MKT_B = "mkt_4_7_b"
const ACTOR = "user_4_7_a"

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../../../../../specs/contracts/recovery/schemas/recovery-population.v1.schema.json"
)

type MigrationLike = { up(): Promise<void>; down(): Promise<void> }
async function collectSql(ctor: { prototype: object }, direction: "up" | "down"): Promise<string[]> {
  const out: string[] = []
  const m = Object.create(ctor.prototype) as MigrationLike & { addSql: (s: string) => void }
  m.addSql = (s: string) => {
    out.push(s)
  }
  await m[direction]()
  return out
}

const MIGRATIONS = [
  Migration20260818090000MoneyPathCompensationFailureTable,
  Migration20261114120000MoneyPathCompensationFailureRecoveryColumns,
  Migration20261114100000DeferredIssuanceTraceTable,
  Migration1779018600000,
  Migration20261115100000RecoveryPopulationReadEntry,
]

const EXPECTED_POLICY = /instance_id = current_setting\('app\.gp_instance_id'::text, true\)\).*market_id = current_setting\('app\.gp_market_id'::text, true\)/

if (!enabled) {
  describe("Story 4.7 — wejście odczytu populacji pod RLS (PG)", () => {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1, DATABASE_URL i GP_INSTANCE_ID", () => {
      console.warn("[NOT_RUN] Story 4.7: ustaw GP_RUN_MIGRATION_INTEGRATION=1, DATABASE_URL, GP_INSTANCE_ID")
    })
  })
}

const describeOrNotRun = enabled ? describe : describe.skip

describeOrNotRun("Story 4.7 — wejście odczytu populacji pod RLS (PG)", () => {
  let pool: Pool
  let admin: PoolClient
  let knex: Knex
  const logs: string[] = []
  const logger = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
  }
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return knex
      if (key === "logger") return logger
      throw new Error(`unexpected resolve(${key})`)
    },
  }

  async function seed(market: string): Promise<void> {
    await admin.query(
      `INSERT INTO money_path_compensation_failure
         (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id, payment_intent_id,
          order_id, purchase_correlation_key, failure_code, failure_detail, resolution_state,
          instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind, provenance_source)
       VALUES ($1, $2, 'webhook_delivery_release', 'stripe_webhook', $3, $4, NULL, $5, 'fc', 'fd', 'open',
               $6, 'operator_role', 'ops-recovery', now() + interval '24 hours', 'not_closed',
               'runtime_observed', 'story-4-7-seed')`,
      [`mpcf_${market}`, market, `evt_cf_${market}`, `pi_cf_${market}`, `pck_${market}`, INSTANCE]
    )
    await admin.query(
      `INSERT INTO deferred_issuance_trace
         (trace_id, instance_id, market_id, state, owner_type, owner_id, deadline, occurred_at,
          closure_path, provenance_kind, provenance_source, payment_intent_id, stripe_event_id,
          deferral_reason, psp_occurred_at, age_source)
       VALUES ($1, $2, $3, 'awaiting_order', 'operator_role', 'ops-recovery', now() + interval '24 hours', now(),
               'not_closed', 'runtime_observed', 'story-4-7-seed', $4, $5, 'webhook_before_order',
               now() - make_interval(secs => $6::double precision), 'database_now_minus_occurred_at')`,
      [
        `evt_dit_${market}#deferred-issuance`,
        INSTANCE,
        market,
        `pi_dit_${market}`,
        `evt_dit_${market}`,
        DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS + 600,
      ]
    )
    await admin.query(
      `INSERT INTO mor_policy_dlq_entry
         (dlq_entry_id, instance_id, market_id, state, owner_type, owner_id, deadline, occurred_at,
          closure_path, resolution_evidence, provenance_kind, provenance_source, tier, classification,
          failure_mode, sqlstate, is_retryable, reason, source_job, event_class, event_id, subject_id)
       VALUES ($1, $2, $3, 'dlq_pending_ops_review', 'operator_role', 'ops-recovery', now() + interval '24 hours', now(),
               'not_closed', NULL, 'runtime_observed', $4, 'dlq_pending_ops_review', 'terminal',
               'FM-71-DLQ-1', '22P02', false, 'permanent_data_defect:sqlstate_22P02:Error', $4,
               'permanent_data_defect', $5, $6)`,
      [
        dlqEntryId(INSTANCE, market, STRIPE_RETRY_DLQ_SOURCE, `evt_dlq_${market}`, `order_${market}`),
        INSTANCE,
        market,
        STRIPE_RETRY_DLQ_SOURCE,
        `evt_dlq_${market}`,
        `order_${market}`,
      ]
    )
  }

  function req(market?: string) {
    return {
      auth_context: { actor_id: ACTOR, actor_type: "user" },
      query: market ? { market_id: market } : {},
      headers: {},
      scope: container,
    } as never
  }
  function res() {
    const r = {
      statusCode: 200,
      body: undefined as unknown,
      status(c: number) {
        r.statusCode = c
        return r
      },
      json(b: unknown) {
        r.body = b
        return r
      },
    }
    return r
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    admin = await pool.connect()
    const db = await admin.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 4.7 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
    await admin.query(
      `DROP TABLE IF EXISTS mor_policy_dlq_entry, deferred_issuance_trace_backfill_quarantine, deferred_issuance_trace,
         money_path_compensation_failure_backfill_quarantine, money_path_compensation_failure, admin_market_grants CASCADE`
    )
    for (const m of MIGRATIONS) for (const sql of await collectSql(m, "up")) await admin.query(sql)
    await admin.query(
      `CREATE TABLE admin_market_grants (admin_user_id text NOT NULL, market_id text NOT NULL,
         granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz NULL,
         PRIMARY KEY (admin_user_id, market_id))`
    )
    await admin.query("INSERT INTO admin_market_grants (admin_user_id, market_id) VALUES ($1, $2)", [ACTOR, MKT_A])
    await seed(MKT_A)
    await seed(MKT_B)

    knex = knexFactory({ client: "pg", connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } })
    installRlsPoolHook(knex as never, logger)
    __setKnexForAdminMarketTests(knexFactory({ client: "pg", connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }))
  })

  afterAll(async () => {
    __setKnexForAdminMarketTests(undefined)
    await knex?.destroy()
    admin?.release()
    await pool?.end()
  })

  it("AC1: rola runtime medusa_store jest NOBYPASSRLS, a trzy tabele mają FORCE RLS", async () => {
    const role = await admin.query("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'medusa_store'")
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false })
    const rls = await admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('money_path_compensation_failure','deferred_issuance_trace','mor_policy_dlq_entry') ORDER BY relname`
    )
    expect(rls.rows.every((r) => r.relrowsecurity === true && r.relforcerowsecurity === true)).toBe(true)
    expect(rls.rows).toHaveLength(3)
  })

  it("AC1: jedno wejście oddaje trzy populacje rynku A w kształcie 4.1; brak wierszy B", async () => {
    const r = res()
    await handleRecoveryRead(req(MKT_A), r as never)
    expect(r.statusCode).toBe(200)
    const body = r.body as { market_id: string; populations: Record<string, Array<Record<string, unknown>>> }
    expect(body.market_id).toBe(MKT_A)

    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")))
    for (const type of ["compensation_failure", "deferred_issuance_trace", "dlq_entry"]) {
      const rows = body.populations[type]
      expect(rows).toHaveLength(1)
      for (const row of rows) {
        const ok = validate(row)
        if (!ok) throw new Error(`${type}: ${JSON.stringify(validate.errors)}`)
        expect(row.market_id).toBe(MKT_A)
        expect(row.population_type).toBe(type)
      }
    }
    const all = Object.values(body.populations).flat()
    expect(all.some((row) => row.market_id === MKT_B)).toBe(false)
  })

  it("AC2: rynek spoza uprawnień ⇒ 403 recovery_market_forbidden (nie 200 [])", async () => {
    const r = res()
    await handleRecoveryRead(req(MKT_B), r as never)
    expect(r.statusCode).toBe(403)
    expect((r.body as { code: string }).code).toBe(RECOVERY_READ_CODES.marketForbidden)
    expect(JSON.stringify(r.body)).not.toContain("populations")
  })

  it("AC2: brak market_id ⇒ odmowa recovery_market_required (bez rynku domyślnego)", async () => {
    const r = res()
    await handleRecoveryRead(req(), r as never)
    expect(r.statusCode).toBe(400)
    expect((r.body as { code: string }).code).toBe(RECOVERY_READ_CODES.marketRequired)
  })

  it("AC2 (NFR-3): polityki market_isolation trzech tabel bez zmian predykatu", async () => {
    const pol = await admin.query<{ tablename: string; roles: string; qual: string; with_check: string }>(
      `SELECT tablename, roles::text AS roles, qual, with_check FROM pg_policies
        WHERE policyname = 'market_isolation'
          AND tablename IN ('money_path_compensation_failure','deferred_issuance_trace','mor_policy_dlq_entry')
        ORDER BY tablename`
    )
    expect(pol.rows.map((p) => p.tablename)).toEqual([
      "deferred_issuance_trace",
      "money_path_compensation_failure",
      "mor_policy_dlq_entry",
    ])
    for (const p of pol.rows) {
      expect(p.roles).toBe("{medusa_store}")
      expect(p.qual).toMatch(EXPECTED_POLICY)
      expect(p.with_check).toMatch(EXPECTED_POLICY)
    }
  })

  it("T4: retencja kwarantann 2555 dni bez sweepa i właściciel kwarantanny śladu (D-35 p.9/p.10)", async () => {
    await admin.query(
      "INSERT INTO deferred_issuance_trace_backfill_quarantine (source_event_id, source_row, reason) VALUES ('evt_q_4_7', '{}', 'test')"
    )
    const q = await admin.query(
      `SELECT owner_type, owner_id, round(extract(epoch FROM deadline - quarantined_at) / 3600) AS sla_h,
              round(extract(epoch FROM retention_until - quarantined_at) / 86400) AS retention_d
         FROM deferred_issuance_trace_backfill_quarantine WHERE source_event_id = 'evt_q_4_7'`
    )
    expect(q.rows[0]).toEqual({ owner_type: "operator_role", owner_id: "ops-recovery", sla_h: "24", retention_d: String(QUARANTINE_RETENTION_DAYS) })
    const cols = await admin.query(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'retention_until'
         AND table_name IN ('deferred_issuance_trace_backfill_quarantine','money_path_compensation_failure_backfill_quarantine')
       ORDER BY table_name`
    )
    expect(cols.rows).toHaveLength(2)
  })

  it("DW-15-321 p.1: zdarzenie z wierszem DLQ jest wykluczone z wyboru pracy pod RLS (medusa_store)", async () => {
    await admin.query("BEGIN")
    try {
      await admin.query("SET LOCAL ROLE medusa_store")
      const input = { instance_id: INSTANCE, source_job: STRIPE_RETRY_DLQ_SOURCE, event_id: `evt_dlq_${MKT_A}`, subject_id: `order_${MKT_A}` }
      expect(await isEventDeadLettered(admin, { ...input, market_id: MKT_A })).toBe(true)
      expect(await isEventDeadLettered(admin, { ...input, event_id: "evt_not_in_dlq", market_id: MKT_A })).toBe(false)
      // GUC przywrócone po odczycie (brak dziedziczenia scope'u).
      const guc = await admin.query("SELECT current_setting('app.gp_market_id', true) AS m")
      expect(guc.rows[0].m ?? "").toBe("")
    } finally {
      await admin.query("ROLLBACK")
    }
  })

  it("DW-15-333 p.2: job 4.5 z DOMYŚLNYM klientem (queryUnderMarketContext) pod medusa_store widzi ślad tylko swojego rynku", async () => {
    const emitted: Array<{ severity: string; context?: Record<string, unknown> }> = []
    const result = await runDeferredIssuanceTraceAgeEscalation(container as never, {
      env: { [MARKETS_ENV_VAR]: `${MKT_A},${MKT_B}` } as NodeJS.ProcessEnv,
      emit: (p) => emitted.push(p as never),
    })
    expect(result.status).toBe("ok")
    const escalated = (result as { escalated: Array<{ market_id: string; trace_id: string }> }).escalated
    expect(escalated.map((e) => `${e.market_id}:${e.trace_id}`).sort()).toEqual([
      `${MKT_A}:evt_dit_${MKT_A}#deferred-issuance`,
      `${MKT_B}:evt_dit_${MKT_B}#deferred-issuance`,
    ])
    for (const e of emitted) expect(e.context?.market_id).toBeDefined()
  })

  // Story 8.3 AC2 (T5): przerwany powrót z pobranymi pieniędzmi (PI `succeeded`,
  // koszyk bez zamówienia) zostawia ślad zapisany przez Path Y (`link_unresolved`
  // ⇒ `recordDeferredIssuanceTrace`). Ślad jest odnajdywalny przez GET /admin/recovery
  // po `payment_intent_id` w ISTNIEJĄCEJ populacji `deferred_issuance_trace` — bez
  // nowej tabeli i kolumny. Kontrola ujemna: rynek B go nie widzi.
  it("Story 8.3 AC2: ślad przerwanego powrotu jest odnajdywalny przez GET /admin/recovery po payment_intent_id", async () => {
    const PI = "pi_story83_interrupted_return"
    const EVT = "evt_story83_interrupted_return"
    await admin.query("BEGIN")
    try {
      await admin.query("SELECT set_config('app.gp_market_id', $1, true), set_config('app.gp_instance_id', $2, true)", [MKT_A, INSTANCE])
      const created = await recordDeferredIssuanceTrace(admin as never, {
        stripe_event_id: EVT,
        payment_intent_id: PI,
        instance_id: INSTANCE,
        market_id: MKT_A,
        psp_occurred_at: new Date().toISOString(),
        sla_seconds: 3600,
      })
      expect(created).toBe(true)
      await admin.query("COMMIT")
    } catch (err) {
      await admin.query("ROLLBACK")
      throw err
    }
    try {
      const r = res()
      await handleRecoveryRead(req(MKT_A), r as never)
      expect(r.statusCode).toBe(200)
      const body = r.body as { populations: Record<string, Array<{ payload: Record<string, unknown>; state: string }>> }
      const found = body.populations.deferred_issuance_trace.filter((row) => row.payload.payment_intent_id === PI)
      expect(found).toHaveLength(1)
      expect(found[0].state).toBe("awaiting_order")
      expect(found[0].payload.deferral_reason).toBe("webhook_before_order")

      await admin.query("INSERT INTO admin_market_grants (admin_user_id, market_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [ACTOR, MKT_B])
      const rb = res()
      await handleRecoveryRead(req(MKT_B), rb as never)
      const bodyB = rb.body as { populations: Record<string, Array<{ payload: Record<string, unknown> }>> }
      expect(bodyB.populations.deferred_issuance_trace.some((row) => row.payload.payment_intent_id === PI)).toBe(false)
    } finally {
      await admin.query("DELETE FROM admin_market_grants WHERE admin_user_id = $1 AND market_id = $2", [ACTOR, MKT_B])
      await admin.query("DELETE FROM deferred_issuance_trace WHERE payment_intent_id = $1", [PI])
    }
  })
  // Story 8.7 (DW-15-361): odzysk Path Y z częściową porażką NIE domyka śladu —
  // rekord zostaje widoczny w GET /admin/recovery; pełne wystawienie po ponowieniu
  // domyka go jako `issued_after_link`. Klient pod rolą runtime (RLS).
  it("DW-15-361: partialFailure ⇒ ślad widoczny w /admin/recovery; pełne wystawienie ⇒ issued_after_link", async () => {
    const PI = "pi_dw15361_partial"
    const EVT = "evt_dw15361_partial"
    const ORDER = "order_dw15361"
    const scope = { instance_id: INSTANCE, market_id: MKT_A }
    await admin.query("BEGIN")
    try {
      await admin.query("SELECT set_config('app.gp_market_id', $1, true), set_config('app.gp_instance_id', $2, true)", [MKT_A, INSTANCE])
      await recordDeferredIssuanceTrace(admin as never, {
        stripe_event_id: EVT, payment_intent_id: PI, instance_id: INSTANCE, market_id: MKT_A,
        psp_occurred_at: new Date().toISOString(), sla_seconds: 3600,
      })
      await admin.query("COMMIT")
    } catch (err) {
      await admin.query("ROLLBACK")
      throw err
    }
    const runUnderRuntime = async (result: { event_processed: boolean; failed_lines: unknown[]; issued: unknown[] }) => {
      await admin.query("BEGIN")
      try {
        await admin.query("SET LOCAL ROLE medusa_store")
        const outcome = await closePathYRecoveryTrace(admin as never, {
          event_id: `${EVT}#deferred-issuance`, order_id: ORDER, scope, payment_intent_id: PI, result, logger,
        })
        await admin.query("COMMIT")
        return outcome
      } catch (err) {
        await admin.query("ROLLBACK")
        throw err
      }
    }
    const readTrace = async () => {
      const r = res()
      await handleRecoveryRead(req(MKT_A), r as never)
      expect(r.statusCode).toBe(200)
      const body = r.body as { populations: Record<string, Array<{ payload: Record<string, unknown>; state: string }>> }
      return body.populations.deferred_issuance_trace.filter((row) => row.payload.payment_intent_id === PI)
    }
    try {
      // 1) Częściowa porażka: 1 linia wystawiona, 1 nieudana, event NIE skonsumowany.
      expect(await runUnderRuntime({ event_processed: false, failed_lines: [{ line_item_id: "li_b" }], issued: [{ id: "ent_a" }] }))
        .toBe("skipped_partial_failure")
      const visible = await readTrace()
      expect(visible).toHaveLength(1)
      expect(visible[0].state).toBe("awaiting_order")

      // 2) Ponowienie z pełnym wystawieniem ⇒ domknięcie `issued_after_link`.
      expect(await runUnderRuntime({ event_processed: true, failed_lines: [], issued: [{ id: "ent_b" }] })).toBe("closed")
      expect(await readTrace()).toHaveLength(0)
      const row = await admin.query<{ state: string; closure_path: string }>(
        "SELECT state, closure_path FROM deferred_issuance_trace WHERE payment_intent_id = $1", [PI]
      )
      expect(row.rows).toEqual([{ state: "issued_after_link", closure_path: expect.any(String) }])
    } finally {
      await admin.query("DELETE FROM deferred_issuance_trace WHERE payment_intent_id = $1", [PI])
    }
  })
})
