/**
 * Story v180-2-8 BE-7 refund channel — unit tests.
 *
 * Covers AC6 cases (a)-(g) plus review-fix findings:
 *  (a) original_payment → routing + audit, NO automated Stripe refund.create
 *  (b) store_credit → customer.metadata.gp.store_credit incremented
 *  (c) vendor_wallet → vendor.metadata.wallet incremented
 *  (d) unknown channel → typed reject (fail-loud)
 *  (e) event gp.entitlements.entitlement_refund_applied.v1 emitted with full
 *      envelope + refund_channel + refunded_amount_minor + currency
 *  (f) idempotency — duplicate refund_id returns same result without re-applying
 *  (g) snapshot immutability (policy_snapshot.refund_channel immutable post-ISSUED)
 *  (h) review-fix F-01: scope.instance_id = entitlement instance ID (not "gp-dev")
 *  (i) review-fix F-02: amount must be positive integer
 *  (j) review-fix F-05: currency must be 3-char uppercase ISO 4217
 *  (k) review-fix F-04: terminal/invalid state guard
 */

import { describe, it, expect, beforeEach } from "@jest/globals"
import { VoucherService, ENTITLEMENT_REFUND_APPLIED_EVENT } from ".."
import {
  EntitlementInstanceState,
  EntitlementType,
  snapshotPolicy,
  assertPolicySnapshotImmutable,
} from "../models/entitlement"
import { REFUND_CHANNELS } from "../entitlement-boundary"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type QueryCall = { sql: string; params: unknown[] }

function makePool(
  rows: Record<string, unknown>[] = [],
  updateRowCount: number = 1
) {
  const calls: QueryCall[] = []

  const queryFn = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] })
    const sqlUpper = sql.trim().toUpperCase()
    if (sqlUpper.startsWith("SELECT") || sqlUpper.startsWith("BEGIN") || sqlUpper.startsWith("COMMIT") || sqlUpper.startsWith("ROLLBACK")) {
      return { rows, rowCount: rows.length }
    }
    // For UPDATE / INSERT
    return { rows: [], rowCount: updateRowCount }
  }

  const client = {
    query: queryFn,
    release: () => {},
  }

  const pool = {
    query: queryFn,
    connect: async () => client,
    _calls: calls,
  }

  return pool
}

function makeEntitlementRow(
  refundChannel: string,
  state: EntitlementInstanceState = EntitlementInstanceState.ACTIVE,
  id = "ent_test_001",
  orderId: string | null = "order_001"
) {
  return {
    id,
    entitlement_profile_id: "profile_001",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    order_id: orderId,
    state,
    booking_pointer: null,
    policy_snapshot: JSON.stringify(
      snapshotPolicy({
        validity_months: 12,
        refund_channel: refundChannel,
      })
    ),
    expires_at: new Date("2027-01-01T00:00:00.000Z"),
    unpaid_extension_count: 0,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  }
}

function makeService(pool: ReturnType<typeof makePool>) {
  const emitted: Array<{ name: string; data: unknown }> = []
  const eventBus = {
    emit: async (msg: { name: string; data: unknown }) => {
      emitted.push(msg)
    },
  }
  const svc = new VoucherService(
    { [Symbol.for("event_bus")]: eventBus },
    {}
  )
  svc._testPool = pool as any
  // Inject eventBus via container resolve pattern
  ;(svc as any).container_ = {
    resolve: (key: string) => {
      if (key === "eventBus" || key === require("@medusajs/framework/utils").Modules.EVENT_BUS) {
        return eventBus
      }
      return null
    },
  }
  return { svc, emitted }
}

// ---------------------------------------------------------------------------
// AC6(a) + (e) — original_payment routing + audit event
// ---------------------------------------------------------------------------

describe("refund_request — original_payment channel", () => {
  it("(a+e) emits audit event with refund_channel=original_payment, no Stripe create", async () => {
    // Pool returns entitlement row on SELECT, empty on idempotency check
    const entitlementRow = makeEntitlementRow("original_payment")

    let callCount = 0
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        // Idempotency check — no existing event
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [entitlementRow], rowCount: 1 }
      }
      callCount++
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({
      query: pool.query,
      release: () => {},
    })

    const { svc, emitted } = makeService(pool)

    const result = await svc.refund_request("ent_test_001", {
      refund_id: "refund_001",
      amount: 5000,
      currency: "PLN",
    })

    expect(result.refund_channel).toBe("original_payment")
    expect(result.idempotent).toBe(false)

    // (e) event emitted
    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe(ENTITLEMENT_REFUND_APPLIED_EVENT)
    const env = emitted[0].data as any
    expect(env.event_type).toBe(ENTITLEMENT_REFUND_APPLIED_EVENT)
    expect(env.payload.refund_channel).toBe("original_payment")
    expect(env.payload.refunded_amount_minor).toBe(5000)
    expect(env.payload.currency).toBe("PLN")
    expect(env.idempotency_key).toBe("entitlement:ent_test_001:refund_applied:refund_001")

    // (h) review-fix F-01: scope.instance_id must be the entitlement instance ID
    expect(env.scope.instance_id).toBe("ent_test_001")

    // (a) NO Stripe refund.create call — assert no external HTTP call pattern
    // (structural: no stripe-related SQL or external call in captured queries)
    const sqlCalls = pool._calls.map((c) => c.sql)
    expect(sqlCalls.some((s) => s.includes("stripe"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC6(b) — store_credit
// ---------------------------------------------------------------------------

describe("refund_request — store_credit channel", () => {
  it("(b) increments customer.metadata.gp.store_credit, emits event", async () => {
    const entitlementRow = makeEntitlementRow("store_credit")
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [entitlementRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc, emitted } = makeService(pool)

    const result = await svc.refund_request("ent_test_001", {
      refund_id: "refund_sc_001",
      amount: 2500,
      currency: "PLN",
    })

    expect(result.refund_channel).toBe("store_credit")

    // Verify UPDATE customer was called
    const updateCall = pool._calls.find(
      (c) => c.sql.includes("UPDATE customer") && c.sql.includes("store_credit")
    )
    expect(updateCall).toBeDefined()
    expect(updateCall?.params).toContain(2500)

    // (e) event emitted
    expect(emitted[0].data as any).toMatchObject({
      payload: { refund_channel: "store_credit", refunded_amount_minor: 2500 },
    })
  })
})

// ---------------------------------------------------------------------------
// AC6(c) — vendor_wallet
// ---------------------------------------------------------------------------

describe("refund_request — vendor_wallet channel", () => {
  it("(c) increments vendor.metadata.wallet, emits event", async () => {
    const entitlementRow = makeEntitlementRow("vendor_wallet")
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [entitlementRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc, emitted } = makeService(pool)

    const result = await svc.refund_request("ent_test_001", {
      refund_id: "refund_vw_001",
      amount: 7500,
      currency: "PLN",
    })

    expect(result.refund_channel).toBe("vendor_wallet")

    const updateCall = pool._calls.find(
      (c) => c.sql.includes("UPDATE seller") && c.sql.includes("wallet")
    )
    expect(updateCall).toBeDefined()
    expect(updateCall?.params).toContain(7500)

    expect(emitted[0].data as any).toMatchObject({
      payload: { refund_channel: "vendor_wallet", refunded_amount_minor: 7500 },
    })
  })
})

// ---------------------------------------------------------------------------
// AC6(d) — unknown channel → fail-loud typed error
// ---------------------------------------------------------------------------

describe("refund_request — unknown/unsupported channel", () => {
  it("(d) rejects with EntitlementRefundError for unknown channel", async () => {
    const entitlementRow = makeEntitlementRow("bank_transfer")
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [entitlementRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_bad_001",
        amount: 1000,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "UNKNOWN_REFUND_CHANNEL",
    })
  })

  it("(d) rejects with EntitlementRefundError for missing channel", async () => {
    const entitlementRow = makeEntitlementRow("" as any)
    // Override policy_snapshot to have no refund_channel
    const rowNoChannel = {
      ...entitlementRow,
      policy_snapshot: JSON.stringify({ validity_months: 12 }),
    }
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [rowNoChannel], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_noChannel_001",
        amount: 1000,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "UNKNOWN_REFUND_CHANNEL",
    })
  })
})

// ---------------------------------------------------------------------------
// AC6(f) — idempotency
// ---------------------------------------------------------------------------

describe("refund_request — idempotency", () => {
  it("(f) duplicate refund_id returns existing result without re-applying effect", async () => {
    const existingPayload = {
      entitlement_id: "ent_test_001",
      refund_id: "refund_dup_001",
      applied_at: "2026-02-01T10:00:00.000Z",
      currency: "PLN",
      refunded_amount_minor: 3000,
      refund_channel: "store_credit",
    }
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      if (sql.includes("voucher_event") && sql.includes("refund_id")) {
        return { rows: [{ payload: existingPayload }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc, emitted } = makeService(pool)

    const result = await svc.refund_request("ent_test_001", {
      refund_id: "refund_dup_001",
      amount: 3000,
      currency: "PLN",
    })

    expect(result.idempotent).toBe(true)
    expect(result.refund_channel).toBe("store_credit")
    expect(result.amount).toBe(3000)

    // No event re-emitted (idempotent path returns early before COMMIT)
    expect(emitted).toHaveLength(0)

    // No UPDATE customer or seller called
    const updateCalls = pool._calls.filter(
      (c) => c.sql.includes("UPDATE customer") || c.sql.includes("UPDATE seller")
    )
    expect(updateCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC6(g) — snapshot immutability (reuse assertPolicySnapshotImmutable)
// ---------------------------------------------------------------------------

describe("refund_request — snapshot immutability (AC5/AC6g)", () => {
  it("(g) mutation of policy_snapshot.refund_channel post-ISSUED throws", () => {
    const snapshot = snapshotPolicy({ validity_months: 12, refund_channel: "store_credit" })

    // Attempting to mutate the snapshot should throw (deep-frozen)
    expect(() => {
      ;(snapshot as any).refund_channel = "vendor_wallet"
    }).toThrow()
  })

  it("(g) assertPolicySnapshotImmutable detects snapshot swap on non-ISSUED instance", () => {
    const original = snapshotPolicy({ validity_months: 12, refund_channel: "store_credit" })
    const modified = snapshotPolicy({ validity_months: 12, refund_channel: "vendor_wallet" })

    expect(() =>
      assertPolicySnapshotImmutable(EntitlementInstanceState.ACTIVE, original, modified)
    ).toThrow(/immutable/)
  })

  it("(g) assertPolicySnapshotImmutable allows same snapshot on non-ISSUED", () => {
    const snap = snapshotPolicy({ validity_months: 12, refund_channel: "store_credit" })
    expect(() =>
      assertPolicySnapshotImmutable(EntitlementInstanceState.ACTIVE, snap, snap)
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Review-fix F-02 — amount positivity guard
// ---------------------------------------------------------------------------

describe("refund_request — amount validation (review-fix F-02)", () => {
  it("(i) rejects zero amount with EntitlementRefundError", async () => {
    const pool = makePool()
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_zero_001",
        amount: 0,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_REFUND_AMOUNT",
    })
  })

  it("(i) rejects negative amount with EntitlementRefundError", async () => {
    const pool = makePool()
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_neg_001",
        amount: -500,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_REFUND_AMOUNT",
    })
  })

  it("(i) rejects non-integer (fractional) amount with EntitlementRefundError", async () => {
    const pool = makePool()
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_frac_001",
        amount: 19.99,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_REFUND_AMOUNT",
    })
  })
})

// ---------------------------------------------------------------------------
// Review-fix F-05 — currency format validation
// ---------------------------------------------------------------------------

describe("refund_request — currency validation (review-fix F-05)", () => {
  it("(j) rejects empty currency string with EntitlementRefundError", async () => {
    const pool = makePool()
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_cur_001",
        amount: 1000,
        currency: "",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_CURRENCY",
    })
  })

  it("(j) rejects lowercase currency code with EntitlementRefundError", async () => {
    const pool = makePool()
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_cur_002",
        amount: 1000,
        currency: "pln",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_CURRENCY",
    })
  })
})

// ---------------------------------------------------------------------------
// Review-fix F-04 — entitlement state guard
// ---------------------------------------------------------------------------

describe("refund_request — state guard (review-fix F-04)", () => {
  it("(k) rejects REFUNDED (terminal) state with EntitlementRefundError", async () => {
    const entitlementRow = makeEntitlementRow("store_credit", EntitlementInstanceState.REFUNDED)
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [entitlementRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_state_001",
        amount: 1000,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_ENTITLEMENT_STATE_FOR_REFUND",
    })
  })

  it("(k) rejects CLOSED (terminal) state with EntitlementRefundError", async () => {
    const entitlementRow = makeEntitlementRow("store_credit", EntitlementInstanceState.CLOSED)
    const pool = makePool()
    pool.query = async (sql: string, params?: unknown[]) => {
      pool._calls.push({ sql, params: params ?? [] })
      const s = sql.trim().toUpperCase()
      if (s.startsWith("SELECT") && sql.includes("voucher_event")) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith("SELECT") && sql.includes("entitlement_instance")) {
        return { rows: [entitlementRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    pool.connect = async () => ({ query: pool.query, release: () => {} })
    const { svc } = makeService(pool)

    await expect(
      svc.refund_request("ent_test_001", {
        refund_id: "refund_state_002",
        amount: 1000,
        currency: "PLN",
      })
    ).rejects.toMatchObject({
      name: "EntitlementRefundError",
      code: "INVALID_ENTITLEMENT_STATE_FOR_REFUND",
    })
  })
})

// ---------------------------------------------------------------------------
// REFUND_CHANNELS enum boundary (AC2 — single-source integrity)
// ---------------------------------------------------------------------------

describe("REFUND_CHANNELS boundary (AC2)", () => {
  it("contains exactly [original_payment, store_credit, vendor_wallet]", () => {
    expect([...REFUND_CHANNELS].sort()).toEqual([
      "original_payment",
      "store_credit",
      "vendor_wallet",
    ])
  })

  it("does NOT contain bank_transfer (substrate drift fix AC1/AC2)", () => {
    expect(REFUND_CHANNELS).not.toContain("bank_transfer")
  })
})
