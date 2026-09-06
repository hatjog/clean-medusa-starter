import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const fixture = fs.readFileSync(
  path.join(REPO_ROOT, "GP/backend/packages/api/src/__tests__/fixtures/story-11-1-unknown-market.sql"),
  "utf8"
)
const inventory = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, "_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/11-1/provenance-inventory.json"),
  "utf8"
)) as { legacy_populations: Array<{ table: string; historical_count: string; provenance: string }> }

async function setRuntime(client: PoolClient, marketId: string): Promise<void> {
  await client.query("SET ROLE medusa_store")
  await client.query("SELECT set_config('app.gp_market_id', $1, false)", [marketId])
}

describe("Story 11.1 — UNKNOWN legacy provenance", () => {
  it("nie zawiera automatycznego marketu ani sfałszowanego pomiaru", () => {
    expect(fixture).not.toMatch(/market_id|default|bonbeauty|bongarden/i)
    expect(inventory.legacy_populations.map((entry) => entry.table).sort()).toEqual([
      "event_processed",
      "voucher_claim_audit",
      "voucher_claim_binding",
    ])
    for (const entry of inventory.legacy_populations) {
      expect(entry.historical_count).toBe("NOT_MEASURED")
      expect(entry.provenance).toContain("UNKNOWN")
    }
  })

  if (!enabled) {
    it("NOT_RUN: fixture UNKNOWN wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 provenance inventory: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
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

  it("utrzymuje fixture bez marketu niewidoczną dla A i B oraz rollbackuje probe", async () => {
    await client.query("BEGIN")
    try {
      await client.query(fixture)
      await setRuntime(client, "market-a")
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-unknown'")).rows).toEqual([])
      await setRuntime(client, "market-b")
      expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-unknown'")).rows).toEqual([])
    } finally {
      await client.query("RESET ROLE").catch(() => undefined)
      await client.query("ROLLBACK")
    }
    expect((await client.query("SELECT external_id FROM event_processed WHERE external_id = 'story-11-1-unknown'")).rows).toEqual([])
  })
})
