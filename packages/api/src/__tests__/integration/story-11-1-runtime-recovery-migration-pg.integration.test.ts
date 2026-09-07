import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import {
  applyRuntimeRecoveryMigration,
  rollbackRuntimeRecoveryMigration,
  runtimeRecoveryMigrationDownSql,
} from "./story-11-1-runtime-recovery-migration-support"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL

describe("Story 11.1 — migracja granicy RLS na rzeczywistym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 migracja: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
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

  it("wykonuje up i niedestrukcyjny down w izolowanej transakcji", async () => {
    await client.query("BEGIN")
    try {
      const execution = await applyRuntimeRecoveryMigration(client)
      expect(execution.rolesObservedDuringSetRole).toEqual(["gp_runtime_recovery_migrator"])
      const columns = await client.query<{ relname: string; attname: string }>(
        `SELECT c.relname, a.attname
           FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.relname = ANY($1::text[])
            AND a.attname = ANY($2::text[])
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY c.relname, a.attname`,
        [["event_processed", "voucher_claim_audit", "voucher_claim_binding"], ["instance_id", "market_id"]]
      )
      expect(columns.rows).toHaveLength(6)
      await rollbackRuntimeRecoveryMigration(client)
      expect(await runtimeRecoveryMigrationDownSql()).toEqual([])
    } finally {
      await client.query("ROLLBACK")
    }
  })
})
