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
import {
  ENTITLEMENT_EXTENDED_EVENT,
  EntitlementExtensionError,
  VoucherService,
} from ".."

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
    extension: {
      allowed: true,
      paid: true,
      fee_pct: 10,
      max_extension_months: 6,
    },
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

  // AC4/AC5 explicit proof: mutating policy_snapshot.extension post-ISSUED
  // must throw (L2 traceability — a dedicated assertion targeting .extension).
  it("rejects snapshot change of extension sub-object post-ISSUED (AC4/AC5)", () => {
    const extensionPolicy = {
      validity_months: 12,
      extension: {
        allowed: true,
        paid: true,
        fee_pct: 10,
        max_extension_months: 6,
      },
    }
    const issued = snapshotPolicy(extensionPolicy)
    const mutatedExtension = snapshotPolicy({
      validity_months: 12,
      extension: {
        allowed: true,
        paid: false,
        fee_pct: 0,
        max_extension_months: 3,
      },
    })
    // changing extension sub-object after ISSUED must throw
    expect(() =>
      assertPolicySnapshotImmutable(
        EntitlementInstanceState.ACTIVE,
        issued,
        mutatedExtension
      )
    ).toThrow(/immutable after ISSUED/)
  })
})

// ---------------------------------------------------------------------------
// T2 — Layer 2 boundary
// ---------------------------------------------------------------------------

describe("Layer 2 — entitlement_boundary", () => {
  it("encodes the AC2 platform maxima/minima", () => {
    expect(ENTITLEMENT_BOUNDARY.validity_months_max).toBe(24)
    expect(ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_max).toBe(15)
    expect(ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_min).toBe(5)
    expect(ENTITLEMENT_BOUNDARY.policy.cancellation.cutoff_hours_min).toBe(12)
    expect(ENTITLEMENT_BOUNDARY.policy.cancellation.refund_pct_max).toBe(100)
  })

  it("passes the BonBeauty MVP profile policies (within boundary)", () => {
    // voucher-kwotowy-365d (BE-5 Story 2.6: transferability is now enum string)
    expect(
      checkPolicyAgainstBoundary({
        validity_months: 12,
        extension: {
          allowed: true,
          paid: true,
          fee_pct: 10,
          max_extension_months: 6,
        },
        cancellation: { enabled: true, cutoff_hours: 24, refund_pct: 100 },
        no_show: { policy: "charge_full", charge_pct: 100 },
        transferability: "bearer",
        refund_channel: "original_payment",
      })
    ).toEqual([])
    // voucher-sezonowy (validity 6, store_credit, forfeit_voucher)
    expect(
      checkPolicyAgainstBoundary({
        validity_months: 6,
        extension: {
          allowed: false,
          paid: false,
          fee_pct: 0,
          max_extension_months: 1,
        },
        cancellation: { enabled: true, cutoff_hours: 24, refund_pct: 100 },
        no_show: { policy: "forfeit_voucher", charge_pct: 0 },
        transferability: "bearer",
        refund_channel: "store_credit",
      })
    ).toEqual([])
  })

  it("reports each kind of boundary violation", () => {
    const v = checkPolicyAgainstBoundary({
      validity_months: 36, // > 24
      extension: {
        allowed: true,
        paid: true,
        fee_pct: 25,
        max_extension_months: 6,
      }, // > 15
      cancellation: { enabled: true, cutoff_hours: 6, refund_pct: 150 }, // < 12, > 100
      no_show: { policy: "charge_double" }, // not in enum
      transferability: "invalid_value", // not in enum (BE-5 Story 2.6)
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
        "policy.transferability",
        "policy.validity_months",
      ].sort()
    )
  })

  it("requires validity_months", () => {
    const v = checkPolicyAgainstBoundary({})
    expect(v.some((x) => x.field === "policy.validity_months")).toBe(true)
  })

  it("rejects paid extension fee below the GP minimum", () => {
    const v = checkPolicyAgainstBoundary({
      validity_months: 12,
      extension: {
        allowed: true,
        paid: true,
        fee_pct: 4,
        max_extension_months: 6,
      },
    })
    expect(v).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "policy.extension.fee_pct" }),
      ])
    )
  })

  // L1 governance gate: unpaid extension with non-zero fee_pct must fail (even
  // though it passes the paid-only range check). Prevents garbage values from
  // silently slipping through when paid=false.
  it("rejects unpaid extension with non-zero fee_pct (L1 governance gate)", () => {
    const v = checkPolicyAgainstBoundary({
      validity_months: 12,
      extension: {
        allowed: true,
        paid: false,
        fee_pct: 5, // non-zero is invalid for unpaid
        max_extension_months: 6,
      },
    })
    expect(v).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "policy.extension.fee_pct" }),
      ])
    )
  })

  it("accepts unpaid extension with fee_pct=0 (free extension semantics)", () => {
    const v = checkPolicyAgainstBoundary({
      validity_months: 12,
      extension: {
        allowed: true,
        paid: false,
        fee_pct: 0,
        max_extension_months: 3,
      },
    })
    expect(v.some((x) => x.field === "policy.extension.fee_pct")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Story 2.2 — BE-1 extend(entitlement_id, paid)
// ---------------------------------------------------------------------------

type QueryRecord = Record<string, unknown>

class FakeEntitlementClient {
  row: QueryRecord
  readonly events: string[] = []

  constructor(row: QueryRecord) {
    this.row = { ...row }
  }

  async query(sql: string, params: unknown[] = []) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      this.events.push(sql)
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("SELECT") && sql.includes("entitlement_instance")) {
      return { rows: [this.row], rowCount: 1 }
    }
    if (sql.includes("UPDATE entitlement_instance")) {
      this.row.expires_at = params[1]
      this.row.unpaid_extension_count = params[2]
      this.events.push("UPDATE")
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in test: ${sql}`)
  }

  release() {
    this.events.push("RELEASE")
  }
}

function entitlementRow(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    id: "ent_inst_1",
    entitlement_profile_id: "voucher-kwotowy-365d",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    order_id: "order_1",
    state: EntitlementInstanceState.ACTIVE,
    policy_snapshot: snapshotPolicy({
      validity_months: 12,
      extension: {
        allowed: true,
        paid: true,
        fee_pct: 10,
        max_extension_months: 6,
      },
    }),
    expires_at: new Date("2026-06-01T00:00:00.000Z"),
    unpaid_extension_count: 0,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }
}

function serviceWith(row: QueryRecord) {
  const client = new FakeEntitlementClient(row)
  const eventBus = {
    messages: [] as Array<{ name: string; data: Record<string, unknown> }>,
    async emit(message: { name: string; data: Record<string, unknown> }) {
      this.messages.push(message)
    },
  }
  const service = new VoucherService({
    resolve(key: string) {
      return key === "event_bus" ? eventBus : undefined
    },
  })
  service._testPool = {
    connect: async () => client,
  } as never
  return { service, client, eventBus }
}

describe("Story 2.2 — extend entitlement", () => {
  it("rejects paid=true when fee_pct exceeds 15", async () => {
    const { service } = serviceWith(
      entitlementRow({
        policy_snapshot: snapshotPolicy({
          validity_months: 12,
          extension: {
            allowed: true,
            paid: true,
            fee_pct: 16,
            max_extension_months: 6,
          },
        }),
      })
    )

    await expect(service.extend("ent_inst_1", { paid: true })).rejects.toThrow(
      EntitlementExtensionError
    )
  })

  it("rejects paid=true when fee_pct is below 5", async () => {
    const { service } = serviceWith(
      entitlementRow({
        policy_snapshot: snapshotPolicy({
          validity_months: 12,
          extension: {
            allowed: true,
            paid: true,
            fee_pct: 4,
            max_extension_months: 6,
          },
        }),
      })
    )

    await expect(service.extend("ent_inst_1", { paid: true })).rejects.toThrow(
      EntitlementExtensionError
    )
  })

  it("rejects a second unpaid extension on the same instance", async () => {
    const { service } = serviceWith(entitlementRow({ unpaid_extension_count: 1 }))

    await expect(service.extend("ent_inst_1", { paid: false })).rejects.toThrow(
      EntitlementExtensionError
    )
  })

  it("rejects extension when instance is not ACTIVE or extension is disallowed", async () => {
    const inactive = serviceWith(
      entitlementRow({ state: EntitlementInstanceState.EXPIRED })
    )
    await expect(
      inactive.service.extend("ent_inst_1", { paid: true })
    ).rejects.toThrow(EntitlementExtensionError)

    const disallowed = serviceWith(
      entitlementRow({
        policy_snapshot: snapshotPolicy({
          validity_months: 12,
          extension: {
            allowed: false,
            paid: false,
            fee_pct: 0,
            max_extension_months: 1,
          },
        }),
      })
    )
    await expect(
      disallowed.service.extend("ent_inst_1", { paid: false })
    ).rejects.toThrow(EntitlementExtensionError)
  })

  it("extends expires_at and emits the complete ENTITLEMENT_EXTENDED envelope", async () => {
    const now = new Date("2026-05-16T12:00:00.000Z")
    const { service, client, eventBus } = serviceWith(entitlementRow())

    const result = await service.extend("ent_inst_1", {
      paid: true,
      actor: "admin_1",
      source: "unit-test",
      now,
    })

    expect(result.previous_expires_at.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z"
    )
    expect(result.new_expires_at.toISOString()).toBe("2026-12-01T00:00:00.000Z")
    expect(client.row.expires_at).toEqual(result.new_expires_at)
    expect(eventBus.messages).toHaveLength(1)
    expect(eventBus.messages[0]).toEqual({
      name: ENTITLEMENT_EXTENDED_EVENT,
      data: {
        event: ENTITLEMENT_EXTENDED_EVENT,
        // entitlement_id = entitlement_profile_id (the template), not the
        // instance id — they are distinct identifiers (H1 fix).
        entitlement_id: "voucher-kwotowy-365d",
        entitlement_instance_id: "ent_inst_1",
        paid: true,
        fee_pct: 10,
        previous_expires_at: "2026-06-01T00:00:00.000Z",
        new_expires_at: "2026-12-01T00:00:00.000Z",
        actor: "admin_1",
        source: "unit-test",
        timestamp: "2026-05-16T12:00:00.000Z",
      },
    })
    expect(client.events).toEqual(["BEGIN", "UPDATE", "COMMIT", "RELEASE"])
  })

  it("increments unpaid_extension_count only for unpaid extension", async () => {
    const { service, client } = serviceWith(entitlementRow())

    await service.extend("ent_inst_1", { paid: false })

    expect(client.row.unpaid_extension_count).toBe(1)
  })
})
