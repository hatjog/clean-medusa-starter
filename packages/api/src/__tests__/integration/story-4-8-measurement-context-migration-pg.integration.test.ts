/** Story 4.8 — wykonanie migracji etykiet AD-25 na realnym PostgreSQL. */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1779014000000 } from "../../modules/voucher/migrations/1779014000000_add_delivery_measurement_context"

function collectUpSql(): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (sql: string) => sqls.push(sql) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1779014000000.prototype as any).up.call(fakeThis)
  return sqls
}

const enabled =
  process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const maybe = enabled ? describe : describe.skip

maybe("Story 4.8 — migracja 1779014000000 na realnym PG", () => {
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

  it("backfilluje zastane wiersze, zdejmuje DEFAULT i wymaga etykiet nowych zapisów", async () => {
    await client.query("BEGIN")
    try {
      await client.query(`
        CREATE TEMP TABLE voucher_delivery_dispatch (
          dispatch_id text PRIMARY KEY
        ) ON COMMIT DROP;
        CREATE TEMP TABLE voucher_delivery_dispatch_audit (
          audit_id bigint PRIMARY KEY
        ) ON COMMIT DROP;
        INSERT INTO voucher_delivery_dispatch VALUES ('legacy-dispatch');
        INSERT INTO voucher_delivery_dispatch_audit VALUES (1)
      `)

      for (const sql of collectUpSql()) await client.query(sql)

      for (const table of [
        "voucher_delivery_dispatch",
        "voucher_delivery_dispatch_audit",
      ]) {
        const legacy = await client.query<{ env: string; instance_id: string }>(
          `SELECT env, instance_id FROM ${table}`,
        )
        expect(legacy.rows[0]).toEqual({
          env: "unattributed",
          instance_id: "unattributed",
        })

        const columns = await client.query<{
          column_name: string
          column_default: string | null
          is_nullable: string
        }>(
          `SELECT column_name, column_default, is_nullable
             FROM information_schema.columns
            WHERE table_schema LIKE 'pg_temp_%'
              AND table_name = $1
              AND column_name IN ('env', 'instance_id')
            ORDER BY column_name`,
          [table],
        )
        expect(columns.rows).toEqual([
          { column_name: "env", column_default: null, is_nullable: "NO" },
          {
            column_name: "instance_id",
            column_default: null,
            is_nullable: "NO",
          },
        ])
      }

      await expect(
        client.query(
          "INSERT INTO voucher_delivery_dispatch (dispatch_id) VALUES ('missing-labels')",
        ),
      ).rejects.toThrow(/null value in column "env"/)
      await client.query("ROLLBACK")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })
})
