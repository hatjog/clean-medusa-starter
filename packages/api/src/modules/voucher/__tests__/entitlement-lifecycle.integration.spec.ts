/**
 * Story v180-2-2 BE-1 lifecycle integration.
 * Story v180-2-11 AC5 NULL-policy lifecycle (HG-4 backwards-compat).
 *
 * Run against live local infra with:
 * GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION=1 pnpm test:integration:modules -- --runTestsByPath packages/api/src/modules/voucher/__tests__/entitlement-lifecycle.integration.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import { Pool } from "pg"
import { VoucherService } from ".."
import {
  assertTransition,
  canTransition,
  EntitlementInstanceState,
  EntitlementType,
  snapshotPolicy,
} from "../models/entitlement"

const runLive = process.env.GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION === "1"
const maybeDescribe = runLive ? describe : describe.skip

// ---------------------------------------------------------------------------
// Story 2.11 AC5 (unit-level, no DB) — state machine tolerates NULL policy
// ---------------------------------------------------------------------------

describe("Story 2.11 AC5 (unit) — NULL-policy lifecycle via state machine", () => {
  // A v1.7.0-shaped entitlement_instance has no 10 NEW policy-related snapshot
  // keys. The core state machine (canTransition / assertTransition) must work
  // for the full path ISSUED→ACTIVE→REDEMPTION_REQUESTED→REDEEMED_FULL→
  // SETTLED→CLOSED without any interaction with policy fields.
  const corePath: EntitlementInstanceState[] = [
    EntitlementInstanceState.ISSUED,
    EntitlementInstanceState.ACTIVE,
    EntitlementInstanceState.REDEMPTION_REQUESTED,
    EntitlementInstanceState.REDEEMED_FULL,
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.CLOSED,
  ]

  it("permits full ISSUED→...→CLOSED core path regardless of policy snapshot content", () => {
    for (let i = 0; i < corePath.length - 1; i++) {
      expect(canTransition(corePath[i], corePath[i + 1])).toBe(true)
      expect(() => assertTransition(corePath[i], corePath[i + 1])).not.toThrow()
    }
  })

  it("policy-absent (v1.7.0-shaped) snapshot does not block state transition guards", () => {
    // snapshotPolicy({}) = empty policy — no extension/no_show/transferability keys
    const emptySnapshot = snapshotPolicy({})
    // The snapshot being empty does NOT affect canTransition (pure enum check)
    expect(typeof emptySnapshot).toBe("object")
    expect(canTransition(EntitlementInstanceState.ISSUED, EntitlementInstanceState.ACTIVE)).toBe(true)
    expect(canTransition(EntitlementInstanceState.ACTIVE, EntitlementInstanceState.REDEMPTION_REQUESTED)).toBe(true)
    expect(canTransition(EntitlementInstanceState.REDEMPTION_REQUESTED, EntitlementInstanceState.REDEEMED_FULL)).toBe(true)
    expect(canTransition(EntitlementInstanceState.REDEEMED_FULL, EntitlementInstanceState.SETTLED)).toBe(true)
    expect(canTransition(EntitlementInstanceState.SETTLED, EntitlementInstanceState.CLOSED)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Story 2.11 AC5 (integration, live-infra-gated) — DB lifecycle NULL-policy
// ---------------------------------------------------------------------------

maybeDescribe(
  "Story 2.11 AC5 (integration) — legacy NULL-policy entitlement_instance lifecycle",
  () => {
    let pool: Pool
    const id = "ent_it_2_11_null_policy"

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.DATABASE_URL })
      // Clean up any leftover from previous run
      await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [id])
      // Insert v1.7.0-shaped record: all 10 NEW policy-related columns NULL/absent.
      // The core columns from Migration1778880672656 (Story 2.1) are provided;
      // policy_snapshot is intentionally empty ({}) — no extension/no_show/
      // transferability/refund_channel/auto_redeem/retention_id/entitlement_profile_id keys.
      // expires_at = NULL (BE-1 / Story 2.2 column exists but set NULL = v1.7.0 posture).
      // unpaid_extension_count = 0 (default; Story 2.2 column).
      // booking_pointer = NULL (BE-2 / Story 2.3 column exists but set NULL).
      await pool.query(
        `INSERT INTO entitlement_instance (
           id, entitlement_profile_id, entitlement_type, order_id, state,
           policy_snapshot, expires_at, unpaid_extension_count, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, 0, NOW(), NOW())`,
        [
          id,
          "voucher-kwotowy-365d",
          EntitlementType.VOUCHER_AMOUNT,
          null,
          EntitlementInstanceState.ISSUED,
          JSON.stringify({}),
        ]
      )
    })

    afterAll(async () => {
      if (pool) {
        await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [id])
        await pool.end()
      }
    })

    it(
      "walks ISSUED→ACTIVE→REDEMPTION_REQUESTED→REDEEMED_FULL→SETTLED→CLOSED without error (NULL policy)",
      async () => {
        const transitions: Array<[EntitlementInstanceState, EntitlementInstanceState]> = [
          [EntitlementInstanceState.ISSUED, EntitlementInstanceState.ACTIVE],
          [EntitlementInstanceState.ACTIVE, EntitlementInstanceState.REDEMPTION_REQUESTED],
          [EntitlementInstanceState.REDEMPTION_REQUESTED, EntitlementInstanceState.REDEEMED_FULL],
          [EntitlementInstanceState.REDEEMED_FULL, EntitlementInstanceState.SETTLED],
          [EntitlementInstanceState.SETTLED, EntitlementInstanceState.CLOSED],
        ]

        for (const [fromState, toState] of transitions) {
          // State-machine guard passes (pure TS, no policy read)
          expect(() => assertTransition(fromState, toState)).not.toThrow()

          // DB update — no NOT NULL violation (policy columns remain NULL/0)
          const result = await pool.query(
            `UPDATE entitlement_instance
               SET state = $2, updated_at = NOW()
             WHERE id = $1 AND state = $3
             RETURNING state`,
            [id, toState, fromState]
          )
          // If rowCount=0 the UPDATE was gated on wrong state — detect and fail explicitly
          const row = await pool.query<{ state: string }>(
            `SELECT state FROM entitlement_instance WHERE id = $1`,
            [id]
          )
          expect(row.rows[0]?.state).toBe(toState)
          void result // intentional: used only for side-effect above
        }

        // Final state = CLOSED
        const final = await pool.query<{ state: string; expires_at: unknown; booking_pointer: unknown }>(
          `SELECT state, expires_at, booking_pointer FROM entitlement_instance WHERE id = $1`,
          [id]
        )
        expect(final.rows[0]?.state).toBe(EntitlementInstanceState.CLOSED)
        // NULL policy columns remain NULL throughout — no NOT NULL regression
        expect(final.rows[0]?.expires_at).toBeNull()
      }
    )
  }
)

// ---------------------------------------------------------------------------
// Story 2.2 lifecycle integration — issue → active → extend
// ---------------------------------------------------------------------------

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
