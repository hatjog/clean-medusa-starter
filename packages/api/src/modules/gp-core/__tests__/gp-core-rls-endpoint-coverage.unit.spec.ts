/**
 * NEEDS-LIVE-RUN — Story 1.4 / ADR-141 §8 gp_core endpoint coverage-test.
 *
 * This suite requires a live gp_core PostgreSQL database with Story 1.1/1.2/1.3
 * migrations applied, role gp_core_runtime present with NOBYPASSRLS, and the
 * connection role allowed to `SET LOCAL ROLE gp_core_runtime`.
 *
 * Run:
 *   GP_CORE_RLS_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/gp_core \
 *     pnpm jest packages/api/src/modules/gp-core/__tests__/gp-core-rls-endpoint-coverage.unit.spec.ts --runInBand
 *
 * Smoke psql:
 *   BEGIN;
 *   SET LOCAL ROLE gp_core_runtime;
 *   SELECT set_config('app.gp_market_id', '<market_a_uuid>', true);
 *   SELECT COUNT(*) FROM gp_core.entitlements WHERE market_id = '<market_b_uuid>'; -- 0
 *   INSERT INTO gp_core.entitlements (
 *     entitlement_id, instance_id, market_id, vendor_id, order_id, line_item_id,
 *     face_value_minor, remaining_minor, currency, status, voucher_code_normalized
 *   ) VALUES (
 *     gen_random_uuid(), 'rls-smoke', '<market_b_uuid>', 'vendor-b',
 *     'order-smoke', 'line-smoke', 1000, 1000, 'PLN', 'ISSUED', 'RLS-SMOKE'
 *   ); -- ERROR: row-level security policy
 *   ROLLBACK;
 *
 * Rollback runbook ADR-141 §8:
 *   1. Set app flag GP_CORE_RLS_ENFORCED=false first; this stops SET LOCAL ROLE.
 *   2. Only if needed, DB rollback: ALTER TABLE ... NO FORCE ROW LEVEL SECURITY;
 *      ALTER TABLE ... DISABLE ROW LEVEL SECURITY. M1 denormalization stays.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, PoolClient } from "pg"

import { GP_MARKET_SESSION_VAR } from "../../../lib/rls-pool-hook"

const TEST_DB_URL = process.env.GP_CORE_RLS_TEST_DATABASE_URL
const maybeDescribe = TEST_DB_URL ? describe : describe.skip

if (!TEST_DB_URL) {
  console.warn(
    "NEEDS-LIVE-RUN: gp_core Story 1.4 endpoint coverage-test skipped; set GP_CORE_RLS_TEST_DATABASE_URL to run against live Postgres."
  )
}

const FIXTURE = {
  instanceId: "story-1-4-rls",
  marketA: "11111111-1111-4111-8111-111111111111",
  marketB: "22222222-2222-4222-8222-222222222222",
  entitlementA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  entitlementB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  smokeEntitlement: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  crossMarketIssue: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
}

const COVERED_ENDPOINTS = ["claim", "redeem", "issue", "read"] as const

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(
    `
      DELETE FROM gp_core.entitlement_audit_log
      WHERE entitlement_id = ANY($1::uuid[])
    `,
    [[FIXTURE.entitlementA, FIXTURE.entitlementB, FIXTURE.smokeEntitlement, FIXTURE.crossMarketIssue]]
  )
  await pool.query(
    `
      DELETE FROM gp_core.redemptions
      WHERE entitlement_id = ANY($1::uuid[])
    `,
    [[FIXTURE.entitlementA, FIXTURE.entitlementB, FIXTURE.smokeEntitlement, FIXTURE.crossMarketIssue]]
  )
  await pool.query(
    `
      DELETE FROM gp_core.entitlements
      WHERE entitlement_id = ANY($1::uuid[])
         OR instance_id = $2
    `,
    [[FIXTURE.entitlementA, FIXTURE.entitlementB, FIXTURE.smokeEntitlement, FIXTURE.crossMarketIssue], FIXTURE.instanceId]
  )
  await pool.query("DELETE FROM gp_core.markets WHERE id = ANY($1::uuid[])", [
    [FIXTURE.marketA, FIXTURE.marketB],
  ])
}

async function seedTwoMarkets(pool: Pool): Promise<void> {
  await cleanup(pool)
  await pool.query(
    `
      INSERT INTO gp_core.markets (id, instance_id, name, slug, status)
      VALUES
        ($1, $3, 'RLS Market A', 'rls-market-a', 'active'),
        ($2, $3, 'RLS Market B', 'rls-market-b', 'active')
      ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
    `,
    [FIXTURE.marketA, FIXTURE.marketB, FIXTURE.instanceId]
  )
  await pool.query(
    `
      INSERT INTO gp_core.entitlements (
        entitlement_id, instance_id, market_id, vendor_id, order_id, line_item_id,
        face_value_minor, remaining_minor, currency, status, voucher_code_normalized
      ) VALUES
        ($1, $5, $3, 'vendor-a', 'order-a', 'line-a', 1000, 1000, 'PLN', 'ISSUED', 'RLS-A-READ'),
        ($2, $5, $4, 'vendor-b', 'order-b', 'line-b', 1000, 1000, 'PLN', 'ISSUED', 'RLS-B-READ')
    `,
    [FIXTURE.entitlementA, FIXTURE.entitlementB, FIXTURE.marketA, FIXTURE.marketB, FIXTURE.instanceId]
  )
}

async function withRuntimeTransaction<T>(
  pool: Pool,
  marketId: string | null,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE gp_core_runtime")
    if (marketId) {
      await client.query(`SELECT set_config('${GP_MARKET_SESSION_VAR}', $1, true)`, [marketId])
    }
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

maybeDescribe("NEEDS-LIVE-RUN Story 1.4 gp_core RLS endpoint coverage-test", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL })
    await seedTwoMarkets(pool)
  })

  afterAll(async () => {
    if (pool) {
      await cleanup(pool)
      await pool.end()
    }
  })

  it("reports the endpoint operations covered by the cross-market suite", () => {
    console.info(`Story 1.4 gp_core RLS covered endpoints: ${COVERED_ENDPOINTS.join(", ")}`)
    expect(COVERED_ENDPOINTS).toEqual(["claim", "redeem", "issue", "read"])
  })

  it("read endpoint operation returns 0 rows for market B data in market A context", async () => {
    const rows = await withRuntimeTransaction(pool, FIXTURE.marketA, async (client) => {
      const result = await client.query(
        `
          SELECT entitlement_id
          FROM gp_core.entitlements
          WHERE entitlement_id = $1
             OR voucher_code_normalized = 'RLS-B-READ'
        `,
        [FIXTURE.entitlementB]
      )
      return result.rows
    })

    expect(rows).toHaveLength(0)
  })

  it("claim endpoint operation cannot mutate market B entitlement from market A context", async () => {
    const rowCount = await withRuntimeTransaction(pool, FIXTURE.marketA, async (client) => {
      const result = await client.query(
        `
          UPDATE gp_core.entitlements
          SET status = 'ACTIVE'
          WHERE entitlement_id = $1
        `,
        [FIXTURE.entitlementB]
      )
      return result.rowCount
    })

    expect(rowCount).toBe(0)
    const check = await pool.query("SELECT status FROM gp_core.entitlements WHERE entitlement_id = $1", [
      FIXTURE.entitlementB,
    ])
    expect(check.rows[0]?.status).toBe("ISSUED")
  })

  it("redeem endpoint operation is rejected when inserting market B redemption from market A context", async () => {
    await expect(
      withRuntimeTransaction(pool, FIXTURE.marketA, async (client) => {
        await client.query(
          `
            INSERT INTO gp_core.redemptions (
              entitlement_id, market_id, amount_minor, remaining_minor_after,
              status_after, idempotency_key, actor_hint
            ) VALUES ($1, $2, 1000, 0, 'REDEEMED', 'rls-cross-market-redeem', 'vendor')
          `,
          [FIXTURE.entitlementB, FIXTURE.marketB]
        )
      })
    ).rejects.toThrow(/row-level security|violates row-level|permission denied/i)
  })

  it("issue endpoint operation is rejected when inserting market B entitlement from market A context", async () => {
    await expect(
      withRuntimeTransaction(pool, FIXTURE.marketA, async (client) => {
        await client.query(
          `
            INSERT INTO gp_core.entitlements (
              entitlement_id, instance_id, market_id, vendor_id, order_id, line_item_id,
              face_value_minor, remaining_minor, currency, status, voucher_code_normalized
            ) VALUES ($1, $2, $3, 'vendor-b', 'order-cross', 'line-cross', 1000, 1000, 'PLN', 'ISSUED', 'RLS-CROSS-ISSUE')
          `,
          [FIXTURE.crossMarketIssue, FIXTURE.instanceId, FIXTURE.marketB]
        )
      })
    ).rejects.toThrow(/row-level security|violates row-level|permission denied/i)
  })

  it("no market context is fail-closed: 0 rows for read/claim and write rejection", async () => {
    const result = await withRuntimeTransaction(pool, null, async (client) => {
      const read = await client.query("SELECT entitlement_id FROM gp_core.entitlements")
      const claim = await client.query(
        "UPDATE gp_core.entitlements SET status = 'ACTIVE' WHERE entitlement_id = $1",
        [FIXTURE.entitlementB]
      )
      return { readRows: read.rows.length, claimRowCount: claim.rowCount }
    })

    expect(result).toEqual({ readRows: 0, claimRowCount: 0 })
    await expect(
      withRuntimeTransaction(pool, null, async (client) => {
        await client.query(
          `
            INSERT INTO gp_core.entitlements (
              entitlement_id, instance_id, market_id, vendor_id, order_id, line_item_id,
              face_value_minor, remaining_minor, currency, status, voucher_code_normalized
            ) VALUES ($1, $2, $3, 'vendor-a', 'order-no-context', 'line-no-context', 1000, 1000, 'PLN', 'ISSUED', 'RLS-NO-CONTEXT')
          `,
          [FIXTURE.crossMarketIssue, FIXTURE.instanceId, FIXTURE.marketA]
        )
      })
    ).rejects.toThrow(/row-level security|violates row-level|permission denied/i)
  })

  it("smoke non-regression: legal issue to claim to redeem to ledger works within market A context", async () => {
    const smoke = await withRuntimeTransaction(pool, FIXTURE.marketA, async (client) => {
      await client.query(
        `
          INSERT INTO gp_core.entitlements (
            entitlement_id, instance_id, market_id, vendor_id, order_id, line_item_id,
            face_value_minor, remaining_minor, currency, status, voucher_code_normalized
          ) VALUES ($1, $2, $3, 'vendor-a', 'order-smoke', 'line-smoke', 1000, 1000, 'PLN', 'ISSUED', 'RLS-SMOKE')
        `,
        [FIXTURE.smokeEntitlement, FIXTURE.instanceId, FIXTURE.marketA]
      )

      const claim = await client.query(
        "UPDATE gp_core.entitlements SET status = 'ACTIVE' WHERE entitlement_id = $1",
        [FIXTURE.smokeEntitlement]
      )
      await client.query(
        `
          INSERT INTO gp_core.redemptions (
            entitlement_id, market_id, amount_minor, remaining_minor_after,
            status_after, idempotency_key, actor_hint
          ) VALUES ($1, $2, 1000, 0, 'REDEEMED', 'rls-smoke-redeem', 'vendor')
        `,
        [FIXTURE.smokeEntitlement, FIXTURE.marketA]
      )
      const redeem = await client.query(
        "UPDATE gp_core.entitlements SET status = 'REDEEMED', remaining_minor = 0 WHERE entitlement_id = $1",
        [FIXTURE.smokeEntitlement]
      )
      await client.query(
        `
          INSERT INTO gp_core.entitlement_audit_log (
            entitlement_id, market_id, action, actor_type, actor_id, old_status, new_status, metadata
          ) VALUES ($1, $2, 'redeem', 'vendor', 'vendor-a', 'ACTIVE', 'REDEEMED', '{"story":"1.4"}'::jsonb)
        `,
        [FIXTURE.smokeEntitlement, FIXTURE.marketA]
      )
      const ledger = await client.query(
        "SELECT COUNT(*)::int AS count FROM gp_core.entitlement_audit_log WHERE entitlement_id = $1",
        [FIXTURE.smokeEntitlement]
      )

      return {
        claimRowCount: claim.rowCount,
        redeemRowCount: redeem.rowCount,
        ledgerCount: ledger.rows[0]?.count,
      }
    })

    expect(smoke).toEqual({ claimRowCount: 1, redeemRowCount: 1, ledgerCount: 1 })
  })
})
