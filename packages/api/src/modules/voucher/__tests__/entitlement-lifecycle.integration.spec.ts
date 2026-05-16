/**
 * Story v180-2-2 BE-1 lifecycle integration.
 * Story v180-2-11 AC5 NULL-policy lifecycle (HG-4 backwards-compat).
 * Story v180-2-6 BE-5 transferability lifecycle.
 *
 * Run against live local infra with:
 * GP_RUN_VOUCHER_LIFECYCLE_INTEGRATION=1 pnpm test:integration:modules -- --runTestsByPath packages/api/src/modules/voucher/__tests__/entitlement-lifecycle.integration.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import { Pool } from "pg"
import { VoucherService, ENTITLEMENT_REFUND_APPLIED_EVENT } from ".."
import {
  TransferabilityError,
  assertTransferabilityAllowed,
} from "../entitlement-boundary"
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

// ---------------------------------------------------------------------------
// Story 2.8 BE-7: issue → active → refund_request(store_credit) lifecycle
// ---------------------------------------------------------------------------

const idRefund = "ent_it_be7_lifecycle"

maybeDescribe("Story 2.8 lifecycle integration — issue → active → refund_request(store_credit)", () => {
  let pool: Pool
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = []

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    await pool.query(`DELETE FROM voucher_event WHERE entitlement_id = $1`, [idRefund])
    await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [idRefund])
    // Note: inserting directly in ACTIVE state for test simplicity — the
    // ISSUED → ACTIVE transition is bypassed here. The full state-machine
    // lifecycle (ISSUED → ACTIVE transition guard) is covered by the Story 2.1
    // unit tests; this test focuses on the refund_request() behavior.
    await pool.query(
      `INSERT INTO entitlement_instance (
         id, entitlement_profile_id, entitlement_type, order_id, state,
         policy_snapshot, expires_at, unpaid_extension_count, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 0, $8, $8)`,
      [
        idRefund,
        "voucher-kwotowy-365d",
        EntitlementType.VOUCHER_AMOUNT,
        "order_be7_lifecycle",
        EntitlementInstanceState.ACTIVE,
        JSON.stringify(
          snapshotPolicy({
            validity_months: 12,
            refund_channel: "store_credit",
          })
        ),
        new Date("2027-01-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      ]
    )
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM voucher_event WHERE entitlement_id = $1`, [idRefund])
      await pool.query(`DELETE FROM entitlement_instance WHERE id = $1`, [idRefund])
      await pool.end()
    }
  })

  it("routes refund to store_credit, persists event, emits audit envelope", async () => {
    const service = new VoucherService({
      [Modules.EVENT_BUS]: {
        async emit(message: { name: string; data: Record<string, unknown> }) {
          emitted.push(message)
        },
      },
    })
    service._testPool = pool

    const result = await service.refund_request(idRefund, {
      refund_id: "refund_be7_lifecycle_001",
      amount: 5000,
      currency: "PLN",
    })

    expect(result.refund_channel).toBe("store_credit")
    expect(result.idempotent).toBe(false)

    // Event persisted in voucher_event table
    const evtRow = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM voucher_event
        WHERE entitlement_id = $1
          AND event_type = $2
          AND payload->>'refund_id' = $3`,
      [idRefund, ENTITLEMENT_REFUND_APPLIED_EVENT, "refund_be7_lifecycle_001"]
    )
    expect(evtRow.rows).toHaveLength(1)
    expect(evtRow.rows[0].payload.refund_channel).toBe("store_credit")
    expect(evtRow.rows[0].payload.refunded_amount_minor).toBe(5000)

    // Event emitted via event bus
    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe(ENTITLEMENT_REFUND_APPLIED_EVENT)
  })

  it("idempotency — re-trigger with same refund_id produces no second event", async () => {
    const service = new VoucherService({
      [Modules.EVENT_BUS]: {
        async emit(message: { name: string; data: Record<string, unknown> }) {
          emitted.push(message)
        },
      },
    })
    service._testPool = pool

    const emittedBefore = emitted.length

    const result = await service.refund_request(idRefund, {
      refund_id: "refund_be7_lifecycle_001", // same id
      amount: 5000,
      currency: "PLN",
    })

    expect(result.idempotent).toBe(true)
    expect(emitted.length).toBe(emittedBefore) // no new emission

    // Still only one event row in DB
    const evtRows = await pool.query(
      `SELECT id FROM voucher_event
        WHERE entitlement_id = $1
          AND payload->>'refund_id' = $2`,
      [idRefund, "refund_be7_lifecycle_001"]
    )
    expect(evtRows.rows).toHaveLength(1)
  })
})
