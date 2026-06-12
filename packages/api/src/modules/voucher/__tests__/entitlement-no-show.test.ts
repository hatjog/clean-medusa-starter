/**
 * Story 2.7 BE-6 — mark_no_show unit tests.
 *
 * AC7 cases (a)-(h):
 *   (a) forfeit_voucher  → VOIDED, no fee, event outcome=forfeiture
 *   (b) charge_partial   → fee = round(base*pct/100), remaining preserved+clamped, outcome=partial_fee
 *   (c) charge_full      → full fee, VOIDED, outcome=charge_full
 *   (d) no_charge        → no penalty, state unchanged, event outcome=no_charge
 *   (e) vendor_decision  → PENDING_VENDOR_DECISION via assertTransition, outcome=vendor_decision
 *   (f) idempotency      → 2× mark_no_show: fee once, event once
 *   (g) policy_snapshot  → policy read from snapshot (NOT live profile)
 *   (h) illegal src state (SETTLED/CLOSED) → EntitlementTransitionError
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals"
import { VoucherService, ENTITLEMENT_NO_SHOW_EVENT_TYPE } from "../service"
import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
} from "../models/entitlement"
import type { Pool, PoolClient } from "pg"

// ---------------------------------------------------------------------------
// Mock Pool factory (mirrors service.test.ts pattern)
// ---------------------------------------------------------------------------

type QueryRow = Record<string, unknown>
type QueryResponse = { rows: QueryRow[]; rowCount?: number | null }

interface MockPoolConfig {
  clientQueryResponses?: QueryResponse[]
  captureClientQueries?: Array<{ sql: string; params: unknown[] }>
}

function makeMockPool(config: MockPoolConfig = {}): Pool {
  let cIdx = 0
  const clientResponses = config.clientQueryResponses ?? []

  const mockClientQuery = jest
    .fn()
    .mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (config.captureClientQueries) {
        config.captureClientQueries.push({
          sql: String(sql),
          params: params ?? [],
        })
      }
      const resp = clientResponses[cIdx] ?? { rows: [] }
      cIdx++
      return resp
    })

  const mockClient: Partial<PoolClient> = {
    query: mockClientQuery as unknown as PoolClient["query"],
    release: jest.fn(),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockConnect = (jest.fn() as any).mockResolvedValue(mockClient)

  return {
    connect: mockConnect,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    end: (jest.fn() as any).mockResolvedValue(undefined),
  } as unknown as Pool
}

function makeService(pool: Pool): VoucherService {
  const svc = new VoucherService()
  svc._testPool = pool
  return svc
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INSTANCE: QueryRow = {
  id: "ent_no_show_001",
  entitlement_profile_id: "voucher-rezerwacja-otwarta",
  entitlement_type: EntitlementType.VOUCHER_SERVICE,
  order_id: "ord_001",
  market_id: "mkt_bonbeauty_pl",
  state: EntitlementInstanceState.ACTIVE,
  booking_pointer: null,
  policy_snapshot: JSON.stringify({
    validity_months: 12,
    no_show: { policy: "forfeit_voucher", charge_pct: 0 },
  }),
  expires_at: new Date("2027-05-16T12:00:00.000Z"),
  unpaid_extension_count: 0,
  remaining_amount: 20000,
  created_at: new Date("2026-05-16T08:00:00.000Z"),
  updated_at: new Date("2026-05-16T09:00:00.000Z"),
}

function instanceWithPolicy(policy: Record<string, unknown>, overrides: Partial<QueryRow> = {}): QueryRow {
  return {
    ...BASE_INSTANCE,
    policy_snapshot: JSON.stringify({
      validity_months: 12,
      no_show: policy,
    }),
    ...overrides,
  }
}

// Standard client responses: BEGIN, SELECT FOR UPDATE, UPDATE, INSERT event, COMMIT
function clientResponses(selectRow: QueryRow, updateRow?: QueryRow): QueryResponse[] {
  return [
    { rows: [] },                                           // BEGIN
    { rows: [selectRow], rowCount: 1 },                     // SELECT FOR UPDATE
    { rows: [updateRow ?? selectRow], rowCount: 1 },        // UPDATE
    { rows: [] },                                           // INSERT event
    { rows: [] },                                           // COMMIT
  ]
}

// For no_charge: no UPDATE — BEGIN, SELECT, INSERT event, COMMIT
function noChargeClientResponses(selectRow: QueryRow): QueryResponse[] {
  return [
    { rows: [] },                         // BEGIN
    { rows: [selectRow], rowCount: 1 },   // SELECT FOR UPDATE
    { rows: [] },                         // INSERT event
    { rows: [] },                         // COMMIT
  ]
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/gp_mercur"
})

afterEach(() => {
  delete process.env.DATABASE_URL
})

// ---------------------------------------------------------------------------
// (a) forfeit_voucher → VOIDED, no fee, event outcome=forfeiture
// ---------------------------------------------------------------------------

describe("mark_no_show — (a) forfeit_voucher → VOIDED", () => {
  it("transitions to VOIDED, emits forfeiture event, no fee", async () => {
    const row = instanceWithPolicy({ policy: "forfeit_voucher", charge_pct: 0 })
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: clientResponses(row),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", { reason: "client did not appear" })

    expect(result.outcome).toBe("forfeiture")
    expect(result.resulting_state).toBe(EntitlementInstanceState.VOIDED)
    expect(result.fee_amount).toBeUndefined()

    const update = capturedClientQueries.find((q) =>
      q.sql.includes("UPDATE entitlement_instance")
    )
    expect(update?.sql).toContain("state = $2")
    expect(update?.params).toContain(EntitlementInstanceState.VOIDED)

    const event = capturedClientQueries.find(
      (q) =>
        q.sql.includes("INSERT INTO voucher_event") &&
        q.params[2] === ENTITLEMENT_NO_SHOW_EVENT_TYPE
    )
    expect(event).toBeDefined()
    expect((event?.params[3] as Record<string, unknown>).outcome).toBe("forfeiture")
    expect((event?.params[3] as Record<string, unknown>).no_show_policy).toBe(
      "forfeit_voucher"
    )
  })
})

// ---------------------------------------------------------------------------
// (b) charge_partial → fee calc, remaining preserved+clamped, outcome=partial_fee
// ---------------------------------------------------------------------------

describe("mark_no_show — (b) charge_partial", () => {
  it("computes fee=round(base*pct/100), preserves remaining_amount, state unchanged", async () => {
    const row = instanceWithPolicy({ policy: "charge_partial", charge_pct: 50 })
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const updatedRow = { ...row, remaining_amount: 10000 }
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: clientResponses(row, updatedRow),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", {
      reason: "no show",
      base_amount: 20000,
    })

    // fee = round(20000 * 50 / 100) = 10000
    expect(result.fee_amount).toBe(10000)
    expect(result.charge_pct).toBe(50)
    expect(result.remaining_amount).toBe(10000) // 20000 - 10000
    expect(result.outcome).toBe("partial_fee")
    expect(result.resulting_state).toBe(EntitlementInstanceState.ACTIVE)

    const update = capturedClientQueries.find((q) =>
      q.sql.includes("UPDATE entitlement_instance") &&
      q.sql.includes("remaining_amount")
    )
    expect(update?.params).toContain(10000)

    const event = capturedClientQueries.find(
      (q) =>
        q.sql.includes("INSERT INTO voucher_event") &&
        q.params[2] === ENTITLEMENT_NO_SHOW_EVENT_TYPE
    )
    expect((event?.params[3] as Record<string, unknown>).outcome).toBe("partial_fee")
    expect((event?.params[3] as Record<string, unknown>).fee_amount).toBe(10000)
  })

  it("clamps remaining_amount to >= 0 when fee exceeds balance", async () => {
    const row = instanceWithPolicy(
      { policy: "charge_partial", charge_pct: 100 },
      { remaining_amount: 5000 }
    )
    const updatedRow = { ...row, remaining_amount: 0 }
    const pool = makeMockPool({
      clientQueryResponses: clientResponses(row, updatedRow),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", {
      reason: "no show",
      base_amount: 20000,
    })

    expect(result.remaining_amount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (c) charge_full → full fee, VOIDED
// ---------------------------------------------------------------------------

describe("mark_no_show — (c) charge_full", () => {
  it("applies full fee and sets state to VOIDED", async () => {
    const row = instanceWithPolicy({ policy: "charge_full", charge_pct: 100 })
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const updatedRow = { ...row, state: EntitlementInstanceState.VOIDED, remaining_amount: 0 }
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: clientResponses(row, updatedRow),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", {
      reason: "no show",
      base_amount: 20000,
    })

    expect(result.outcome).toBe("charge_full")
    expect(result.fee_amount).toBe(20000)
    expect(result.resulting_state).toBe(EntitlementInstanceState.VOIDED)

    const update = capturedClientQueries.find(
      (q) =>
        q.sql.includes("UPDATE entitlement_instance") &&
        q.sql.includes("remaining_amount = 0")
    )
    expect(update?.params).toContain(EntitlementInstanceState.VOIDED)
  })
})

// ---------------------------------------------------------------------------
// (d) no_charge → no penalty, state unchanged, event emitted
// ---------------------------------------------------------------------------

describe("mark_no_show — (d) no_charge", () => {
  it("does not mutate state, no fee, still emits audit event", async () => {
    const row = instanceWithPolicy({ policy: "no_charge" })
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: noChargeClientResponses(row),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", { reason: "no show" })

    expect(result.outcome).toBe("no_charge")
    expect(result.resulting_state).toBe(EntitlementInstanceState.ACTIVE)
    expect(result.fee_amount).toBeUndefined()

    const hasUpdate = capturedClientQueries.some(
      (q) => q.sql.includes("UPDATE entitlement_instance")
    )
    expect(hasUpdate).toBe(false)

    const event = capturedClientQueries.find(
      (q) =>
        q.sql.includes("INSERT INTO voucher_event") &&
        q.params[2] === ENTITLEMENT_NO_SHOW_EVENT_TYPE
    )
    expect(event).toBeDefined()
    expect((event?.params[3] as Record<string, unknown>).outcome).toBe("no_charge")
  })
})

// ---------------------------------------------------------------------------
// (e) vendor_decision → PENDING_VENDOR_DECISION
// ---------------------------------------------------------------------------

describe("mark_no_show — (e) vendor_decision", () => {
  it("transitions to PENDING_VENDOR_DECISION via assertTransition", async () => {
    const row = instanceWithPolicy({ policy: "vendor_decision" })
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const updatedRow = {
      ...row,
      state: EntitlementInstanceState.PENDING_VENDOR_DECISION,
    }
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: clientResponses(row, updatedRow),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", { reason: "no show" })

    expect(result.outcome).toBe("vendor_decision")
    expect(result.resulting_state).toBe(
      EntitlementInstanceState.PENDING_VENDOR_DECISION
    )

    const update = capturedClientQueries.find((q) =>
      q.sql.includes("UPDATE entitlement_instance")
    )
    expect(update?.params).toContain(
      EntitlementInstanceState.PENDING_VENDOR_DECISION
    )
  })
})

// ---------------------------------------------------------------------------
// (f) idempotency — 2× mark_no_show skips on already-no-show state
// ---------------------------------------------------------------------------

describe("mark_no_show — (f) idempotency", () => {
  it("returns early without mutation or event when already VOIDED", async () => {
    const row = instanceWithPolicy(
      { policy: "forfeit_voucher", charge_pct: 0 },
      { state: EntitlementInstanceState.VOIDED }
    )
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: [
        { rows: [] },                        // BEGIN
        { rows: [row], rowCount: 1 },        // SELECT FOR UPDATE
        { rows: [] },                        // ROLLBACK (idempotent path)
      ],
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", { reason: "repeat" })

    expect(result.resulting_state).toBe(EntitlementInstanceState.VOIDED)

    const hasUpdate = capturedClientQueries.some(
      (q) => q.sql.includes("UPDATE entitlement_instance")
    )
    expect(hasUpdate).toBe(false)

    const hasEvent = capturedClientQueries.some(
      (q) => q.sql.includes("INSERT INTO voucher_event")
    )
    expect(hasEvent).toBe(false)
  })

  it("returns early without mutation or event when already PENDING_VENDOR_DECISION", async () => {
    const row = instanceWithPolicy(
      { policy: "vendor_decision" },
      { state: EntitlementInstanceState.PENDING_VENDOR_DECISION }
    )
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: [
        { rows: [] },
        { rows: [row], rowCount: 1 },
        { rows: [] },
      ],
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", { reason: "repeat" })

    expect(result.resulting_state).toBe(
      EntitlementInstanceState.PENDING_VENDOR_DECISION
    )
    expect(result.outcome).toBe("vendor_decision")
    expect(
      capturedClientQueries.some((q) =>
        q.sql.includes("UPDATE entitlement_instance")
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (g) policy read from policy_snapshot (NOT live profile)
// ---------------------------------------------------------------------------

describe("mark_no_show — (g) policy from snapshot, not live profile", () => {
  it("uses policy_snapshot.no_show, ignoring any hypothetical live profile change", async () => {
    // snapshot says forfeit_voucher → must VOID even if live profile were different
    const row = instanceWithPolicy({ policy: "forfeit_voucher", charge_pct: 0 })
    const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
    const pool = makeMockPool({
      captureClientQueries: capturedClientQueries,
      clientQueryResponses: clientResponses(row),
    })
    const svc = makeService(pool)

    const result = await svc.mark_no_show("ent_no_show_001", { reason: "snapshot test" })

    // Must obey snapshot → VOIDED regardless of what a live profile would say
    expect(result.resulting_state).toBe(EntitlementInstanceState.VOIDED)
    expect(result.outcome).toBe("forfeiture")
  })
})

// ---------------------------------------------------------------------------
// (h) illegal source state → EntitlementTransitionError
// ---------------------------------------------------------------------------

describe("mark_no_show — (h) illegal source state", () => {
  for (const badState of [
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.REFUNDED,
  ]) {
    it(`rejects forfeit_voucher from ${badState} with EntitlementTransitionError`, async () => {
      const row = instanceWithPolicy(
        { policy: "forfeit_voucher", charge_pct: 0 },
        { state: badState }
      )
      const pool = makeMockPool({
        clientQueryResponses: [
          { rows: [] },               // BEGIN
          { rows: [row], rowCount: 1 }, // SELECT FOR UPDATE
          { rows: [] },               // ROLLBACK
        ],
      })
      const svc = makeService(pool)

      await expect(
        svc.mark_no_show("ent_no_show_001", { reason: "bad state" })
      ).rejects.toThrow(EntitlementTransitionError)
    })
  }

  it("rejects vendor_decision from SETTLED", async () => {
    const row = instanceWithPolicy(
      { policy: "vendor_decision" },
      { state: EntitlementInstanceState.SETTLED }
    )
    const pool = makeMockPool({
      clientQueryResponses: [
        { rows: [] },
        { rows: [row], rowCount: 1 },
        { rows: [] },
      ],
    })
    const svc = makeService(pool)

    await expect(
      svc.mark_no_show("ent_no_show_001", { reason: "bad state" })
    ).rejects.toThrow(EntitlementTransitionError)
  })

  // H1 fix coverage: charge_partial and no_charge must also reject invalid source states.
  it("rejects charge_partial from SETTLED (H1 guard)", async () => {
    const row = instanceWithPolicy(
      { policy: "charge_partial", charge_pct: 50 },
      { state: EntitlementInstanceState.SETTLED }
    )
    const pool = makeMockPool({
      clientQueryResponses: [
        { rows: [] },
        { rows: [row], rowCount: 1 },
        { rows: [] },
      ],
    })
    const svc = makeService(pool)

    await expect(
      svc.mark_no_show("ent_no_show_001", { reason: "bad state", base_amount: 20000 })
    ).rejects.toThrow(EntitlementTransitionError)
  })

  it("rejects no_charge from SETTLED (H1 guard)", async () => {
    const row = instanceWithPolicy(
      { policy: "no_charge" },
      { state: EntitlementInstanceState.SETTLED }
    )
    const pool = makeMockPool({
      clientQueryResponses: [
        { rows: [] },
        { rows: [row], rowCount: 1 },
        { rows: [] },
      ],
    })
    const svc = makeService(pool)

    await expect(
      svc.mark_no_show("ent_no_show_001", { reason: "bad state" })
    ).rejects.toThrow(EntitlementTransitionError)
  })
})
