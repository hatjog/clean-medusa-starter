import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { applyRuntimeRecoveryMigration } from "./story-11-1-runtime-recovery-migration-support"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const unknownFixture = fs.readFileSync(
  path.join(REPO_ROOT, "GP/backend/packages/api/src/__tests__/fixtures/story-11-1-unknown-market.sql"),
  "utf8"
)
const provisioningSql = fs.readFileSync(
  path.join(REPO_ROOT, "infra/postgres/migrations/003-rls-market-isolation.sql"),
  "utf8"
)
const provisioningGuard = provisioningSql.match(/DO \$\$[\s\S]*?protected_table[\s\S]*?\$\$;/)?.[0]

async function configureRuntime(client: PoolClient, instanceId: string, marketId: string): Promise<void> {
  await client.query("SET ROLE medusa_store")
  await client.query("SELECT set_config('app.gp_instance_id', $1, false)", [instanceId])
  await client.query("SELECT set_config('app.gp_market_id', $1, false)", [marketId])
}

async function resetRuntime(client: PoolClient): Promise<void> {
  await client.query("RESET ROLE")
  await client.query("RESET app.gp_instance_id")
  await client.query("RESET app.gp_market_id")
}

describe("Story 11.1 — RLS claim/issuance na rzeczywistym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 RLS: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
      expect(enabled).toBe(false)
    })
    return
  }

  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
    client = await pool.connect()
  })
  afterAll(async () => {
    client?.release()
    await pool?.end()
  })

  it("chroni rzeczywiste tabele, UNKNOWN, globalny replay, współbieżność i rollback", async () => {
    expect(provisioningGuard).toBeDefined()
    await client.query("BEGIN")
    try {
      await applyRuntimeRecoveryMigration(client)
      // DDL migracji trzyma ACCESS EXCLUSIVE lock. Zatwierdzamy ją w izolowanej
      // bazie testowej przed otwarciem dwóch równoległych klientów, żeby test
      // mierzył konflikt dedupe, a nie własną blokadę migracji.
      await client.query("COMMIT")
      await client.query("BEGIN")
      const existingTables = await client.query<{ relname: string }>(
        `SELECT relname FROM pg_class
          WHERE relkind = 'r' AND relname = ANY($1::text[])
          ORDER BY relname`,
        [["event_processed", "voucher_claim_audit", "voucher_claim_binding"]]
      )
      expect(existingTables.rows.map((row) => row.relname)).toEqual([
        "event_processed",
        "voucher_claim_audit",
        "voucher_claim_binding",
      ])

      await client.query(unknownFixture)

      const roles = await client.query<{ rolname: string; rolbypassrls: boolean }>(
        `SELECT rolname, rolbypassrls FROM pg_roles
          WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
        [["gp_runtime_recovery_migrator", "medusa_store"]]
      )
      expect(roles.rows).toEqual([
        { rolname: "gp_runtime_recovery_migrator", rolbypassrls: false },
        { rolname: "medusa_store", rolbypassrls: false },
      ])
      const owners = await client.query<{ relname: string; owner: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
          WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`,
        [["event_processed", "voucher_claim_audit", "voucher_claim_binding"]]
      )
      expect(owners.rows).toEqual([
        expect.objectContaining({ relname: "event_processed", owner: "gp_runtime_recovery_migrator", relrowsecurity: true, relforcerowsecurity: true }),
        expect.objectContaining({ relname: "voucher_claim_audit", owner: "gp_runtime_recovery_migrator", relrowsecurity: true, relforcerowsecurity: true }),
        expect.objectContaining({ relname: "voucher_claim_binding", owner: "gp_runtime_recovery_migrator", relrowsecurity: true, relforcerowsecurity: true }),
      ])
      const grants = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'medusa_store' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [["event_processed", "voucher_claim_audit", "voucher_claim_binding"]]
      )
      expect(grants.rows).toEqual([
        { table_name: "event_processed", privilege_type: "INSERT" },
        { table_name: "event_processed", privilege_type: "SELECT" },
        { table_name: "voucher_claim_audit", privilege_type: "INSERT" },
        { table_name: "voucher_claim_audit", privilege_type: "SELECT" },
        { table_name: "voucher_claim_binding", privilege_type: "INSERT" },
        { table_name: "voucher_claim_binding", privilege_type: "SELECT" },
        { table_name: "voucher_claim_binding", privilege_type: "UPDATE" },
      ])

      await configureRuntime(client, "instance-a", "market-a")
      await client.query(`INSERT INTO voucher_claim_audit (idempotency_key, code, ip, outcome, occurred_at, instance_id, market_id) VALUES ('story-11-1-audit', 'story-11-1-code', '127.0.0.1', 'ok', NOW(), 'instance-a', 'market-a')`)
      await client.query(`INSERT INTO voucher_claim_audit (idempotency_key, code, ip, outcome, occurred_at, instance_id, market_id) VALUES ('story-11-1-audit-chain', 'story-11-1-code', '127.0.0.1', 'idempotent_replay', NOW(), 'instance-a', 'market-a')`)
      await client.query(`INSERT INTO voucher_claim_binding (idempotency_key, binding_hash, code, claimed_at, expires_at, instance_id, market_id) VALUES ('story-11-1-binding', 'story-11-1-hash', 'story-11-1-code', '2026-09-06T12:00:00Z', NOW() + interval '1 hour', 'instance-a', 'market-a')`)
      await client.query(`INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id) VALUES ('story-11-1-issuance', 'issued', 1779016000000, 'story-11-1-purchase', 'instance-a', 'market-a')`)
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-issuance'")).rows).toEqual([
        { external_id: "story-11-1-issuance" },
      ])
      const auditChain = await client.query<{ idempotency_key: string; prev_row_hash: string | null; content_hash: string }>(
        "SELECT idempotency_key, prev_row_hash, content_hash FROM voucher_claim_audit WHERE idempotency_key IN ('story-11-1-audit', 'story-11-1-audit-chain') ORDER BY audit_id"
      )
      expect(auditChain.rows).toHaveLength(2)
      expect(auditChain.rows[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(auditChain.rows[1]).toEqual(expect.objectContaining({
        idempotency_key: "story-11-1-audit-chain",
        prev_row_hash: auditChain.rows[0]?.content_hash,
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }))

      const first = await pool.connect()
      const second = await pool.connect()
      try {
        await configureRuntime(first, "instance-a", "market-a")
        await configureRuntime(second, "instance-a", "market-a")
        const [firstInsert, secondInsert] = await Promise.all([
          first.query(`INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id) VALUES ('story-11-1-concurrent', 'issued', 1779016000002, 'story-11-1-purchase', 'instance-a', 'market-a') ON CONFLICT DO NOTHING`),
          second.query(`INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id) VALUES ('story-11-1-concurrent', 'issued', 1779016000003, 'story-11-1-purchase', 'instance-a', 'market-a') ON CONFLICT DO NOTHING`),
        ])
        expect((firstInsert.rowCount ?? 0) + (secondInsert.rowCount ?? 0)).toBe(1)
      } finally {
        await resetRuntime(first).catch(() => undefined)
        await resetRuntime(second).catch(() => undefined)
        first.release()
        second.release()
      }

      await configureRuntime(client, "instance-a", "market-b")
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id LIKE 'story-11-1-%'")).rows).toEqual([])
      expect((await client.query("SELECT audit_id FROM voucher_claim_audit WHERE idempotency_key = 'story-11-1-audit'")).rows).toEqual([])
      expect((await client.query("SELECT idempotency_key FROM voucher_claim_binding WHERE idempotency_key = 'story-11-1-binding'")).rows).toEqual([])
      expect((await client.query(`INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id) VALUES ('story-11-1-issuance', 'issued', 1779016000001, 'story-11-1-purchase', 'instance-a', 'market-b') ON CONFLICT DO NOTHING`)).rowCount).toBe(0)
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-unknown'")).rows).toEqual([])

      await configureRuntime(client, "instance-b", "market-a")
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-issuance'")).rows).toEqual([])

      await configureRuntime(client, "instance-a", "market-a")
      expect((await client.query("UPDATE voucher_claim_binding SET updated_at = NOW() WHERE idempotency_key = 'story-11-1-binding'")).rowCount).toBe(1)
      await client.query("SAVEPOINT append_only_audit")
      await expect(client.query("UPDATE voucher_claim_audit SET outcome = 'ok' WHERE idempotency_key = 'story-11-1-audit'")).rejects.toThrow(/permission denied/i)
      await client.query("ROLLBACK TO SAVEPOINT append_only_audit")
      await client.query("SAVEPOINT append_only_dedupe")
      await expect(client.query("DELETE FROM event_processed WHERE external_id = 'story-11-1-issuance'")).rejects.toThrow(/permission denied/i)
      await client.query("ROLLBACK TO SAVEPOINT append_only_dedupe")

      await resetRuntime(client)
      await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_claim_audit, voucher_claim_binding, event_processed TO medusa_store")
      await client.query(provisioningGuard!)
      await client.query(provisioningGuard!)
      const repeatedGrants = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'medusa_store' AND table_name IN ('event_processed', 'voucher_claim_audit', 'voucher_claim_binding')
          ORDER BY table_name, privilege_type`
      )
      expect(repeatedGrants.rows).toEqual(grants.rows)

      await resetRuntime(client)
      await client.query("DROP POLICY market_isolation ON event_processed")
      await client.query("CREATE POLICY market_isolation ON event_processed TO medusa_store USING (true) WITH CHECK (true)")
      await configureRuntime(client, "instance-a", "market-b")
      await expect(
        client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-issuance'")
          .then((result) => expect(result.rows).toEqual([]))
      ).rejects.toThrow()
    } finally {
      await resetRuntime(client).catch(() => undefined)
      await client.query("ROLLBACK")
      // Dwaj klienci współbieżnego INSERT-u nie należą do transakcji klienta
      // głównego. Sprzątamy wyłącznie deterministyczny klucz fixture przed
      // asercją post-condition, aby kolejny przebieg nie odziedziczył skutku.
      await client.query("DELETE FROM event_processed WHERE external_id = 'story-11-1-concurrent'")
      const persisted = await client.query("SELECT external_id FROM event_processed WHERE external_id LIKE 'story-11-1-%'")
      expect(persisted.rows).toEqual([])
    }
  }, 30_000)
})
