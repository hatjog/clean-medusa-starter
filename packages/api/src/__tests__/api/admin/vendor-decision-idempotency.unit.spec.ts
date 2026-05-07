/**
 * Story v160-cleanup-36 — vendor decision idempotency route unit tests.
 *
 * Covers the 5 scenarios from AC6:
 *   (a) First POST happy path — Idempotency-Key K1, decision=opted_in, vendor pending → 200
 *   (b) Duplicate POST same key + same body — 200 cached (workflow NOT re-invoked)
 *   (c) Different key + illegal state transition — opted_out vendor, K2 + opt_in → 409
 *   (d) Same key + different body (AC3.1) — K1 reuse with different decision → 422
 *   (e) Missing key fallback — strict policy → 400 MISSING_IDEMPOTENCY_KEY
 *
 * Also covers: override=true reversal allowed (opted_out → opted_in with override).
 */

import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { POST } from "../../../api/admin/vendors/[id]/decision/route"

// ── Shared test key ────────────────────────────────────────────────────────────
const KEY_K1 = "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5"
const KEY_K2 = "b2c3d4e5-f6a7-4b8c-a9d0-e1f2a3b4c5d6"
const VENDOR_ID = "vendor-test-1"

// ── Mock factory helpers ───────────────────────────────────────────────────────

function makePendingSeller() {
  return {
    id: VENDOR_ID,
    handle: "test-vendor",
    email: "vendor@test.com",
    name: "Test Vendor",
    metadata: {
      gp: {
        lifecycle_status: "open",
      },
    },
  }
}

function makeOptedOutSeller() {
  return {
    id: VENDOR_ID,
    handle: "test-vendor",
    email: "vendor@test.com",
    name: "Test Vendor",
    metadata: {
      gp: {
        lifecycle_status: "open",
        decision_status: "opted_out",
        lifecycle_decision: {
          decision: "opted_out",
          reason: "vendor declined migration",
          captured_at: "2026-05-01T10:00:00Z",
          captured_by: "admin-1",
        },
      },
    },
  }
}

type MockKnexState = {
  existingRow: Record<string, unknown> | null
  insertedRow: Record<string, unknown> | null
}

function makeKnexMock(state: MockKnexState) {
  // Simulate the idempotency table queries
  const firstMock = jest.fn().mockImplementation(() => {
    return Promise.resolve(state.existingRow)
  })
  const whereFindMock = jest.fn(() => ({ first: firstMock }))

  // Simulate insert with ON CONFLICT DO NOTHING
  const returningMock = jest.fn().mockImplementation(() => {
    if (state.insertedRow) {
      return Promise.resolve([state.insertedRow])
    }
    return Promise.resolve([])
  })
  const ignoreMock = jest.fn(() => ({ returning: returningMock }))
  const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
  const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))

  const tableFn = jest.fn(() => ({
    where: whereFindMock,
    insert: insertMock,
  }))

  return {
    knex: tableFn,
    firstMock,
    whereFindMock,
    insertMock,
    onConflictMock,
    ignoreMock,
    returningMock,
  }
}

function makeSellerServiceMock(seller: Record<string, unknown> | null) {
  return {
    list: jest.fn().mockResolvedValue(seller ? [seller] : []),
    update: jest.fn().mockResolvedValue(undefined),
  }
}

function makeDispatchMock() {
  return jest.fn().mockResolvedValue({ notificationId: "audit-log-id-1" })
}

function makeNotificationLogMock() {
  return jest.fn().mockResolvedValue({
    entry: { id: "audit-log-id-1" },
    persisted: true,
  })
}

type AnyFn = (...args: unknown[]) => unknown

function makeScope(opts: {
  knex: AnyFn
  sellerService: Record<string, unknown>
}) {
  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return opts.knex
      if (
        key === "sellerModuleService" ||
        key === "sellerService" ||
        key === "ISellerModuleService"
      ) {
        return opts.sellerService
      }
      throw new Error(`unexpected scope key: ${key}`)
    },
  }
}

function makeReq(opts: {
  vendorId: string
  idempotencyKey?: string
  body: Record<string, unknown>
  scope: Record<string, unknown>
}) {
  return {
    params: { id: opts.vendorId },
    headers: opts.idempotencyKey
      ? { "idempotency-key": opts.idempotencyKey, authorization: "Bearer admin-token" }
      : { authorization: "Bearer admin-token" },
    body: opts.body,
    scope: opts.scope,
  } as unknown as Parameters<typeof POST>[0]
}

function makeRes() {
  const res = {
    _statusCode: 200,
    _body: null as unknown,
    status(code: number) {
      res._statusCode = code
      return res
    },
    json(body: unknown) {
      res._body = body
      return res
    },
  }
  return res as unknown as Parameters<typeof POST>[1] & {
    _statusCode: number
    _body: unknown
  }
}

// ── Mock the imports used by the route ──────────────────────────────────────────
jest.mock("../../../lib/capability-check", () => ({
  extractActorIdOrThrow: jest.fn().mockReturnValue("admin-actor-1"),
}))

jest.mock("../../../lib/vendor-notification-dispatch", () => ({
  dispatchVendorEmail: jest.fn(),
  NotificationModuleUnavailableError: class NotificationModuleUnavailableError extends Error {
    code = "NOTIFICATION_MODULE_UNAVAILABLE"
  },
}))

jest.mock("../../../lib/vendor-notification-provider-readiness", () => ({
  NotificationProviderNotReadyError: class NotificationProviderNotReadyError extends Error {
    code = "NOTIFICATION_PROVIDER_NOT_READY"
  },
}))

jest.mock("../../../lib/vendor-notification-log", () => ({
  appendNotificationLogBestEffort: jest.fn(),
}))

import { dispatchVendorEmail } from "../../../lib/vendor-notification-dispatch"
import { appendNotificationLogBestEffort } from "../../../lib/vendor-notification-log"

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("POST /admin/vendors/[id]/decision — idempotency (cleanup-36 AC6)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(dispatchVendorEmail as jest.Mock).mockResolvedValue({ notificationId: "audit-log-id-1" })
    ;(appendNotificationLogBestEffort as jest.Mock).mockResolvedValue({
      entry: { id: "audit-log-id-1" },
      persisted: true,
    })
  })

  // ── (e) Missing key → 400 MISSING_IDEMPOTENCY_KEY ─────────────────────────────
  it("(e) returns 400 MISSING_IDEMPOTENCY_KEY when Idempotency-Key header is absent", async () => {
    const seller = makePendingSeller()
    const sellerService = makeSellerServiceMock(seller)
    const knexState: MockKnexState = { existingRow: null, insertedRow: null }
    const { knex } = makeKnexMock(knexState)
    const scope = makeScope({ knex, sellerService })

    const req = makeReq({
      vendorId: VENDOR_ID,
      // no idempotencyKey
      body: { decision: "opted_in", reason: "vendor wants to migrate" },
      scope,
    })
    const res = makeRes()

    await POST(req, res)

    expect(res._statusCode).toBe(400)
    expect((res._body as Record<string, unknown>).error_code).toBe("MISSING_IDEMPOTENCY_KEY")
    // Workflow must NOT have been called
    expect(dispatchVendorEmail).not.toHaveBeenCalled()
  })

  // ── (a) First POST happy path ─────────────────────────────────────────────────
  it("(a) first POST happy path → 200 + state mutated + idempotency row persisted", async () => {
    const seller = makePendingSeller()
    const sellerService = makeSellerServiceMock(seller)

    const persistedIdempRow = {
      id: "idem-rec-1",
      idempotency_key: KEY_K1,
      vendor_id: VENDOR_ID,
      request_hash: "will-be-computed",
      status_code: 200,
      response_body: { vendor_id: VENDOR_ID, decision: "opted_in", audit_log_id: "audit-log-id-1", email_dispatched: true },
      created_at: "2026-05-07T10:00:00Z",
    }

    const knexState: MockKnexState = {
      existingRow: null, // no existing row → first call
      insertedRow: persistedIdempRow,
    }
    const { knex, insertMock } = makeKnexMock(knexState)
    const scope = makeScope({ knex, sellerService })

    const req = makeReq({
      vendorId: VENDOR_ID,
      idempotencyKey: KEY_K1,
      body: { decision: "opted_in", reason: "vendor confirmed migration" },
      scope,
    })
    const res = makeRes()

    await POST(req, res)

    expect(res._statusCode).toBe(200)
    const body = res._body as Record<string, unknown>
    expect(body.vendor_id).toBe(VENDOR_ID)
    expect(body.decision).toBe("opted_in")
    expect(body.email_dispatched).toBe(true)

    // Workflow invoked once
    expect(dispatchVendorEmail).toHaveBeenCalledTimes(1)

    // Seller state updated
    expect(sellerService.update).toHaveBeenCalled()

    // Idempotency row persisted
    expect(insertMock).toHaveBeenCalled()
  })

  // ── (b) Duplicate POST same key + same body → cached response ────────────────
  it("(b) repeat POST same key same body → 200 cached, workflow NOT re-invoked", async () => {
    const seller = makePendingSeller()
    const sellerService = makeSellerServiceMock(seller)

    // Pre-compute request hash for {decision:"opted_in",reason:"vendor confirmed migration"}
    // We use the same body as (a) to get a cached hit.
    const { hashRequestBody } = await import("../../../lib/vendor-decision-idempotency")
    const cachedHash = hashRequestBody({
      decision: "opted_in",
      reason: "vendor confirmed migration",
      admin_note: undefined,
      override: undefined,
    })

    const cachedResponse = {
      vendor_id: VENDOR_ID,
      decision: "opted_in",
      audit_log_id: "audit-log-id-1",
      email_dispatched: true,
    }

    const existingRow = {
      id: "idem-rec-1",
      idempotency_key: KEY_K1,
      vendor_id: VENDOR_ID,
      request_hash: cachedHash,
      status_code: 200,
      response_body: cachedResponse,
      created_at: "2026-05-07T10:00:00Z",
    }

    const knexState: MockKnexState = {
      existingRow,
      insertedRow: null,
    }
    const { knex } = makeKnexMock(knexState)
    const scope = makeScope({ knex, sellerService })

    const req = makeReq({
      vendorId: VENDOR_ID,
      idempotencyKey: KEY_K1,
      body: { decision: "opted_in", reason: "vendor confirmed migration" },
      scope,
    })
    const res = makeRes()

    await POST(req, res)

    // Cached response returned
    expect(res._statusCode).toBe(200)
    expect(res._body).toEqual(cachedResponse)

    // Workflow NOT re-invoked (no side effects)
    expect(dispatchVendorEmail).not.toHaveBeenCalled()
    expect(sellerService.update).not.toHaveBeenCalled()
    expect(appendNotificationLogBestEffort).not.toHaveBeenCalled()
  })

  // ── (c) Different key + illegal state transition → 409 ───────────────────────
  it("(c) different key + opted_in attempt on opted_out vendor → 409 INVALID_STATE_TRANSITION", async () => {
    const seller = makeOptedOutSeller()
    const sellerService = makeSellerServiceMock(seller)

    const persistedConflictRow = {
      id: "idem-rec-2",
      idempotency_key: KEY_K2,
      vendor_id: VENDOR_ID,
      request_hash: "some-hash",
      status_code: 409,
      response_body: {
        error_code: "INVALID_STATE_TRANSITION",
        current_state: "opted_out",
        attempted: "opted_in",
        hint: "include override=true to force reversal",
      },
      created_at: "2026-05-07T11:00:00Z",
    }

    const knexState: MockKnexState = {
      existingRow: null, // new key K2 — no existing row
      insertedRow: persistedConflictRow,
    }
    const { knex, insertMock } = makeKnexMock(knexState)
    const scope = makeScope({ knex, sellerService })

    const req = makeReq({
      vendorId: VENDOR_ID,
      idempotencyKey: KEY_K2,
      body: { decision: "opted_in", reason: "admin correction attempt" },
      scope,
    })
    const res = makeRes()

    await POST(req, res)

    expect(res._statusCode).toBe(409)
    const body = res._body as Record<string, unknown>
    expect(body.error_code).toBe("INVALID_STATE_TRANSITION")
    expect(body.current_state).toBe("opted_out")
    expect(body.attempted).toBe("opted_in")

    // No side effects
    expect(dispatchVendorEmail).not.toHaveBeenCalled()
    expect(sellerService.update).not.toHaveBeenCalled()

    // 409 response persisted for deterministic replay
    expect(insertMock).toHaveBeenCalled()
  })

  // ── (d) Same key + different body → 422 IDEMPOTENCY_KEY_REUSED ───────────────
  it("(d) same key K1 with different decision → 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", async () => {
    const seller = makePendingSeller()
    const sellerService = makeSellerServiceMock(seller)

    // Existing row was created with decision=opted_in; now trying opted_out
    const { hashRequestBody } = await import("../../../lib/vendor-decision-idempotency")
    const originalHash = hashRequestBody({
      decision: "opted_in",
      reason: "vendor confirmed migration",
      admin_note: undefined,
      override: undefined,
    })

    const existingRow = {
      id: "idem-rec-1",
      idempotency_key: KEY_K1,
      vendor_id: VENDOR_ID,
      request_hash: originalHash, // hash of opted_in body
      status_code: 200,
      response_body: { vendor_id: VENDOR_ID, decision: "opted_in", audit_log_id: "audit-log-id-1", email_dispatched: true },
      created_at: "2026-05-07T10:00:00Z",
    }

    const knexState: MockKnexState = {
      existingRow,
      insertedRow: null,
    }
    const { knex } = makeKnexMock(knexState)
    const scope = makeScope({ knex, sellerService })

    const req = makeReq({
      vendorId: VENDOR_ID,
      idempotencyKey: KEY_K1,
      body: { decision: "opted_out", reason: "vendor changed their mind" }, // different body
      scope,
    })
    const res = makeRes()

    await POST(req, res)

    expect(res._statusCode).toBe(422)
    const body = res._body as Record<string, unknown>
    expect(body.error_code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD")

    // No side effects
    expect(dispatchVendorEmail).not.toHaveBeenCalled()
    expect(sellerService.update).not.toHaveBeenCalled()
  })

  // ── override=true reversal ─────────────────────────────────────────────────────
  it("allows opted_out → opted_in reversal with override=true in body", async () => {
    const seller = makeOptedOutSeller()
    const sellerService = makeSellerServiceMock(seller)

    const persistedIdempRow = {
      id: "idem-rec-3",
      idempotency_key: KEY_K2,
      vendor_id: VENDOR_ID,
      request_hash: "some-hash",
      status_code: 200,
      response_body: { vendor_id: VENDOR_ID, decision: "opted_in", audit_log_id: "audit-log-id-2", email_dispatched: true },
      created_at: "2026-05-07T12:00:00Z",
    }

    const knexState: MockKnexState = {
      existingRow: null,
      insertedRow: persistedIdempRow,
    }
    const { knex } = makeKnexMock(knexState)
    const scope = makeScope({ knex, sellerService })

    const req = makeReq({
      vendorId: VENDOR_ID,
      idempotencyKey: KEY_K2,
      body: {
        decision: "opted_in",
        reason: "admin override — vendor email correction",
        override: true,
      },
      scope,
    })
    const res = makeRes()

    await POST(req, res)

    expect(res._statusCode).toBe(200)
    const body = res._body as Record<string, unknown>
    expect(body.decision).toBe("opted_in")

    // Workflow invoked for the reversal
    expect(dispatchVendorEmail).toHaveBeenCalledTimes(1)
    expect(sellerService.update).toHaveBeenCalled()
  })
})
