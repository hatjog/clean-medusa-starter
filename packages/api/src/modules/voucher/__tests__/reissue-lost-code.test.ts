import { describe, expect, it, jest } from "@jest/globals"

import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"
import { isWithinReissueWindow } from "../entitlement-boundary"
import {
  ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE,
  EntitlementNotFoundError,
  InMemoryReissueLostCodeStore,
  LostCodeReissueWindowError,
  ReissueLostCodeWorkflow,
  type ReissuableEntitlement,
} from "../workflows/reissue-lost-code"

function entitlement(
  overrides: Partial<ReissuableEntitlement> = {}
): ReissuableEntitlement {
  const issuedAt = new Date("2026-05-01T10:00:00Z")
  return {
    id: "ent_old_001",
    entitlement_profile_id: "voucher-kwotowy-365d",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    order_id: "ord_001",
    state: EntitlementInstanceState.ACTIVE,
    policy_snapshot: snapshotPolicy({
      validity_months: 12,
      refund_channel: "original_payment",
      extension: { enabled: true, fee_pct: 10 },
    }),
    created_at: issuedAt,
    updated_at: issuedAt,
    expires_at: new Date("2027-05-01T10:00:00Z"),
    market_id: "pl",
    sales_channel_id: "sc_pl",
    ...overrides,
  }
}

function workflowWith(rows: ReissuableEntitlement[]) {
  const store = new InMemoryReissueLostCodeStore(rows)
  const emit = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const workflow = new ReissueLostCodeWorkflow(store, { emit })
  return { store, emit, workflow }
}

describe("lost-code reissue boundary", () => {
  it("allows reissue exactly within the 30-day window", () => {
    expect(
      isWithinReissueWindow(
        new Date("2026-05-01T10:00:00Z"),
        new Date("2026-05-31T10:00:00Z")
      )
    ).toBe(true)
  })

  it("rejects reissue after the 30-day window", () => {
    expect(
      isWithinReissueWindow(
        new Date("2026-05-01T10:00:00Z"),
        new Date("2026-05-31T10:00:01Z")
      )
    ).toBe(false)
  })
})

describe("ReissueLostCodeWorkflow", () => {
  it("voids the old entitlement and issues a new active entitlement atomically", async () => {
    const old = entitlement()
    const { store, workflow } = workflowWith([old])

    const result = await workflow.reissue({
      entitlement_id: old.id,
      reason: "Customer reports lost code after email deletion.",
      admin_user_id: "user_admin_001",
      now: new Date("2026-05-10T12:00:00Z"),
      idempotency_key: "entitlement:ent_old_001:reissue",
    })

    const oldAfter = store.get(old.id)
    const next = store.get(result.new_entitlement_id)

    expect(oldAfter?.state).toBe(EntitlementInstanceState.VOIDED)
    expect(next?.state).toBe(EntitlementInstanceState.ACTIVE)
    expect(next?.id).toBe(result.new_code)
    expect(next?.id).not.toBe(old.id)
    expect(next?.policy_snapshot).toEqual(old.policy_snapshot)
    expect(next?.policy_snapshot).not.toBe(old.policy_snapshot)
    expect((next?.policy_snapshot as EntitlementPolicySnapshot)).toEqual(
      old.policy_snapshot
    )
    expect(next?.expires_at?.toISOString()).toBe(
      old.expires_at?.toISOString()
    )
  })

  it("rejects when the original issue date is outside the window", async () => {
    const old = entitlement({ created_at: new Date("2026-04-01T10:00:00Z") })
    const { workflow } = workflowWith([old])

    await expect(
      workflow.reissue({
        entitlement_id: old.id,
        reason: "Customer reports lost code.",
        admin_user_id: "user_admin_001",
        now: new Date("2026-05-10T12:00:00Z"),
      })
    ).rejects.toBeInstanceOf(LostCodeReissueWindowError)
  })

  it("uses EntitlementTransitionError for states that cannot transition to VOIDED", async () => {
    const old = entitlement({ state: EntitlementInstanceState.SETTLED })
    const { workflow } = workflowWith([old])

    await expect(
      workflow.reissue({
        entitlement_id: old.id,
        reason: "Customer reports lost code.",
        admin_user_id: "user_admin_001",
        now: new Date("2026-05-10T12:00:00Z"),
      })
    ).rejects.toBeInstanceOf(EntitlementTransitionError)
  })

  it("emits the lost-code reissued envelope after mutation", async () => {
    const old = entitlement()
    const { emit, workflow } = workflowWith([old])

    const result = await workflow.reissue({
      entitlement_id: old.id,
      reason: "Customer reports lost code.",
      reason_code: "LOST_CODE",
      admin_user_id: "user_admin_001",
      now: new Date("2026-05-10T12:00:00Z"),
      idempotency_key: "entitlement:ent_old_001:reissue",
    })

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "1",
        event_type: ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE,
        actor: "market_operator",
        idempotency_key: "entitlement:ent_old_001:reissue",
        payload: expect.objectContaining({
          old_entitlement_id: old.id,
          new_entitlement_id: result.new_entitlement_id,
          reason: "Customer reports lost code.",
          reason_code: "LOST_CODE",
          admin_user_id: "user_admin_001",
          original_issued_at: old.created_at.toISOString(),
        }),
      })
    )
  })

  it("is idempotent for repeated reissue with the same idempotency key", async () => {
    const old = entitlement()
    const { emit, store, workflow } = workflowWith([old])
    const input = {
      entitlement_id: old.id,
      reason: "Customer reports lost code.",
      admin_user_id: "user_admin_001",
      now: new Date("2026-05-10T12:00:00Z"),
      idempotency_key: "entitlement:ent_old_001:reissue",
    }

    const first = await workflow.reissue(input)
    const second = await workflow.reissue(input)

    expect(second.new_entitlement_id).toBe(first.new_entitlement_id)
    expect([...store.all()].filter((row) => row.id !== old.id)).toHaveLength(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it("returns not found for an unknown entitlement", async () => {
    const { workflow } = workflowWith([])

    await expect(
      workflow.reissue({
        entitlement_id: "ent_missing",
        reason: "Customer reports lost code.",
        admin_user_id: "user_admin_001",
      })
    ).rejects.toBeInstanceOf(EntitlementNotFoundError)
  })
})
