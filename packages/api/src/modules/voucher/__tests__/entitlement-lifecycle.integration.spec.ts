/**
 * Story v180-2-2 BE-1 lifecycle integration.
 *
 * Run against live local infra with:
 * GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION=1 pnpm test:integration:modules -- --runTestsByPath packages/api/src/modules/voucher/__tests__/entitlement-lifecycle.integration.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import { Pool } from "pg"
import { VoucherService } from ".."
import {
  EntitlementInstanceState,
  EntitlementType,
  snapshotPolicy,
} from "../models/entitlement"

const runLive = process.env.GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION === "1"
const maybeDescribe = runLive ? describe : describe.skip

maybeDescribe("Story 2.2 lifecycle integration — issue → active → extend", () => {
  let pool: Pool
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = []
  const id = "ent_it_be1_lifecycle"

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [id])
    await pool.query(
      `INSERT INTO entitlement_instance (
         id, entitlement_profile_id, entitlement_type, order_id, state,
         policy_snapshot, expires_at, unpaid_extension_count, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 0, $8, $8)`,
      [
        id,
        "voucher-kwotowy-365d",
        EntitlementType.VOUCHER_AMOUNT,
        "order_be1_lifecycle",
        EntitlementInstanceState.ISSUED,
        JSON.stringify(
          snapshotPolicy({
            validity_months: 12,
            extension: {
              allowed: true,
              paid: true,
              fee_pct: 10,
              max_extension_months: 6,
            },
          })
        ),
        new Date("2026-06-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      ]
    )
    await pool.query(
      `UPDATE entitlement_instance
          SET state = $2, updated_at = NOW()
        WHERE id = $1`,
      [id, EntitlementInstanceState.ACTIVE]
    )
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [id])
      await pool.end()
    }
  })

  it("extends paid voucher expiry end-to-end", async () => {
    const service = new VoucherService({
      [Modules.EVENT_BUS]: {
        async emit(message: { name: string; data: Record<string, unknown> }) {
          emitted.push(message)
        },
      },
    })
    service._testPool = pool

    const result = await service.extend(id, {
      paid: true,
      actor: "integration-test",
      source: "entitlement-lifecycle.integration",
      now: new Date("2026-05-16T12:00:00.000Z"),
    })

    const row = await pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM entitlement_instance WHERE id = $1`,
      [id]
    )
    expect(result.new_expires_at.toISOString()).toBe("2026-12-01T00:00:00.000Z")
    expect(new Date(row.rows[0].expires_at).toISOString()).toBe(
      "2026-12-01T00:00:00.000Z"
    )
    expect(emitted).toHaveLength(1)
  })
})
