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
  measured_at: string
  database: string
  migration_revision: string
  carriers: Array<{
    carrier: string
    table: string
    fields: string[]
    writer: string
    mechanism: string
    cutoff: string
    remaining_count: string
    relation_present: boolean
  }>
}
const API_SRC = path.join(REPO_ROOT, "GP/backend/packages/api/src")

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

/**
 * Story 11.1 AI-Verify-C4-NEW-001/002: walidacja SEMANTYCZNA artefaktu. Writer
 * musi wskazywać istniejący plik (i symbol, gdy podany), fields — niepustą listę
 * nazw kolumn, cutoff — niepustą wartość (UNSPECIFIED, gdy brak decyzji; nie
 * wymyślamy wartości, DW-15-248), measured_at — pełny znacznik ISO z godziną,
 * database — izolowaną bazę `*_test`, migration_revision — migrację 11.1.
 */
function assertSemanticInventory(candidate: typeof inventory): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(candidate.measured_at ?? "") || Number.isNaN(Date.parse(candidate.measured_at))) {
    throw new Error("retention inventory: measured_at nie jest znacznikiem ISO z godziną")
  }
  if (!/_test$/.test(candidate.database ?? "")) {
    throw new Error("retention inventory: database nie jest izolowaną bazą *_test")
  }
  if (candidate.migration_revision !== "1779016000000_runtime_recovery_rls_boundary") {
    throw new Error("retention inventory: brak rewizji migracji Story 11.1")
  }
  for (const entry of candidate.carriers) {
    const writer = typeof entry.writer === "string" ? entry.writer.trim() : ""
    const match = writer.match(/^([A-Za-z0-9_./\[\]-]+\.ts)(?::([A-Za-z0-9_/]+))?/)
    if (!match) throw new Error(`retention inventory: writer bez ścieżki pliku dla ${entry.carrier}`)
    const file = path.join(API_SRC, match[1]!)
    if (!fs.existsSync(file)) throw new Error(`retention inventory: writer ${match[1]} nie istnieje (${entry.carrier})`)
    if (match[2]) {
      const source = fs.readFileSync(file, "utf8")
      for (const symbol of match[2].split("/")) {
        if (!source.includes(symbol)) throw new Error(`retention inventory: symbol ${symbol} nie występuje w ${match[1]}`)
      }
    }
    if (!Array.isArray(entry.fields) || entry.fields.length === 0 || entry.fields.some((f) => !/^[a-z_][a-z0-9_]*$/.test(f))) {
      throw new Error(`retention inventory: fields puste albo niepoprawne dla ${entry.carrier}`)
    }
    if (typeof entry.cutoff !== "string" || entry.cutoff.trim() === "") {
      throw new Error(`retention inventory: brak cutoff dla ${entry.carrier}`)
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

  it("waliduje semantycznie writer, fields, cutoff, measured_at, bazę i rewizję migracji", () => {
    expect(() => assertSemanticInventory(inventory)).not.toThrow()
  })

  it.each([
    ["writer usunięty", (m: typeof inventory) => { m.carriers[0]!.writer = "" }, /writer/],
    ["writer wskazuje nieistniejący plik", (m: typeof inventory) => { m.carriers[0]!.writer = "modules/nope/missing.ts:x" }, /nie istnieje/],
    ["cutoff usunięty", (m: typeof inventory) => { m.carriers[1]!.cutoff = "" }, /cutoff/],
    ["fields puste", (m: typeof inventory) => { m.carriers[2]!.fields = [] }, /fields/],
    ["measured_at bez godziny", (m: typeof inventory) => { m.measured_at = "2026-09-07" }, /measured_at/],
    ["baza współdzielona bez _test", (m: typeof inventory) => { m.database = "gp_mercur" }, /database/],
    ["brak rewizji migracji", (m: typeof inventory) => { m.migration_revision = "" }, /rewizji/],
  ])("odrzuca mutant: %s", (_name, mutate, pattern) => {
    const mutant = structuredClone(inventory)
    mutate(mutant)
    expect(() => assertSemanticInventory(mutant)).toThrow(pattern)
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
    // Tożsamość bazy: pomiar wiąże się wyłącznie z bazą zapisaną w artefakcie.
    expect(database.rows[0]?.current_database).toBe(inventory.database)
    const revision = await client.query("SELECT 1 FROM mikro_orm_migrations WHERE name = $1", [inventory.migration_revision])
    expect(revision.rowCount).toBe(1)
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
      const columns = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [entry.table]
      )
      const present = new Set(columns.rows.map((row) => row.column_name))
      expect(entry.fields.filter((field) => !present.has(field))).toEqual([])
    }
  })
})
