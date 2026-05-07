/**
 * Story v160-cleanup-36 — vendor decision idempotency unit tests.
 * Updated post review (H1, H2, H3, L2, M4).
 *
 * Tests for:
 *   - extractIdempotencyKey (header parsing + UUIDv4 validation + length cap + case-insensitive lookup)
 *   - hashRequestBody (stable canonical hash; undefined keys skipped per JSON.stringify)
 *   - findIdempotencyRecord (DB lookup by key only)
 *   - reserveIdempotencySlot / finalizeIdempotencyRecord / releaseReservation
 *   - persistIdempotencyRecord (legacy upsert with cross-vendor guard)
 */

import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  extractIdempotencyKey,
  hashRequestBody,
  findIdempotencyRecord,
  persistIdempotencyRecord,
  reserveIdempotencySlot,
  finalizeIdempotencyRecord,
  releaseReservation,
  PENDING_HASH,
  PENDING_STATUS,
  type IdempotencyRecord,
} from "../../../src/lib/vendor-decision-idempotency"

// ── extractIdempotencyKey ──────────────────────────────────────────────────────

describe("extractIdempotencyKey", () => {
  it("returns ok=true for a valid UUIDv4", () => {
    const result = extractIdempotencyKey({
      "idempotency-key": "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.key).toBe("a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5")
    }
  })

  it("returns ok=true for UUIDv4 with uppercase letters", () => {
    const result = extractIdempotencyKey({
      "idempotency-key": "A1B2C3D4-E5F6-4A7B-B8C9-D0E1F2A3B4C5",
    })
    expect(result.ok).toBe(true)
  })

  it("performs case-insensitive header lookup (review fix M4)", () => {
    const result = extractIdempotencyKey({
      "Idempotency-Key": "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
    } as Record<string, string>)
    expect(result.ok).toBe(true)
  })

  it("returns 400 MISSING_IDEMPOTENCY_KEY when header is absent", () => {
    const result = extractIdempotencyKey({})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(400)
      expect(result.body.error_code).toBe("MISSING_IDEMPOTENCY_KEY")
    }
  })

  it("returns 400 MISSING_IDEMPOTENCY_KEY when header is empty string", () => {
    const result = extractIdempotencyKey({ "idempotency-key": "" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(400)
      expect(result.body.error_code).toBe("MISSING_IDEMPOTENCY_KEY")
    }
  })

  it("returns 400 INVALID_IDEMPOTENCY_KEY_FORMAT for non-UUID value", () => {
    const result = extractIdempotencyKey({ "idempotency-key": "not-a-uuid" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(400)
      expect(result.body.error_code).toBe("INVALID_IDEMPOTENCY_KEY_FORMAT")
    }
  })

  it("returns 400 INVALID_IDEMPOTENCY_KEY_FORMAT for UUIDv1 (wrong version bit)", () => {
    const result = extractIdempotencyKey({
      "idempotency-key": "a1b2c3d4-e5f6-1a7b-b8c9-d0e1f2a3b4c5",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.body.error_code).toBe("INVALID_IDEMPOTENCY_KEY_FORMAT")
    }
  })

  it("rejects over-length keys (review fix L2)", () => {
    const longKey = "x".repeat(256)
    const result = extractIdempotencyKey({ "idempotency-key": longKey })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.body.error_code).toBe("INVALID_IDEMPOTENCY_KEY_FORMAT")
    }
  })

  it("handles array header value — takes first element", () => {
    const result = extractIdempotencyKey({
      "idempotency-key": [
        "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
        "other-value",
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.key).toBe("a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5")
    }
  })
})

// ── hashRequestBody ────────────────────────────────────────────────────────────

describe("hashRequestBody", () => {
  it("produces consistent hash for same payload regardless of key order", () => {
    const h1 = hashRequestBody({ decision: "opted_in", reason: "test", admin_note: null })
    const h2 = hashRequestBody({ reason: "test", decision: "opted_in", admin_note: null })
    expect(h1).toBe(h2)
  })

  it("produces different hashes for different payloads", () => {
    const h1 = hashRequestBody({ decision: "opted_in", reason: "test" })
    const h2 = hashRequestBody({ decision: "opted_out", reason: "test" })
    expect(h1).not.toBe(h2)
  })

  it("returns a 64-char hex string (SHA-256)", () => {
    const h = hashRequestBody({ decision: "opted_in" })
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it("review fix H3: undefined-valued keys are equivalent to omitted keys", () => {
    const h1 = hashRequestBody({ decision: "opted_in", reason: "test" })
    const h2 = hashRequestBody({
      decision: "opted_in",
      reason: "test",
      admin_note: undefined,
      override: undefined,
    })
    expect(h1).toBe(h2)
  })
})

// ── DB helper test scaffolding ─────────────────────────────────────────────────

type AnyFn = (...args: unknown[]) => unknown

function makeScope(knexFn: AnyFn) {
  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return knexFn
      throw new Error(`unexpected scope key: ${key}`)
    },
  }
}

const SAMPLE_RECORD: IdempotencyRecord = {
  id: "rec-uuid-1",
  idempotency_key: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
  vendor_id: "vendor-1",
  request_hash: "abc123",
  status_code: 200,
  response_body: { vendor_id: "vendor-1", decision: "opted_in", audit_log_id: "log-1", email_dispatched: true },
  created_at: "2026-05-07T10:00:00Z",
}

describe("findIdempotencyRecord", () => {
  it("returns found=true with record when row exists (lookup by key only — review fix H2)", async () => {
    const firstMock = jest.fn().mockResolvedValue(SAMPLE_RECORD)
    const whereMock = jest.fn(() => ({ first: firstMock }))
    const tableFn = jest.fn(() => ({ where: whereMock }))

    const scope = makeScope(tableFn)
    const result = await findIdempotencyRecord(
      scope,
      "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
    )

    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.record).toEqual(SAMPLE_RECORD)
    }
    expect(whereMock).toHaveBeenCalledWith({
      idempotency_key: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
    })
  })

  it("returns found=false when no row", async () => {
    const firstMock = jest.fn().mockResolvedValue(undefined)
    const whereMock = jest.fn(() => ({ first: firstMock }))
    const tableFn = jest.fn(() => ({ where: whereMock }))

    const scope = makeScope(tableFn)
    const result = await findIdempotencyRecord(
      scope,
      "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
    )

    expect(result.found).toBe(false)
  })
})

describe("reserveIdempotencySlot (review fix H1)", () => {
  beforeEach(() => { jest.clearAllMocks() })

  it("returns reserved=true with PENDING row on race-win", async () => {
    const reservedRow = {
      ...SAMPLE_RECORD,
      request_hash: PENDING_HASH,
      status_code: PENDING_STATUS,
    }
    const returningMock = jest.fn().mockResolvedValue([reservedRow])
    const ignoreMock = jest.fn(() => ({ returning: returningMock }))
    const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
    const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))
    const tableFn = jest.fn(() => ({ insert: insertMock }))

    const scope = makeScope(tableFn)
    const result = await reserveIdempotencySlot(scope, {
      idempotencyKey: SAMPLE_RECORD.idempotency_key,
      vendorId: "vendor-1",
      requestHash: "abc123",
    })

    expect(result.reserved).toBe(true)
    if (result.reserved) {
      expect(result.record.status_code).toBe(PENDING_STATUS)
    }
  })

  it("returns reserved=false with existing row on race-loss", async () => {
    const returningMock = jest.fn().mockResolvedValue([])
    const ignoreMock = jest.fn(() => ({ returning: returningMock }))
    const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
    const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))

    const firstMock = jest.fn().mockResolvedValue(SAMPLE_RECORD)
    const whereMock = jest.fn(() => ({ first: firstMock }))

    const tableFn = jest.fn(() => ({ insert: insertMock, where: whereMock }))

    const scope = makeScope(tableFn)
    const result = await reserveIdempotencySlot(scope, {
      idempotencyKey: SAMPLE_RECORD.idempotency_key,
      vendorId: "vendor-1",
      requestHash: "different-hash",
    })

    expect(result.reserved).toBe(false)
    if (!result.reserved) {
      expect(result.existing).toEqual(SAMPLE_RECORD)
    }
  })
})

describe("finalizeIdempotencyRecord (review fix H1)", () => {
  it("UPDATEs row by key and returns the new row", async () => {
    const updated = { ...SAMPLE_RECORD, request_hash: "newhash", status_code: 200 }
    const returningMock = jest.fn().mockResolvedValue([updated])
    const updateMock = jest.fn(() => ({ returning: returningMock }))
    const whereMock = jest.fn(() => ({ update: updateMock }))
    const tableFn = jest.fn(() => ({ where: whereMock }))

    const scope = makeScope(tableFn)
    const result = await finalizeIdempotencyRecord(scope, {
      idempotencyKey: SAMPLE_RECORD.idempotency_key,
      requestHash: "newhash",
      statusCode: 200,
      responseBody: SAMPLE_RECORD.response_body,
    })

    expect(result).toEqual(updated)
    expect(whereMock).toHaveBeenCalledWith({
      idempotency_key: SAMPLE_RECORD.idempotency_key,
    })
  })
})

describe("releaseReservation (review fix M1)", () => {
  it("DELETEs only PENDING rows for the given key", async () => {
    const deleteMock = jest.fn().mockResolvedValue(1)
    const whereMock = jest.fn(() => ({ delete: deleteMock }))
    const tableFn = jest.fn(() => ({ where: whereMock }))

    const scope = makeScope(tableFn)
    await releaseReservation(scope, "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5")

    expect(whereMock).toHaveBeenCalledWith({
      idempotency_key: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
      status_code: PENDING_STATUS,
    })
    expect(deleteMock).toHaveBeenCalled()
  })
})

describe("persistIdempotencyRecord (legacy upsert)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("inserts and returns the new record on first call", async () => {
    const returningMock = jest.fn().mockResolvedValue([SAMPLE_RECORD])
    const ignoreMock = jest.fn(() => ({ returning: returningMock }))
    const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
    const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))
    const tableFn = jest.fn(() => ({ insert: insertMock }))

    const scope = makeScope(tableFn)
    const result = await persistIdempotencyRecord(scope, {
      idempotencyKey: SAMPLE_RECORD.idempotency_key,
      vendorId: "vendor-1",
      requestHash: "abc123",
      statusCode: 200,
      responseBody: SAMPLE_RECORD.response_body,
    })

    expect(result).toEqual(SAMPLE_RECORD)
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: SAMPLE_RECORD.idempotency_key,
        vendor_id: "vendor-1",
        status_code: 200,
      }),
    )
    expect(onConflictMock).toHaveBeenCalledWith("idempotency_key")
  })

  it("re-reads existing record when ON CONFLICT DO NOTHING returns empty (race) — same vendor", async () => {
    const returningMock = jest.fn().mockResolvedValue([])
    const ignoreMock = jest.fn(() => ({ returning: returningMock }))
    const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
    const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))

    const firstMock = jest.fn().mockResolvedValue(SAMPLE_RECORD)
    const whereMock = jest.fn(() => ({ first: firstMock }))

    const tableFn = jest.fn(() => ({ insert: insertMock, where: whereMock })) as AnyFn

    const scope = makeScope(tableFn)
    const result = await persistIdempotencyRecord(scope, {
      idempotencyKey: SAMPLE_RECORD.idempotency_key,
      vendorId: "vendor-1",
      requestHash: "abc123",
      statusCode: 200,
      responseBody: SAMPLE_RECORD.response_body,
    })

    expect(result).toEqual(SAMPLE_RECORD)
  })

  it("review fix H2: throws when existing row belongs to a different vendor", async () => {
    const returningMock = jest.fn().mockResolvedValue([])
    const ignoreMock = jest.fn(() => ({ returning: returningMock }))
    const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
    const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))

    const otherVendorRecord = { ...SAMPLE_RECORD, vendor_id: "vendor-OTHER" }
    const firstMock = jest.fn().mockResolvedValue(otherVendorRecord)
    const whereMock = jest.fn(() => ({ first: firstMock }))
    const tableFn = jest.fn(() => ({ insert: insertMock, where: whereMock })) as AnyFn

    const scope = makeScope(tableFn)
    await expect(
      persistIdempotencyRecord(scope, {
        idempotencyKey: SAMPLE_RECORD.idempotency_key,
        vendorId: "vendor-1",
        requestHash: "abc123",
        statusCode: 200,
        responseBody: SAMPLE_RECORD.response_body,
      }),
    ).rejects.toThrow(/already bound to vendor_id=vendor-OTHER/)
  })
})
