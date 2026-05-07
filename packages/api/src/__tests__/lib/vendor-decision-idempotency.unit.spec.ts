/**
 * Story v160-cleanup-36 — vendor decision idempotency unit tests.
 *
 * Tests for:
 *   - extractIdempotencyKey (header parsing + UUIDv4 validation)
 *   - hashRequestBody (stable canonical hash)
 *   - findIdempotencyRecord (DB lookup)
 *   - persistIdempotencyRecord (DB insert + ON CONFLICT handling)
 */

import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  extractIdempotencyKey,
  hashRequestBody,
  findIdempotencyRecord,
  persistIdempotencyRecord,
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
    // UUIDv1 has '1' as the version nibble, not '4'
    const result = extractIdempotencyKey({
      "idempotency-key": "a1b2c3d4-e5f6-1a7b-b8c9-d0e1f2a3b4c5",
    })
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
})

// ── findIdempotencyRecord / persistIdempotencyRecord ────────────────────────────

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
  it("returns found=true with record when row exists", async () => {
    const firstMock = jest.fn().mockResolvedValue(SAMPLE_RECORD)
    const whereMock = jest.fn(() => ({ first: firstMock }))
    const tableFn = jest.fn(() => ({ where: whereMock }))

    const scope = makeScope(tableFn)
    const result = await findIdempotencyRecord(
      scope,
      "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
      "vendor-1",
    )

    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.record).toEqual(SAMPLE_RECORD)
    }
    expect(whereMock).toHaveBeenCalledWith({
      idempotency_key: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
      vendor_id: "vendor-1",
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
      "vendor-1",
    )

    expect(result.found).toBe(false)
  })
})

describe("persistIdempotencyRecord", () => {
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
      idempotencyKey: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
      vendorId: "vendor-1",
      requestHash: "abc123",
      statusCode: 200,
      responseBody: { vendor_id: "vendor-1", decision: "opted_in", audit_log_id: "log-1", email_dispatched: true },
    })

    expect(result).toEqual(SAMPLE_RECORD)
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
        vendor_id: "vendor-1",
        status_code: 200,
      }),
    )
    expect(onConflictMock).toHaveBeenCalledWith("idempotency_key")
  })

  it("re-reads existing record when ON CONFLICT DO NOTHING returns empty (race)", async () => {
    const returningMock = jest.fn().mockResolvedValue([]) // race — no row returned
    const ignoreMock = jest.fn(() => ({ returning: returningMock }))
    const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
    const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))

    const firstMock = jest.fn().mockResolvedValue(SAMPLE_RECORD)
    const whereMock = jest.fn(() => ({ first: firstMock }))

    const tableFn = jest.fn((tableName: unknown) => {
      if (tableName === "vendor_decision_idempotency") {
        return { insert: insertMock, where: whereMock }
      }
      return {}
    }) as AnyFn

    const scope = makeScope(tableFn)
    const result = await persistIdempotencyRecord(scope, {
      idempotencyKey: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
      vendorId: "vendor-1",
      requestHash: "abc123",
      statusCode: 200,
      responseBody: { vendor_id: "vendor-1", decision: "opted_in", audit_log_id: "log-1", email_dispatched: true },
    })

    expect(result).toEqual(SAMPLE_RECORD)
    expect(whereMock).toHaveBeenCalledWith({
      idempotency_key: "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
    })
  })
})
