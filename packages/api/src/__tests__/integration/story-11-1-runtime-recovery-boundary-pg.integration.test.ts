import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1779016000000 } from "../../modules/voucher/migrations/1779016000000_runtime_recovery_rls_boundary"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const maybe = enabled ? describe : describe.skip

function sql(): string[] {
  const commands: string[] = []
  const fakeThis = { addSql: (command: string) => commands.push(command) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1779016000000.prototype as any).up.call(fakeThis)
  return commands
}

maybe("Story 11.1 — RLS claim/issuance na realnym PostgreSQL", () => {
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

  it("izoluje A/B, ukrywa UNKNOWN i utrzymuje globalną deduplikację issuance", async () => {
    await client.query("BEGIN")
    try {
      await client.query(`
        CREATE TEMP TABLE voucher_claim_audit (audit_id bigint PRIMARY KEY, idempotency_key text, code text, ip text, outcome text, occurred_at timestamptz);
        CREATE TEMP TABLE voucher_claim_binding (idempotency_key text PRIMARY KEY, binding_hash text, code text, claimed_at text, expires_at timestamptz, created_at timestamptz, updated_at timestamptz);
        CREATE TEMP TABLE event_processed (external_id text, event_type text, processed_at bigint, purchase_key text, PRIMARY KEY (external_id, event_type));
        INSERT INTO event_processed VALUES ('legacy','issued',1,'legacy');
      `)
      for (const command of sql()) await client.query(command)

      await client.query("SET ROLE medusa_store")
      await client.query("SELECT set_config('app.gp_market_id', $1, false)", ["market-a"])
      await client.query("INSERT INTO event_processed VALUES ('pi-1','issued',2,'pi-1','market-a')")
      expect((await client.query("SELECT external_id FROM event_processed ORDER BY external_id")).rows).toEqual([{ external_id: "pi-1" }])

      await client.query("SELECT set_config('app.gp_market_id', $1, false)", ["market-b"])
      expect((await client.query("SELECT external_id FROM event_processed")).rows).toEqual([])
      expect((await client.query("INSERT INTO event_processed VALUES ('pi-1','issued',3,'pi-1','market-b') ON CONFLICT DO NOTHING")).rowCount).toBe(0)

      await client.query("SELECT set_config('app.gp_market_id', '', false)")
      expect((await client.query("SELECT external_id FROM event_processed")).rows).toEqual([])

      // Mutant polityki jest wykrywalny: `USING (true)` przecieka A do B.
      await client.query("RESET ROLE")
      await client.query("DROP POLICY market_isolation ON event_processed")
      await client.query("CREATE POLICY market_isolation ON event_processed TO medusa_store USING (true) WITH CHECK (true)")
      await client.query("SET ROLE medusa_store")
      await client.query("SELECT set_config('app.gp_market_id', $1, false)", ["market-b"])
      expect((await client.query("SELECT external_id FROM event_processed ORDER BY external_id")).rows).toEqual([
        { external_id: "legacy" },
        { external_id: "pi-1" },
      ])
    } finally {
      await client.query("RESET ROLE").catch(() => undefined)
      await client.query("ROLLBACK")
    }
  })
})
