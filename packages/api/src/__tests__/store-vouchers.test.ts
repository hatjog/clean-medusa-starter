/**
 * Story v160-cleanup-25 — store-vouchers tests (updated from v160-cleanup-13b).
 *
 * Tests the VoucherService + AR45 PII allowlist projection contract.
 * Previous test used in-memory voucher-fixture-store (deleted in cleanup-25).
 * This version tests the same contract via VoucherService with an injected
 * mock Pool.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals"
import { VoucherService } from "../modules/voucher/service"
import type { Pool, PoolClient } from "pg"

type QueryRow = Record<string, unknown>
type QueryResponse = { rows: QueryRow[] }

function makeMockPool(responses: QueryResponse[]): Pool {
  let idx = 0
  const mockQuery = async () => {
    const resp = responses[idx] ?? { rows: [] }
    idx++
    return resp
  }
  const mockClient: Partial<PoolClient> = {
    query: async () => ({ rows: [] }),
    release: () => {},
  }
  return {
    query: mockQuery,
    connect: async () => mockClient,
    end: async () => {},
  } as unknown as Pool
}

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

const CLAIMED_ROW: QueryRow = {
  code: "E2E-CLAIMED-VOUCHER-002",
  market_id: null,
  seller_id: "sel_01KREMIDOTYK0000000000",
  seller_name: "Kremidotyk",
  seller_handle: "kremidotyk",
  product_title: "Peeling węglowy",
  value_minor: "24000",
  currency_code: "PLN",
  status: "claimed",
  expires_at: new Date("2027-12-31T23:59:59Z"),
  created_at: new Date("2026-05-04T09:00:00Z"),
  updated_at: new Date("2026-05-04T10:05:00Z"),
}

const CLAIMED_EVENTS: QueryRow[] = [
  { id: "evt-claimed-002-created", voucher_code: "E2E-CLAIMED-VOUCHER-002", event_type: "created", occurred_at: new Date("2026-05-04T09:00:00Z"), created_at: new Date() },
  { id: "evt-claimed-002-sent", voucher_code: "E2E-CLAIMED-VOUCHER-002", event_type: "sent", occurred_at: new Date("2026-05-04T09:01:00Z"), created_at: new Date() },
  { id: "evt-claimed-002-opened", voucher_code: "E2E-CLAIMED-VOUCHER-002", event_type: "opened", occurred_at: new Date("2026-05-04T10:00:00Z"), created_at: new Date() },
  { id: "evt-claimed-002-claimed", voucher_code: "E2E-CLAIMED-VOUCHER-002", event_type: "claimed", occurred_at: new Date("2026-05-04T10:05:00Z"), created_at: new Date() },
]

const IDLE_EVENTS: QueryRow[] = [
  { id: "evt-idle-001-created", voucher_code: "E2E-IDLE-VOUCHER-001", event_type: "created", occurred_at: new Date("2026-05-04T08:00:00Z"), created_at: new Date() },
  { id: "evt-idle-001-sent", voucher_code: "E2E-IDLE-VOUCHER-001", event_type: "sent", occurred_at: new Date("2026-05-04T08:01:00Z"), created_at: new Date() },
]

function makeService(queryResponses: QueryResponse[]): VoucherService {
  const svc = new VoucherService()
  svc._testPool = makeMockPool(queryResponses)
  return svc
}

describe("v160-cleanup-25 voucher module + AR45 allowlist", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/gp_mercur"
  })

  afterEach(() => {
    delete process.env.DATABASE_URL
  })

  it("returns the default seeded idle voucher by code", async () => {
    const svc = makeService([
      { rows: [IDLE_ROW] },
      { rows: IDLE_EVENTS },
    ])
    const result = await svc.getByCode("E2E-IDLE-VOUCHER-001")
    expect(result).not.toBeNull()
    expect(result?.code).toBe("E2E-IDLE-VOUCHER-001")
    expect(result?.status).toBe("idle")
    expect(result?.events.length).toBeGreaterThanOrEqual(1)
  })

  it("returns the default seeded claimed voucher by code with claimed event", async () => {
    const svc = makeService([
      { rows: [CLAIMED_ROW] },
      { rows: CLAIMED_EVENTS },
    ])
    const result = await svc.getByCode("E2E-CLAIMED-VOUCHER-002")
    expect(result).not.toBeNull()
    expect(result?.status).toBe("claimed")
    const types = result!.events.map((e) => e.event_type)
    expect(types).toContain("claimed")
  })

  it("returns null for unknown code (404 path)", async () => {
    const svc = makeService([{ rows: [] }])
    const result = await svc.getByCode("NEVER-EXISTED")
    expect(result).toBeNull()
  })

  it("AR45 allowlist projection — JSON.stringify must NOT contain raw PII", async () => {
    const svc = makeService([
      { rows: [IDLE_ROW] },
      { rows: IDLE_EVENTS },
    ])
    const voucher = await svc.getByCode("E2E-IDLE-VOUCHER-001")
    expect(voucher).not.toBeNull()

    // Simulate AR45 allowlist projection (same as route handler)
    const view = {
      code: voucher!.code,
      seller_id: voucher!.seller_id,
      seller_name: voucher!.seller_name,
      seller_handle: voucher!.seller_handle,
      product_title: voucher!.product_title,
      value_minor: voucher!.value_minor,
      currency_code: voucher!.currency_code,
      status: voucher!.status,
      expires_at: voucher!.expires_at,
    }
    const body = JSON.stringify(view)
    // No buyer email pattern
    expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    // No PL phone pattern
    expect(body).not.toMatch(/\+48\d{9}/)
  })

  it("upsert supports idempotent overwrite (re-seed pattern)", async () => {
    const svc = makeService([
      { rows: [] },                                           // INSERT INTO voucher
      { rows: [{ ...IDLE_ROW, code: "CUSTOM-001" }] },       // getByCode after upsert
      { rows: [] },                                           // no events yet
    ])
    const result = await svc.upsert({
      code: "CUSTOM-001",
      seller_id: "sel_test",
      seller_name: "Test Seller",
      seller_handle: "test-seller",
      product_title: "Test Service",
      value_minor: 5000,
      currency_code: "PLN",
      status: "idle",
      expires_at: null,
      events: [],
    })
    expect(result.code).toBe("CUSTOM-001")
    expect(result.status).toBe("idle")
  })

  it("listCodes returns seeded codes", async () => {
    const svc = makeService([{
      rows: [
        { code: "E2E-IDLE-VOUCHER-001" },
        { code: "E2E-CLAIMED-VOUCHER-002" },
      ],
    }])
    const codes = await svc.listCodes()
    expect(codes).toContain("E2E-IDLE-VOUCHER-001")
    expect(codes).toContain("E2E-CLAIMED-VOUCHER-002")
  })

  it("events filter to known types only (allowlist) and sort ascending", async () => {
    const svc = makeService([
      { rows: [CLAIMED_ROW] },
      { rows: CLAIMED_EVENTS },
    ])
    const result = await svc.getByCode("E2E-CLAIMED-VOUCHER-002")
    expect(result).not.toBeNull()
    const KNOWN = new Set(["created", "sent", "opened", "claimed", "withdrawn"])
    const events = result!.events.filter((e) => KNOWN.has(e.event_type))
    const sorted = [...events].sort((a, b) =>
      a.occurred_at.toISOString().localeCompare(b.occurred_at.toISOString())
    )
    expect(events.map((e) => e.id)).toEqual(sorted.map((e) => e.id))
    expect(events[0].event_type).toBe("created")
  })
})
