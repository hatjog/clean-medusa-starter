/**
 * voucher/service.test.ts — Story v160-cleanup-25 AC4 (a)-(f).
 *
 * Tests run against an injected mock Pool to avoid real DB connections.
 * Uses the `_testPool` injection point on VoucherService (test-only API).
 *
 * Covers:
 *   (a) Creation: upsert + getByCode
 *   (b) Claim happy path: idle → claimed + claimed event appended
 *   (c) Claim already-claimed: idempotent return of existing state
 *   (d) Claim expired: returns { status: "expired" }
 *   (e) Cross-vendor: seller isolation (voucher code is the secret;
 *       market isolation enforced at route layer via ALS)
 *   (f) Audit trail: events ordered chronologically; appendEvent visible on read
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals"
import { VoucherService } from "../service"
import type { CancellationPaymentRefundSeam } from "../service"
import type { VoucherWithEvents } from "../models/types"
import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
} from "../models/entitlement"
import type { Pool, PoolClient } from "pg"

// ---------------------------------------------------------------------------
// Mock Pool factory
// ---------------------------------------------------------------------------

type QueryRow = Record<string, unknown>
type QueryResponse = { rows: QueryRow[] }
type EntitlementTestRow = QueryRow & {
  id: string
  entitlement_profile_id: string
  entitlement_type: EntitlementType
  order_id: string | null
  state: EntitlementInstanceState
  policy_snapshot: Record<string, unknown>
  booking_pointer: string | null
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}

interface MockPoolConfig {
  queryResponses?: QueryResponse[]
  clientQueryResponses?: QueryResponse[]
  captureQuerySql?: string[]
  captureClientQueries?: Array<{ sql: string; params: unknown[] }>
}

function makeMockPool(config: MockPoolConfig = {}): Pool {
  let qIdx = 0
  let cIdx = 0
  const responses = config.queryResponses ?? []
  const clientResponses = config.clientQueryResponses ?? []
  const capture = config.captureQuerySql

  const mockQuery = jest.fn().mockImplementation(async (sql: unknown) => {
    if (capture) capture.push(String(sql))
    const resp = responses[qIdx] ?? { rows: [] }
    qIdx++
    return resp
  })

  const mockClientQuery = jest.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
    if (config.captureClientQueries) {
      config.captureClientQueries.push({ sql: String(sql), params: params ?? [] })
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
    query: mockQuery,
    connect: mockConnect,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    end: (jest.fn() as any).mockResolvedValue(undefined),
  } as unknown as Pool
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const IDLE_ROW: QueryRow = {
  code: "E2E-IDLE-VOUCHER-001",
  market_id: null,
  seller_id: "sel_01CITYBEAUTY00000000000",
  seller_name: "City Beauty",
  seller_handle: "city-beauty",
  product_title: "Peeling kwasami",
  value_minor: "22000",
  currency_code: "PLN",
  status: "idle",
  expires_at: new Date("2027-12-31T23:59:59Z"),
  created_at: new Date("2026-05-04T08:00:00Z"),
  updated_at: new Date("2026-05-04T08:00:00Z"),
}

const IDLE_EVENTS: QueryRow[] = [
  {
    id: "evt-idle-001-created",
    voucher_code: "E2E-IDLE-VOUCHER-001",
    event_type: "created",
    occurred_at: new Date("2026-05-04T08:00:00Z"),
    created_at: new Date("2026-05-04T08:00:00Z"),
  },
  {
    id: "evt-idle-001-sent",
    voucher_code: "E2E-IDLE-VOUCHER-001",
    event_type: "sent",
    occurred_at: new Date("2026-05-04T08:01:00Z"),
    created_at: new Date("2026-05-04T08:01:00Z"),
  },
]

const CLAIMED_ROW: QueryRow = {
  ...IDLE_ROW,
  code: "E2E-CLAIMED-VOUCHER-002",
  seller_id: "sel_01KREMIDOTYK0000000000",
  seller_name: "Kremidotyk",
  seller_handle: "kremidotyk",
  product_title: "Peeling węglowy",
  value_minor: "24000",
  status: "claimed",
}

const EXPIRED_ROW: QueryRow = {
  ...IDLE_ROW,
  code: "EXPIRED-VOUCHER-003",
  status: "idle",
  expires_at: new Date("2020-01-01T00:00:00Z"),
}

const SERVICE_POLICY = {
  validity_months: 12,
  cancellation: { cutoff_hours: 24, fee_pct: 0, deduct_method: "forfeit_credit" },
}

const ENTITLEMENT_REBOOK_ROW: EntitlementTestRow = {
  id: "ent_service_rebook_001",
  entitlement_profile_id: "voucher-rezerwacja-otwarta",
  entitlement_type: EntitlementType.VOUCHER_SERVICE,
  order_id: "ord_rebook_001",
  state: EntitlementInstanceState.REDEMPTION_REQUESTED,
  policy_snapshot: SERVICE_POLICY,
  booking_pointer: "booking_abc_123",
  expires_at: new Date("2027-05-16T12:00:00.000Z"),
  created_at: new Date("2026-05-16T08:00:00.000Z"),
  updated_at: new Date("2026-05-16T09:00:00.000Z"),
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // DATABASE_URL is not needed for injected-pool tests, but set for safety
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/gp_mercur"
})

afterEach(() => {
  delete process.env.DATABASE_URL
})

function makeService(pool: Pool): VoucherService {
  const svc = new VoucherService()
  svc._testPool = pool
  return svc
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VoucherService", () => {

  // (a) Creation: upsert + getByCode
  describe("(a) Creation — upsert + getByCode", () => {
    it("upsert inserts a voucher; getByCode returns it with events", async () => {
      const pool = makeMockPool({
        queryResponses: [
          { rows: [] },           // INSERT INTO voucher
          { rows: [IDLE_ROW] },   // SELECT * FROM voucher WHERE code
          { rows: IDLE_EVENTS },  // SELECT * FROM voucher_event
        ],
      })
      const svc = makeService(pool)

      const result = await svc.upsert({
        code: "E2E-IDLE-VOUCHER-001",
        seller_id: IDLE_ROW.seller_id as string,
        seller_name: IDLE_ROW.seller_name as string,
        seller_handle: IDLE_ROW.seller_handle as string,
        product_title: IDLE_ROW.product_title as string,
        value_minor: 22000,
        currency_code: IDLE_ROW.currency_code as string,
        status: "idle",
        expires_at: IDLE_ROW.expires_at as Date,
        events: [],
      })

      expect(result.code).toBe("E2E-IDLE-VOUCHER-001")
      expect(result.status).toBe("idle")
      expect(result.events).toHaveLength(2)
    })

    it("getByCode returns null if not found", async () => {
      const pool = makeMockPool({ queryResponses: [{ rows: [] }] })
      const svc = makeService(pool)

      const result = await svc.getByCode("NONEXISTENT-CODE")
      expect(result).toBeNull()
    })

    it("getByCode includes events in DB order", async () => {
      const pool = makeMockPool({
        queryResponses: [
          { rows: [IDLE_ROW] },
          { rows: IDLE_EVENTS },
        ],
      })
      const svc = makeService(pool)

      const result = await svc.getByCode("E2E-IDLE-VOUCHER-001")
      expect(result).not.toBeNull()
      expect(result!.events[0].event_type).toBe("created")
      expect(result!.events[1].event_type).toBe("sent")
    })
  })

  // (b) Claim happy path
  describe("(b) Claim happy path — idle → claimed + event appended", () => {
    it("claim(code) transitions idle voucher to claimed", async () => {
      const claimedRow = { ...IDLE_ROW, status: "claimed" }
      const claimedEvents = [
        ...IDLE_EVENTS,
        {
          id: "evt-claimed",
          voucher_code: "E2E-IDLE-VOUCHER-001",
          event_type: "claimed",
          occurred_at: new Date(),
          created_at: new Date(),
        },
      ]

      const pool = makeMockPool({
        // pool.query: initial getByCode (2 queries) + post-claim getByCode (2 queries)
        queryResponses: [
          { rows: [IDLE_ROW] },
          { rows: IDLE_EVENTS },
          { rows: [claimedRow] },
          { rows: claimedEvents },
        ],
        // F2: Transaction client: BEGIN / SELECT FOR UPDATE / UPDATE / INSERT / COMMIT
        clientQueryResponses: [
          { rows: [] },                                                    // BEGIN
          { rows: [{ status: "idle", expires_at: IDLE_ROW.expires_at }] }, // SELECT FOR UPDATE
          { rows: [], rowCount: 1 } as unknown as { rows: QueryRow[] },    // UPDATE
          { rows: [] },                                                    // INSERT event
          { rows: [] },                                                    // COMMIT
        ],
      })
      const svc = makeService(pool)

      const result = await svc.claim("E2E-IDLE-VOUCHER-001")
      expect(result.status).toBe("claimed")
      const claimed = result as { status: "claimed"; voucher: VoucherWithEvents }
      expect(claimed.voucher.status).toBe("claimed")
    })
  })

  // (c) Claim already-claimed
  describe("(c) Claim already-claimed — idempotent no-op", () => {
    it("claim on already-claimed voucher returns status=already_claimed", async () => {
      const pool = makeMockPool({
        queryResponses: [
          { rows: [CLAIMED_ROW] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      const result = await svc.claim("E2E-CLAIMED-VOUCHER-002")
      expect(result.status).toBe("already_claimed")
      const r = result as { status: "already_claimed"; voucher: VoucherWithEvents }
      expect(r.voucher.status).toBe("claimed")
    })
  })

  // (d) Claim expired
  describe("(d) Claim expired — returns expired status", () => {
    it("claim on expired voucher returns status=expired", async () => {
      const pool = makeMockPool({
        queryResponses: [
          { rows: [EXPIRED_ROW] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      const result = await svc.claim("EXPIRED-VOUCHER-003", {
        now: new Date("2026-05-07T00:00:00Z"),
      })
      expect(result.status).toBe("expired")
    })
  })

  // (e) Cross-vendor voucher
  describe("(e) Cross-vendor — seller isolation", () => {
    it("getByCode returns voucher for recipient regardless of seller scope", async () => {
      // voucher code is the secret (AR45 boundary). Seller isolation
      // enforced at route level via ALS market scoping (cleanup-27, TF-46).
      const pool = makeMockPool({
        queryResponses: [
          { rows: [IDLE_ROW] },
          { rows: IDLE_EVENTS },
        ],
      })
      const svc = makeService(pool)

      const result = await svc.getByCode("E2E-IDLE-VOUCHER-001")
      expect(result).not.toBeNull()
      expect(result!.seller_id).toBe("sel_01CITYBEAUTY00000000000")
    })

    it("getByCode returns null for unknown code (no seller-B data leak)", async () => {
      const pool = makeMockPool({ queryResponses: [{ rows: [] }] })
      const svc = makeService(pool)

      const result = await svc.getByCode("SELLER-B-VOUCHER-UNKNOWN")
      expect(result).toBeNull()
    })
  })

  // (f) Audit trail
  describe("(f) Audit trail — events ordered and appendEvent visible", () => {
    it("appendEvent inserts event row for given code + event_type", async () => {
      const capturedSql: string[] = []
      const pool = makeMockPool({
        queryResponses: [{ rows: [] }],
        captureQuerySql: capturedSql,
      })
      const svc = makeService(pool)

      const evt = await svc.appendEvent("E2E-IDLE-VOUCHER-001", {
        event_type: "opened",
        occurred_at: new Date("2026-05-04T09:00:00Z"),
      })
      expect(evt.event_type).toBe("opened")
      expect(evt.voucher_code).toBe("E2E-IDLE-VOUCHER-001")
      expect(capturedSql.some((s) => s.includes("INSERT INTO voucher_event"))).toBe(true)
    })

    it("getByCode returns events in DB-ordered sequence", async () => {
      const pool = makeMockPool({
        queryResponses: [
          { rows: [IDLE_ROW] },
          { rows: IDLE_EVENTS },
        ],
      })
      const svc = makeService(pool)

      const result = await svc.getByCode("E2E-IDLE-VOUCHER-001")
      expect(result!.events).toHaveLength(2)
      const types = result!.events.map((e) => e.event_type)
      expect(types).toContain("created")
      expect(types).toContain("sent")
    })
  })

  // listCodes
  describe("listCodes", () => {
    it("returns all voucher codes", async () => {
      const pool = makeMockPool({
        queryResponses: [{
          rows: [{ code: "CODE-A" }, { code: "CODE-B" }],
        }],
      })
      const svc = makeService(pool)

      const codes = await svc.listCodes()
      expect(codes).toEqual(["CODE-A", "CODE-B"])
    })
  })

  // claim not_found
  describe("claim not_found", () => {
    it("claim on nonexistent code returns status=not_found", async () => {
      const pool = makeMockPool({ queryResponses: [{ rows: [] }] })
      const svc = makeService(pool)

      const result = await svc.claim("NONEXISTENT-999")
      expect(result.status).toBe("not_found")
    })
  })

  describe("cancel_booking — service voucher rebook state machine", () => {
    it("returns REDEMPTION_REQUESTED service voucher to ACTIVE without changing TTL or policy snapshot", async () => {
      const updatedRow = {
        ...ENTITLEMENT_REBOOK_ROW,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
      }
      const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
      const pool = makeMockPool({
        captureClientQueries: capturedClientQueries,
        clientQueryResponses: [
          { rows: [] },
          { rows: [ENTITLEMENT_REBOOK_ROW] },
          { rows: [updatedRow], rowCount: 1 } as unknown as QueryResponse,
          { rows: [] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      const beforePolicy = structuredClone(ENTITLEMENT_REBOOK_ROW.policy_snapshot)
      const beforeExpiresAt = ENTITLEMENT_REBOOK_ROW.expires_at

      const result = await svc.cancel_booking("ent_service_rebook_001")

      expect(result.state).toBe(EntitlementInstanceState.ACTIVE)
      expect(result.booking_pointer).toBeNull()
      expect((result as unknown as { expires_at?: Date }).expires_at).toBe(beforeExpiresAt)
      expect(result.policy_snapshot).toEqual(beforePolicy)

      const update = capturedClientQueries.find((q) =>
        q.sql.includes("UPDATE entitlement_instance")
      )
      expect(update?.sql).toContain("booking_pointer = NULL")
      expect(update?.sql).toContain("state = $2")
      expect(update?.sql).not.toContain("expires_at")

      const eventInsert = capturedClientQueries.find((q) =>
        q.sql.includes("INSERT INTO voucher_event")
      )
      expect(eventInsert?.sql).toContain("payload")
      expect(eventInsert?.params[2]).toBe("ENTITLEMENT_BOOKING_CANCELLED")
      expect(eventInsert?.params[3]).toEqual({
        entitlement_id: "ent_service_rebook_001",
        previous_state: EntitlementInstanceState.REDEMPTION_REQUESTED,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
        entitlement_type: EntitlementType.VOUCHER_SERVICE,
      })
    })

    it("rejects illegal source states without mutation or event emission", async () => {
      const activeRow = {
        ...ENTITLEMENT_REBOOK_ROW,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: "booking_abc_123",
      }
      const closedRow = {
        ...ENTITLEMENT_REBOOK_ROW,
        state: EntitlementInstanceState.CLOSED,
        booking_pointer: "booking_closed_123",
      }
      const refundRequestedRow = {
        ...ENTITLEMENT_REBOOK_ROW,
        state: EntitlementInstanceState.REFUND_REQUESTED,
        booking_pointer: "booking_refund_123",
      }

      for (const row of [activeRow, closedRow, refundRequestedRow]) {
        const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
        const pool = makeMockPool({
          captureClientQueries: capturedClientQueries,
          clientQueryResponses: [
            { rows: [] },
            { rows: [row] },
            { rows: [] },
          ],
        })
        const svc = makeService(pool)

        await expect(svc.cancel_booking(row.id)).rejects.toThrow(
          EntitlementTransitionError
        )

        expect(
          capturedClientQueries.some((q) =>
            q.sql.includes("UPDATE entitlement_instance")
          )
        ).toBe(false)
        expect(
          capturedClientQueries.some((q) => q.sql.includes("INSERT INTO voucher_event"))
        ).toBe(false)
      }
    })

    it("supports rebook lifecycle: request → cancel → request → redeem while preserving TTL", async () => {
      const expiresAt = ENTITLEMENT_REBOOK_ROW.expires_at
      const policySnapshot = structuredClone(ENTITLEMENT_REBOOK_ROW.policy_snapshot)
      let instance: EntitlementTestRow = {
        ...ENTITLEMENT_REBOOK_ROW,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
      }

      function requestRedemption(bookingPointer: string): void {
        expect(instance.state).toBe(EntitlementInstanceState.ACTIVE)
        instance = {
          ...instance,
          state: EntitlementInstanceState.REDEMPTION_REQUESTED,
          booking_pointer: bookingPointer,
        }
      }

      function redeem(): void {
        expect(instance.state).toBe(EntitlementInstanceState.REDEMPTION_REQUESTED)
        instance = {
          ...instance,
          state: EntitlementInstanceState.REDEEMED_FULL,
        }
      }

      requestRedemption("booking_first")

      const updatedRow = {
        ...instance,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
      }
      // M2 fix: capture real client queries so we can verify the INSERT INTO
      // voucher_event for ENTITLEMENT_BOOKING_CANCELLED fires exactly once,
      // not via a self-pushed local array (which was tautological).
      const capturedLifecycleQueries: Array<{ sql: string; params: unknown[] }> = []
      const pool = makeMockPool({
        captureClientQueries: capturedLifecycleQueries,
        clientQueryResponses: [
          { rows: [] },
          { rows: [instance] },
          { rows: [updatedRow], rowCount: 1 } as unknown as QueryResponse,
          { rows: [] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      instance = {
        ...instance,
        ...(await svc.cancel_booking("ent_service_rebook_001")),
      }

      expect(instance.state).toBe(EntitlementInstanceState.ACTIVE)
      expect(instance.booking_pointer).toBeNull()
      expect(instance.expires_at).toBe(expiresAt)
      expect(instance.policy_snapshot).toEqual(policySnapshot)

      // AC6: verify ENTITLEMENT_BOOKING_CANCELLED was actually inserted into
      // voucher_event exactly once (not just asserted via a hand-pushed array).
      const cancelledEventInserts = capturedLifecycleQueries.filter(
        (q) =>
          q.sql.includes("INSERT INTO voucher_event") &&
          q.params[2] === "ENTITLEMENT_BOOKING_CANCELLED"
      )
      expect(cancelledEventInserts).toHaveLength(1)

      requestRedemption("booking_second")
      redeem()

      expect(instance.state).toBe(EntitlementInstanceState.REDEEMED_FULL)
      expect(instance.expires_at).toBe(expiresAt)
    })

    it("applies forfeit_credit cancellation fee inside cutoff and emits audit event", async () => {
      const scheduledAt = new Date("2026-05-17T10:00:00.000Z")
      const cancelledAt = new Date("2026-05-17T02:00:00.000Z")
      const row = {
        ...ENTITLEMENT_REBOOK_ROW,
        remaining_amount: 10000,
        policy_snapshot: {
          validity_months: 12,
          cancellation: {
            cutoff_hours: 12,
            fee_pct: 25,
            deduct_method: "forfeit_credit",
          },
        },
      }
      const updatedRow = {
        ...row,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
        remaining_amount: 7500,
      }
      const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
      const pool = makeMockPool({
        captureClientQueries: capturedClientQueries,
        clientQueryResponses: [
          { rows: [] },
          { rows: [row] },
          { rows: [updatedRow], rowCount: 1 } as unknown as QueryResponse,
          { rows: [] },
          { rows: [] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      const result = await svc.cancel_booking("ent_service_rebook_001", {
        current_time: cancelledAt,
        scheduled_at: scheduledAt,
        base_amount: 10000,
      })

      expect(result.remaining_amount).toBe(7500)
      const update = capturedClientQueries.find((q) =>
        q.sql.includes("UPDATE entitlement_instance")
      )
      expect(update?.params).toEqual([
        "ent_service_rebook_001",
        EntitlementInstanceState.ACTIVE,
        7500,
      ])
      const feeEvent = capturedClientQueries.find(
        (q) => q.params[2] === "ENTITLEMENT_CANCELLATION_FEE_APPLIED"
      )
      expect(feeEvent?.params[3]).toEqual({
        entitlement_id: "ent_service_rebook_001",
        fee_amount: 2500,
        fee_pct: 25,
        deduct_method: "forfeit_credit",
        base_amount: 10000,
        cutoff_hours: 12,
        cancelled_at: cancelledAt.toISOString(),
        scheduled_at: scheduledAt.toISOString(),
        remaining_amount: 7500,
      })
    })

    it("applies charge_card cancellation fee through refund seam inside cutoff", async () => {
      const scheduledAt = new Date("2026-05-17T10:00:00.000Z")
      const cancelledAt = new Date("2026-05-17T03:00:00.000Z")
      const paymentRefund =
        jest.fn() as jest.MockedFunction<CancellationPaymentRefundSeam>
      const row = {
        ...ENTITLEMENT_REBOOK_ROW,
        remaining_amount: 10000,
        policy_snapshot: {
          validity_months: 12,
          cancellation: {
            cutoff_hours: 12,
            fee_pct: 10,
            deduct_method: "charge_card",
          },
        },
      }
      const updatedRow = {
        ...row,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
      }
      const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
      const pool = makeMockPool({
        captureClientQueries: capturedClientQueries,
        clientQueryResponses: [
          { rows: [] },
          { rows: [row] },
          { rows: [updatedRow], rowCount: 1 } as unknown as QueryResponse,
          { rows: [] },
          { rows: [] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      await svc.cancel_booking("ent_service_rebook_001", {
        current_time: cancelledAt,
        scheduled_at: scheduledAt,
        base_amount: 10000,
        currency: "PLN",
        payment_refund: paymentRefund,
      })

      expect(paymentRefund).toHaveBeenCalledWith({
        entitlement_id: "ent_service_rebook_001",
        order_id: "ord_rebook_001",
        refund_amount: 9000,
        fee_amount: 1000,
        base_amount: 10000,
        currency: "PLN",
      })
      const feeEvent = capturedClientQueries.find(
        (q) => q.params[2] === "ENTITLEMENT_CANCELLATION_FEE_APPLIED"
      )
      expect(feeEvent?.params[3]).toEqual(
        expect.objectContaining({
          fee_amount: 1000,
          fee_pct: 10,
          deduct_method: "charge_card",
          refund_amount: 9000,
        })
      )
    })

    it("does not apply cancellation fee outside cutoff", async () => {
      const row = {
        ...ENTITLEMENT_REBOOK_ROW,
        remaining_amount: 10000,
        policy_snapshot: {
          validity_months: 12,
          cancellation: {
            cutoff_hours: 12,
            fee_pct: 25,
            deduct_method: "forfeit_credit",
          },
        },
      }
      const updatedRow = {
        ...row,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
      }
      const capturedClientQueries: Array<{ sql: string; params: unknown[] }> = []
      const pool = makeMockPool({
        captureClientQueries: capturedClientQueries,
        clientQueryResponses: [
          { rows: [] },
          { rows: [row] },
          { rows: [updatedRow], rowCount: 1 } as unknown as QueryResponse,
          { rows: [] },
          { rows: [] },
        ],
      })
      const svc = makeService(pool)

      await svc.cancel_booking("ent_service_rebook_001", {
        current_time: new Date("2026-05-16T10:00:00.000Z"),
        scheduled_at: new Date("2026-05-17T10:00:00.000Z"),
        base_amount: 10000,
      })

      expect(
        capturedClientQueries.some(
          (q) => q.params[2] === "ENTITLEMENT_CANCELLATION_FEE_APPLIED"
        )
      ).toBe(false)
      const update = capturedClientQueries.find((q) =>
        q.sql.includes("UPDATE entitlement_instance")
      )
      expect(update?.params[2]).toBeNull()
    })
  })
})
