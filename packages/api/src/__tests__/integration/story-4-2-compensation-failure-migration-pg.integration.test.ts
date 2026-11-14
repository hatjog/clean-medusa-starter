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
import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import {
  CLOSE_QUARANTINED_COMPENSATION_FAILURE_SQL,
  LEGACY_BACKFILL_CLOSED_STATE,
  LEGACY_BACKFILL_STATE,
  LEGACY_INSTANCE_ID_BACKFILL_SOURCE,
  Migration20261114120000MoneyPathCompensationFailureRecoveryColumns,
} from "../../migrations/Migration20261114120000MoneyPathCompensationFailureRecoveryColumns"
import {
  buildCompensationFailureId,
  buildPurchaseCorrelationKey,
  CompensationFailureInstanceUnconfiguredError,
  findOpenCompensationFailures,
  recordCompensationFailure,
  type CompensationFailureRecord,
} from "../../lib/payment/money-path-compensation-registry"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"
import { LiteValidator, type JsonSchema } from "../contracts/json-schema-lite"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const INSTANCE = "gp-test-4-2"
const TABLE = "money_path_compensation_failure"
const QUARANTINE = `${TABLE}_backfill_quarantine`

// packages/api/src/__tests__/integration -> GP/backend -> GP -> <repo root>
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const POPULATION_SCHEMA = "recovery-population.v1.schema.json"
const populationSchema = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "specs/contracts/recovery/schemas", POPULATION_SCHEMA), "utf8")
) as JsonSchema
const PROVENANCE_PROBE = "provenance-probe.json"
const contractValidator = new LiteValidator({
  [POPULATION_SCHEMA]: populationSchema,
  [PROVENANCE_PROBE]: { $ref: `${POPULATION_SCHEMA}#/$defs/provenance` },
})
/** Naruszenia `$defs.provenance` kontraktu v1 dla pary kolumn wiersza (pusta = zgodne). */
const provenanceViolations = (row: { provenance_kind: unknown; provenance_source: unknown }) =>
  contractValidator.validate(PROVENANCE_PROBE, { kind: row.provenance_kind, source: row.provenance_source })

// Ponowny provisioning = szerokie granty 003 + końcowy guard least privilege.
const provisioningSql = fs.readFileSync(
  path.join(REPO_ROOT, "infra/postgres/migrations/003-rls-market-isolation.sql"),
  "utf8"
)
const reprovisioning = provisioningSql.match(
  /GRANT USAGE ON SCHEMA public TO medusa_store;[\s\S]*?protected_table[\s\S]*?\n\$\$;/
)?.[0]

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const

async function runtimePrivileges(client: PoolClient, table: string): Promise<string[]> {
  const granted: string[] = []
  for (const privilege of PRIVILEGES) {
    const r = await client.query<{ ok: boolean }>("SELECT has_table_privilege('medusa_store', $1, $2) AS ok", [
      `public.${table}`,
      privilege,
    ])
    if (r.rows[0].ok) granted.push(privilege)
  }
  return granted
}

async function tableOwner(client: PoolClient, table: string): Promise<string> {
  const r = await client.query<{ owner: string }>(
    "SELECT r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = to_regclass($1)",
    [`public.${table}`]
  )
  return r.rows[0].owner
}

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
      $1, $2, $3, $4::timestamptz, 'not_closed', 'runtime_observed', 'money-path-compensation-registry')`
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
      '${INSTANCE}', 'operator_role', 'ops-recovery', now(), 'not_closed', 'runtime_observed', 'x'${stateSql ? `, ${stateSql}` : ""})`
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
      // R-1: wiersz writera waliduje się względem `$defs.provenance` kontraktu v1
      // (enum [runtime_observed, backfilled_verified]; source = nazwa producenta).
      expect(provenanceViolations(row)).toEqual([])
      expect(row.provenance_kind).toBe("runtime_observed")
      expect(row.provenance_source).toBe("money-path-compensation-registry")
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

  it("R-1: provenance_kind spoza słownika kontraktu v1 jest odrzucony przez CHECK i przez walidator schematu", async () => {
    expect(provenanceViolations({ provenance_kind: "runtime_writer", provenance_source: "money-path-compensation-registry" })).not.toEqual([])
    expect(provenanceViolations({ provenance_kind: "runtime_observed", provenance_source: "money-path-compensation-registry" })).toEqual([])
    const check = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'money_path_compensation_failure_provenance_kind_check'`
    )
    const allowed = [...check.rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    const contractEnum = (populationSchema.$defs as Record<string, { properties: { kind: { enum: string[] } } }>).provenance
      .properties.kind.enum
    expect(allowed).toEqual([...contractEnum].sort())
    await expect(
      client.query(
        `INSERT INTO ${TABLE} (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id,
          payment_intent_id, purchase_correlation_key, failure_code, failure_detail, resolution_state,
          instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind, provenance_source)
         VALUES ('prov_probe', 'bonbeauty', 'webhook_delivery_release', 'p', 'e', 'pi', 'k', 'c', 'd', 'open',
          $1, 'operator_role', 'ops-recovery', now(), 'not_closed', 'runtime_writer', 'money-path-compensation-registry')`,
        [INSTANCE]
      )
    ).rejects.toThrow(/money_path_compensation_failure_provenance_kind_check/)
  })

  it("R-3/R-4: otwarta porażka zastana w kwarantannie nadal jest widoczna dla odczytu webhooka; rozwiązana nie", async () => {
    const open = await findOpenCompensationFailures(client, {
      delivery_path: "stripe_payment_intent_webhook",
      stripe_event_id: "evt_legacy_1",
    })
    expect(open).toEqual([{ failure_id: "legacy_open", attempt_count: 1, order_id: null }])
    const resolved = await findOpenCompensationFailures(client, {
      delivery_path: "stripe_payment_intent_webhook",
      stripe_event_id: "evt_legacy_2",
    })
    expect(resolved).toEqual([])
  })

  it("Fix 2 D-31: sekwencja pod medusa_store — kwarantanna open → ponowienie bez duplikatu → resolved_manually odblokowuje; zamknięcie ops-recovery odblokowuje", async () => {
    const MIGRATOR = "gp_runtime_recovery_migrator"
    const retried = record({ stripe_event_id: "evt_seq_retry", order_id: "order_seq_retry" })
    const closed = record({ stripe_event_id: "evt_seq_closed", order_id: "order_seq_closed" })
    const retriedId = buildCompensationFailureId(retried)
    const closedId = buildCompensationFailureId(closed)
    const find = (stripe_event_id: string) =>
      findOpenCompensationFailures(client, { delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER, stripe_event_id })
    const asRuntime = async () => {
      await client.query("RESET ROLE")
      await client.query("SET LOCAL ROLE medusa_store")
      await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [INSTANCE])
      await client.query("SELECT set_config('app.gp_market_id', $1, true)", ["bonbeauty"])
    }
    const previous = process.env.GP_INSTANCE_ID
    process.env.GP_INSTANCE_ID = INSTANCE
    await client.query("BEGIN")
    try {
      // Wiersze zastane `open` w kwarantannie z deterministycznym failure_id writera
      // (kształt wiersza po cf-backfill; zapis superuserem = migracja).
      for (const [id, rec] of [[retriedId, retried], [closedId, closed]] as const) {
        await client.query(
          `INSERT INTO ${QUARANTINE} (source_failure_id, source_row, reason, market_id, instance_id,
             instance_id_source, backfill_state, owner_type, owner_id, deadline)
           VALUES ($1, $2::jsonb, 'test', 'bonbeauty', $3, $4, $5, 'operator_role', 'ops-recovery', now() + interval '24 hours')`,
          [
            id,
            JSON.stringify({ failure_id: id, delivery_path: rec.delivery_path, stripe_event_id: rec.stripe_event_id,
              order_id: rec.order_id, attempt_count: 1, resolution_state: "open" }),
            INSTANCE,
            LEGACY_INSTANCE_ID_BACKFILL_SOURCE,
            LEGACY_BACKFILL_STATE,
          ]
        )
      }
      await asRuntime()
      expect(await find("evt_seq_retry")).toEqual([{ failure_id: retriedId, attempt_count: 1, order_id: "order_seq_retry" }])

      // Ponowienie: writer zapisuje wiersz populacji z tym samym failure_id.
      const written = await recordCompensationFailure(client, retried)
      expect(written.failure_id).toBe(retriedId)
      const afterRetry = await find("evt_seq_retry")
      expect(afterRetry.map((r) => r.failure_id)).toEqual([retriedId])

      // Operator rozwiązuje wiersz populacji — dostawa odblokowana.
      await client.query(
        `UPDATE ${TABLE} SET resolution_state = 'resolved_manually', resolved_at = now(), resolved_by = 'ops@test'
          WHERE failure_id = $1`,
        [retriedId]
      )
      expect(await find("evt_seq_retry")).toEqual([])

      // Zamknięcie wiersza kwarantanny: medusa_store nie może, ops-recovery (migrator) może.
      expect(await find("evt_seq_closed")).toHaveLength(1)
      await client.query("SAVEPOINT runtime_close")
      await expect(
        client.query(CLOSE_QUARANTINED_COMPENSATION_FAILURE_SQL, [closedId, "ops@test", JSON.stringify({ ticket: "T-1" })])
      ).rejects.toThrow(/permission denied/)
      await client.query("ROLLBACK TO SAVEPOINT runtime_close")
      await client.query("RESET ROLE")
      await client.query(`SET LOCAL ROLE ${MIGRATOR}`)
      const closure = await client.query(CLOSE_QUARANTINED_COMPENSATION_FAILURE_SQL, [
        closedId, "ops@test", JSON.stringify({ ticket: "T-1" }),
      ])
      expect(closure.rows.map((r) => [r.source_failure_id, r.backfill_state])).toEqual([[closedId, LEGACY_BACKFILL_CLOSED_STATE]])
      // Przejście jednokrotne: drugi raz zero wierszy.
      const again = await client.query(CLOSE_QUARANTINED_COMPENSATION_FAILURE_SQL, [closedId, "ops@test", "{}"])
      expect(again.rowCount).toBe(0)
      await asRuntime()
      expect(await find("evt_seq_closed")).toEqual([])
      // Fakt nie jest kasowany: wiersz i zamrożony source_row zostają.
      const kept = await client.query<{ backfill_state: string; state: string }>(
        `SELECT backfill_state, source_row->>'resolution_state' AS state FROM ${QUARANTINE} WHERE source_failure_id = $1`,
        [closedId]
      )
      expect(kept.rows).toEqual([{ backfill_state: LEGACY_BACKFILL_CLOSED_STATE, state: "open" }])
    } finally {
      await client.query("ROLLBACK")
      if (previous === undefined) delete process.env.GP_INSTANCE_ID
      else process.env.GP_INSTANCE_ID = previous
    }
  })

  it("Fix 2 D-31: stan terminalny kwarantanny wymaga closed_at/closed_by/dowodu (CHECK)", async () => {
    await client.query("BEGIN")
    try {
      await expect(
        client.query(`UPDATE ${QUARANTINE} SET backfill_state = $1 WHERE source_failure_id = 'legacy_open'`, [
          LEGACY_BACKFILL_CLOSED_STATE,
        ])
      ).rejects.toThrow(/mpcf_backfill_quarantine_closure_check/)
    } finally {
      await client.query("ROLLBACK")
    }
  })

  it("R-2: ponowny provisioning 003 przywraca least privilege obu tabel 4.2 (idempotentnie)", async () => {
    expect(reprovisioning).toBeDefined()
    await client.query("BEGIN")
    try {
      await client.query(reprovisioning!)
      await client.query(reprovisioning!)
      expect(await runtimePrivileges(client, TABLE)).toEqual(["SELECT", "INSERT", "UPDATE"])
      expect(await runtimePrivileges(client, QUARANTINE)).toEqual(["SELECT"])
    } finally {
      await client.query("ROLLBACK")
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
        'recovery_in_progress', $1, 'operator_role', 'ops-recovery', now(), 'not_closed', 'runtime_observed', 'x')`,
      [INSTANCE]
    )
    const down = await collect(Migration20261114120000MoneyPathCompensationFailureRecoveryColumns, "down")
    await expect(runInTx(client, down)).rejects.toThrow(/rollback refused/)
    await client.query(`DELETE FROM ${TABLE}`)

    // Wiersz kwarantanny zamknięty przez ops-recovery wraca w down jako resolved_manually.
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE gp_runtime_recovery_migrator")
    const closedLegacy = await client.query(CLOSE_QUARANTINED_COMPENSATION_FAILURE_SQL, [
      "legacy_open", "ops@test", JSON.stringify({ ticket: "T-down" }),
    ])
    await client.query("COMMIT")
    expect(closedLegacy.rowCount).toBe(1)

    await runInTx(client, down)
    expect((await client.query("SELECT to_regclass($1) AS t", [QUARANTINE])).rows[0].t).toBeNull()
    const restored = await client.query<{ failure_id: string; resolution_state: string; resolved_by: string | null }>(
      `SELECT failure_id, resolution_state, resolved_by FROM ${TABLE} ORDER BY failure_id`
    )
    expect(restored.rows).toEqual([
      { failure_id: "legacy_open", resolution_state: "resolved_manually", resolved_by: "ops@test" },
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
    // R-5: down przywraca uprawnienia sprzed 4.2 — właściciel = wykonawca migracji,
    // runtime z szerokimi grantami 003 i bez RLS; medusa_store czyta tabelę.
    const executor = (await client.query<{ u: string }>("SELECT current_user AS u")).rows[0].u
    expect(await tableOwner(client, TABLE)).toBe(executor)
    expect(await runtimePrivileges(client, TABLE)).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"])
    const rls = await client.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass($1)", [TABLE])
    expect(rls.rows[0].relrowsecurity).toBe(false)
    await client.query("BEGIN")
    try {
      await client.query("SET LOCAL ROLE medusa_store")
      expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(2)
    } finally {
      await client.query("ROLLBACK")
    }

    // Brak nazwanego źródła instance_id przy wierszach zastanych = migracja przerywa się.
    await expect(migrateUp(client, undefined)).rejects.toThrow(/require GP_INSTANCE_ID/)
    expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(2)

    await migrateUp(client, INSTANCE)
    expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(0)
    expect((await client.query(`SELECT count(*)::int AS n FROM ${QUARANTINE}`)).rows[0].n).toBe(2)
    expect(await tableOwner(client, TABLE)).toBe("gp_runtime_recovery_migrator")
    expect(await runtimePrivileges(client, TABLE)).toEqual(["SELECT", "INSERT", "UPDATE"])
    expect(await runtimePrivileges(client, QUARANTINE)).toEqual(["SELECT"])
  })
})
