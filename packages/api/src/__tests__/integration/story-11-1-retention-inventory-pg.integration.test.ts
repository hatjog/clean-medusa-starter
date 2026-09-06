import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const inventory = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, "_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/11-1/retention-inventory.json"),
  "utf8"
)) as { carriers: Array<{ carrier: string; table: string; mechanism: string; remaining_count: string }> }

describe("Story 11.1 — read-only retention inventory", () => {
  it("obejmuje sześć nośników, nie udaje licznika i nie zawiera mutacji", () => {
    expect(inventory.carriers.map((entry) => entry.carrier).sort()).toEqual([
      "claim_audit",
      "delivery_decision",
      "delivery_ledger",
      "notification_payload",
      "order_metadata",
      "voucher_recipient_pii",
    ])
    for (const entry of inventory.carriers) {
      expect(entry.remaining_count).toBe("NOT_MEASURED")
      expect(entry.mechanism).not.toMatch(/\b(DELETE|UPDATE|INSERT|TRUNCATE)\b/i)
    }
  })

  if (!enabled) {
    it("NOT_RUN: pomiar tabel wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 retention inventory: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
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

  it("wykonuje tylko dodatni, read-only probe rzeczywistej bazy", async () => {
    const database = await client.query<{ current_database: string }>("SELECT current_database()")
    expect(database.rows[0]?.current_database).toEqual(expect.any(String))
    for (const entry of inventory.carriers) {
      const probe = await client.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [entry.table])
      expect(probe.rows).toHaveLength(1)
    }
  })
})
