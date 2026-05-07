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
import type { VoucherWithEvents } from "../models/types"
import type { Pool, PoolClient } from "pg"

// ---------------------------------------------------------------------------
// Mock Pool factory
// ---------------------------------------------------------------------------

type QueryRow = Record<string, unknown>
type QueryResponse = { rows: QueryRow[] }

interface MockPoolConfig {
  queryResponses?: QueryResponse[]
  clientQueryResponses?: QueryResponse[]
  captureQuerySql?: string[]
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

  const mockClientQuery = jest.fn().mockImplementation(async () => {
    const resp = clientResponses[cIdx] ?? { rows: [] }
    cIdx++
    return resp
  })

  const mockClient: Partial<PoolClient> = {
    query: mockClientQuery as unknown as PoolClient["query"],
    release: jest.fn(),
  }

  const mockConnect = jest.fn().mockResolvedValue(mockClient)

  return {
    query: mockQuery,
    connect: mockConnect,
    end: jest.fn().mockResolvedValue(undefined),
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
})
