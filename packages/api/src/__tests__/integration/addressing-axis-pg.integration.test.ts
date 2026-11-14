/**
 * v1.16.0 Story 6.4 AC2 (FR-20, AD-36 oś (a), NFR-2) — zapytanie dowodowe osi (a)
 * na realnym PostgreSQL z OBOWIĄZKOWĄ kontrolą dodatnią przed `(0 rows)`.
 *
 * Profil: `pnpm run test:integration:addressing-axis-pg`
 * Baza: izolowana `gp_story_6_4_test` (stack gp-test, port 55432); suita odmawia
 * startu na bazie bez sufiksu `_test`. Pracuje we własnym schemacie
 * `story_6_4_axis` (tabela z produkcyjnej migracji 1778933000000), który usuwa
 * na końcu — bez migracji schematu aplikacji (D-35 p.16).
 *
 * Gdy ustawione `GP_6_4_EVIDENCE_OUT`, suita zapisuje tam artefakt dowodowy
 * (kontrola dodatnia + zapytanie właściwe), który weryfikuje bramka
 * `_grow/tools/validate_addressing_axis.py`. Oś (a) NIE jest dowodem dostarczenia.
 */
import { writeFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1778933000000 } from "../../modules/voucher/migrations/1778933000000_create_voucher_delivery_dispatch"
import {
  ADDRESSING_AXIS_PROOF_SQL,
  ADDRESSING_AXIS_TEMPLATE_KEY,
  runAddressingAxisProof,
} from "../../modules/voucher-delivery/addressing-axis"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"

const DATABASE_URL = process.env.DATABASE_URL
const SCHEMA = "story_6_4_axis"
const PAYER = "platnik-6-4@example.test"
const GIFT_RECIPIENT = "ola-6-4@example.test"
const ENT = "ent_6_4_gift"
const ENT_CONTROL = "ent_6_4_positive_control"
const ENT_BAD = "ent_6_4_misaddressed"

async function migrationSql(): Promise<string[]> {
  const statements: string[] = []
  const migration = Object.create(Migration1778933000000.prototype) as Migration1778933000000 & {
    addSql: (sql: string) => void
  }
  migration.addSql = (sql: string) => {
    statements.push(sql)
  }
  await migration.up()
  return statements
}

async function insertDispatch(client: PoolClient, entitlementId: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO voucher_delivery_dispatch
       (dispatch_id, entitlement_id, template_key, recipient_hash, market_id, flow_id, locale, status, queued_at)
     VALUES ($1, $2, $3, $4, 'mkt_6_4', 'flow_6_4', 'pl', 'queued', NOW())`,
    [`disp_${entitlementId}`, entitlementId, ADDRESSING_AXIS_TEMPLATE_KEY, hashRecipientEmail(email)],
  )
}

if (!DATABASE_URL) {
  describe("Story 6.4 AC2 — oś (a) na PostgreSQL", () => {
    it("NOT_RUN: wymaga DATABASE_URL izolowanej bazy *_test", () => {
      console.warn("[NOT_RUN] Story 6.4: ustaw DATABASE_URL na gp_story_6_4_test")
    })
  })
} else {
  describe("Story 6.4 AC2 — oś (a) na PostgreSQL: kontrola dodatnia przed (0 rows)", () => {
    let pool: Pool
    let client: PoolClient

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL })
      client = await pool.connect()
      const db = await client.query<{ name: string }>("SELECT current_database() AS name")
      if (!/_test$/.test(db.rows[0]?.name ?? "")) {
        throw new Error(`Story 6.4 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
      }
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path TO ${SCHEMA}`)
      for (const sql of await migrationSql()) await client.query(sql)
      // wiersz dowodowy właściwy: handoff do obdarowanej
      await insertDispatch(client, ENT, GIFT_RECIPIENT)
      // wiersz kontrolny: recipient_hash == hash(buyer_email)
      await insertDispatch(client, ENT_CONTROL, PAYER)
    })

    afterAll(async () => {
      if (client) {
        await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
        client.release()
      }
      if (pool) await pool.end()
    })

    it("kontrola dodatnia znajduje wiersz kontrolny, zanim (0 rows) zostanie uznane ⇒ PASS", async () => {
      const proof = await runAddressingAxisProof(client, {
        entitlement_id: ENT,
        control_entitlement_id: ENT_CONTROL,
        payer_email: `  ${PAYER.toUpperCase()} `,
      })
      expect(proof.positive_control.row_count).toBe(1)
      expect(proof.positive_control.recipient_hashes).toEqual([hashRecipientEmail(PAYER)])
      expect(proof.proof).toEqual({ entitlement_id: ENT, row_count: 0, executed_seq: 2 })
      expect(proof.verdict).toBe("PASS")
      expect(proof.is_delivery_proof).toBe(false)

      const rows = await client.query<{ dispatch_id: string; recipient_hash: string }>(
        "SELECT dispatch_id, recipient_hash FROM voucher_delivery_dispatch WHERE entitlement_id = $1 AND template_key = $2",
        [ENT, ADDRESSING_AXIS_TEMPLATE_KEY],
      )
      const out = process.env.GP_6_4_EVIDENCE_OUT
      if (out) {
        writeFileSync(
          out,
          JSON.stringify(
            {
              story: "6.4",
              ac: "AC2",
              database: "postgres://postgres@localhost:55432/gp_story_6_4_test",
              schema: SCHEMA,
              measured_at: new Date().toISOString(),
              note: "Oś (a) jest warunkiem koniecznym, NIE dowodem dostarczenia; oś (b) = bramka ludzka 6.7.",
              ...proof,
              addressing_rows: rows.rows,
            },
            null,
            2,
          ) + "\n",
        )
      }
    })

    it("bez wiersza kontrolnego pusty wynik NIE jest uznany ⇒ CONTROL_FAILED", async () => {
      const proof = await runAddressingAxisProof(client, {
        entitlement_id: ENT,
        control_entitlement_id: "ent_6_4_no_such_control",
        payer_email: PAYER,
      })
      expect(proof.verdict).toBe("CONTROL_FAILED")
      expect(proof.proof.executed_seq).toBeNull()
    })

    it("handoff zaadresowany do płatnika (inna wielkość liter) ⇒ FAIL", async () => {
      await insertDispatch(client, ENT_BAD, ` ${PAYER.toUpperCase()}`)
      const proof = await runAddressingAxisProof(client, {
        entitlement_id: ENT_BAD,
        control_entitlement_id: ENT_CONTROL,
        payer_email: PAYER,
      })
      expect(proof.verdict).toBe("FAIL")
      expect(proof.proof.row_count).toBe(1)
      expect(proof.query_sql).toBe(ADDRESSING_AXIS_PROOF_SQL)
    })
  })
}
