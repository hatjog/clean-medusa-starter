import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const inventory = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, "_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/11-1/retention-inventory.json"),
  "utf8"
)) as {
  measurement_status: string
  carriers: Array<{ carrier: string; table: string; mechanism: string; remaining_count: string; relation_present: boolean }>
}

describe("Story 11.1 — read-only retention inventory", () => {
  it("obejmuje sześć nośników, zapisuje wynik pomiaru z kontrolą relacji i nie zawiera mutacji", () => {
    expect(inventory.measurement_status).toBe("MEASURED")
    expect(inventory.carriers.map((entry) => entry.carrier).sort()).toEqual([
      "claim_audit",
      "delivery_decision",
      "delivery_ledger",
      "notification_payload",
      "order_metadata",
      "voucher_recipient_pii",
    ])
    for (const entry of inventory.carriers) {
      if (entry.relation_present) {
        expect(entry.remaining_count).toMatch(/^\d+$/)
      } else {
        expect(entry.remaining_count).toBe("ABSENT")
      }
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

  it("mierzy każdy nośnik tylko przez SELECT COUNT(*)", async () => {
    const database = await client.query<{ current_database: string }>("SELECT current_database()")
    expect(database.rows[0]?.current_database).toEqual(expect.any(String))
    for (const entry of inventory.carriers) {
      const relation = entry.table === "order" ? '"order"' : entry.table
      const exists = await client.query<{ relation: string | null }>(
        "SELECT to_regclass($1) AS relation",
        [entry.table]
      )
      expect(exists.rows).toHaveLength(1)
      // Brak tabeli jest wynikiem inwentarza tego konkretnego środowiska, nie
      // pretekstem do wpisania fałszywego zera ani do tworzenia nośnika danych.
      if (!exists.rows[0]?.relation) continue
      const count = await client.query<{ remaining_count: string }>(
        `SELECT COUNT(*)::text AS remaining_count FROM ${relation}`
      )
      expect(count.rows).toEqual([expect.objectContaining({ remaining_count: expect.stringMatching(/^\d+$/) })])
    }
  })
})
