/**
 * NEEDS-LIVE-RUN — AC7 behavioral cross-market deny test.
 *
 * This suite REQUIRES a real PostgreSQL instance with:
 *   - All gp_core migrations applied (including Migration20260525000000)
 *   - A non-BYPASSRLS role to simulate gp_core_runtime behavior
 *
 * Set GP_CORE_RLS_TEST_DATABASE_URL to enable (e.g. in CI or manual smoke):
 *   GP_CORE_RLS_TEST_DATABASE_URL=postgres://gp_core_runtime:pw@localhost:5432/gp_core \
 *     pnpm jest gp-core-rls-cross-market-deny.live.spec
 *
 * Without the env var the suite skips — it does NOT produce a false pass.
 *
 * Smoke psql commands (manual verification):
 *   -- As non-BYPASSRLS role (e.g. gp_core_runtime or a test role without BYPASSRLS):
 *   BEGIN;
 *   SELECT set_config('app.gp_market_id', '<market_a_uuid>', true);
 *   SELECT COUNT(*) FROM gp_core.entitlements;          -- must equal count for market_a only
 *   SELECT COUNT(*) FROM gp_core.entitlements
 *     WHERE market_id != '<market_a_uuid>';              -- must be 0
 *   COMMIT;
 *
 *   -- No GUC set (fail-closed):
 *   BEGIN;
 *   SELECT COUNT(*) FROM gp_core.entitlements;          -- must be 0 (UNKNOWN predicate)
 *   COMMIT;
 *
 *   -- WITH CHECK blocks cross-market INSERT:
 *   BEGIN;
 *   SELECT set_config('app.gp_market_id', '<market_a_uuid>', true);
 *   INSERT INTO gp_core.entitlements (market_id, ...) VALUES ('<market_b_uuid>', ...);
 *   -- must raise ERROR: new row violates row-level security policy
 *   ROLLBACK;
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals"
import { Pool } from "pg"

const TEST_DB_URL = process.env.GP_CORE_RLS_TEST_DATABASE_URL

// Conditional: entire suite skips if live PG is not configured.
// This guard prevents false passes in CI where no live DB is available.
const maybeDescribe = TEST_DB_URL ? describe : describe.skip

maybeDescribe("LIVE: AC7 gp_core RLS cross-market deny (NEEDS-LIVE-RUN)", () => {
  let pool: Pool
  const marketA = process.env.GP_CORE_RLS_MARKET_A_ID ?? "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
  const marketB = process.env.GP_CORE_RLS_MARKET_B_ID ?? "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  it("market A cannot see rows belonging to market B (cross-market deny)", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SELECT set_config('app.gp_market_id', $1, true)`, [marketA])

      // Any entitlements visible must belong only to market A
      const { rows } = await client.query<{ market_id: string }>(
        `SELECT market_id FROM gp_core.entitlements WHERE market_id != $1`,
        [marketA]
      )
      expect(rows).toHaveLength(0)

      await client.query("COMMIT")
    } finally {
      client.release()
    }
  })

  it("no GUC set → fail-closed: 0 rows without error (UNKNOWN predicate)", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      // Do NOT set app.gp_market_id — policy predicate evaluates to UNKNOWN → 0 rows

      const { rows } = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM gp_core.entitlements`
      )
      expect(rows[0]?.cnt).toBe("0")

      await client.query("COMMIT")
    } finally {
      client.release()
    }
  })

  it("WITH CHECK blocks cross-market INSERT (write isolation)", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SELECT set_config('app.gp_market_id', $1, true)`, [marketA])

      // Attempt INSERT with market_id = marketB (cross-market) — must be rejected by WITH CHECK
      await expect(
        client.query(
          `INSERT INTO gp_core.entitlements (
             market_id, status, voucher_code, face_value_minor, remaining_minor, currency,
             product_name, vendor_name, order_id
           ) VALUES ($1, 'active', 'TEST-DENY', 1000, 1000, 'PLN', 'Test', 'Test', gen_random_uuid())`,
          [marketB]
        )
      ).rejects.toThrow(/row-level security/i)

      await client.query("ROLLBACK")
    } finally {
      client.release()
    }
  })
})
