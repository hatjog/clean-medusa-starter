import { describe, expect, it, jest } from "@jest/globals"

import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"
import {
  RETENTION_AMOUNT_PCT_MAX,
  RETENTION_AMOUNT_PCT_MIN,
  isRetentionAmountWithinBoundary,
} from "../entitlement-boundary"
import {
  ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
  InMemoryIssueRetentionStore,
  IssueRetentionWorkflow,
  RetentionAmountBoundaryError,
  RetentionEntitlementNotFoundError,
  generateRetentionEntitlementCode,
  type RetentionEntitlement,
} from "../workflows/issue-retention"

function entitlement(
  overrides: Partial<RetentionEntitlement> = {}
): RetentionEntitlement {
  const issuedAt = new Date("2026-05-01T10:00:00Z")
  return {
    id: "ent_original_001",
    entitlement_profile_id: "voucher-kwotowy-365d",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    order_id: "ord_001",
    state: EntitlementInstanceState.ACTIVE,
    policy_snapshot: snapshotPolicy({
      validity_months: 12,
      refund_channel: "original_payment",
      extension: { enabled: true, fee_pct: 10 },
    }),
    metadata: null,
    created_at: issuedAt,
    updated_at: issuedAt,
    issued_at: issuedAt,
    expires_at: new Date("2027-05-01T10:00:00Z"),
    market_id: "pl",
    sales_channel_id: "sc_pl",
    ...overrides,
  }
}

function workflowWith(rows: RetentionEntitlement[]) {
  const store = new InMemoryIssueRetentionStore(rows)
  const emit = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const workflow = new IssueRetentionWorkflow(store, { emit })
  return { store, emit, workflow }
}

// ---------------------------------------------------------------------------
// Boundary helper unit tests
// ---------------------------------------------------------------------------

describe("isRetentionAmountWithinBoundary", () => {
  it("accepts amount > 0 when original is unknown (DDL drift degradation)", () => {
    expect(isRetentionAmountWithinBoundary(1, null)).toBe(true)
    expect(isRetentionAmountWithinBoundary(9999, undefined)).toBe(true)
  })

  it("rejects amount <= 0 always", () => {
    expect(isRetentionAmountWithinBoundary(0)).toBe(false)
    expect(isRetentionAmountWithinBoundary(-1)).toBe(false)
    expect(isRetentionAmountWithinBoundary(0, null)).toBe(false)
    expect(isRetentionAmountWithinBoundary(0, 500)).toBe(false)
  })

  it("accepts amount exactly at RETENTION_AMOUNT_PCT_MIN (100%) of original", () => {
    expect(isRetentionAmountWithinBoundary(500, 500)).toBe(true) // 100%
  })

  it("accepts amount at 110% (typical retention offer)", () => {
    expect(isRetentionAmountWithinBoundary(550, 500)).toBe(true) // 110%
  })

  it("accepts amount exactly at RETENTION_AMOUNT_PCT_MAX (200%) of original", () => {
    const original = 500
    const amount = (original * RETENTION_AMOUNT_PCT_MAX) / 100
    expect(isRetentionAmountWithinBoundary(amount, original)).toBe(true)
  })

  it("rejects amount below 100% of original (masked partial refund)", () => {
    expect(isRetentionAmountWithinBoundary(499, 500)).toBe(false) // 99.8%
  })

  it("rejects amount above 200% of original (anti-abuse)", () => {
    expect(isRetentionAmountWithinBoundary(1001, 500)).toBe(false) // 200.2%
  })

  it("documents boundary constants have expected values", () => {
    expect(RETENTION_AMOUNT_PCT_MIN).toBe(100)
    expect(RETENTION_AMOUNT_PCT_MAX).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// IssueRetentionWorkflow unit tests — cases (a)-(g) from AC6
// ---------------------------------------------------------------------------

describe("IssueRetentionWorkflow", () => {
  // (a) happy path: voids old + issues new retention instance atomically
  it("(a) happy path: voids old + issues retention instance with new code and amount", async () => {
    const old = entitlement()
    const { store, workflow } = workflowWith([old])

    const result = await workflow.issueRetention({
      entitlement_id: old.id,
      amount: 550,
      reason: "Customer requested refund; retention offer accepted.",
      admin_user_id: "user_admin_001",
      now: new Date("2026-05-16T10:00:00Z"),
      idempotency_key: "entitlement:ent_original_001:retention",
    })

    const oldAfter = store.get(old.id)
    const next = store.get(result.retention_entitlement_id)

    expect(oldAfter?.state).toBe(EntitlementInstanceState.VOIDED)
    expect(next?.state).toBe(EntitlementInstanceState.ACTIVE)
    expect(next?.id).toBe(result.retention_code)
    expect(next?.id).not.toBe(old.id)
    expect(result.amount).toBe(550)
    expect(next?.entitlement_type).toBe(old.entitlement_type)
  })

  // (b) amount <= 0 → 422 boundary
  it("(b) rejects amount <= 0 with RetentionAmountBoundaryError", async () => {
    const old = entitlement()
    const { workflow } = workflowWith([old])

    await expect(
      workflow.issueRetention({
        entitlement_id: old.id,
        amount: 0,
        reason: "Test",
        admin_user_id: "user_admin_001",
      })
    ).rejects.toBeInstanceOf(RetentionAmountBoundaryError)

    await expect(
      workflow.issueRetention({
        entitlement_id: old.id,
        amount: -100,
        reason: "Test",
        admin_user_id: "user_admin_001",
      })
    ).rejects.toBeInstanceOf(RetentionAmountBoundaryError)
  })

  // (c) incentive ratio outside boundary when original value resolvable
  it("(c) rejects when incentive ratio is outside boundary (original resolvable from snapshot)", async () => {
    // Policy snapshot carries `amount` = 500 (simulated)
    const old = entitlement({
      policy_snapshot: snapshotPolicy({
        validity_months: 12,
        refund_channel: "original_payment",
        amount: 500, // original value in snapshot
      }),
    })
    const { workflow } = workflowWith([old])

    // Below 100%: 499 / 500 = 99.8% → violation
    await expect(
      workflow.issueRetention({
        entitlement_id: old.id,
        amount: 499,
        reason: "Partial retention (below minimum)",
        admin_user_id: "user_admin_001",
      })
    ).rejects.toBeInstanceOf(RetentionAmountBoundaryError)

    // Above 200%: 1001 / 500 = 200.2% → violation
    await expect(
      workflow.issueRetention({
        entitlement_id: old.id,
        amount: 1001,
        reason: "Extreme retention (above maximum)",
        admin_user_id: "user_admin_001",
      })
    ).rejects.toBeInstanceOf(RetentionAmountBoundaryError)
  })

  // (d) source state not allowing VOIDED → EntitlementTransitionError
  it("(d) rejects with EntitlementTransitionError when source state cannot transition to VOIDED", async () => {
    for (const state of [
      EntitlementInstanceState.VOIDED,
      EntitlementInstanceState.SETTLED,
      EntitlementInstanceState.CLOSED,
    ]) {
      const old = entitlement({ state })
      const { workflow } = workflowWith([old])
      await expect(
        workflow.issueRetention({
          entitlement_id: old.id,
          amount: 550,
          reason: "Retention attempt",
          admin_user_id: "user_admin_001",
        })
      ).rejects.toBeInstanceOf(EntitlementTransitionError)
    }
  })

  // (e) retention profile resolution: body override > metadata > fallback verbatim snapshot
  it("(e) retention profile resolution: body override takes priority", async () => {
    const old = entitlement({
      metadata: { retention_voucher_template_id: "meta-template" },
    })
    const { store, workflow } = workflowWith([old])

    const result = await workflow.issueRetention({
      entitlement_id: old.id,
      amount: 550,
      reason: "Test body override",
      admin_user_id: "user_admin_001",
      retention_voucher_template_id: "body-override-template",
    })

    // Event payload carries the body-override template id
    expect(result.event.payload.retention_voucher_template_id).toBe(
      "body-override-template"
    )
    // New entitlement exists and is ACTIVE
    const next = store.get(result.retention_entitlement_id)
    expect(next?.state).toBe(EntitlementInstanceState.ACTIVE)
  })

  it("(e) retention profile resolution: metadata template used when no body override", async () => {
    const old = entitlement({
      metadata: { retention_voucher_template_id: "meta-template" },
    })
    const { workflow } = workflowWith([old])

    const result = await workflow.issueRetention({
      entitlement_id: old.id,
      amount: 550,
      reason: "Test metadata fallback",
      admin_user_id: "user_admin_001",
      // no retention_voucher_template_id in body
    })

    expect(result.event.payload.retention_voucher_template_id).toBe(
      "meta-template"
    )
  })

  it("(e) retention profile resolution: verbatim snapshot fallback when no template declared", async () => {
    const old = entitlement({ metadata: null })
    const { store, workflow } = workflowWith([old])

    const result = await workflow.issueRetention({
      entitlement_id: old.id,
      amount: 550,
      reason: "Test verbatim snapshot fallback",
      admin_user_id: "user_admin_001",
    })

    // No template id in event
    expect(result.event.payload.retention_voucher_template_id).toBeUndefined()
    // policy_snapshot is deep-equal to source but not the same reference
    const next = store.get(result.retention_entitlement_id)
    expect(next?.policy_snapshot).toEqual(old.policy_snapshot)
    expect(next?.policy_snapshot).not.toBe(old.policy_snapshot)
  })

  // (f) event envelope shape: event_type / actor / idempotency_key / required payload fields
  it("(f) emits correct event envelope after state mutation", async () => {
    const old = entitlement()
    const { emit, workflow } = workflowWith([old])

    const result = await workflow.issueRetention({
      entitlement_id: old.id,
      amount: 550,
      reason: "Customer retention offer.",
      reason_code: "RETENTION_OFFER",
      admin_user_id: "user_admin_001",
      now: new Date("2026-05-16T10:00:00Z"),
      idempotency_key: "entitlement:ent_original_001:retention",
    })

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "1",
        event_type: ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
        actor: "market_operator",
        idempotency_key: "entitlement:ent_original_001:retention",
        payload: expect.objectContaining({
          original_entitlement_id: old.id,
          retention_entitlement_id: result.retention_entitlement_id,
          reason: "Customer retention offer.",
          reason_code: "RETENTION_OFFER",
          amount: 550,
          admin_user_id: "user_admin_001",
          issued_at: "2026-05-16T10:00:00.000Z",
        }),
      })
    )
  })

  // (g) idempotency: repeated trigger with same key does NOT create second successor
  it("(g) idempotent: repeated trigger with same idempotency_key returns same result, no duplicate", async () => {
    const old = entitlement()
    const { emit, store, workflow } = workflowWith([old])
    const input = {
      entitlement_id: old.id,
      amount: 550,
      reason: "Customer retention offer.",
      admin_user_id: "user_admin_001",
      now: new Date("2026-05-16T10:00:00Z"),
      idempotency_key: "entitlement:ent_original_001:retention",
    }

    const first = await workflow.issueRetention(input)
    const second = await workflow.issueRetention(input)

    expect(second.retention_entitlement_id).toBe(first.retention_entitlement_id)
    expect(second.retention_code).toBe(first.retention_code)
    expect([...store.all()].filter((r) => r.id !== old.id)).toHaveLength(1)
    expect(emit).toHaveBeenCalledTimes(1) // only on first trigger
  })

  // not-found case
  it("returns RetentionEntitlementNotFoundError for unknown entitlement", async () => {
    const { workflow } = workflowWith([])
    await expect(
      workflow.issueRetention({
        entitlement_id: "ent_missing",
        amount: 550,
        reason: "Retention offer",
        admin_user_id: "user_admin_001",
      })
    ).rejects.toBeInstanceOf(RetentionEntitlementNotFoundError)
  })

  // emit failure propagation (mirrors Story 2.5 M2 guard)
  it("propagates emit failure after state mutation so the route can return 500", async () => {
    const old = entitlement()
    const store = new InMemoryIssueRetentionStore([old])
    const emit = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("event bus unavailable"))
    const workflow = new IssueRetentionWorkflow(store, { emit })

    await expect(
      workflow.issueRetention({
        entitlement_id: old.id,
        amount: 550,
        reason: "Retention offer",
        admin_user_id: "user_admin_001",
        now: new Date("2026-05-16T10:00:00Z"),
        idempotency_key: "entitlement:ent_original_001:retention",
      })
    ).rejects.toThrow("audit event emit failed")

    // State was already mutated (old is VOIDED)
    const oldAfter = store.get(old.id)
    expect(oldAfter?.state).toBe(EntitlementInstanceState.VOIDED)
    // emit was retried once (2 attempts total)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  // Integration / lifecycle test (InMemory, authored-runnable per AC6 / authored-vs-applied posture)
  it("lifecycle: issue → active → issue_retention → old VOIDED + new retention ACTIVE with amount", async () => {
    const originalIssuedAt = new Date("2026-05-01T10:00:00Z")
    const retentionNow = new Date("2026-05-16T10:00:00Z")
    const originalExpiresAt = new Date("2027-05-01T10:00:00Z")
    const originalPolicy = snapshotPolicy({
      validity_months: 12,
      refund_channel: "original_payment",
      extension: { enabled: true, fee_pct: 10 },
    })

    // 1. Start with an ACTIVE entitlement (post-ISSUED lifecycle step)
    const activeEntitlement = entitlement({
      state: EntitlementInstanceState.ACTIVE,
      created_at: originalIssuedAt,
      issued_at: originalIssuedAt,
      expires_at: originalExpiresAt,
      policy_snapshot: originalPolicy,
    })

    const { store, emit, workflow } = workflowWith([activeEntitlement])

    // 2. Issue retention
    const first = await workflow.issueRetention({
      entitlement_id: activeEntitlement.id,
      amount: 550,
      reason: "Customer requested refund; retention voucher offered.",
      reason_code: "RETENTION_OFFER",
      admin_user_id: "user_admin_001",
      now: retentionNow,
      idempotency_key: "entitlement:ent_original_001:retention",
    })

    // Old is VOIDED
    expect(store.get(activeEntitlement.id)?.state).toBe(
      EntitlementInstanceState.VOIDED
    )

    // New is ACTIVE, different code, same type, correct amount
    const retentionEnt = store.get(first.retention_entitlement_id)
    expect(retentionEnt?.state).toBe(EntitlementInstanceState.ACTIVE)
    expect(retentionEnt?.id).not.toBe(activeEntitlement.id)
    expect(first.amount).toBe(550)
    expect(retentionEnt?.entitlement_type).toBe(
      activeEntitlement.entitlement_type
    )
    // policy_snapshot is deep-equal (verbatim fallback) but a distinct object
    expect(retentionEnt?.policy_snapshot).toEqual(originalPolicy)
    expect(retentionEnt?.policy_snapshot).not.toBe(originalPolicy)

    // 3. Idempotent re-trigger: same result, no duplicate, emit called once
    const second = await workflow.issueRetention({
      entitlement_id: activeEntitlement.id,
      amount: 550,
      reason: "Customer requested refund; retention voucher offered.",
      reason_code: "RETENTION_OFFER",
      admin_user_id: "user_admin_001",
      now: retentionNow,
      idempotency_key: "entitlement:ent_original_001:retention",
    })
    expect(second.retention_entitlement_id).toBe(first.retention_entitlement_id)
    expect(
      store.all().filter((r) => r.id !== activeEntitlement.id)
    ).toHaveLength(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  // retention_code != old code
  it("generates a retention code that differs from the original entitlement id", () => {
    const oldId = "ent_original_001"
    const idempotencyKey = `entitlement:${oldId}:retention`
    const code = generateRetentionEntitlementCode(oldId, idempotencyKey)
    expect(code).not.toBe(oldId)
    expect(code).toMatch(/^GP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })
})
