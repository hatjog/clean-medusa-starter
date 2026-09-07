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

const RELATIONS: Record<string, string> = {
  voucher_recipient_pii: "voucher_recipient_pii",
  voucher_delivery_decision: "voucher_delivery_decision",
  notification: "notification",
  order: '"order"',
  voucher_delivery_dispatch: "voucher_delivery_dispatch",
  voucher_delivery_dispatch_audit: "voucher_delivery_dispatch_audit",
  voucher_claim_audit: "voucher_claim_audit",
}

const REQUIRED_CARRIERS = [
  "claim_audit",
  "delivery_decision",
  "delivery_ledger",
  "delivery_ledger_audit",
  "notification_payload",
  "order_metadata",
  "voucher_recipient_pii",
]

function assertReadOnlyInventory(candidate: typeof inventory): void {
  for (const entry of candidate.carriers) {
    if (/\b(DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(entry.mechanism)) {
      throw new Error(`mutacja w inventory retention: ${entry.carrier}`)
    }
  }
}

function assertRecordedCount(entry: (typeof inventory.carriers)[number], measured: string): void {
  if (entry.remaining_count !== measured) {
    throw new Error(
      `rozjazd retention inventory dla ${entry.carrier}: artefakt=${entry.remaining_count}, pomiar=${measured}`
    )
  }
}

function assertRequiredCarriers(candidate: typeof inventory): void {
  expect(candidate.carriers.map((entry) => entry.carrier).sort()).toEqual(REQUIRED_CARRIERS)
}

describe("Story 11.1 — read-only retention inventory", () => {
  it("obejmuje siedem nośników, w tym ledger i jego append-only audit, zapisuje wynik pomiaru z kontrolą relacji i nie zawiera mutacji", () => {
    expect(inventory.measurement_status).toBe("MEASURED")
    assertRequiredCarriers(inventory)
    expect(() => assertReadOnlyInventory(inventory)).not.toThrow()
    for (const entry of inventory.carriers) {
      if (entry.relation_present) {
        expect(entry.remaining_count).toMatch(/^\d+$/)
      } else {
        expect(entry.remaining_count).toBe("ABSENT")
      }
    }
  })

  it("odrzuca mutant z mutacją retencji w read-only inventory", () => {
    const mutant = structuredClone(inventory)
    mutant.carriers[0]!.mechanism = "DELETE FROM voucher_recipient_pii"
    expect(() => assertReadOnlyInventory(mutant)).toThrow(/mutacja/)
  })

  it("odrzuca mutant pomijający append-only audit ledgera", () => {
    const mutant = structuredClone(inventory)
    mutant.carriers = mutant.carriers.filter((entry) => entry.carrier !== "delivery_ledger_audit")
    expect(() => assertRequiredCarriers(mutant)).toThrow()
  })

  it("odrzuca mutant rozjeżdżający wartość artefaktu z pomiarem", () => {
    const entry = inventory.carriers.find((carrier) => carrier.carrier === "claim_audit")!
    const mutant = { ...entry, remaining_count: entry.remaining_count === "0" ? "1" : "0" }
    expect(() => assertRecordedCount(mutant, entry.remaining_count)).toThrow(/rozjazd retention inventory/)
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

  it("mierzy każdy nośnik tylko przez SELECT COUNT(*) i wiąże wynik z artefaktem", async () => {
    const database = await client.query<{ current_database: string }>("SELECT current_database()")
    expect(database.rows[0]?.current_database).toEqual(expect.any(String))
    for (const entry of inventory.carriers) {
      const relation = RELATIONS[entry.table]
      expect(relation).toBeDefined()
      const exists = await client.query<{ relation: string | null }>(
        "SELECT to_regclass($1) AS relation",
        [entry.table]
      )
      expect(exists.rows).toHaveLength(1)
      const relationPresent = Boolean(exists.rows[0]?.relation)
      expect(relationPresent).toBe(entry.relation_present)
      if (!relationPresent) {
        expect(entry.remaining_count).toBe("ABSENT")
        continue
      }
      const count = await client.query<{ remaining_count: string }>(
        `SELECT COUNT(*)::text AS remaining_count FROM ${relation}`
      )
      const measured = count.rows[0]?.remaining_count
      expect(measured).toMatch(/^\d+$/)
      assertRecordedCount(entry, measured!)
    }
  })
})
