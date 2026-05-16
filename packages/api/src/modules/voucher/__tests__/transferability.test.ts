/**
 * transferability.test.ts — Story 2.6 BE-5 (FR1.16) unit tests.
 *
 * Covers AC6 cases (a)-(h):
 *   (a) bearer + anonymous redeem → OK
 *   (b) personalized + matching customer_id → OK
 *   (c) personalized + mismatch customer_id → reject (TransferabilityError)
 *   (d) personalized + no redeeming identity → reject
 *   (e) hybrid + mismatch → allow with softFlag=true (NOT throw)
 *   (f) hybrid + no identity → allow
 *   (g) value outside enum in policy_snapshot → reject
 *   (h) policy_snapshot.transferability immutability post-ISSUED → throw
 *       (covered via existing assertPolicySnapshotImmutable in entitlement.test.ts;
 *        tested here with transferability sub-key per AC5)
 */

import { describe, expect, it } from "@jest/globals"
import {
  TRANSFERABILITY_VALUES,
  TransferabilityError,
  assertTransferabilityAllowed,
} from "../entitlement-boundary"
import {
  EntitlementInstanceState,
  assertPolicySnapshotImmutable,
  snapshotPolicy,
} from "../models/entitlement"

// ---------------------------------------------------------------------------
// TRANSFERABILITY_VALUES enum definition
// ---------------------------------------------------------------------------

describe("TRANSFERABILITY_VALUES — boundary enum", () => {
  it("contains exactly bearer, personalized, hybrid", () => {
    expect([...TRANSFERABILITY_VALUES].sort()).toEqual(
      ["bearer", "hybrid", "personalized"].sort()
    )
  })
})

// ---------------------------------------------------------------------------
// assertTransferabilityAllowed — pure guard
// ---------------------------------------------------------------------------

describe("assertTransferabilityAllowed", () => {
  // (a) bearer — anonymous redeem OK
  it("(a) bearer + no customer_id → allow (softFlag=false)", () => {
    const snap = snapshotPolicy({ validity_months: 12, transferability: "bearer" })
    expect(
      assertTransferabilityAllowed(snap, { customer_id: null })
    ).toEqual({ softFlag: false })
  })

  it("(a) bearer + any customer_id → allow (softFlag=false)", () => {
    const snap = snapshotPolicy({ validity_months: 12, transferability: "bearer" })
    expect(
      assertTransferabilityAllowed(snap, {
        customer_id: "cust_stranger",
        recipient_customer_id: "cust_owner",
      })
    ).toEqual({ softFlag: false })
  })

  // (b) personalized + matching customer_id → OK
  it("(b) personalized + matching customer_id → allow (softFlag=false)", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "personalized",
    })
    expect(
      assertTransferabilityAllowed(snap, {
        customer_id: "cust_abc",
        recipient_customer_id: "cust_abc",
      })
    ).toEqual({ softFlag: false })
  })

  // (c) personalized + mismatch → reject
  it("(c) personalized + mismatch customer_id → throws TransferabilityError", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "personalized",
    })
    expect(() =>
      assertTransferabilityAllowed(snap, {
        customer_id: "cust_stranger",
        recipient_customer_id: "cust_owner",
      })
    ).toThrow(TransferabilityError)
  })

  it("(c) personalized mismatch error carries correct fields", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "personalized",
    })
    try {
      assertTransferabilityAllowed(snap, {
        customer_id: "cust_x",
        recipient_customer_id: "cust_y",
      })
    } catch (e) {
      expect(e).toBeInstanceOf(TransferabilityError)
      const te = e as TransferabilityError
      expect(te.transferability).toBe("personalized")
      expect(te.redeemCustomerId).toBe("cust_x")
      expect(te.recipientCustomerId).toBe("cust_y")
      return
    }
    throw new Error("Expected TransferabilityError but did not throw")
  })

  // (d) personalized + no redeeming identity → reject
  it("(d) personalized + no redeeming identity → throws TransferabilityError", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "personalized",
    })
    expect(() =>
      assertTransferabilityAllowed(snap, {
        customer_id: null,
        recipient_customer_id: "cust_owner",
      })
    ).toThrow(TransferabilityError)
  })

  it("(d) personalized + absent customer_id (undefined) → throws TransferabilityError", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "personalized",
    })
    expect(() =>
      assertTransferabilityAllowed(snap, {
        recipient_customer_id: "cust_owner",
      })
    ).toThrow(TransferabilityError)
  })

  // (e) hybrid + mismatch → allow with softFlag=true (NOT throw)
  it("(e) hybrid + mismatch customer_id → allow with softFlag=true", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "hybrid",
    })
    const result = assertTransferabilityAllowed(snap, {
      customer_id: "cust_stranger",
      recipient_customer_id: "cust_owner",
    })
    expect(result).toEqual({ softFlag: true })
  })

  // (f) hybrid + no identity → allow
  it("(f) hybrid + no identity → allow (softFlag=false)", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "hybrid",
    })
    expect(
      assertTransferabilityAllowed(snap, { customer_id: null })
    ).toEqual({ softFlag: false })
  })

  it("(f) hybrid + matching identity → allow (softFlag=false)", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "hybrid",
    })
    expect(
      assertTransferabilityAllowed(snap, {
        customer_id: "cust_abc",
        recipient_customer_id: "cust_abc",
      })
    ).toEqual({ softFlag: false })
  })

  // (g) value outside enum in policy_snapshot → reject (data-integrity guard)
  it("(g) unknown transferability value in policy_snapshot → throws with enum message", () => {
    const snap = snapshotPolicy({
      validity_months: 12,
      transferability: "invalid_value",
    })
    expect(() =>
      assertTransferabilityAllowed(snap, { customer_id: "cust_abc" })
    ).toThrow(/invalid transferability enum.*invalid_value/)
  })

  // Missing transferability in snapshot → defaults to bearer (allow)
  it("missing transferability in snapshot defaults to bearer → allow", () => {
    const snap = snapshotPolicy({ validity_months: 12 })
    expect(
      assertTransferabilityAllowed(snap, { customer_id: null })
    ).toEqual({ softFlag: false })
  })
})

// ---------------------------------------------------------------------------
// (h) policy_snapshot.transferability immutability post-ISSUED (AC5)
// ---------------------------------------------------------------------------

describe("policy_snapshot.transferability immutability post-ISSUED (AC5)", () => {
  it("(h) attempt to mutate transferability sub-key post-ISSUED → throw", () => {
    const issued = snapshotPolicy({
      validity_months: 12,
      transferability: "bearer",
    })
    const mutated = snapshotPolicy({
      validity_months: 12,
      transferability: "personalized",
    })
    expect(() =>
      assertPolicySnapshotImmutable(
        EntitlementInstanceState.ACTIVE,
        issued,
        mutated
      )
    ).toThrow(/immutable after ISSUED/)
  })

  it("same transferability value post-ISSUED → OK", () => {
    const issued = snapshotPolicy({
      validity_months: 12,
      transferability: "bearer",
    })
    const same = snapshotPolicy({
      validity_months: 12,
      transferability: "bearer",
    })
    expect(() =>
      assertPolicySnapshotImmutable(
        EntitlementInstanceState.ACTIVE,
        issued,
        same
      )
    ).not.toThrow()
  })
})
