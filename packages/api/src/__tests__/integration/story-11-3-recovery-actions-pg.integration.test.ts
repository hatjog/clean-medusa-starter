/**
 * v1.16.0 Story 11.3 AC-1/AC-3/AC-4 (FR-11, FR-12, FR-14, AD-48, AD-49, NFR-3; D-37) —
 * autoryzowane akcje recovery propose → approve na realnym PostgreSQL pod RLS.
 *
 * Profil: `pnpm run test:integration:story-11-3-recovery-actions-pg`
 * Baza: izolowana `gp_story_11_3_test` (stack gp-test, port 55432); odmowa startu
 * na bazie bez sufiksu `_test`. Suita DROP-uje i odtwarza tabele populacji.
 *
 * Ścieżka produkcyjna: trasa `POST` (z `withOperatorAuth`) → `handleRecoveryStep`
 * → `defaultRecoveryTransaction` (Knex z `installRlsPoolHook`, `SET ROLE medusa_store`
 * + GUC rynku/instancji) → kernel 4.1 z trwałym store/ledgerem/weryfikatorem.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"
import { Pool, type PoolClient } from "pg"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import { Migration20261114120000MoneyPathCompensationFailureRecoveryColumns } from "../../migrations/Migration20261114120000MoneyPathCompensationFailureRecoveryColumns"
import { Migration20261114100000DeferredIssuanceTraceTable } from "../../migrations/Migration20261114100000DeferredIssuanceTraceTable"
import { Migration1779018600000 } from "../../modules/voucher/migrations/1779018600000_create_mor_policy_dlq_entry"
import { Migration20261115100000RecoveryPopulationReadEntry } from "../../migrations/Migration20261115100000RecoveryPopulationReadEntry"
import { Migration20261115120000RecoveryActionStep } from "../../migrations/Migration20261115120000RecoveryActionStep"
import { POST as PROPOSE } from "../../api/admin/recovery/[population]/[id]/propose/route"
import { POST as APPROVE } from "../../api/admin/recovery/[population]/[id]/approve/route"
import { handleRecoveryRead } from "../../api/admin/recovery/route"
import { __setKnexForAdminMarketTests } from "../../lib/admin-market-context"
import { installRlsPoolHook } from "../../lib/rls-pool-hook"
import { dlqEntryId, isEventDeadLettered } from "../../lib/events/event-dead-letter"
import { STRIPE_RETRY_DLQ_SOURCE } from "../../subscribers/on-order-placed-stripe-retry"
import {
  __setRecoveryDomainAdaptersForTests,
  createRecoveryDomainAdapterRegistry,
  RECOVERY_RETRY_CAPABILITY,
  type RecoveryDomainAdapter,
} from "../../lib/recovery/recovery-domain-adapters"
import type { RecoveryPopulationType } from "../../lib/recovery/recovery-action-contract"

const INSTANCE = process.env.GP_INSTANCE_ID ?? ""
const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL && !!INSTANCE
const MKT_A = "mkt_11_3_a"
const MKT_B = "mkt_11_3_b"
const ACTOR = "user_11_3_a"
const OTHER_ACTOR = "user_11_3_other"
const THROW_SECRET = "SECRET_DETAIL_11_3"

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
  Migration20261115120000RecoveryActionStep,
]

if (!enabled) {
  describe("Story 11.3 — akcje recovery pod RLS (PG)", () => {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1, DATABASE_URL i GP_INSTANCE_ID", () => {
      console.warn("[NOT_RUN] Story 11.3: ustaw GP_RUN_MIGRATION_INTEGRATION=1, DATABASE_URL, GP_INSTANCE_ID")
    })
  })
}

const describeOrNotRun = enabled ? describe : describe.skip

describeOrNotRun("Story 11.3 — akcje recovery pod RLS (PG)", () => {
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

  const cfId = (m: string, n: string) => `mpcf_${m}_${n}`
  const ditId = (m: string, n: string) => `evt_dit_${m}_${n}#deferred-issuance`
  const dlqEvent = (m: string, n: string) => `evt_dlq_${m}_${n}`

  async function seed(market: string, n: string): Promise<void> {
    await admin.query(
      `INSERT INTO money_path_compensation_failure
         (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id, payment_intent_id,
          order_id, purchase_correlation_key, failure_code, failure_detail, resolution_state,
          instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind, provenance_source)
       VALUES ($1, $2, 'webhook_delivery_release', 'stripe_webhook', $3, $4, NULL, $5, 'fc', 'fd', 'open',
               $6, 'operator_role', 'ops-recovery', now() + interval '24 hours', 'not_closed',
               'runtime_observed', 'story-11-3-seed')`,
      [cfId(market, n), market, `evt_cf_${market}_${n}`, `pi_cf_${market}_${n}`, `pck_${market}_${n}`, INSTANCE]
    )
    await admin.query(
      `INSERT INTO deferred_issuance_trace
         (trace_id, instance_id, market_id, state, owner_type, owner_id, deadline, occurred_at,
          closure_path, provenance_kind, provenance_source, payment_intent_id, stripe_event_id,
          deferral_reason, psp_occurred_at, age_source)
       VALUES ($1, $2, $3, 'awaiting_order', 'operator_role', 'ops-recovery', now() + interval '24 hours', now(),
               'not_closed', 'runtime_observed', 'story-11-3-seed', $4, $5, 'webhook_before_order',
               now() - interval '2 hours', 'database_now_minus_occurred_at')`,
      [ditId(market, n), INSTANCE, market, `pi_dit_${market}_${n}`, `evt_dit_${market}_${n}`]
    )
    await admin.query(
      `INSERT INTO mor_policy_dlq_entry
         (dlq_entry_id, instance_id, market_id, state, owner_type, owner_id, deadline, occurred_at,
          closure_path, resolution_evidence, provenance_kind, provenance_source, tier, classification,
          failure_mode, sqlstate, is_retryable, reason, source_job, event_class, event_id, subject_id)
       VALUES ($1, $2, $3, 'dlq_pending_retry', 'operator_role', 'ops-recovery', now() + interval '24 hours', now(),
               'not_closed', NULL, 'runtime_observed', $4, 'dlq_pending_retry', 'retryable',
               'FM-71-RT-1', '40001', true, 'transient_retry:FM-71-RT-1:Error', $4,
               'unknown_fail_closed', $5, $6)`,
      [
        dlqEntryId(INSTANCE, market, STRIPE_RETRY_DLQ_SOURCE, dlqEvent(market, n), `order_${market}_${n}`),
        INSTANCE,
        market,
        STRIPE_RETRY_DLQ_SOURCE,
        dlqEvent(market, n),
        `order_${market}_${n}`,
      ]
    )
  }

  async function dlqPopulationId(market: string, n: string): Promise<string> {
    const r = await admin.query("SELECT population_id FROM mor_policy_dlq_entry WHERE event_id = $1", [dlqEvent(market, n)])
    return r.rows[0].population_id
  }

  type Res = { statusCode: number; body: any; status(c: number): Res; json(b: unknown): Res }
  function res(): Res {
    const r: Res = {
      statusCode: 200,
      body: undefined,
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

  async function call(
    step: "propose" | "approve",
    population: string,
    id: string,
    body: Record<string, unknown>,
    opts: { market?: string; actor?: string | null } = {}
  ): Promise<Res> {
    const r = res()
    const actor = opts.actor === undefined ? ACTOR : opts.actor
    const req = {
      auth_context: actor ? { actor_id: actor, actor_type: "user" } : undefined,
      params: { population, id },
      query: { market_id: opts.market ?? MKT_A },
      headers: {},
      body,
      scope: container,
    }
    await (step === "propose" ? PROPOSE : APPROVE)(req as never, r as never, (() => undefined) as never)
    return r
  }

  async function steps(populationId: string) {
    const r = await admin.query(
      `SELECT step, step_key, outcome, actor_id FROM recovery_action_step WHERE population_id = $1 ORDER BY recorded_at, audit_id`,
      [populationId]
    )
    return r.rows as Array<{ step: string; step_key: string | null; outcome: string; actor_id: string }>
  }

  /**
   * Adaptery domenowe testu (R-1): skutek biznesowy = wiersz `story_11_3_domain_effect`
   * zapisany W transakcji akcji (pod rolą runtime). Zachowanie per wiersz populacji.
   */
  const behavior: Record<string, "succeed" | "partial" | "fail" | "throw"> = {}
  const testAdapter = (population: RecoveryPopulationType): RecoveryDomainAdapter => ({
    population_type: population,
    capability: RECOVERY_RETRY_CAPABILITY[population],
    retry: async ({ client, record }) => {
      const mode = behavior[record.population_id] ?? "succeed"
      const reference = `effect_${population}_${record.population_id.replace(/[^A-Za-z0-9]/g, "_")}`
      await client.query("INSERT INTO story_11_3_domain_effect (population_type, population_id, reference, mode) VALUES ($1, $2, $3, $4)", [
        population,
        record.population_id,
        reference,
        mode,
      ])
      if (mode === "throw") throw new Error(`pg: relation secret_internal_table violates constraint ${THROW_SECRET}`)
      if (mode === "fail") return { status: "failed", reason: "test_adapter_failed" }
      if (mode === "partial") return { status: "partial", reason: "test_adapter_partial", reference }
      return { status: "succeeded", reference }
    },
  })
  const TEST_ADAPTERS = createRecoveryDomainAdapterRegistry([
    testAdapter("compensation_failure"),
    testAdapter("deferred_issuance_trace"),
    testAdapter("dlq_entry"),
  ])
  /**
   * R-12/R-15 (runda fix 2): retry compensation_failure doprowadzony do `recovery_in_progress` v2
   * idempotentnie — testy zależne od tego stanu przygotowują go same (przechodzą z `-t`).
   */
  async function ensureCompensationRetried(id: string): Promise<void> {
    const cur = await admin.query("SELECT version FROM money_path_compensation_failure WHERE failure_id = $1", [id])
    if (cur.rows[0].version !== 1) return
    const body = { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }
    const p = await call("propose", "compensation_failure", id, body)
    expect([201, 200]).toContain(p.statusCode)
    const a = await call("approve", "compensation_failure", id, body)
    expect(["applied", "replayed"]).toContain(a.body.outcome)
  }
  async function effects(populationId: string) {
    const r = await admin.query("SELECT reference, mode FROM story_11_3_domain_effect WHERE population_id = $1 ORDER BY id", [populationId])
    return r.rows as Array<{ reference: string; mode: string }>
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    admin = await pool.connect()
    const db = await admin.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 11.3 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
    await admin.query(
      `DROP TABLE IF EXISTS recovery_action_step, mor_policy_dlq_entry, deferred_issuance_trace_backfill_quarantine, deferred_issuance_trace,
         money_path_compensation_failure_backfill_quarantine, money_path_compensation_failure, admin_market_grants, story_11_3_domain_effect CASCADE`
    )
    await admin.query(
      `CREATE TABLE story_11_3_domain_effect (id bigserial PRIMARY KEY, population_type text NOT NULL,
         population_id text NOT NULL, reference text NOT NULL, mode text NOT NULL)`
    )
    await admin.query("GRANT SELECT, INSERT ON story_11_3_domain_effect TO medusa_store")
    await admin.query("GRANT USAGE ON SEQUENCE story_11_3_domain_effect_id_seq TO medusa_store")
    for (const m of MIGRATIONS) for (const sql of await collectSql(m, "up")) await admin.query(sql)
    await admin.query(
      `CREATE TABLE admin_market_grants (admin_user_id text NOT NULL, market_id text NOT NULL,
         granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz NULL,
         PRIMARY KEY (admin_user_id, market_id))`
    )
    await admin.query("INSERT INTO admin_market_grants (admin_user_id, market_id) VALUES ($1, $2), ($3, $2)", [ACTOR, MKT_A, OTHER_ACTOR])
    for (const n of ["1", "2", "3"]) {
      await seed(MKT_A, n)
      await seed(MKT_B, n)
    }
    // R-12/R-15: wiersze własne testu rejestru produkcyjnego (4) i wyjątku adaptera (5).
    for (const n of ["4", "5"]) await seed(MKT_A, n)
    knex = knexFactory({ client: "pg", connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } })
    installRlsPoolHook(knex as never, logger)
    __setKnexForAdminMarketTests(knexFactory({ client: "pg", connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } }))
  })

  // R-12/R-15: rejestr testowy ustawiany przed KAŻDYM testem, nie jako skutek uboczny poprzedniego.
  beforeEach(() => {
    __setRecoveryDomainAdaptersForTests(TEST_ADAPTERS)
  })

  afterAll(async () => {
    __setRecoveryDomainAdaptersForTests(undefined)
    __setKnexForAdminMarketTests(undefined)
    await knex?.destroy()
    admin?.release()
    await pool?.end()
  })

  it("AC-1 (NFR-3): recovery_action_step ma FORCE RLS market_isolation; medusa_store bez UPDATE/DELETE", async () => {
    const rls = await admin.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'recovery_action_step'"
    )
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const pol = await admin.query("SELECT qual FROM pg_policies WHERE tablename = 'recovery_action_step' AND policyname = 'market_isolation'")
    expect(pol.rows[0].qual).toMatch(/app\.gp_instance_id.*app\.gp_market_id/)
    const priv = await admin.query(
      `SELECT has_table_privilege('medusa_store', 'recovery_action_step', 'UPDATE') AS upd,
              has_table_privilege('medusa_store', 'recovery_action_step', 'DELETE') AS del,
              has_table_privilege('medusa_store', 'recovery_action_step', 'INSERT') AS ins,
              has_column_privilege('medusa_store', 'mor_policy_dlq_entry', 'state', 'UPDATE') AS dlq_state,
              has_column_privilege('medusa_store', 'mor_policy_dlq_entry', 'event_id', 'UPDATE') AS dlq_event,
              has_column_privilege('medusa_store', 'mor_policy_dlq_entry', 'reason', 'UPDATE') AS dlq_reason`
    )
    expect(priv.rows[0]).toEqual({ upd: false, del: false, ins: true, dlq_state: true, dlq_event: false, dlq_reason: false })
  })

  it("AC-1: 401 z wrappera bez sesji — zero wierszy audytu", async () => {
    const r = await call("propose", "compensation_failure", cfId(MKT_A, "1"), { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }, { actor: null })
    expect(r.statusCode).toBe(401)
    expect(await steps(cfId(MKT_A, "1"))).toEqual([])
  })

  it("AC-1: pole aktora w body ⇒ 400 recovery_actor_in_body_rejected, bez skutku", async () => {
    const r = await call("propose", "compensation_failure", cfId(MKT_A, "1"), {
      action: "retry",
      target_state: "recovery_in_progress",
      expected_version: 1,
      actor: { actor_id: "someone_else" },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe("recovery_actor_in_body_rejected")
    expect(await steps(cfId(MKT_A, "1"))).toEqual([])
  })

  it("R-1: produkcyjny rejestr (bez mechanizmu w zakresie 11.3) ⇒ 503 refused_domain_adapter_unavailable; brak przejścia stanu", async () => {
    // R-12/R-15: rejestr produkcyjny przełączany w SAMYM teście; wiersze własne (n=4), trzy populacje.
    __setRecoveryDomainAdaptersForTests(undefined)
    for (const [population, id, target, table, col, key] of [
      ["compensation_failure", cfId(MKT_A, "4"), "recovery_in_progress", "money_path_compensation_failure", "resolution_state", "failure_id"],
      ["deferred_issuance_trace", ditId(MKT_A, "4"), "escalated", "deferred_issuance_trace", "state", "trace_id"],
      ["dlq_entry", await dlqPopulationId(MKT_A, "4"), "replayed", "mor_policy_dlq_entry", "state", "population_id"],
    ] as const) {
      const body = { action: "retry", target_state: target, expected_version: 1 }
      expect((await call("propose", population, id, body)).statusCode).toBe(201)
      const a = await call("approve", population, id, body)
      expect(a.statusCode).toBe(503)
      expect(a.body).toEqual(expect.objectContaining({ outcome: "refused_domain_adapter_unavailable", domain_effects: 0 }))
      expect(a.body.domain_adapter).toEqual(expect.objectContaining({ status: "unavailable" }))
      const row = await admin.query(`SELECT ${col} AS state, version FROM ${table} WHERE ${key} = $1`, [id])
      expect(row.rows[0].version).toBe(1)
      expect(row.rows[0].state).not.toBe(target)
      expect(await effects(id)).toEqual([])
    }
  })

  describe("compensation_failure — retry_compensation / resolve_compensation", () => {
    const id = () => cfId(MKT_A, "1")

    it("retry: propose → approve ⇒ recovery_in_progress, retry_count 1, audyt obu kroków z aktorem sesji", async () => {
      const body = { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }
      const p = await call("propose", "compensation_failure", id(), body)
      expect(p.statusCode).toBe(201)
      expect(p.body).toEqual(expect.objectContaining({ outcome: "proposed", domain_effects: 0, step_key: `propose:compensation_failure:${id()}:retry:1:recovery_in_progress` }))
      const unchanged = await admin.query("SELECT resolution_state, version FROM money_path_compensation_failure WHERE failure_id = $1", [id()])
      expect(unchanged.rows[0]).toEqual({ resolution_state: "open", version: 1 })

      expect(await effects(id())).toEqual([])
      const a = await call("approve", "compensation_failure", id(), body)
      expect(a.statusCode).toBe(200)
      expect(a.body).toEqual(expect.objectContaining({ outcome: "applied", domain_effects: 1, record: { state: "recovery_in_progress", version: 2 } }))
      // R-1: skutek domenowy adaptera retry_compensation zapisany w tej samej transakcji.
      expect(await effects(id())).toEqual([{ reference: `effect_compensation_failure_${id()}`, mode: "succeed" }])
      const row = await admin.query("SELECT resolution_state, version, retry_count FROM money_path_compensation_failure WHERE failure_id = $1", [id()])
      expect(row.rows[0]).toEqual({ resolution_state: "recovery_in_progress", version: 2, retry_count: 1 })
      const s = await steps(id())
      expect(s.map((x) => [x.step, x.outcome, x.actor_id])).toEqual([
        ["propose", "proposed", ACTOR],
        ["approve", "applied", ACTOR],
      ])
      expect(s[0].step_key).toBe(`propose:compensation_failure:${id()}:retry:1:recovery_in_progress`)
      expect(s[0].step_key).not.toBe(s[1].step_key)
    })

    it("AC-4 replay approve ⇒ replayed, brak drugiego skutku, osobny wiersz audytu", async () => {
      await ensureCompensationRetried(id())
      const before = (await steps(id())).length
      const a = await call("approve", "compensation_failure", id(), { action: "retry", target_state: "recovery_in_progress", expected_version: 1 })
      expect(a.statusCode).toBe(200)
      expect(a.body.outcome).toBe("replayed")
      expect(a.body.domain_effects).toBe(0)
      const row = await admin.query("SELECT version, retry_count FROM money_path_compensation_failure WHERE failure_id = $1", [id()])
      expect(row.rows[0]).toEqual({ version: 2, retry_count: 1 })
      const s = await steps(id())
      expect(s).toHaveLength(before + 1)
      expect(s[s.length - 1]).toEqual(expect.objectContaining({ step: "approve", outcome: "replayed", step_key: null }))
      expect(s.filter((x) => x.outcome === "applied")).toHaveLength(1)
      expect(await effects(id())).toHaveLength(1)
    })

    it("AC-3 częściowy skutek (recovery_in_progress) nie uruchamia ślepego retry ⇒ 422", async () => {
      await ensureCompensationRetried(id())
      const p = await call("propose", "compensation_failure", id(), { action: "retry", target_state: "recovery_in_progress", expected_version: 2 })
      expect(p.statusCode).toBe(422)
      expect(p.body.outcome).toBe("refused_invalid_transition")
    })

    it("resolve: evidence z obcą płatnością ⇒ 422; z płatnością wiersza ⇒ resolved_recovered + resolved_at/by + closure", async () => {
      const bad = await call("propose", "compensation_failure", id(), {
        action: "resolve",
        target_state: "resolved_recovered",
        expected_version: 2,
        evidence: { kind: "refund_confirmed", reference: `pi_cf_${MKT_A}_2` },
      })
      expect(bad.statusCode).toBe(422)
      const body = {
        action: "resolve",
        target_state: "resolved_recovered",
        expected_version: 2,
        evidence: { kind: "refund_confirmed", reference: `pi_cf_${MKT_A}_1` },
      }
      expect((await call("propose", "compensation_failure", id(), body)).statusCode).toBe(201)
      const a = await call("approve", "compensation_failure", id(), { action: "resolve", target_state: "resolved_recovered", expected_version: 2 })
      expect(a.statusCode).toBe(200)
      expect(a.body.outcome).toBe("applied")
      const row = await admin.query(
        `SELECT resolution_state, version, resolved_by, resolved_at IS NOT NULL AS has_at, closure_path,
                resolution_evidence->>'kind' AS kind, resolution_evidence->'recorded_by'->>'actor_id' AS by
           FROM money_path_compensation_failure WHERE failure_id = $1`,
        [id()]
      )
      expect(row.rows[0]).toEqual({
        resolution_state: "resolved_recovered",
        version: 3,
        resolved_by: ACTOR,
        has_at: true,
        closure_path: "operator_action",
        kind: "refund_confirmed",
        by: ACTOR,
      })
    })
  })

  describe("deferred_issuance_trace — retry_issuance_link / resolve_issuance_link", () => {
    const id = () => ditId(MKT_A, "1")

    it("retry ⇒ escalated; ponowny retry z escalated (częściowy skutek) ⇒ 422", async () => {
      const body = { action: "retry", target_state: "escalated", expected_version: 1 }
      expect((await call("propose", "deferred_issuance_trace", id(), body)).statusCode).toBe(201)
      const a = await call("approve", "deferred_issuance_trace", id(), body)
      expect(a.body.outcome).toBe("applied")
      const row = await admin.query("SELECT state, version, retry_count FROM deferred_issuance_trace WHERE trace_id = $1", [id()])
      expect(row.rows[0]).toEqual({ state: "escalated", version: 2, retry_count: 1 })
      expect(await effects(id())).toEqual([{ reference: `effect_deferred_issuance_trace_${id().replace(/[^A-Za-z0-9]/g, "_")}`, mode: "succeed" }])
      const again = await call("propose", "deferred_issuance_trace", id(), { ...body, expected_version: 2 })
      expect(again.statusCode).toBe(422)
    })

    it("resolve ⇒ issued_after_link z evidence entitlement_issued związanym z payment_intent_id", async () => {
      const body = { action: "resolve", target_state: "issued_after_link", expected_version: 2 }
      const noEvidence = await call("propose", "deferred_issuance_trace", id(), body)
      expect(noEvidence.statusCode).toBe(422)
      expect(noEvidence.body.outcome).toBe("refused_missing_evidence")
      expect(
        (await call("propose", "deferred_issuance_trace", id(), { ...body, evidence: { kind: "entitlement_issued", reference: `pi_dit_${MKT_A}_1` } })).statusCode
      ).toBe(201)
      const a = await call("approve", "deferred_issuance_trace", id(), body)
      expect(a.body.outcome).toBe("applied")
      const row = await admin.query("SELECT state, version, closure_path, resolution_evidence->>'reference' AS ref FROM deferred_issuance_trace WHERE trace_id = $1", [id()])
      expect(row.rows[0]).toEqual({ state: "issued_after_link", version: 3, closure_path: "operator_action", ref: `pi_dit_${MKT_A}_1` })
    })
  })

  describe("dlq_entry — retry_domain_adapter / resolve_domain_adapter", () => {
    it("retry ⇒ replay adaptera ⇒ replayed z evidence = referencja WYNIKU replayu (R-1/R-6); isEventDeadLettered: replayed nie wyklucza, open wyklucza", async () => {
      const id = await dlqPopulationId(MKT_A, "1")
      const body = { action: "retry", target_state: "replayed", expected_version: 1 }
      // Evidence operatora dla retry jest odrzucane — dowód wytwarza adapter.
      const wrong = await call("propose", "dlq_entry", id, { ...body, evidence: { kind: "replayed_successfully", reference: dlqEvent(MKT_A, "1") } })
      expect(wrong.statusCode).toBe(422)
      expect((await call("propose", "dlq_entry", id, body)).statusCode).toBe(201)
      const a = await call("approve", "dlq_entry", id, body)
      expect(a.body.outcome).toBe("applied")
      const ref = `effect_dlq_entry_${id.replace(/[^A-Za-z0-9]/g, "_")}`
      expect(await effects(id)).toEqual([{ reference: ref, mode: "succeed" }])
      const row = await admin.query(
        "SELECT state, version, retry_count, closure_path, resolution_evidence->>'reference' AS ref, resolution_evidence->>'kind' AS kind FROM mor_policy_dlq_entry WHERE population_id = $1",
        [id]
      )
      expect(row.rows[0]).toEqual({ state: "replayed", version: 2, retry_count: 1, closure_path: "operator_action", ref, kind: "replayed_successfully" })

      await admin.query("BEGIN")
      try {
        await admin.query("SET LOCAL ROLE medusa_store")
        const input = { instance_id: INSTANCE, market_id: MKT_A, source_job: STRIPE_RETRY_DLQ_SOURCE }
        expect(await isEventDeadLettered(admin, { ...input, event_id: dlqEvent(MKT_A, "1"), subject_id: `order_${MKT_A}_1` })).toBe(false)
        expect(await isEventDeadLettered(admin, { ...input, event_id: dlqEvent(MKT_A, "2"), subject_id: `order_${MKT_A}_2` })).toBe(true)
      } finally {
        await admin.query("ROLLBACK")
      }
    })

    it("resolve ⇒ discarded_with_evidence (written_off_with_approval); kolumny faktu nietknięte", async () => {
      const id = await dlqPopulationId(MKT_A, "2")
      const body = { action: "resolve", target_state: "discarded_with_evidence", expected_version: 1 }
      expect((await call("propose", "dlq_entry", id, { ...body, evidence: { kind: "written_off_with_approval", reference: "INC-11-3-0001" } })).statusCode).toBe(201)
      const a = await call("approve", "dlq_entry", id, body)
      expect(a.body.outcome).toBe("applied")
      const row = await admin.query("SELECT state, event_id, reason FROM mor_policy_dlq_entry WHERE population_id = $1", [id])
      expect(row.rows[0]).toEqual({ state: "discarded_with_evidence", event_id: dlqEvent(MKT_A, "2"), reason: "transient_retry:FM-71-RT-1:Error" })
    })
  })

  describe("R-1/R-4 — porażka i częściowy skutek adaptera", () => {
    it("R-1 retry_failed: adapter failed ⇒ 502, skutek adaptera cofnięty (SAVEPOINT), stan i wersja bez zmian", async () => {
      const id = ditId(MKT_A, "2")
      behavior[id] = "fail"
      const body = { action: "retry", target_state: "escalated", expected_version: 1 }
      expect((await call("propose", "deferred_issuance_trace", id, body)).statusCode).toBe(201)
      const a = await call("approve", "deferred_issuance_trace", id, body)
      expect(a.statusCode).toBe(502)
      expect(a.body).toEqual(expect.objectContaining({ outcome: "retry_failed", domain_effects: 0 }))
      expect(a.body.domain_adapter).toEqual({ status: "failed", reason: "test_adapter_failed" })
      expect(await effects(id)).toEqual([])
      const row = await admin.query("SELECT state, version, retry_count FROM deferred_issuance_trace WHERE trace_id = $1", [id])
      expect(row.rows[0]).toEqual({ state: "awaiting_order", version: 1, retry_count: 0 })
      delete behavior[id]
    })

    it("R-13 wyjątek adaptera ⇒ 502 z nazwanym kodem adapter_threw; treść wyjątku tylko w audycie kroku", async () => {
      const id = ditId(MKT_A, "5")
      behavior[id] = "throw"
      const body = { action: "retry", target_state: "escalated", expected_version: 1 }
      expect((await call("propose", "deferred_issuance_trace", id, body)).statusCode).toBe(201)
      const a = await call("approve", "deferred_issuance_trace", id, body)
      delete behavior[id]
      expect(a.statusCode).toBe(502)
      expect(a.body).toEqual(expect.objectContaining({ outcome: "retry_failed", domain_effects: 0 }))
      expect(a.body.domain_adapter).toEqual({ status: "failed", reason: "adapter_threw" })
      expect(JSON.stringify(a.body)).not.toContain(THROW_SECRET)
      expect(JSON.stringify(a.body)).not.toContain("secret_internal_table")
      const audit = await admin.query(
        "SELECT audit->'domain_adapter'->'detail'->>'error_message' AS msg FROM recovery_action_step WHERE population_id = $1 AND step = 'approve'",
        [id]
      )
      expect(audit.rows[0].msg).toContain(THROW_SECRET)
    })

    it("R-4 partial_effect: częściowy skutek ⇒ jawny stan nieterminalny; ślepy retry i resolve odrzucone; jedyny następca dlq_pending_ops_review", async () => {
      const id = await dlqPopulationId(MKT_A, "3")
      behavior[id] = "partial"
      const retry = { action: "retry", target_state: "replayed", expected_version: 1 }
      expect((await call("propose", "dlq_entry", id, retry)).statusCode).toBe(201)
      const a = await call("approve", "dlq_entry", id, retry)
      expect(a.statusCode).toBe(200)
      // R-10 (runda fix 2): odpowiedź = stan FAKTYCZNIE zapisany w wierszu; częściowy skutek osobnym polem.
      expect(a.body).toEqual(
        expect.objectContaining({ outcome: "partial_effect", pending_partial_effect: true, domain_effects: 1, record: { state: "dlq_pending_retry", version: 2 } })
      )
      expect(await effects(id)).toHaveLength(1)
      const row = await admin.query("SELECT state, version, retry_count, resolution_evidence FROM mor_policy_dlq_entry WHERE population_id = $1", [id])
      expect(row.rows[0]).toEqual({ state: "dlq_pending_retry", version: 2, retry_count: 1, resolution_evidence: null })
      expect(a.body.record).toEqual({ state: row.rows[0].state, version: row.rows[0].version })
      delete behavior[id]

      const blind = await call("propose", "dlq_entry", id, { ...retry, expected_version: 2 })
      expect(blind.statusCode).toBe(422)
      expect(blind.body.outcome).toBe("refused_partial_effect_pending")
      const resolve = await call("propose", "dlq_entry", id, {
        action: "resolve",
        target_state: "discarded_with_evidence",
        expected_version: 2,
        evidence: { kind: "written_off_with_approval", reference: "INC-11-3-0003" },
      })
      expect(resolve.statusCode).toBe(422)
      expect(resolve.body.outcome).toBe("refused_partial_effect_pending")

      const successor = { action: "retry", target_state: "dlq_pending_ops_review", expected_version: 2 }
      expect((await call("propose", "dlq_entry", id, successor)).statusCode).toBe(201)
      const s = await call("approve", "dlq_entry", id, successor)
      expect(s.statusCode).toBe(200)
      expect(s.body).toEqual(expect.objectContaining({ outcome: "applied", record: { state: "dlq_pending_ops_review", version: 3 } }))
      // Następca nie wykonuje ponownie skutku domenowego.
      expect(await effects(id)).toHaveLength(1)
      const after = await call("propose", "dlq_entry", id, {
        action: "resolve",
        target_state: "discarded_with_evidence",
        expected_version: 3,
        evidence: { kind: "written_off_with_approval", reference: "INC-11-3-0003" },
      })
      expect(after.statusCode).toBe(201)
    })
  })

  describe("R-2 — klucz intencji z celem i konflikt treści", () => {
    it("propose tego samego celu z innym evidence ⇒ 409 refused_idempotency_payload_mismatch; inny cel = osobna propozycja i droga do zamierzonego rozwiązania", async () => {
      const id = ditId(MKT_A, "3")
      const wrongTarget = {
        action: "resolve",
        target_state: "issued_after_link",
        expected_version: 1,
        evidence: { kind: "entitlement_issued", reference: `pi_dit_${MKT_A}_3` },
      }
      expect((await call("propose", "deferred_issuance_trace", id, wrongTarget)).statusCode).toBe(201)
      const intended = {
        action: "resolve",
        target_state: "closed_order_never_created",
        expected_version: 1,
        evidence: { kind: "written_off_with_approval", reference: "INC-11-3-0004" },
      }
      expect((await call("propose", "deferred_issuance_trace", id, intended)).statusCode).toBe(201)
      const mismatch = await call("propose", "deferred_issuance_trace", id, { ...intended, evidence: { kind: "written_off_with_approval", reference: "INC-11-3-9999" } })
      expect(mismatch.statusCode).toBe(409)
      expect(mismatch.body.outcome).toBe("refused_idempotency_payload_mismatch")
      const same = await call("propose", "deferred_issuance_trace", id, intended)
      expect(same.statusCode).toBe(200)
      expect(same.body.outcome).toBe("replayed")

      const a = await call("approve", "deferred_issuance_trace", id, { action: "resolve", target_state: "closed_order_never_created", expected_version: 1 })
      expect(a.statusCode).toBe(200)
      expect(a.body.outcome).toBe("applied")
      const row = await admin.query("SELECT state, resolution_evidence->>'reference' AS ref FROM deferred_issuance_trace WHERE trace_id = $1", [id])
      expect(row.rows[0]).toEqual({ state: "closed_order_never_created", ref: "INC-11-3-0004" })
      // R-9 (runda fix 2): approve INNEGO celu tej samej intencji po zastosowanym approve ⇒ 409, nie `replayed`.
      const second = await call("approve", "deferred_issuance_trace", id, { action: "resolve", target_state: "issued_after_link", expected_version: 1 })
      expect(second.statusCode).toBe(409)
      expect(second.body).toEqual(expect.objectContaining({ outcome: "refused_idempotency_payload_mismatch", domain_effects: 0 }))
      // Ta sama treść ⇒ `replayed` (200), bez drugiego skutku.
      const same2 = await call("approve", "deferred_issuance_trace", id, { action: "resolve", target_state: "closed_order_never_created", expected_version: 1 })
      expect(same2.statusCode).toBe(200)
      expect(same2.body).toEqual(expect.objectContaining({ outcome: "replayed", domain_effects: 0 }))
      const after = await admin.query("SELECT state, version, resolution_evidence->>'reference' AS ref FROM deferred_issuance_trace WHERE trace_id = $1", [id])
      expect(after.rows[0]).toEqual({ state: "closed_order_never_created", version: 2, ref: "INC-11-3-0004" })
      const s = await steps(id)
      expect(s.slice(-2).map((x) => [x.step, x.outcome, x.step_key])).toEqual([
        ["approve", "refused_idempotency_payload_mismatch", null],
        ["approve", "replayed", null],
      ])
    })
  })

  describe("AC-4 — idempotencja, konflikt, cross-market", () => {
    it("approve bez propozycji ⇒ 409 refused_proposal_missing, bez skutku", async () => {
      const a = await call("approve", "compensation_failure", cfId(MKT_A, "2"), { action: "retry", target_state: "recovery_in_progress", expected_version: 1 })
      expect(a.statusCode).toBe(409)
      expect(a.body.outcome).toBe("refused_proposal_missing")
      const row = await admin.query("SELECT version FROM money_path_compensation_failure WHERE failure_id = $1", [cfId(MKT_A, "2")])
      expect(row.rows[0].version).toBe(1)
    })

    it("approve innego aktora niż propozycja ⇒ 403 refused_proposal_actor_mismatch", async () => {
      const body = { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }
      expect((await call("propose", "compensation_failure", cfId(MKT_A, "2"), body)).statusCode).toBe(201)
      const a = await call("approve", "compensation_failure", cfId(MKT_A, "2"), body, { actor: OTHER_ACTOR })
      expect(a.statusCode).toBe(403)
      expect(a.body.outcome).toBe("refused_proposal_actor_mismatch")
    })

    it("równoległy approve tej samej intencji ⇒ jeden skutek + replayed", async () => {
      const body = { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }
      const [x, y] = await Promise.all([
        call("approve", "compensation_failure", cfId(MKT_A, "2"), body),
        call("approve", "compensation_failure", cfId(MKT_A, "2"), body),
      ])
      expect([x.body.outcome, y.body.outcome].sort()).toEqual(["applied", "replayed"])
      const row = await admin.query("SELECT version, retry_count FROM money_path_compensation_failure WHERE failure_id = $1", [cfId(MKT_A, "2")])
      expect(row.rows[0]).toEqual({ version: 2, retry_count: 1 })
      // R-1: równoległe approve tej samej intencji wywołuje adapter dokładnie raz.
      expect(await effects(cfId(MKT_A, "2"))).toHaveLength(1)
    })

    it("równoległe RÓŻNE intencje na tej samej wersji (CAS) ⇒ jedna applied, druga jawny 409", async () => {
      const id = cfId(MKT_A, "3")
      const retry = { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }
      const resolve = { action: "resolve", target_state: "closed_unrecoverable", expected_version: 1 }
      expect((await call("propose", "compensation_failure", id, retry)).statusCode).toBe(201)
      expect(
        (await call("propose", "compensation_failure", id, { ...resolve, evidence: { kind: "written_off_with_approval", reference: "INC-11-3-0002" } })).statusCode
      ).toBe(201)
      const [x, y] = await Promise.all([
        call("approve", "compensation_failure", id, retry),
        call("approve", "compensation_failure", id, resolve),
      ])
      expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409])
      expect([x.body.outcome, y.body.outcome].sort()).toEqual(["applied", "refused_version_conflict"])
      const row = await admin.query("SELECT version FROM money_path_compensation_failure WHERE failure_id = $1", [id])
      expect(row.rows[0].version).toBe(2)
    })

    it("aktor rynku A na rynku B ⇒ 403 recovery_market_forbidden; wiersz B nietknięty", async () => {
      const r = await call("propose", "compensation_failure", cfId(MKT_B, "1"), { action: "retry", target_state: "recovery_in_progress", expected_version: 1 }, { market: MKT_B })
      expect(r.statusCode).toBe(403)
      expect(r.body.code).toBe("recovery_market_forbidden")
      const row = await admin.query("SELECT resolution_state, version FROM money_path_compensation_failure WHERE failure_id = $1", [cfId(MKT_B, "1")])
      expect(row.rows[0]).toEqual({ resolution_state: "open", version: 1 })
    })

    it("wiersz rynku B przez kontekst rynku A ⇒ 404 (RLS nie oddaje wiersza)", async () => {
      const r = await call("propose", "compensation_failure", cfId(MKT_B, "1"), { action: "retry", target_state: "recovery_in_progress", expected_version: 1 })
      expect(r.statusCode).toBe(404)
    })
  })

  it("AC-1: odczyt 4.7 po akcjach — populacja nie zawiera wierszy terminalnych", async () => {
    const r = res()
    await handleRecoveryRead({ auth_context: { actor_id: ACTOR, actor_type: "user" }, query: { market_id: MKT_A }, headers: {}, scope: container } as never, r as never)
    expect(r.statusCode).toBe(200)
    const ids = (r.body.populations.compensation_failure as Array<{ population_id: string }>).map((x) => x.population_id)
    expect(ids).not.toContain(cfId(MKT_A, "1"))
  })
})
