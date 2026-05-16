/**
 * entitlement-auto-redeem.test.ts — Story 2.9 (BE-8) unit tests.
 *
 * Covers AC4, AC6 cases (a)-(f):
 *   (a) enabled=true + on_appointment_confirm + ACTIVE → REDEEMED_FULL + event
 *   (b) enabled=false → no-op
 *   (c) trigger ∈ {on_service_complete, manual_only} → no-op
 *   (d) no auto_redeem in snapshot → no-op
 *   (e) idempotency: 2× same event → exactly 1 redeem + 1 event (replay = no-op)
 *   (f) disallowed source state (VOIDED/EXPIRED/already-REDEEMED_FULL) → controlled
 *
 * Integration/lifecycle test (issue→active→booking-confirmed→REDEEMED_FULL + event;
 * replay→idempotent no-op): authored as a unit-level lifecycle simulation using the
 * InMemoryRedeemEntitlementStore. Live DB integration apply-path: standard
 * `pnpm test:integration:modules` suite; infra DB not available in worktree
 * (mirror Story 2.1/2.5 authored-not-applied posture for live-DB tests).
 */

import { describe, it, expect, jest } from "@jest/globals"

import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  shouldAutoRedeemOnBookingConfirm,
  snapshotPolicy,
} from "../models/entitlement"
import {
  RedeemEntitlementWorkflow,
  InMemoryRedeemEntitlementStore,
  EntitlementNotFoundError,
  type RedeemableEntitlement,
  type RedeemEntitlementEventEmitter,
} from "../workflows/redeem-entitlement"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntitlement(
  overrides: Partial<RedeemableEntitlement> = {}
): RedeemableEntitlement {
  return {
    id: "ent-001",
    state: EntitlementInstanceState.ACTIVE,
    policy_snapshot: snapshotPolicy({
      auto_redeem: { enabled: true, trigger: "on_appointment_confirm" },
    }),
    order_id: "ord-001",
    market_id: "bonbeauty",
    ...overrides,
  }
}

function makeWorkflow(
  entitlements: RedeemableEntitlement[],
  emitFn: RedeemEntitlementEventEmitter["emit"] = jest.fn<RedeemEntitlementEventEmitter["emit"]>().mockResolvedValue(undefined)
): {
  workflow: RedeemEntitlementWorkflow
  store: InMemoryRedeemEntitlementStore
  emitFn: RedeemEntitlementEventEmitter["emit"]
} {
  const store = new InMemoryRedeemEntitlementStore(entitlements)
  const workflow = new RedeemEntitlementWorkflow(store, { emit: emitFn })
  return { workflow, store, emitFn }
}

const BASE_INPUT = {
  entitlement_id: "ent-001",
  booking_ref: "booking-abc-123",
} as const

// ---------------------------------------------------------------------------
// shouldAutoRedeemOnBookingConfirm — pure predicate
// ---------------------------------------------------------------------------

describe("shouldAutoRedeemOnBookingConfirm", () => {
  it("returns true for enabled=true + on_appointment_confirm", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: true, trigger: "on_appointment_confirm" } })
      )
    ).toBe(true)
  })

  it("returns false for enabled=false", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: false, trigger: "on_appointment_confirm" } })
      )
    ).toBe(false)
  })

  it("returns false for trigger=on_service_complete", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: true, trigger: "on_service_complete" } })
      )
    ).toBe(false)
  })

  it("returns false for trigger=manual_only", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: true, trigger: "manual_only" } })
      )
    ).toBe(false)
  })

  it("returns false when auto_redeem key is absent from snapshot", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(snapshotPolicy({ validity_months: 12 }))
    ).toBe(false)
  })

  it("returns false when trigger is undefined", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: true } })
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RedeemEntitlementWorkflow — case (a): happy path
// ---------------------------------------------------------------------------

describe("RedeemEntitlementWorkflow — case (a) happy path", () => {
  it("transitions ACTIVE → REDEEMED_FULL and emits event", async () => {
    const { workflow, store, emitFn } = makeWorkflow([makeEntitlement()])

    const result = await workflow.redeem(BASE_INPUT)

    expect(result.entitlement_id).toBe("ent-001")
    expect(result.new_state).toBe(EntitlementInstanceState.REDEEMED_FULL)
    expect(result.idempotent).toBe(false)
    expect(result.event.event_type).toBe("gp.entitlements.entitlement_redeemed.v1")
    expect(result.event.payload.new_status).toBe("REDEEMED")
    expect(result.event.payload.remaining_minor_after).toBe(0)
    expect(result.event.payload.amount_minor).toBeGreaterThanOrEqual(1)
    expect(result.event.idempotency_key).toContain("ent-001")
    expect(result.event.idempotency_key).toContain("booking-abc-123")

    // State persisted
    expect(store.get("ent-001")?.state).toBe(EntitlementInstanceState.REDEEMED_FULL)

    // Event emitted exactly once
    expect(emitFn).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Case (e): idempotency — 2× same event → exactly 1 redeem + 1 event
// ---------------------------------------------------------------------------

describe("RedeemEntitlementWorkflow — case (e) idempotency", () => {
  it("second call is no-op: state stays REDEEMED_FULL, no second event", async () => {
    const { workflow, store, emitFn } = makeWorkflow([makeEntitlement()])

    const first = await workflow.redeem(BASE_INPUT)
    expect(first.idempotent).toBe(false)
    expect(emitFn).toHaveBeenCalledTimes(1)

    // Second call — entitlement is now REDEEMED_FULL
    const second = await workflow.redeem(BASE_INPUT)
    expect(second.idempotent).toBe(true)
    expect(second.new_state).toBe(EntitlementInstanceState.REDEEMED_FULL)

    // No second event emitted
    expect(emitFn).toHaveBeenCalledTimes(1)

    // State unchanged
    expect(store.get("ent-001")?.state).toBe(EntitlementInstanceState.REDEEMED_FULL)
  })

  it("deterministic idempotency_key: same inputs produce same key", async () => {
    const { workflow } = makeWorkflow([makeEntitlement()])
    const r1 = await workflow.redeem(BASE_INPUT)

    const { workflow: w2 } = makeWorkflow([makeEntitlement()])
    const r2 = await w2.redeem(BASE_INPUT)

    expect(r1.event.idempotency_key).toBe(r2.event.idempotency_key)
  })
})

// ---------------------------------------------------------------------------
// Case (b): enabled=false → no-op (subscriber gate handles this, but workflow
// is called only after gate passes; test the gate directly)
// ---------------------------------------------------------------------------

describe("shouldAutoRedeemOnBookingConfirm gate — case (b) enabled=false", () => {
  it("gate returns false → subscriber does not call workflow", () => {
    const snapshot = snapshotPolicy({
      auto_redeem: { enabled: false, trigger: "on_appointment_confirm" },
    })
    expect(shouldAutoRedeemOnBookingConfirm(snapshot)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Case (c): trigger not in booking-confirm set → no-op (gate)
// ---------------------------------------------------------------------------

describe("shouldAutoRedeemOnBookingConfirm gate — case (c) wrong trigger", () => {
  it("on_service_complete → false", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: true, trigger: "on_service_complete" } })
      )
    ).toBe(false)
  })

  it("manual_only → false", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(
        snapshotPolicy({ auto_redeem: { enabled: true, trigger: "manual_only" } })
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Case (d): no auto_redeem in snapshot → no-op (gate)
// ---------------------------------------------------------------------------

describe("shouldAutoRedeemOnBookingConfirm gate — case (d) missing key", () => {
  it("returns false defensively when auto_redeem absent", () => {
    expect(
      shouldAutoRedeemOnBookingConfirm(snapshotPolicy({ validity_months: 12 }))
    ).toBe(false)
  })

  it("returns false when snapshot is empty", () => {
    expect(shouldAutoRedeemOnBookingConfirm(snapshotPolicy({}))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Case (f): disallowed source states
// ---------------------------------------------------------------------------

describe("RedeemEntitlementWorkflow — case (f) disallowed source states", () => {
  it("VOIDED → EntitlementTransitionError (not uncontrolled exception)", async () => {
    const { workflow } = makeWorkflow([
      makeEntitlement({ state: EntitlementInstanceState.VOIDED }),
    ])
    await expect(workflow.redeem(BASE_INPUT)).rejects.toThrow(
      EntitlementTransitionError
    )
  })

  it("EXPIRED → EntitlementTransitionError", async () => {
    const { workflow } = makeWorkflow([
      makeEntitlement({ state: EntitlementInstanceState.EXPIRED }),
    ])
    await expect(workflow.redeem(BASE_INPUT)).rejects.toThrow(
      EntitlementTransitionError
    )
  })

  it("CLOSED → EntitlementTransitionError", async () => {
    const { workflow } = makeWorkflow([
      makeEntitlement({ state: EntitlementInstanceState.CLOSED }),
    ])
    await expect(workflow.redeem(BASE_INPUT)).rejects.toThrow(
      EntitlementTransitionError
    )
  })

  it("not found → EntitlementNotFoundError", async () => {
    const { workflow } = makeWorkflow([])
    await expect(workflow.redeem(BASE_INPUT)).rejects.toThrow(
      EntitlementNotFoundError
    )
  })
})

// ---------------------------------------------------------------------------
// Integration/lifecycle simulation (unit-level with InMemoryStore)
// AC6: issue → active → booking-confirmed → REDEEMED_FULL + event;
//       replay booking-confirmed → no second redeem/event
//
// Live DB integration apply-path: `pnpm test:integration:modules` with a real
// postgres instance; authored here as a lifecycle simulation since infra DB is
// not available in worktree (mirror Story 2.1/2.5 authored-not-applied posture).
// ---------------------------------------------------------------------------

describe("Integration/lifecycle simulation — full redemption cycle", () => {
  it("lifecycle: ACTIVE → REDEEMED_FULL + event; replay → idempotent no-op", async () => {
    const emitFn = jest.fn<RedeemEntitlementEventEmitter["emit"]>().mockResolvedValue(undefined)
    const store = new InMemoryRedeemEntitlementStore([
      makeEntitlement({ state: EntitlementInstanceState.ACTIVE }),
    ])
    const workflow = new RedeemEntitlementWorkflow(store, { emit: emitFn })

    // Simulate booking-confirmation event received for entitlement in ACTIVE state.
    const bookingEvent = { entitlement_id: "ent-001", booking_ref: "bk-xyz" }

    // Gate check (as subscriber does)
    const ent = store.get("ent-001")!
    expect(shouldAutoRedeemOnBookingConfirm(ent.policy_snapshot)).toBe(true)

    // First delivery → redeem
    const r1 = await workflow.redeem(bookingEvent)
    expect(r1.idempotent).toBe(false)
    expect(store.get("ent-001")?.state).toBe(EntitlementInstanceState.REDEEMED_FULL)
    expect(emitFn).toHaveBeenCalledTimes(1)
    const emittedEvent = emitFn.mock.calls[0]?.[0]
    expect(emittedEvent?.payload.new_status).toBe("REDEEMED")
    expect(emittedEvent?.payload.remaining_minor_after).toBe(0)

    // Second delivery (replay) → idempotent no-op
    const r2 = await workflow.redeem(bookingEvent)
    expect(r2.idempotent).toBe(true)
    expect(emitFn).toHaveBeenCalledTimes(1) // still 1, no second emit

    // State unchanged
    expect(store.get("ent-001")?.state).toBe(EntitlementInstanceState.REDEEMED_FULL)
  })

  it("lifecycle: REDEMPTION_REQUESTED (partial progress) → resumes to REDEEMED_FULL", async () => {
    // Simulates a scenario where ACTIVE→REDEMPTION_REQUESTED succeeded but the
    // process was interrupted before REDEMPTION_REQUESTED→REDEEMED_FULL.
    const emitFn = jest.fn<RedeemEntitlementEventEmitter["emit"]>().mockResolvedValue(undefined)
    const store = new InMemoryRedeemEntitlementStore([
      makeEntitlement({ state: EntitlementInstanceState.REDEMPTION_REQUESTED }),
    ])
    const workflow = new RedeemEntitlementWorkflow(store, { emit: emitFn })

    const result = await workflow.redeem(BASE_INPUT)
    expect(result.idempotent).toBe(false)
    expect(store.get("ent-001")?.state).toBe(EntitlementInstanceState.REDEEMED_FULL)
    expect(emitFn).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Event envelope shape validation
// ---------------------------------------------------------------------------

describe("RedeemEntitlementWorkflow — event envelope shape", () => {
  it("emits correct entitlement_redeemed.v1 envelope structure", async () => {
    const emitFn = jest.fn<RedeemEntitlementEventEmitter["emit"]>().mockResolvedValue(undefined)
    const { workflow } = makeWorkflow([makeEntitlement()], emitFn)

    await workflow.redeem(BASE_INPUT)

    const envelope = emitFn.mock.calls[0]?.[0]
    expect(envelope).toMatchObject({
      schema_version: "1",
      event_type: "gp.entitlements.entitlement_redeemed.v1",
      actor: "system",
      scope: {
        instance_id: "ent-001",
        market_id: "bonbeauty",
      },
      payload: {
        entitlement_id: "ent-001",
        remaining_minor_after: 0,
        new_status: "REDEEMED",
        actor_hint: "system:auto-redeem:booking-confirm",
      },
    })
    expect(typeof envelope?.occurred_at).toBe("string")
    expect(typeof envelope?.payload.redemption_id).toBe("string")
    expect(typeof envelope?.payload.redeemed_at).toBe("string")
    expect(typeof envelope?.payload.currency).toBe("string")
    expect(envelope?.payload.amount_minor).toBeGreaterThanOrEqual(1)
  })
})
