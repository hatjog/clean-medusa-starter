import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { applyRuntimeRecoveryMigration } from "./story-11-1-runtime-recovery-migration-support"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const provisioningSql = fs.readFileSync(
  path.join(REPO_ROOT, "infra/postgres/migrations/003-rls-market-isolation.sql"),
  "utf8"
)
const provisioningGuard = provisioningSql.match(/DO \$\$[\s\S]*?protected_table[\s\S]*?\$\$;/)?.[0]
const TABLES = ["event_processed", "voucher_claim_audit", "voucher_claim_binding"]

describe("Story 11.1 — provisioning ról na rzeczywistym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 provisioning: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
      expect(enabled).toBe(false)
    })
    return
  }

  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    client = await pool.connect()
  })
  afterAll(async () => {
    client?.release()
    await pool?.end()
  })

  it("sprawdza role, ownera, granty oraz idempotentny guard provisioning", async () => {
    expect(provisioningGuard).toBeDefined()
    await client.query("BEGIN")
    try {
      await applyRuntimeRecoveryMigration(client)
      const roles = await client.query<{ rolname: string; rolbypassrls: boolean }>(
        "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
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
        [TABLES]
      )
      expect(owners.rows).toEqual(TABLES.map((relname) => expect.objectContaining({
        relname,
        owner: "gp_runtime_recovery_migrator",
        relrowsecurity: true,
        relforcerowsecurity: true,
      })))

      const grants = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'medusa_store' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [TABLES]
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

      await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_claim_audit, voucher_claim_binding, event_processed TO medusa_store")
      await client.query(provisioningGuard!)
      await client.query(provisioningGuard!)
      const rechecked = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'medusa_store' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [TABLES]
      )
      expect(rechecked.rows).toEqual(grants.rows)
    } finally {
      await client.query("ROLLBACK")
    }
  })
})
