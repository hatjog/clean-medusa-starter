/**
 * Story v180-2-2 BE-1 lifecycle integration + Story v180-2-6 BE-5 lifecycle.
 *
 * Run against live local infra with:
 * GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION=1 pnpm test:integration:modules -- --runTestsByPath packages/api/src/modules/voucher/__tests__/entitlement-lifecycle.integration.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import { Pool } from "pg"
import { VoucherService } from ".."
import {
  TransferabilityError,
  assertTransferabilityAllowed,
} from "../entitlement-boundary"
import {
  EntitlementInstanceState,
  EntitlementType,
  snapshotPolicy,
} from "../models/entitlement"

const runLive = process.env.GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION === "1"
const maybeDescribe = runLive ? describe : describe.skip

// ---------------------------------------------------------------------------
// Story 2.6 BE-5 — Transferability lifecycle
// issue(personalized + recipient bound) → active → redeem mismatch → reject;
//                                                   redeem match → OK
//
// Authored-vs-applied posture (Story 2.2 M5 precedent): there is no live
// redeem entry-point in v1.8.0; guard is tested as pure function here.
// Wiring to a live redeem service is tracked as a downstream dependency
// (FR1.22 joint Story 1.3 / issuance story). Live DB assertions are gated
// behind GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION to mirror Story 2.1/2.2/0.18.
// ---------------------------------------------------------------------------

maybeDescribe("Story 2.6 lifecycle integration — issue(personalized) → redeem guard", () => {
  let pool: Pool
  const id = "ent_it_be5_lifecycle"
  const recipientId = "cust_be5_recipient"
  const strangerId = "cust_be5_stranger"

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
        "order_be5_lifecycle",
        EntitlementInstanceState.ISSUED,
        JSON.stringify(
          snapshotPolicy({
            validity_months: 12,
            transferability: "personalized",
          })
        ),
        new Date("2026-06-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      ]
    )
    await pool.query(
      `UPDATE entitlement_instance SET state = $2, updated_at = NOW() WHERE id = $1`,
      [id, EntitlementInstanceState.ACTIVE]
    )
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [id])
      await pool.end()
    }
  })

  it("personalized → redeem by stranger → reject (TransferabilityError)", async () => {
    const row = await pool.query<{ policy_snapshot: unknown }>(
      `SELECT policy_snapshot FROM entitlement_instance WHERE id = $1`,
      [id]
    )
    const snapshot = row.rows[0].policy_snapshot as Record<string, unknown>

    expect(() =>
      assertTransferabilityAllowed(snapshot, {
        customer_id: strangerId,
        recipient_customer_id: recipientId,
      })
    ).toThrow(TransferabilityError)
  })

  it("personalized → redeem by recipient → OK (softFlag=false)", async () => {
    const row = await pool.query<{ policy_snapshot: unknown }>(
      `SELECT policy_snapshot FROM entitlement_instance WHERE id = $1`,
      [id]
    )
    const snapshot = row.rows[0].policy_snapshot as Record<string, unknown>

    expect(
      assertTransferabilityAllowed(snapshot, {
        customer_id: recipientId,
        recipient_customer_id: recipientId,
      })
    ).toEqual({ softFlag: false })
  })
})

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
