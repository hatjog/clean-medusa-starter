/**
 * v1.16.0 Story 4.3 AC2/AC4 (FR-11, AD-32, AD-48) — runtime alarm populacji
 * `compensation_failure` po terminie na REALNYM PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-4-3-compensation-alarm-pg`
 * Baza: izolowana `gp_story_4_3_test` (stack gp-test, port 55432); odmowa
 * startu na bazie bez sufiksu `_test`.
 *
 * Schemat z klas migracji 3.5 + 4.2 (`addSql`). Odczyt joba idzie rolą
 * `medusa_store` z GUC rynku/instancji (RLS `market_isolation`); termin
 * porównuje baza (`deadline < statement_timestamp()`).
 *  - pusta populacja ⇒ `{ evaluated: true, overdue_count: 0 }` (stan mierzalny),
 *  - kontrola dodatnia: wiersz dowodowy po terminie ⇒ alarm z polami kontraktu,
 *  - wiersz przed terminem, terminalny i obcego rynku ⇒ bez alarmu.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import { Migration20261114120000MoneyPathCompensationFailureRecoveryColumns } from "../../migrations/Migration20261114120000MoneyPathCompensationFailureRecoveryColumns"
import type { AlertDeliveryResult } from "../../lib/alert-channel"
import type { StructuredAlertPayload } from "../../lib/alert-emit"
import type { TraceQueryClient } from "../../lib/recovery/deferred-issuance-trace"
import {
  MARKETS_ENV_VAR,
  runCompensationFailureRecoveryAlarm,
} from "../../jobs/compensation-failure-recovery-alarm"
import { ALERT_CODE_COMPENSATION_FAILURE_OVERDUE } from "../../lib/recovery/recovery-population-adapters"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const INSTANCE = process.env.GP_INSTANCE_ID ?? "gp_test"
const MARKET_A = "mkt_4_3_a"
const MARKET_B = "mkt_4_3_b"

type MigrationCtor = { prototype: object }

async function collect(MigrationClass: MigrationCtor, direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = []
  const migration = Object.create(MigrationClass.prototype) as {
    addSql: (sql: string) => void
    up: () => Promise<void>
    down: () => Promise<void>
  }
  migration.addSql = (sql) => statements.push(sql)
  await migration[direction]()
  return statements
}

function runtimeClient(client: PoolClient, scope: { market_id: string; instance_id: string }): TraceQueryClient {
  return {
    query: async <T,>(sql: string, values: ReadonlyArray<unknown> = []) => {
      await client.query("BEGIN")
      try {
        await client.query("SET LOCAL ROLE medusa_store")
        await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [scope.instance_id])
        await client.query("SELECT set_config('app.gp_market_id', $1, true)", [scope.market_id])
        const result = await client.query(sql, values as unknown[])
        await client.query("COMMIT")
        return { rows: result.rows as T[], rowCount: result.rowCount }
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      }
    },
  }
}

const describeOrNotRun = enabled ? describe : describe.skip

if (!enabled) {
  describe("Story 4.3 — alarm kompensacji po terminie (PG)", () => {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 4.3: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
    })
  })
}

describeOrNotRun("Story 4.3 — alarm kompensacji po terminie (PG)", () => {
  let pool: Pool
  let client: PoolClient

  async function seed(failureId: string, deadlineOffsetSeconds: number, market = MARKET_A, state = "open") {
    await client.query(
      `INSERT INTO money_path_compensation_failure
         (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id, payment_intent_id,
          order_id, purchase_correlation_key, failure_code, failure_detail, resolution_state,
          instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind, provenance_source)
       VALUES ($1, $2, 'webhook_delivery_release', 'stripe_payment_intent_webhook', $3, $4,
               NULL, $5, 'delivery_release_failed', 'story-4-3 evidence row', $6,
               $7, 'operator_role', 'ops-recovery', now() + make_interval(secs => $8::double precision),
               'manual_review', 'runtime_observed', 'story-4-3-pg-test')`,
      [failureId, market, `evt_${failureId}`, `pi_${failureId}`, `purchase:pi_${failureId}`, state, INSTANCE, deadlineOffsetSeconds]
    )
  }

  async function seedQuarantine(failureId: string, deadlineOffsetSeconds: number, market = MARKET_A) {
    await client.query(
      `INSERT INTO money_path_compensation_failure_backfill_quarantine
         (source_failure_id, source_row, reason, market_id, instance_id, instance_id_source,
          backfill_state, owner_type, owner_id, deadline)
       VALUES ($1, jsonb_build_object('failure_id', $1::text, 'resolution_state', 'open'),
               'story-4-3 legacy row', $2, $3, 'GP_INSTANCE_ID',
               'quarantined_pending_review', 'operator_role', 'ops-recovery',
               now() + make_interval(secs => $4::double precision))`,
      [failureId, market, INSTANCE, deadlineOffsetSeconds]
    )
  }

  async function run(alerts: StructuredAlertPayload[], markets = MARKET_A) {
    const delivered: AlertDeliveryResult = { status: "delivered", delivered_via: "webhook", attempts: [{ channel: "webhook", ok: true }] }
    return runCompensationFailureRecoveryAlarm({ resolve: () => { throw new Error("no container") } } as never, {
      env: { [MARKETS_ENV_VAR]: markets, GP_INSTANCE_ID: INSTANCE },
      emit: (p) => alerts.push(p),
      deliver: async () => delivered,
      clientForMarket: (_c, ctx) => runtimeClient(client, ctx),
    })
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    client = await pool.connect()
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 4.3 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
    await client.query("DROP TABLE IF EXISTS money_path_compensation_failure_backfill_quarantine")
    await client.query("DROP TABLE IF EXISTS money_path_compensation_failure")
    for (const sql of await collect(Migration20260818090000MoneyPathCompensationFailureTable, "up")) await client.query(sql)
    for (const sql of await collect(Migration20261114120000MoneyPathCompensationFailureRecoveryColumns, "up")) await client.query(sql)
  })

  afterAll(async () => {
    if (client) {
      await client.query("DROP TABLE IF EXISTS money_path_compensation_failure_backfill_quarantine")
      await client.query("DROP TABLE IF EXISTS money_path_compensation_failure")
      client.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    await client.query("DELETE FROM money_path_compensation_failure")
    await client.query("DELETE FROM money_path_compensation_failure_backfill_quarantine")
  })

  it("AC4: pusta populacja = wykonanie zapisane jako evaluated:true, overdue_count:0", async () => {
    const alerts: StructuredAlertPayload[] = []
    const result = await run(alerts)
    expect(result).toEqual(
      expect.objectContaining({
        evaluated: true,
        overdue_count: 0,
        per_market: [{ market_id: MARKET_A, evaluated: true, overdue_count: 0 }],
        alarms: [],
      })
    )
    expect(alerts).toEqual([])
  })

  it("AC2/AC4 kontrola dodatnia: wiersz dowodowy po terminie ⇒ alarm z polami kontraktu, bez PII", async () => {
    await seed("mpcf_4_3_overdue", -3600)
    await seed("mpcf_4_3_future", 3600)
    await seed("mpcf_4_3_terminal", -3600, MARKET_A, "closed_unrecoverable")
    await seed("mpcf_4_3_other_market", -3600, MARKET_B)
    const alerts: StructuredAlertPayload[] = []
    const result = await run(alerts)
    expect(result.evaluated).toBe(true)
    expect(result.overdue_count).toBe(1)
    expect(alerts).toHaveLength(1)
    const ctx = alerts[0].context as Record<string, unknown>
    expect(alerts[0].code).toBe(ALERT_CODE_COMPENSATION_FAILURE_OVERDUE)
    expect(ctx).toEqual({
      population_type: "compensation_failure",
      source: "compensation_failure",
      failure_id: "mpcf_4_3_overdue",
      instance_id: INSTANCE,
      market_id: MARKET_A,
      owner_type: "operator_role",
      owner_id: "ops-recovery",
      deadline: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      state: "open",
    })
    expect(new Date(ctx.deadline as string).getTime()).toBeLessThan(Date.now())
    // bez PII: brak e-maila, payment_intent i opisu porażki w alarmie
    expect(JSON.stringify(alerts[0])).not.toMatch(/@|pi_mpcf|evidence row/)
  })

  it("RLS: rynek B widzi wyłącznie swój wiersz po terminie", async () => {
    await seed("mpcf_4_3_overdue", -3600)
    await seed("mpcf_4_3_other_market", -3600, MARKET_B)
    const alerts: StructuredAlertPayload[] = []
    const result = await run(alerts, `${MARKET_A},${MARKET_B}`)
    expect(result.per_market).toEqual([
      { market_id: MARKET_A, evaluated: true, overdue_count: 1 },
      { market_id: MARKET_B, evaluated: true, overdue_count: 1 },
    ])
    expect(result.alarms.map((a) => [a.alarm.market_id, a.alarm.failure_id])).toEqual([
      [MARKET_A, "mpcf_4_3_overdue"],
      [MARKET_B, "mpcf_4_3_other_market"],
    ])
  })

  it("fix R2: zastany wiersz kwarantanny 4.2 po terminie ⇒ alarm (source=backfill_quarantine); przed terminem ⇒ brak", async () => {
    await seedQuarantine("mpcf_4_3_legacy_overdue", -3600)
    await seedQuarantine("mpcf_4_3_legacy_future", 3600)
    await seedQuarantine("mpcf_4_3_legacy_other_market", -3600, MARKET_B)
    const alerts: StructuredAlertPayload[] = []
    const result = await run(alerts)
    expect(result.evaluated).toBe(true)
    expect(result.overdue_count).toBe(1)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].code).toBe(ALERT_CODE_COMPENSATION_FAILURE_OVERDUE)
    expect(alerts[0].context).toEqual({
      population_type: "compensation_failure",
      source: "backfill_quarantine",
      failure_id: "mpcf_4_3_legacy_overdue",
      instance_id: INSTANCE,
      market_id: MARKET_A,
      owner_type: "operator_role",
      owner_id: "ops-recovery",
      deadline: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      state: "quarantined_pending_review",
    })
  })

  it("fix R2: kwarantanna tylko przed terminem ⇒ pusta populacja", async () => {
    await seedQuarantine("mpcf_4_3_legacy_future", 3600)
    const alerts: StructuredAlertPayload[] = []
    const result = await run(alerts)
    expect(result.overdue_count).toBe(0)
    expect(alerts).toEqual([])
  })
})
