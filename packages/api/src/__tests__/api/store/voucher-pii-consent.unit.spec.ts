/**
 * Story 4.4 (TF-208) — /store/voucher-pii-consent route unit tests.
 *
 * Covers action-discriminated payload: grant / withdraw / pause and error paths.
 *
 * AC mapping:
 *   - action='grant'    → recordConsentTransaction (D-66 chained tx)
 *   - action='withdraw' → lookupConsentSnapshot + recordWithdrawalTransaction
 *   - action='pause'    → recordPauseAudit (SC-3 lightweight audit row)
 *   - backward compat   → legacy body (market_id, no action) → grant path
 *   - R-NEW-6           → no silent fallback, no synthetic audit IDs
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { POST } from "../../../api/store/voucher-pii-consent/route"
import * as marketContextModule from "../../../lib/market-context"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockService = {
  recordConsentTransaction: ReturnType<typeof vi.fn>
  lookupConsentSnapshot: ReturnType<typeof vi.fn>
  recordWithdrawalTransaction: ReturnType<typeof vi.fn>
  recordPauseAudit: ReturnType<typeof vi.fn>
}

function makeService(overrides?: Partial<MockService>): MockService {
  return {
    recordConsentTransaction: vi.fn().mockResolvedValue({
      consent_audit_id: "aud_grant_001",
      recipient_pii_id: "pii_001",
      delivery_decision_id: "del_001",
      latency_ms: 10,
    }),
    lookupConsentSnapshot: vi.fn().mockResolvedValue({
      consent_audit_id: "aud_original_001",
      market_id: "bonbeauty",
      order_id: "ord_abc",
      audit_confirmed: true,
    }),
    recordWithdrawalTransaction: vi.fn().mockResolvedValue({
      withdrawal_audit_id: "aud_withdraw_001",
      latency_ms: 5,
      in_flight_dispatch_aborted: false,
    }),
    recordPauseAudit: vi.fn().mockResolvedValue({
      pause_audit_id: "aud_pause_001",
      latency_ms: 3,
    }),
    ...overrides,
  }
}

function makeReq(body: Record<string, unknown>, service: MockService | null = makeService()) {
  return {
    body,
    scope: {
      resolve: vi.fn().mockReturnValue(service),
    },
  } as unknown as Parameters<typeof POST>[0]
}

function makeRes() {
  const calls: { status?: number; json?: unknown } = {}
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockImplementation((s: number) => {
      calls.status = s
      return res
    }),
    json: vi.fn().mockImplementation((j: unknown) => {
      calls.json = j
      return res
    }),
    _calls: calls,
  }
  return res as unknown as Parameters<typeof POST>[1] & { _calls: typeof calls }
}

// ---------------------------------------------------------------------------
// Market context mock — return null by default (override per test)
// ---------------------------------------------------------------------------

vi.spyOn(marketContextModule.marketContextStorage, "getStore").mockReturnValue(null)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /store/voucher-pii-consent — action='grant'", () => {
  it("happy path → 201 with consent_audit_id, recipient_pii_id, delivery_decision_id", async () => {
    const service = makeService()
    const req = makeReq({
      action: "grant",
      market_id: "bonbeauty",
      order_id: "ord_abc",
      entitlement_id: "ent_xyz",
      locale: "pl",
      is_gift: false,
    }, service)
    const res = makeRes()

    await POST(req, res)

    expect(res._calls.status).toBe(201)
    const json = res._calls.json as Record<string, unknown>
    expect(json.consent_audit_id).toBe("aud_grant_001")
    expect(json.recipient_pii_id).toBe("pii_001")
    expect(json.delivery_decision_id).toBe("del_001")
    expect(service.recordConsentTransaction).toHaveBeenCalledOnce()
  })

  it("missing market_id → 400 validation_failed", async () => {
    const req = makeReq({ action: "grant", order_id: "ord_abc", entitlement_id: "ent_xyz", locale: "pl", is_gift: false })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(json.error).toBe("validation_failed")
    expect(String(json.message)).toMatch(/market_id/)
  })

  it("is_gift not boolean → 400 validation_failed", async () => {
    const req = makeReq({ action: "grant", market_id: "bb", order_id: "o", entitlement_id: "e", locale: "pl", is_gift: "yes" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/is_gift/)
  })

  it("backward compat: no action + market_id → grant path", async () => {
    const service = makeService()
    const req = makeReq({
      market_id: "bonbeauty",
      order_id: "ord_abc",
      entitlement_id: "ent_xyz",
      locale: "pl",
      is_gift: true,
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    expect(service.recordConsentTransaction).toHaveBeenCalledOnce()
  })

  it("no action + no market_id → 400 (requires action discriminator)", async () => {
    const req = makeReq({ locale: "pl" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
  })
})

describe("POST /store/voucher-pii-consent — action='withdraw'", () => {
  it("happy path → 201 with withdrawal_audit_id", async () => {
    const service = makeService()
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_original_001",
      locale: "pl",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    const json = res._calls.json as Record<string, unknown>
    expect(json.withdrawal_audit_id).toBe("aud_withdraw_001")
    expect(service.lookupConsentSnapshot).toHaveBeenCalledWith("aud_original_001")
    expect(service.recordWithdrawalTransaction).toHaveBeenCalledOnce()
  })

  it("missing compensates_audit_id → 400", async () => {
    const req = makeReq({ action: "withdraw", locale: "pl" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/compensates_audit_id/)
  })

  it("consent snapshot not found / not confirmed → 404", async () => {
    const service = makeService({ lookupConsentSnapshot: vi.fn().mockResolvedValue(null) })
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_missing",
      locale: "pl",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
    const json = res._calls.json as Record<string, unknown>
    expect(json.error).toBe("consent_not_found")
  })

  it("snapshot exists but audit_confirmed=false → 404", async () => {
    const service = makeService({
      lookupConsentSnapshot: vi.fn().mockResolvedValue({ audit_confirmed: false, market_id: "bb", order_id: "o" }),
    })
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_unconfirmed",
      locale: "pl",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
  })
})

describe("POST /store/voucher-pii-consent — action='pause'", () => {
  it("happy path with market_id in body → 201 with pause_audit_id", async () => {
    const service = makeService()
    const req = makeReq({
      action: "pause",
      token: "tok_abc",
      locale: "pl",
      pause_state: "considering",
      market_id: "bonbeauty",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    const json = res._calls.json as Record<string, unknown>
    expect(json.pause_audit_id).toBe("aud_pause_001")
    expect(service.recordPauseAudit).toHaveBeenCalledOnce()
  })

  it("market_id from context storage (no body market_id)", async () => {
    vi.spyOn(marketContextModule.marketContextStorage, "getStore").mockReturnValue({ market_id: "ctx-market" })
    const service = makeService()
    const req = makeReq({
      action: "pause",
      token: "tok_abc",
      locale: "pl",
      pause_state: "paused",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    const callArgs = service.recordPauseAudit.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.market_id).toBe("ctx-market")
    vi.spyOn(marketContextModule.marketContextStorage, "getStore").mockReturnValue(null)
  })

  it("missing token → 400", async () => {
    const req = makeReq({ action: "pause", locale: "pl", pause_state: "considering", market_id: "bb" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/token/)
  })

  it("invalid pause_state → 400", async () => {
    const req = makeReq({ action: "pause", token: "tok", locale: "pl", pause_state: "invalid-state", market_id: "bb" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/pause_state/)
  })

  it("no market_id in body and no context → 400", async () => {
    vi.spyOn(marketContextModule.marketContextStorage, "getStore").mockReturnValue(null)
    const req = makeReq({ action: "pause", token: "tok", locale: "pl", pause_state: "considering" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/market_id/)
  })
})

describe("POST /store/voucher-pii-consent — service unavailable", () => {
  it("scope.resolve returns null → 503", async () => {
    const req = makeReq({
      action: "grant",
      market_id: "bb",
      order_id: "o",
      entitlement_id: "e",
      locale: "pl",
      is_gift: false,
    }, null)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(503)
    const json = res._calls.json as Record<string, unknown>
    expect(json.error).toBe("service_unavailable")
  })
})

describe("POST /store/voucher-pii-consent — security headers (NFR-SEC-5/6)", () => {
  it("CSP report-only + X-Frame-Options set on every response", async () => {
    const req = makeReq({ locale: "pl" })
    const res = makeRes()
    await POST(req, res)
    const setHeaderCalls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>
    const headerNames = setHeaderCalls.map(([name]) => name)
    expect(headerNames).toContain("Content-Security-Policy-Report-Only")
    expect(headerNames).toContain("X-Frame-Options")
  })
})
