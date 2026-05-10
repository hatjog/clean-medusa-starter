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

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"

const vi = jest
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
    recordConsentTransaction: vi.fn(async () => ({
      consent_audit_id: "aud_grant_001",
      recipient_pii_id: "pii_001",
      delivery_decision_id: "del_001",
      latency_ms: 10,
    })),
    lookupConsentSnapshot: vi.fn(async () => ({
      consent_audit_id: "aud_original_001",
      market_id: "bonbeauty",
      order_id: "ord_abc",
      audit_confirmed: true,
    })),
    recordWithdrawalTransaction: vi.fn(async () => ({
      withdrawal_audit_id: "aud_withdraw_001",
      latency_ms: 5,
      in_flight_dispatch_aborted: false,
    })),
    recordPauseAudit: vi.fn(async () => ({
      pause_audit_id: "aud_pause_001",
      latency_ms: 3,
    })),
    ...overrides,
  }
}

type MockDb = {
  raw: ReturnType<typeof vi.fn>
}

function makeDb(rows: Array<Record<string, unknown>>): MockDb {
  return {
    raw: vi.fn(async () => ({ rows })),
  }
}

function makeReq(
  body: Record<string, unknown>,
  service: MockService | null = makeService(),
  db: MockDb | null = null
) {
  return {
    body,
    scope: {
      resolve: vi.fn().mockImplementation((key: string) => {
        if (key === "voucher_pii") return service
        if (key === "__pg_connection__" || key === "pg_connection") return db
        return undefined
      }),
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
// Market context mock — return null by default (override per test).
// Review F12: spy is reset in beforeEach so tests don't leak state.
// ---------------------------------------------------------------------------

let marketContextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  marketContextSpy = vi
    .spyOn(marketContextModule.marketContextStorage, "getStore")
    .mockReturnValue(undefined)
})

afterEach(() => {
  marketContextSpy?.mockRestore()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /store/voucher-pii-consent — action='grant'", () => {
  it("canonical storefront body action=grant + token → resolves entitlement and persists consent", async () => {
    const service = makeService()
    const db = makeDb([
      {
        entitlement_id: "ent_001",
        market_id: "bonbeauty",
        order_id: "ord_abc",
        buyer_email: "buyer@example.test",
        buyer_is_recipient: true,
      },
    ])
    const req = makeReq({
      action: "grant",
      token: "claim-bonbeauty-1",
      locale: "pl",
      surface: "js",
      occurred_at: "2026-05-10T08:00:00Z",
      schema_version: 1,
    }, service, db)
    const res = makeRes()

    await POST(req, res)

    expect(res._calls.status).toBe(201)
    expect(db.raw).toHaveBeenCalledTimes(1)
    expect(service.recordConsentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: "bonbeauty",
        order_id: "ord_abc",
        entitlement_id: "ent_001",
        recipient_email: "buyer@example.test",
        recipient_phone: null,
        locale: "pl",
        is_gift: false,
      })
    )
    const json = res._calls.json as Record<string, unknown>
    expect(json.audit_id).toBe("aud_grant_001")
  })

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
    expect(service.recordConsentTransaction).toHaveBeenCalledTimes(1)
  })

  it("canonical grant missing token → 400 validation_failed", async () => {
    const req = makeReq({ action: "grant", order_id: "ord_abc", entitlement_id: "ent_xyz", locale: "pl", is_gift: false })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(json.error).toBe("validation_failed")
    expect(String(json.message)).toMatch(/token/)
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
    expect(service.recordConsentTransaction).toHaveBeenCalledTimes(1)
  })

  it("no action + no market_id → 400 (requires action discriminator)", async () => {
    const req = makeReq({ locale: "pl" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
  })

  it("canonical grant with unknown token → 404 and no audit write", async () => {
    const service = makeService()
    const db = makeDb([])
    const req = makeReq({ action: "grant", token: "missing", locale: "pl" }, service, db)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
    expect(service.recordConsentTransaction).not.toHaveBeenCalled()
  })

  it("canonical grant cross-market token mismatch → 404 and no audit write", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "bonbeauty",
      sales_channel_id: "sc_bonbeauty",
    } as never)
    const service = makeService()
    const db = makeDb([
      {
        entitlement_id: "ent_other",
        market_id: "testmarketb",
        order_id: "ord_other",
        buyer_email: null,
        buyer_is_recipient: false,
      },
    ])
    const req = makeReq({ action: "grant", token: "claim-other", locale: "pl" }, service, db)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
    expect(service.recordConsentTransaction).not.toHaveBeenCalled()
  })

  it("canonical grant without database lookup adapter → 503", async () => {
    const service = makeService()
    const req = makeReq({ action: "grant", token: "claim-bonbeauty-1", locale: "pl" }, service, null)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(503)
    const json = res._calls.json as Record<string, unknown>
    expect(json.code).toBe("gp_core_entitlement_lookup_unavailable")
  })
})

describe("POST /store/voucher-pii-consent — action='withdraw'", () => {
  /** Default db mock that returns an entitlement matching the default snapshot. */
  function makeDefaultEntitlementDb() {
    return makeDb([
      {
        entitlement_id: "ent_001",
        market_id: "bonbeauty",
        order_id: "ord_abc",
        buyer_email: "buyer@example.test",
        buyer_is_recipient: true,
      },
    ])
  }

  it("happy path → 201 with withdrawal_audit_id", async () => {
    const service = makeService()
    const db = makeDefaultEntitlementDb()
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_original_001",
      locale: "pl",
    }, service, db)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    const json = res._calls.json as Record<string, unknown>
    expect(json.withdrawal_audit_id).toBe("aud_withdraw_001")
    expect(service.lookupConsentSnapshot).toHaveBeenCalledWith("aud_original_001")
    expect(service.recordWithdrawalTransaction).toHaveBeenCalledTimes(1)
  })

  it("missing compensates_audit_id → 400", async () => {
    const req = makeReq({ action: "withdraw", token: "tok_abc", locale: "pl" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/compensates_audit_id/)
  })

  it("review F3: missing token → 400", async () => {
    const req = makeReq({
      action: "withdraw",
      compensates_audit_id: "aud_x",
      locale: "pl",
    })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/token/)
  })

  it("consent snapshot not found / not confirmed → 404", async () => {
    const service = makeService({ lookupConsentSnapshot: vi.fn(async () => null) })
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_missing",
      locale: "pl",
    }, service, makeDefaultEntitlementDb())
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
    const json = res._calls.json as Record<string, unknown>
    expect(json.error).toBe("consent_not_found")
  })

  it("snapshot exists but audit_confirmed=false → 404", async () => {
    const service = makeService({
      lookupConsentSnapshot: vi.fn(async () => ({ audit_confirmed: false, market_id: "bb", order_id: "o" })),
    })
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_unconfirmed",
      locale: "pl",
    }, service, makeDefaultEntitlementDb())
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
  })

  it("review F1: snapshot missing order_id → 409 consent_incomplete (no token fallback)", async () => {
    const service = makeService({
      lookupConsentSnapshot: vi.fn(async () => ({
        audit_confirmed: true,
        market_id: "bonbeauty",
        order_id: null,
      })),
    })
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_original_001",
      locale: "pl",
    }, service, makeDefaultEntitlementDb())
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(409)
    const json = res._calls.json as Record<string, unknown>
    expect(json.code).toBe("missing_order_id")
    expect(service.recordWithdrawalTransaction).not.toHaveBeenCalled()
  })

  it("review F2: snapshot market_id differs from caller market context → 404", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "bonbeauty",
      sales_channel_id: "sc_bonbeauty",
    } as never)
    const service = makeService({
      lookupConsentSnapshot: vi.fn(async () => ({
        audit_confirmed: true,
        market_id: "testmarketb",
        order_id: "ord_other",
      })),
    })
    const req = makeReq({
      action: "withdraw",
      token: "tok_abc",
      compensates_audit_id: "aud_original_001",
      locale: "pl",
    }, service, makeDefaultEntitlementDb())
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
    expect(service.recordWithdrawalTransaction).not.toHaveBeenCalled()
  })

  it("review F3: token does not match snapshot's entitlement → 404", async () => {
    const service = makeService()
    // entitlement row for a *different* order than snapshot's ord_abc
    const db = makeDb([
      {
        entitlement_id: "ent_other",
        market_id: "bonbeauty",
        order_id: "ord_other",
        buyer_email: null,
        buyer_is_recipient: true,
      },
    ])
    const req = makeReq({
      action: "withdraw",
      token: "tok_wrong",
      compensates_audit_id: "aud_original_001",
      locale: "pl",
    }, service, db)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(404)
    expect(service.recordWithdrawalTransaction).not.toHaveBeenCalled()
  })
})

describe("POST /store/voucher-pii-consent — action='pause'", () => {
  it("review F4: happy path with body market_id matching publishable-key context → 201", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "bonbeauty",
      sales_channel_id: "sc_bonbeauty",
    } as never)
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
    expect(service.recordPauseAudit).toHaveBeenCalledTimes(1)
  })

  it("review F4: body market_id MISMATCHES publishable-key context → 400", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "bonbeauty",
      sales_channel_id: "sc_bonbeauty",
    } as never)
    const service = makeService()
    const req = makeReq({
      action: "pause",
      token: "tok_abc",
      locale: "pl",
      pause_state: "considering",
      market_id: "testmarketb",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/market_id/)
    expect(service.recordPauseAudit).not.toHaveBeenCalled()
  })

  it("market_id from context storage (no body market_id)", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "ctx-market",
      sales_channel_id: "sc_ctx",
    } as never)
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
  })

  it("review F5: raw token is NOT persisted; sha256 hash lands in audit payload instead", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "ctx-market",
      sales_channel_id: "sc_ctx",
    } as never)
    const service = makeService()
    const req = makeReq({
      action: "pause",
      token: "claim-token-secret-abc",
      locale: "pl",
      pause_state: "considering",
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    const callArgs = service.recordPauseAudit.mock.calls[0][0] as Record<string, unknown>
    expect(typeof callArgs.token).toBe("string")
    expect(callArgs.token).not.toBe("claim-token-secret-abc")
    expect(String(callArgs.token).startsWith("sha256:")).toBe(true)
  })

  it("missing token → 400", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "bb",
      sales_channel_id: "sc_bb",
    } as never)
    const req = makeReq({ action: "pause", locale: "pl", pause_state: "considering", market_id: "bb" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/token/)
  })

  it("invalid pause_state → 400", async () => {
    marketContextSpy.mockReturnValue({
      market_id: "bb",
      sales_channel_id: "sc_bb",
    } as never)
    const req = makeReq({ action: "pause", token: "tok", locale: "pl", pause_state: "invalid-state", market_id: "bb" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/pause_state/)
  })

  it("no market_id in body and no context → 400", async () => {
    const req = makeReq({ action: "pause", token: "tok", locale: "pl", pause_state: "considering" })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/market_id/)
  })
})

describe("POST /store/voucher-pii-consent — provenance fields (review F6)", () => {
  it("invalid surface → 400", async () => {
    const req = makeReq({
      action: "grant",
      market_id: "bb",
      order_id: "o",
      entitlement_id: "e",
      locale: "pl",
      is_gift: false,
      surface: "telegram",
    })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/surface/)
  })

  it("invalid occurred_at → 400", async () => {
    const req = makeReq({
      action: "grant",
      market_id: "bb",
      order_id: "o",
      entitlement_id: "e",
      locale: "pl",
      is_gift: false,
      occurred_at: "not-a-date",
    })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/occurred_at/)
  })

  it("schema_version != 1 → 400", async () => {
    const req = makeReq({
      action: "grant",
      market_id: "bb",
      order_id: "o",
      entitlement_id: "e",
      locale: "pl",
      is_gift: false,
      schema_version: 2,
    })
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(400)
    const json = res._calls.json as Record<string, unknown>
    expect(String(json.message)).toMatch(/schema_version/)
  })

  it("valid provenance fields accepted → 201", async () => {
    const service = makeService()
    const req = makeReq({
      action: "grant",
      market_id: "bb",
      order_id: "o",
      entitlement_id: "e",
      locale: "pl",
      is_gift: false,
      surface: "js",
      occurred_at: "2026-05-10T08:00:00.000Z",
      schema_version: 1,
    }, service)
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
  })
})

describe("POST /store/voucher-pii-consent — request-id propagation (review F9)", () => {
  it("Idempotency-Key header propagates to service request_id", async () => {
    const service = makeService()
    const req = makeReq({
      action: "grant",
      market_id: "bb",
      order_id: "o",
      entitlement_id: "e",
      locale: "pl",
      is_gift: false,
    }, service)
    ;(req as unknown as { headers: Record<string, string> }).headers = {
      "idempotency-key": "grant:tok:1715337600000",
    }
    const res = makeRes()
    await POST(req, res)
    expect(res._calls.status).toBe(201)
    const callArgs = service.recordConsentTransaction.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.request_id).toBe("grant:tok:1715337600000")
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
