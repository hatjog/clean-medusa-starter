/**
 * voucher/entitlement.test.ts — Story v180-2-1 (ADR-099 4-layer model).
 *
 * Covers:
 *   T1 — Layer 1 EntitlementType enum (6 canonical, 2 active / 4 inactive)
 *   T2 — Layer 2 boundary checks (within-boundary pass, violation reported)
 *   T4 — Layer 4 entitlement_instance state machine (allowed pass / illegal
 *        reject / terminal states) + policy_snapshot immutability post-ISSUED
 */

import { describe, it, expect } from "@jest/globals"
import {
  EntitlementType,
  ALL_ENTITLEMENT_TYPES,
  ACTIVE_ENTITLEMENT_TYPES,
  INACTIVE_ENTITLEMENT_TYPES,
  isActiveEntitlementType,
  isEntitlementType,
  EntitlementInstanceState,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  TERMINAL_ENTITLEMENT_STATES,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
  canTransition,
  assertTransition,
  EntitlementTransitionError,
  snapshotPolicy,
  assertPolicySnapshotImmutable,
} from "../models/entitlement"
import {
  ENTITLEMENT_BOUNDARY,
  checkPolicyAgainstBoundary,
} from "../entitlement-boundary"

// ---------------------------------------------------------------------------
// T1 — Layer 1 enum
// ---------------------------------------------------------------------------

describe("Layer 1 — EntitlementType", () => {
  it("has the 6 canonical taxonomy values in schema order", () => {
    expect(ALL_ENTITLEMENT_TYPES).toEqual([
      "VOUCHER_AMOUNT",
      "VOUCHER_SERVICE",
      "CREDIT_PACK",
      "SUBSCRIPTION_B2C",
      "SUBSCRIPTION_B2B",
      "BUNDLE",
    ])
  })

  it("activates exactly VOUCHER_AMOUNT + VOUCHER_SERVICE in v1.8.0", () => {
    expect([...ACTIVE_ENTITLEMENT_TYPES].sort()).toEqual([
      "VOUCHER_AMOUNT",
      "VOUCHER_SERVICE",
    ])
    expect(isActiveEntitlementType(EntitlementType.VOUCHER_AMOUNT)).toBe(true)
    expect(isActiveEntitlementType(EntitlementType.CREDIT_PACK)).toBe(false)
  })

  it("marks the other 4 defined-but-inactive", () => {
    expect([...INACTIVE_ENTITLEMENT_TYPES].sort()).toEqual([
      "BUNDLE",
      "CREDIT_PACK",
      "SUBSCRIPTION_B2B",
      "SUBSCRIPTION_B2C",
    ])
  })

  it("active ∪ inactive partitions the full taxonomy", () => {
    expect(
      ACTIVE_ENTITLEMENT_TYPES.size + INACTIVE_ENTITLEMENT_TYPES.size
    ).toBe(ALL_ENTITLEMENT_TYPES.length)
  })

  it("narrows unknown values via isEntitlementType", () => {
    expect(isEntitlementType("VOUCHER_AMOUNT")).toBe(true)
    expect(isEntitlementType("NOPE")).toBe(false)
    expect(isEntitlementType(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T4 — Layer 4 state machine
// ---------------------------------------------------------------------------

describe("Layer 4 — entitlement_instance state machine", () => {
  it("permits the core happy path ISSUED→…→CLOSED", () => {
    const path: EntitlementInstanceState[] = [
      EntitlementInstanceState.ISSUED,
      EntitlementInstanceState.ACTIVE,
      EntitlementInstanceState.REDEMPTION_REQUESTED,
      EntitlementInstanceState.REDEEMED_FULL,
      EntitlementInstanceState.SETTLED,
      EntitlementInstanceState.CLOSED,
    ]
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true)
      expect(() => assertTransition(path[i], path[i + 1])).not.toThrow()
    }
  })

  it("permits partial-redemption loop", () => {
    expect(
      canTransition(
        EntitlementInstanceState.REDEEMED_PARTIAL,
        EntitlementInstanceState.REDEMPTION_REQUESTED
      )
    ).toBe(true)
  })

  it("rejects illegal transitions with EntitlementTransitionError", () => {
    expect(
      canTransition(
        EntitlementInstanceState.ISSUED,
        EntitlementInstanceState.SETTLED
      )
    ).toBe(false)
    expect(() =>
      assertTransition(
        EntitlementInstanceState.ISSUED,
        EntitlementInstanceState.CLOSED
      )
    ).toThrow(EntitlementTransitionError)
    try {
      assertTransition(
        EntitlementInstanceState.CLOSED,
        EntitlementInstanceState.ACTIVE
      )
    } catch (e) {
      expect(e).toBeInstanceOf(EntitlementTransitionError)
      expect((e as EntitlementTransitionError).from).toBe(
        EntitlementInstanceState.CLOSED
      )
      expect((e as EntitlementTransitionError).to).toBe(
        EntitlementInstanceState.ACTIVE
      )
    }
  })

  it("treats CLOSED / VOIDED / REFUNDED as terminal (no outbound)", () => {
    for (const t of TERMINAL_ENTITLEMENT_STATES) {
      expect(ALLOWED_ENTITLEMENT_TRANSITIONS[t]).toEqual([])
    }
  })

  it("allows exception transitions (void/expire/dispute) from ACTIVE", () => {
    for (const ex of [
      EntitlementInstanceState.EXPIRED,
      EntitlementInstanceState.VOIDED,
      EntitlementInstanceState.REFUND_REQUESTED,
      EntitlementInstanceState.DISPUTED,
    ]) {
      expect(canTransition(EntitlementInstanceState.ACTIVE, ex)).toBe(true)
    }
  })

  it("covers all 12 states in the transition map", () => {
    expect(Object.keys(ALLOWED_ENTITLEMENT_TRANSITIONS).sort()).toEqual(
      [...ALL_ENTITLEMENT_INSTANCE_STATES].sort()
    )
  })
})

// ---------------------------------------------------------------------------
// T4 — policy_snapshot immutability (regulamin § 12)
// ---------------------------------------------------------------------------

describe("Layer 4 — policy_snapshot immutability post-ISSUED", () => {
  const policy = {
    validity_months: 12,
    extension: { enabled: true, fee_pct: 10 },
  }

  it("snapshotPolicy returns a deeply frozen clone", () => {
    const snap = snapshotPolicy(policy)
    expect(Object.isFrozen(snap)).toBe(true)
    expect(
      Object.isFrozen((snap as Record<string, unknown>).extension)
    ).toBe(true)
    // mutating the source does not bleed into the snapshot
    policy.validity_months = 99
    expect((snap as { validity_months: number }).validity_months).toBe(12)
  })

  it("allows the snapshot to be (re)set while still ISSUED", () => {
    const issued = snapshotPolicy({ validity_months: 12 })
    expect(() =>
      assertPolicySnapshotImmutable(
        EntitlementInstanceState.ISSUED,
        issued,
        snapshotPolicy({ validity_months: 6 })
      )
    ).not.toThrow()
  })

  it("rejects snapshot change once past ISSUED", () => {
    const issued = snapshotPolicy({ validity_months: 12 })
    expect(() =>
      assertPolicySnapshotImmutable(
        EntitlementInstanceState.ACTIVE,
        issued,
        snapshotPolicy({ validity_months: 6 })
      )
    ).toThrow(/immutable after ISSUED/)
    // identical snapshot on a non-ISSUED instance is fine
    expect(() =>
      assertPolicySnapshotImmutable(
        EntitlementInstanceState.ACTIVE,
        issued,
        snapshotPolicy({ validity_months: 12 })
      )
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// T2 — Layer 2 boundary
// ---------------------------------------------------------------------------

describe("Layer 2 — entitlement_boundary", () => {
  it("encodes the AC2 platform maxima/minima", () => {
    expect(ENTITLEMENT_BOUNDARY.validity_months_max).toBe(24)
    expect(ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_max).toBe(15)
    expect(ENTITLEMENT_BOUNDARY.policy.cancellation.cutoff_hours_min).toBe(12)
    expect(ENTITLEMENT_BOUNDARY.policy.cancellation.refund_pct_max).toBe(100)
  })

  it("passes the BonBeauty MVP profile policies (within boundary)", () => {
    // voucher-kwotowy-365d
    expect(
      checkPolicyAgainstBoundary({
        validity_months: 12,
        extension: { enabled: true, fee_pct: 10 },
        cancellation: { enabled: true, cutoff_hours: 24, refund_pct: 100 },
        no_show: { policy: "charge_full", charge_pct: 100 },
        transferability: { transferable: true, max_transfers: 1 },
        refund_channel: "original_payment",
      })
    ).toEqual([])
    // voucher-sezonowy (validity 6, store_credit, forfeit_voucher)
    expect(
      checkPolicyAgainstBoundary({
        validity_months: 6,
        cancellation: { enabled: true, cutoff_hours: 24, refund_pct: 100 },
        no_show: { policy: "forfeit_voucher", charge_pct: 0 },
        transferability: { transferable: true, max_transfers: 1 },
        refund_channel: "store_credit",
      })
    ).toEqual([])
  })

  it("reports each kind of boundary violation", () => {
    const v = checkPolicyAgainstBoundary({
      validity_months: 36, // > 24
      extension: { enabled: true, fee_pct: 25 }, // > 15
      cancellation: { enabled: true, cutoff_hours: 6, refund_pct: 150 }, // < 12, > 100
      no_show: { policy: "charge_double" }, // not in enum
      transferability: { transferable: true, max_transfers: -1 }, // < 0
      refund_channel: "crypto", // not in enum
    })
    const fields = v.map((x) => x.field).sort()
    expect(fields).toEqual(
      [
        "policy.cancellation.cutoff_hours",
        "policy.cancellation.refund_pct",
        "policy.extension.fee_pct",
        "policy.no_show.policy",
        "policy.refund_channel",
        "policy.transferability.max_transfers",
        "policy.validity_months",
      ].sort()
    )
  })

  it("requires validity_months", () => {
    const v = checkPolicyAgainstBoundary({})
    expect(v.some((x) => x.field === "policy.validity_months")).toBe(true)
  })
})
