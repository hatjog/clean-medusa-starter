import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { applyRuntimeRecoveryMigration } from "./story-11-1-runtime-recovery-migration-support"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL

async function setRuntime(client: PoolClient, instanceId: string, marketId: string): Promise<void> {
  await client.query("SET ROLE medusa_store")
  await client.query("SELECT set_config('app.gp_instance_id', $1, false)", [instanceId])
  await client.query("SELECT set_config('app.gp_market_id', $1, false)", [marketId])
}

async function resetRuntime(client: PoolClient): Promise<void> {
  await client.query("RESET ROLE")
  await client.query("RESET app.gp_instance_id")
  await client.query("RESET app.gp_market_id")
}

describe("Story 11.1 — fail-closed scope na rzeczywistym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 runtime scope: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
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

  it("odmawia zapisu bez obu osi scopu", async () => {
    await client.query("BEGIN")
    try {
      await applyRuntimeRecoveryMigration(client)
      await client.query("SET ROLE medusa_store")
      await client.query("RESET app.gp_instance_id")
      await client.query("RESET app.gp_market_id")
      await expect(client.query(
        `INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id)
         VALUES ($1, 'scope-missing', 1779016000000, $1, 'instance-a', 'market-a')`,
        ["story-11-1-missing-scope"]
      )).rejects.toThrow(/row-level security|permission denied/i)
    } finally {
      await resetRuntime(client).catch(() => undefined)
      await client.query("ROLLBACK")
    }
  })

  it("dopuszcza zgodny instance_id i market_id, a odmawia obcej instancji", async () => {
    await client.query("BEGIN")
    try {
      await applyRuntimeRecoveryMigration(client)
      await setRuntime(client, "instance-a", "market-a")
      await client.query(
        `INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id)
         VALUES ('story-11-1-scope-positive', 'scope-positive', 1779016000001, 'story-11-1-scope-positive', 'instance-a', 'market-a')`
      )
      await setRuntime(client, "instance-b", "market-a")
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-scope-positive'")).rows).toEqual([])
    } finally {
      await resetRuntime(client).catch(() => undefined)
      await client.query("ROLLBACK")
    }
  })
})
