/**
 * v1.16.0 Story 4.2 (AC1, AC2) — migracja `money_path_compensation_failure`
 * na REALNYM PostgreSQL (baza `*_test`, np. `gp_story_4_2_test`).
 *
 * SQL pochodzi z klas migracji (`addSql`), nie z kopii. Suita:
 *   - zakłada tabelę 3.5 z wierszami zastanymi i wykonuje migrację 4.2,
 *   - sprawdza NOT NULL, brak DEFAULT stanu, CHECK enumu, kwarantannę D-35 p.9,
 *   - sprawdza writer runtime (nowe kolumny, `instance_id` z GP_INSTANCE_ID),
 *   - sprawdza RLS `market_isolation` rolą `medusa_store` (bez BYPASSRLS),
 *   - wykonuje down/up zgodnie z planem wycofania ADR-221 + ADR-238.
 * Na końcu baza zostaje w schemacie 4.2.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import {
  LEGACY_BACKFILL_STATE,
  LEGACY_INSTANCE_ID_BACKFILL_SOURCE,
  Migration20261114120000MoneyPathCompensationFailureRecoveryColumns,
} from "../../migrations/Migration20261114120000MoneyPathCompensationFailureRecoveryColumns"
import {
  buildPurchaseCorrelationKey,
  CompensationFailureInstanceUnconfiguredError,
  recordCompensationFailure,
  type CompensationFailureRecord,
} from "../../lib/payment/money-path-compensation-registry"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const INSTANCE = "gp-test-4-2"
const TABLE = "money_path_compensation_failure"
const QUARANTINE = `${TABLE}_backfill_quarantine`

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

async function runInTx(client: PoolClient, statements: string[]): Promise<void> {
  await client.query("BEGIN")
  try {
    for (const sql of statements) await client.query(sql)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

function record(overrides: Partial<CompensationFailureRecord> = {}): CompensationFailureRecord {
  return {
    market_id: "bonbeauty",
    compensation_kind: "webhook_delivery_release",
    delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    stripe_event_id: "evt_pg_4_2",
    payment_intent_id: "pi_pg_4_2",
    order_id: "order_pg_4_2_a",
    purchase_correlation_key: buildPurchaseCorrelationKey("pi_pg_4_2"),
    failure_code: "delivery_release_failed",
    failure_detail: "PG: connection terminated during DELETE",
    ...overrides,
  }
}

const LEGACY_INSERT = `
  INSERT INTO ${TABLE}
    (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id,
     payment_intent_id, order_id, purchase_correlation_key, failure_code, failure_detail,
     resolution_state, resolved_at, resolved_by)
  VALUES ($1, $2, 'webhook_delivery_release', 'stripe_payment_intent_webhook', $3,
          'pi_legacy', NULL, 'purchase:pi_legacy', 'delivery_release_failed', 'legacy', $4, $5, $6)`

async function seedLegacy(client: PoolClient): Promise<void> {
  await client.query(LEGACY_INSERT, ["legacy_open", "bonbeauty", "evt_legacy_1", "open", null, null])
  await client.query(LEGACY_INSERT, [
    "legacy_resolved", "bongarden", "evt_legacy_2", "resolved_manually", "2026-08-20T10:00:00Z", "robert@bonbeauty",
  ])
}

async function resetToLegacySchema(client: PoolClient): Promise<void> {
  for (const sql of await collect(Migration20261114120000MoneyPathCompensationFailureRecoveryColumns, "down")) {
    await client.query(sql).catch(() => undefined)
  }
  await client.query(`DROP TABLE IF EXISTS ${QUARANTINE}`)
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`)
  await runInTx(client, await collect(Migration20260818090000MoneyPathCompensationFailureTable, "up"))
}

async function migrateUp(client: PoolClient, instanceId: string | undefined): Promise<void> {
  const previous = process.env.GP_INSTANCE_ID
  if (instanceId === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = instanceId
  try {
    await runInTx(client, await collect(Migration20261114120000MoneyPathCompensationFailureRecoveryColumns, "up"))
  } finally {
    if (previous === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = previous
  }
}

describe("Story 4.2 — migracja tabeli porażek kompensacji na realnym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 4.2: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
      expect(enabled).toBe(false)
    })
    return
  }

  let pool: Pool
  let client: PoolClient
  let migratedFrom: Date
  let migratedTo: Date

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    client = await pool.connect()
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 4.2: odmowa — baza '${db.rows[0]?.name}' nie jest *_test`)
    }
    await resetToLegacySchema(client)
    await seedLegacy(client)
    migratedFrom = (await client.query<{ t: Date }>("SELECT now() AS t")).rows[0].t
    await migrateUp(client, INSTANCE)
    migratedTo = (await client.query<{ t: Date }>("SELECT now() AS t")).rows[0].t
  })

  afterAll(async () => {
    await client?.query(`DELETE FROM ${TABLE} WHERE failure_id NOT LIKE 'legacy_%'`).catch(() => undefined)
    client?.release()
    await pool?.end()
  })

  it("AC1: instance_id, owner i termin istnieją i są NOT NULL; resolution_state bez DEFAULT", async () => {
    const cols = await client.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE]
    )
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]))
    for (const col of ["instance_id", "owner_type", "owner_id", "deadline", "closure_path", "provenance_kind", "provenance_source"]) {
      expect({ col, nullable: byName.get(col)?.is_nullable }).toEqual({ col, nullable: "NO" })
    }
    expect(byName.get("resolution_state")?.is_nullable).toBe("NO")
    expect(byName.get("resolution_state")?.column_default).toBeNull()
  })

  it("AC1: wiersze zastane są w kwarantannie z jawnym stanem backfillu, ops-recovery, terminem +24 h i nazwanym źródłem instance_id", async () => {
    const main = await client.query(`SELECT failure_id FROM ${TABLE} WHERE failure_id LIKE 'legacy_%'`)
    expect(main.rowCount).toBe(0)
    const q = await client.query<{
      source_failure_id: string; market_id: string; instance_id: string; instance_id_source: string
      backfill_state: string; owner_type: string; owner_id: string; deadline: Date; quarantined_at: Date
      source_row: Record<string, unknown>
    }>(`SELECT * FROM ${QUARANTINE} ORDER BY source_failure_id`)
    expect(q.rows.map((r) => r.source_failure_id)).toEqual(["legacy_open", "legacy_resolved"])
    for (const row of q.rows) {
      expect(row.backfill_state).toBe(LEGACY_BACKFILL_STATE)
      expect(row.owner_type).toBe("operator_role")
      expect(row.owner_id).toBe("ops-recovery")
      expect(row.instance_id).toBe(INSTANCE)
      expect(row.instance_id_source).toBe(LEGACY_INSTANCE_ID_BACKFILL_SOURCE)
      const deadline = new Date(row.deadline).getTime()
      expect(deadline).toBeGreaterThanOrEqual(new Date(migratedFrom).getTime() + 24 * 3600 * 1000)
      expect(deadline).toBeLessThanOrEqual(new Date(migratedTo).getTime() + 24 * 3600 * 1000)
      expect(row.source_row.failure_id).toBe(row.source_failure_id)
    }
    expect(q.rows.map((r) => r.market_id)).toEqual(["bonbeauty", "bongarden"])
  })

  it("AC1: INSERT nowego wiersza bez instance_id / ownera / terminu jest odrzucony przez bazę", async () => {
    const base = `INSERT INTO ${TABLE} (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id,
      payment_intent_id, purchase_correlation_key, failure_code, failure_detail, resolution_state,
      instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind, provenance_source)
      VALUES ('nn_probe', 'bonbeauty', 'webhook_delivery_release', 'p', 'e', 'pi', 'k', 'c', 'd', 'open',
      $1, $2, $3, $4::timestamptz, 'not_closed', 'runtime_writer', 'env:GP_INSTANCE_ID')`
    const future = new Date(Date.now() + 3600_000).toISOString()
    await expect(client.query(base, [null, "operator_role", "ops-recovery", future])).rejects.toThrow(/null value in column "instance_id"/)
    await expect(client.query(base, [INSTANCE, null, "ops-recovery", future])).rejects.toThrow(/null value in column "owner_type"/)
    await expect(client.query(base, [INSTANCE, "operator_role", null, future])).rejects.toThrow(/null value in column "owner_id"/)
    await expect(client.query(base, [INSTANCE, "operator_role", "ops-recovery", null])).rejects.toThrow(/null value in column "deadline"/)
  })

  it("AC2: stan spoza enumu odrzucony przez CHECK; brak resolution_state odrzucony (brak DEFAULT)", async () => {
    const insert = (stateSql: string) => `INSERT INTO ${TABLE} (failure_id, market_id, compensation_kind, delivery_path,
      stripe_event_id, payment_intent_id, purchase_correlation_key, failure_code, failure_detail,
      instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind, provenance_source${stateSql ? ", resolution_state" : ""})
      VALUES ('enum_probe', 'bonbeauty', 'webhook_delivery_release', 'p', 'e', 'pi', 'k', 'c', 'd',
      '${INSTANCE}', 'operator_role', 'ops-recovery', now(), 'not_closed', 'runtime_writer', 'x'${stateSql ? `, ${stateSql}` : ""})`
    await expect(client.query(insert("'nierozstrzygniete'"))).rejects.toThrow(/violates check constraint "money_path_compensation_failure_(state|resolution)_check"/)
    await expect(client.query(insert(""))).rejects.toThrow(/null value in column "resolution_state"/)
    const check = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'money_path_compensation_failure_state_check'`
    )
    for (const state of ["open", "resolved_manually", "recovery_in_progress", "resolved_recovered", "closed_unrecoverable", "closed_legacy_unevidenced"]) {
      expect(check.rows[0].def).toContain(`'${state}'`)
    }
  })

  it("AC1: writer zapisuje nowe kolumny z instance_id z GP_INSTANCE_ID, ownerem ops-recovery i terminem SLA", async () => {
    const previous = process.env.GP_INSTANCE_ID
    process.env.GP_INSTANCE_ID = INSTANCE
    try {
      const written = await recordCompensationFailure(client, record())
      const row = (await client.query(`SELECT *, extract(epoch FROM deadline - occurred_at)::int AS sla_seconds FROM ${TABLE} WHERE failure_id = $1`, [written.failure_id])).rows[0]
      expect(row.instance_id).toBe(INSTANCE)
      expect(row.owner_type).toBe("operator_role")
      expect(row.owner_id).toBe("ops-recovery")
      expect(row.sla_seconds).toBe(24 * 3600)
      expect(row.closure_path).toBe("not_closed")
      expect(row.provenance_kind).toBe("runtime_writer")
      expect(row.provenance_source).toBe("env:GP_INSTANCE_ID")
      expect(row.resolution_state).toBe("open")
    } finally {
      if (previous === undefined) delete process.env.GP_INSTANCE_ID
      else process.env.GP_INSTANCE_ID = previous
    }
  })

  it("AC1: writer bez GP_INSTANCE_ID odmawia (fail-closed) i nie zapisuje wiersza", async () => {
    const previous = process.env.GP_INSTANCE_ID
    delete process.env.GP_INSTANCE_ID
    try {
      await expect(recordCompensationFailure(client, record({ order_id: "order_no_instance" }))).rejects.toBeInstanceOf(
        CompensationFailureInstanceUnconfiguredError
      )
    } finally {
      if (previous !== undefined) process.env.GP_INSTANCE_ID = previous
    }
    const rows = await client.query(`SELECT 1 FROM ${TABLE} WHERE order_id = 'order_no_instance'`)
    expect(rows.rowCount).toBe(0)
  })

  it("AC1: RLS market_isolation — rola runtime bez BYPASSRLS widzi tylko swój rynek i nie zapisze cudzego", async () => {
    const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'medusa_store'"
    )
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false })
    const rel = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname",
      [[TABLE, QUARANTINE]]
    )
    expect(rel.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true)
    const policies = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_policies WHERE policyname = 'market_isolation' AND tablename = ANY($1)",
      [[TABLE, QUARANTINE]]
    )
    expect(policies.rows.map((r) => r.tablename).sort()).toEqual([TABLE, QUARANTINE].sort())

    const previous = process.env.GP_INSTANCE_ID
    process.env.GP_INSTANCE_ID = INSTANCE
    // Wiersz innego rynku zapisany poza RLS (superuser) — runtime nie może go zobaczyć.
    const foreign = await recordCompensationFailure(client, record({ market_id: "bongarden", order_id: "order_foreign" }))
    await client.query("BEGIN")
    try {
      await client.query("SET LOCAL ROLE medusa_store")
      await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [INSTANCE])
      await client.query("SELECT set_config('app.gp_market_id', $1, true)", ["bonbeauty"])
      const own = await recordCompensationFailure(client, record({ order_id: "order_rls_own" }))
      const visible = await client.query<{ failure_id: string; market_id: string }>(`SELECT failure_id, market_id FROM ${TABLE}`)
      expect(visible.rows.map((r) => r.failure_id)).toContain(own.failure_id)
      expect(visible.rows.map((r) => r.failure_id)).not.toContain(foreign.failure_id)
      expect(new Set(visible.rows.map((r) => r.market_id))).toEqual(new Set(["bonbeauty"]))
      const quarantine = await client.query<{ market_id: string }>(`SELECT market_id FROM ${QUARANTINE}`)
      expect(quarantine.rows.map((r) => r.market_id)).toEqual(["bonbeauty"])
      await client.query("SAVEPOINT cross_market")
      await expect(
        recordCompensationFailure(client, record({ market_id: "bongarden", order_id: "order_rls_cross" }))
      ).rejects.toThrow(/row-level security/)
      await client.query("ROLLBACK TO SAVEPOINT cross_market")
      await client.query("SELECT set_config('app.gp_instance_id', $1, true)", ["other-instance"])
      const otherInstance = await client.query(`SELECT 1 FROM ${TABLE}`)
      expect(otherInstance.rowCount).toBe(0)
    } finally {
      await client.query("ROLLBACK")
      if (previous === undefined) delete process.env.GP_INSTANCE_ID
      else process.env.GP_INSTANCE_ID = previous
    }
  })

  it("AC2: down zgodny z planem wycofania (ADR-221/ADR-238) odtwarza wiersze zastane, a up znowu je kwarantannuje", async () => {
    await client.query(`DELETE FROM ${TABLE}`)
    // Wycofanie odmawia, gdy istnieje stan bez reprezentacji w schemacie legacy.
    await client.query(
      `INSERT INTO ${TABLE} (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id, payment_intent_id,
        purchase_correlation_key, failure_code, failure_detail, resolution_state, instance_id, owner_type, owner_id,
        deadline, closure_path, provenance_kind, provenance_source)
       VALUES ('runtime_state', 'bonbeauty', 'webhook_delivery_release', 'p', 'e', 'pi', 'k', 'c', 'd',
        'recovery_in_progress', $1, 'operator_role', 'ops-recovery', now(), 'not_closed', 'runtime_writer', 'x')`,
      [INSTANCE]
    )
    const down = await collect(Migration20261114120000MoneyPathCompensationFailureRecoveryColumns, "down")
    await expect(runInTx(client, down)).rejects.toThrow(/rollback refused/)
    await client.query(`DELETE FROM ${TABLE}`)

    await runInTx(client, down)
    expect((await client.query("SELECT to_regclass($1) AS t", [QUARANTINE])).rows[0].t).toBeNull()
    const restored = await client.query<{ failure_id: string; resolution_state: string; resolved_by: string | null }>(
      `SELECT failure_id, resolution_state, resolved_by FROM ${TABLE} ORDER BY failure_id`
    )
    expect(restored.rows).toEqual([
      { failure_id: "legacy_open", resolution_state: "open", resolved_by: null },
      { failure_id: "legacy_resolved", resolution_state: "resolved_manually", resolved_by: "robert@bonbeauty" },
    ])
    const cols = await client.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE]
    )
    const names = cols.rows.map((r) => r.column_name)
    for (const col of ["instance_id", "owner_type", "owner_id", "deadline", "provenance_kind"]) expect(names).not.toContain(col)
    expect(cols.rows.find((r) => r.column_name === "resolution_state")?.column_default).toMatch(/'open'/)
    const check = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'money_path_compensation_failure_state_check'`
    )
    expect(check.rows[0].def).not.toContain("recovery_in_progress")

    // Brak nazwanego źródła instance_id przy wierszach zastanych = migracja przerywa się.
    await expect(migrateUp(client, undefined)).rejects.toThrow(/require GP_INSTANCE_ID/)
    expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(2)

    await migrateUp(client, INSTANCE)
    expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(0)
    expect((await client.query(`SELECT count(*)::int AS n FROM ${QUARANTINE}`)).rows[0].n).toBe(2)
  })
})
