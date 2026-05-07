/**
 * Story v160-cleanup-40-nudge-dedup — route-level unit tests.
 *
 * Tests POST /admin/vendors/notifications/nudges dedup gate (AC1-AC7).
 *
 * All external deps are mocked:
 *   - vendor-notification-log helpers
 *   - vendor-notification-provider-readiness
 *   - fetchEligibleVendors via GP_NUDGE_DEV_FIXTURE_VENDORS_JSON env var
 *   - capability-check (extractActorIdOrThrow)
 */

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

jest.mock("../../../lib/vendor-notification-log", () => ({
  appendNotificationLogBestEffort: jest.fn(),
  appendNotificationLog: jest.fn(),
  listNotificationLog: jest.fn(),
  findRecentNotificationLog: jest.fn(),
  assertNotificationLogTableReady: jest.fn(),
  resolveNudgeCooldownHours: jest.fn().mockReturnValue(24),
  NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT: 24,
  NUDGE_DEDUP_WINDOW_MAX_DAYS: 7,
  NotificationLogTableUnavailableError: class NotificationLogTableUnavailableError extends Error {
    code = "NUDGE_DEDUP_UNAVAILABLE" as const
    constructor(cause?: string) {
      super(`vendor_notification_log table unavailable${cause ? `: ${cause}` : ""}`)
      this.name = "NotificationLogTableUnavailableError"
    }
  },
}))

jest.mock("../../../lib/vendor-notification-provider-readiness", () => ({
  assertNotificationProviderReady: jest.fn(),
  NotificationProviderNotReadyError: class NotificationProviderNotReadyError extends Error {
    code = "NOTIFICATION_PROVIDER_NOT_READY" as const
    constructor() { super("provider not ready"); this.name = "NotificationProviderNotReadyError" }
  },
}))

jest.mock("../../../lib/capability-check", () => ({
  extractActorIdOrThrow: jest.fn().mockReturnValue("admin_test_user"),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals"

import {
  findRecentNotificationLog,
  assertNotificationLogTableReady,
  appendNotificationLogBestEffort,
  resolveNudgeCooldownHours,
} from "../../../lib/vendor-notification-log"
import { assertNotificationProviderReady } from "../../../lib/vendor-notification-provider-readiness"
import { POST } from "../../../api/admin/vendors/notifications/nudges/route"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockFindRecentNotificationLog = findRecentNotificationLog as jest.MockedFunction<typeof findRecentNotificationLog>
const mockAssertNotificationLogTableReady = assertNotificationLogTableReady as jest.MockedFunction<typeof assertNotificationLogTableReady>
const mockAppendNotificationLogBestEffort = appendNotificationLogBestEffort as jest.MockedFunction<typeof appendNotificationLogBestEffort>
const mockAssertNotificationProviderReady = assertNotificationProviderReady as jest.MockedFunction<typeof assertNotificationProviderReady>
const mockResolveNudgeCooldownHours = resolveNudgeCooldownHours as jest.MockedFunction<typeof resolveNudgeCooldownHours>

type MockedResponse = {
  status: jest.Mock
  json: jest.Mock
  _status: number | null
  _body: unknown
}

function makeResponse(): MockedResponse {
  const res: MockedResponse = {
    _status: null,
    _body: null,
    status: jest.fn(),
    json: jest.fn(),
  }
  res.status.mockImplementation((code: number) => { res._status = code; return res })
  res.json.mockImplementation((body: unknown) => { res._body = body; return res })
  return res
}

function makeScope() {
  return {
    resolve: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn() }),
  }
}

function makeRequest(body: Record<string, unknown>, scope = makeScope()): Parameters<typeof POST>[0] {
  return { body, scope } as unknown as Parameters<typeof POST>[0]
}

function makeVendor(id: string, decision_status: "open" | "opted_in" | "opted_out" = "open") {
  return { id, handle: `vendor_${id}`, email: `${id}@example.com`, preferred_locale: "pl" as const, decision_status }
}

function makePriorRow(vendorId: string, step: string, minsAgo = 1) {
  return {
    id: `prior-log-${vendorId}-${step}`,
    vendor_id: vendorId,
    notification_type: `nudge_${step}` as const,
    sent_at: new Date(Date.now() - minsAgo * 60 * 1000).toISOString(),
    status: "sent" as const,
    locale: "pl" as const,
    recipient_email: `${vendorId}@example.com`,
    triggered_by: "admin",
  }
}

// ---------------------------------------------------------------------------
// Setup + teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GP_FLAG_FLIP_DATE = "2026-06-01"
  process.env.GP_NUDGE_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([makeVendor("v_1")])

  mockAssertNotificationProviderReady.mockReturnValue(undefined)
  mockAssertNotificationLogTableReady.mockResolvedValue(undefined)
  mockFindRecentNotificationLog.mockResolvedValue([])
  mockResolveNudgeCooldownHours.mockReturnValue(24)

  let counter = 0
  mockAppendNotificationLogBestEffort.mockImplementation(async (_, input) => {
    counter++
    const id = (input as { id?: string }).id ?? `audit_${counter}`
    return {
      entry: { ...input, id, sent_at: (input as { sent_at?: string }).sent_at ?? new Date().toISOString() } as ReturnType<typeof makePriorRow>,
      persisted: true,
    }
  })
})

afterEach(() => {
  delete process.env.GP_FLAG_FLIP_DATE
  delete process.env.GP_NUDGE_DEV_FIXTURE_VENDORS_JSON
})

// ---------------------------------------------------------------------------
// AC5.1 — 10× same (vendor, step) within cooldown → 1 dispatched + 9 deduplicated
// ---------------------------------------------------------------------------

describe("AC5.1 — 10× POST same (vendor, step) within cooldown", () => {
  it("first POST dispatches; subsequent 9 are deduplicated", async () => {
    // First POST: no prior row → dispatches
    mockFindRecentNotificationLog.mockResolvedValueOnce([])
    const res1 = makeResponse()
    await POST(makeRequest({ step: "t21" }), res1 as unknown as Parameters<typeof POST>[1])

    expect(res1._status).toBe(200)
    const body1 = res1._body as Record<string, unknown>
    expect(body1.triggered).toBe(1)
    expect(body1.deduplicated).toBe(0)

    // Subsequent 9 POSTs: prior row exists → deduplicated
    const priorRow = makePriorRow("v_1", "t21")
    for (let i = 2; i <= 10; i++) {
      mockFindRecentNotificationLog.mockResolvedValueOnce([priorRow])
      const res = makeResponse()
      await POST(makeRequest({ step: "t21" }), res as unknown as Parameters<typeof POST>[1])

      expect(res._status).toBe(200)
      const body = res._body as Record<string, unknown>
      expect(body.triggered).toBe(0)
      expect(body.deduplicated).toBe(1)
      const entries = body.deduplicated_entries as Array<Record<string, unknown>>
      expect(entries[0].vendor_id).toBe("v_1")
      expect(entries[0].existing_log_id).toBe(priorRow.id)
      expect(entries[0].reason).toBe("deduplicated")
    }
  })
})

// ---------------------------------------------------------------------------
// AC3 — Different step → independent dedup keys
// ---------------------------------------------------------------------------

describe("AC3 — per-step independent dedup keys", () => {
  it("t21 prior row does NOT block t14 dispatch", async () => {
    mockFindRecentNotificationLog.mockResolvedValueOnce([]) // t14 query: no prior t14 row
    const res = makeResponse()
    await POST(makeRequest({ step: "t14" }), res as unknown as Parameters<typeof POST>[1])

    expect(res._status).toBe(200)
    const body = res._body as Record<string, unknown>
    expect(body.triggered).toBe(1)
    expect(body.deduplicated).toBe(0)
    // Dedup query uses nudge_t14 type
    expect(mockFindRecentNotificationLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notification_type: "nudge_t14" }),
    )
  })
})

// ---------------------------------------------------------------------------
// AC4 — force=true bypasses cooldown
// ---------------------------------------------------------------------------

describe("AC4 — force=true operator override", () => {
  it("force=true bypasses dedup, appends audit row with forced=true", async () => {
    mockFindRecentNotificationLog.mockResolvedValueOnce([makePriorRow("v_1", "t21")])

    const res = makeResponse()
    await POST(makeRequest({ step: "t21", force: true }), res as unknown as Parameters<typeof POST>[1])

    expect(res._status).toBe(200)
    const body = res._body as Record<string, unknown>
    expect(body.triggered).toBe(1)
    expect(body.deduplicated).toBe(0)
    expect(body.forced).toBe(1)

    expect(mockAppendNotificationLogBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        forced: true,
        metadata: expect.objectContaining({ forced: true, forced_by: "admin_test_user" }),
      }),
    )
  })

  it("prior row is NOT mutated — only 1 new row appended (append-only invariant)", async () => {
    mockFindRecentNotificationLog.mockResolvedValueOnce([makePriorRow("v_1", "t21")])

    await POST(makeRequest({ step: "t21", force: true }), makeResponse() as unknown as Parameters<typeof POST>[1])

    expect(mockAppendNotificationLogBestEffort).toHaveBeenCalledTimes(1)
    const [, insertedInput] = mockAppendNotificationLogBestEffort.mock.calls[0]
    expect((insertedInput as { id?: string }).id).not.toBe("prior-log-v_1-t21")
  })
})

// ---------------------------------------------------------------------------
// AC7 — 503 when log table unavailable
// ---------------------------------------------------------------------------

describe("AC7 — fail-closed when dedup infra unavailable", () => {
  it("returns 503 NUDGE_DEDUP_UNAVAILABLE when assertNotificationLogTableReady throws", async () => {
    const { NotificationLogTableUnavailableError: NLTUError } =
      jest.requireMock("../../../lib/vendor-notification-log") as {
        NotificationLogTableUnavailableError: new (cause?: string) => Error & { code: string }
      }
    mockAssertNotificationLogTableReady.mockRejectedValueOnce(new NLTUError("relation does not exist"))

    const res = makeResponse()
    await POST(makeRequest({ step: "t21" }), res as unknown as Parameters<typeof POST>[1])

    expect(res._status).toBe(503)
    expect((res._body as Record<string, unknown>).code).toBe("NUDGE_DEDUP_UNAVAILABLE")
    // No dispatch, no audit row
    expect(mockAppendNotificationLogBestEffort).not.toHaveBeenCalled()
    expect(mockFindRecentNotificationLog).not.toHaveBeenCalled()
  })

  it("503 code is distinct from NOTIFICATION_PROVIDER_NOT_READY (AC7 triage)", async () => {
    const { NotificationLogTableUnavailableError: NLTUError } =
      jest.requireMock("../../../lib/vendor-notification-log") as {
        NotificationLogTableUnavailableError: new (cause?: string) => Error & { code: string }
      }
    mockAssertNotificationLogTableReady.mockRejectedValueOnce(new NLTUError())

    const res = makeResponse()
    await POST(makeRequest({ step: "t21" }), res as unknown as Parameters<typeof POST>[1])

    expect((res._body as Record<string, unknown>).code).toBe("NUDGE_DEDUP_UNAVAILABLE")
    expect((res._body as Record<string, unknown>).code).not.toBe("NOTIFICATION_PROVIDER_NOT_READY")
  })
})

// ---------------------------------------------------------------------------
// AC5.d — Dry-run backward compat (no dedup query, no audit row)
// ---------------------------------------------------------------------------

describe("AC5.d — dry_run backward compat", () => {
  it("dry_run=true does not call dedup helpers", async () => {
    const res = makeResponse()
    await POST(makeRequest({ step: "t21", dry_run: true }), res as unknown as Parameters<typeof POST>[1])

    expect(res._status).toBe(200)
    expect((res._body as Record<string, unknown>).dry_run).toBe(true)
    expect(mockAssertNotificationLogTableReady).not.toHaveBeenCalled()
    expect(mockFindRecentNotificationLog).not.toHaveBeenCalled()
    expect(mockAppendNotificationLogBestEffort).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC2 — idempotent 200 + deduplicated payload shape
// ---------------------------------------------------------------------------

describe("AC2 — idempotent 200 with deduplicated payload", () => {
  it("returns 200 with triggered=0 + deduplicated_entries when prior sent row exists", async () => {
    const priorRow = makePriorRow("v_1", "t21")
    mockFindRecentNotificationLog.mockResolvedValueOnce([priorRow])

    const res = makeResponse()
    await POST(makeRequest({ step: "t21" }), res as unknown as Parameters<typeof POST>[1])

    expect(res._status).toBe(200) // idempotent — not 4xx
    const body = res._body as Record<string, unknown>
    expect(body.triggered).toBe(0)
    expect(body.deduplicated).toBe(1)
    expect(body.failed).toBe(0)
    const entries = body.deduplicated_entries as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0].existing_log_id).toBe(priorRow.id)
    expect(entries[0].reason).toBe("deduplicated")

    // Audit row with status=deduplicated + metadata.dedup_of
    expect(mockAppendNotificationLogBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "deduplicated",
        metadata: { dedup_of: priorRow.id },
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// AC1 — cooldown query called before dispatch
// ---------------------------------------------------------------------------

describe("AC1 — dedup gate called before dispatch", () => {
  it("calls findRecentNotificationLog with correct (vendor_id, notification_type)", async () => {
    mockFindRecentNotificationLog.mockResolvedValueOnce([])
    const res = makeResponse()
    await POST(makeRequest({ step: "t7" }), res as unknown as Parameters<typeof POST>[1])

    expect(mockFindRecentNotificationLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ vendor_id: "v_1", notification_type: "nudge_t7" }),
    )
  })
})
