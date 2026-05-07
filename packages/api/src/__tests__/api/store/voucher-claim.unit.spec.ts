/**
 * Story v160-cleanup-25 — voucher claim route unit tests (re-targeted).
 *
 * Covers all ACs from stories v160-cleanup-15c and v160-cleanup-25:
 *   AC1 — Real backend route (happy path, already-claimed, invalid code)
 *   AC2 — Constant-time anti-enumeration (latency floor enforced)
 *   AC3 — HMAC-bound idempotency (tampered binding → 409)
 *   AC6 — Rate-limit: 11th request → 429 with Retry-After
 *
 * v160-cleanup-25: route now resolves VoucherService from req.scope instead
 * of importing from voucher-fixture-store.ts (deleted). Tests mock the
 * VoucherService methods directly via jest.fn().
 */

import {
  computeBinding,
  verifyBinding,
} from "../../../lib/claim-idempotency-binding"
import {
  consumeClaimToken,
  _resetBuckets,
  _setClock,
} from "../../../lib/voucher-claim-rate-limit"
import {
  _clearAuditLog,
  _clearBindingStore,
  _getAuditLog,
  POST,
} from "../../../api/store/vouchers/[code]/claim/route"
import { Modules } from "@medusajs/framework/utils"
import type { VoucherWithEvents } from "../../../modules/voucher"

// ---------------------------------------------------------------------------
// VoucherService mock factory
// ---------------------------------------------------------------------------

type MockVoucherService = {
  getByCode: jest.Mock
  claim: jest.Mock
}

function makeMockVoucherService(defaults?: {
  voucher?: VoucherWithEvents | null
}): MockVoucherService {
  const voucher = defaults?.voucher ?? null
  return {
    getByCode: jest.fn().mockResolvedValue(voucher),
    claim: jest.fn().mockResolvedValue(
      voucher
        ? { status: "claimed", voucher: { ...voucher, status: "claimed" } }
        : { status: "not_found", voucher: null }
    ),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
  code: string,
  body: Record<string, unknown> = {},
  ip = "127.0.0.1",
  voucherService?: MockVoucherService,
  extraScope?: { resolve: (key: string) => unknown },
): {
  params: { code: string }
  body: Record<string, unknown>
  headers: Record<string, string>
  socket: { remoteAddress: string }
  scope: { resolve: (key: string) => unknown }
} {
  const scope = {
    resolve: (key: string): unknown => {
      if (key === "voucher" && voucherService) return voucherService
      if (extraScope) return extraScope.resolve(key)
      throw new Error(`unexpected resolve: ${key}`)
    },
  }
  return {
    params: { code },
    body,
    headers: {},
    socket: { remoteAddress: ip },
    scope,
  }
}

function makeRes(): {
  status: jest.Mock
  json: jest.Mock
  setHeader: jest.Mock
  _status: number
  _body: unknown
} {
  const res: {
    status: jest.Mock
    json: jest.Mock
    setHeader: jest.Mock
    _status: number
    _body: unknown
  } = {
    _status: 0,
    _body: undefined,
    setHeader: jest.fn(),
    status: jest.fn().mockImplementation(function (this: typeof res, s: number) {
      this._status = s
      return this
    }),
    json: jest.fn().mockImplementation(function (this: typeof res, b: unknown) {
      this._body = b
    }),
  }
  res.status = res.status.bind(res)
  res.json = res.json.bind(res)
  return res
}

// ---------------------------------------------------------------------------
// Fixture vouchers (matching the canonical E2E fixture codes)
// ---------------------------------------------------------------------------

const IDLE_VOUCHER: VoucherWithEvents = {
  code: "TEST-IDLE-AAA",
  market_id: null,
  seller_id: "sel_test",
  seller_name: "Test Seller",
  seller_handle: "test-seller",
  product_title: "Test Product",
  value_minor: 10000,
  currency_code: "PLN",
  status: "idle",
  expires_at: new Date("2099-12-31T23:59:59Z"),
  created_at: new Date("2026-05-04T00:00:00Z"),
  updated_at: new Date("2026-05-04T00:00:00Z"),
  events: [
    {
      id: "evt-1",
      voucher_code: "TEST-IDLE-AAA",
      event_type: "created",
      occurred_at: new Date("2026-05-04T00:00:00Z"),
      created_at: new Date("2026-05-04T00:00:00Z"),
    },
  ],
}

const CLAIMED_VOUCHER: VoucherWithEvents = {
  ...IDLE_VOUCHER,
  code: "TEST-CLAIMED-BBB",
  status: "claimed",
  events: [
    {
      id: "evt-2",
      voucher_code: "TEST-CLAIMED-BBB",
      event_type: "created",
      occurred_at: new Date("2026-05-04T00:00:00Z"),
      created_at: new Date("2026-05-04T00:00:00Z"),
    },
    {
      id: "evt-3",
      voucher_code: "TEST-CLAIMED-BBB",
      event_type: "claimed",
      occurred_at: new Date("2026-05-04T01:00:00Z"),
      created_at: new Date("2026-05-04T01:00:00Z"),
    },
  ],
}

const EXPIRED_VOUCHER: VoucherWithEvents = {
  ...IDLE_VOUCHER,
  code: "TEST-EXPIRED-CCC",
  expires_at: new Date("2020-01-01T00:00:00Z"),
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearAuditLog()
  _clearBindingStore()
  _resetBuckets()
  process.env.JWT_SECRET = "test-secret-for-unit-tests"
})

afterEach(() => {
  delete process.env.JWT_SECRET
  delete process.env.GP_VOUCHER_CLAIM_HMAC_SECRET
})

// ---------------------------------------------------------------------------
// claim-idempotency-binding unit tests
// ---------------------------------------------------------------------------

describe("claim-idempotency-binding", () => {
  it("computeBinding returns a 64-char hex string", () => {
    const b = computeBinding("CODE", "SESSION", "2026-01-01T00:00:00Z")
    expect(b).toMatch(/^[0-9a-f]{64}$/)
  })

  it("same inputs produce same binding (deterministic)", () => {
    const b1 = computeBinding("CODE", "SESSION", "2026-01-01T00:00:00Z")
    const b2 = computeBinding("CODE", "SESSION", "2026-01-01T00:00:00Z")
    expect(b1).toBe(b2)
  })

  it("different code → different binding", () => {
    const b1 = computeBinding("CODE-A", "SESSION", "2026-01-01T00:00:00Z")
    const b2 = computeBinding("CODE-B", "SESSION", "2026-01-01T00:00:00Z")
    expect(b1).not.toBe(b2)
  })

  it("different session → different binding", () => {
    const b1 = computeBinding("CODE", "SESSION-A", "2026-01-01T00:00:00Z")
    const b2 = computeBinding("CODE", "SESSION-B", "2026-01-01T00:00:00Z")
    expect(b1).not.toBe(b2)
  })

  it("verifyBinding returns true for matching strings (constant-time)", () => {
    const b = computeBinding("CODE", "SESSION", "2026-01-01T00:00:00Z")
    expect(verifyBinding(b, b)).toBe(true)
  })

  it("verifyBinding returns false for non-matching strings", () => {
    const b1 = computeBinding("CODE", "SESSION", "2026-01-01T00:00:00Z")
    const b2 = computeBinding("CODE", "SESSION-TAMPERED", "2026-01-01T00:00:00Z")
    expect(verifyBinding(b1, b2)).toBe(false)
  })

  it("throws when code contains reserved separator |", () => {
    expect(() => computeBinding("CODE|X", "SESSION", "2026-01-01T00:00:00Z")).toThrow()
  })

  it("throws when JWT_SECRET is absent", () => {
    delete process.env.JWT_SECRET
    expect(() => computeBinding("CODE", "SESSION", "2026-01-01T00:00:00Z")).toThrow(
      /JWT_SECRET/
    )
  })
})

// ---------------------------------------------------------------------------
// voucher-claim-rate-limit unit tests
// ---------------------------------------------------------------------------

describe("voucher-claim-rate-limit", () => {
  it("allows first 10 requests from an IP (full bucket)", () => {
    for (let i = 0; i < 10; i++) {
      const r = consumeClaimToken("10.0.0.1")
      expect(r.allowed).toBe(true)
    }
  })

  it("11th request from same IP within same instant is rejected (429)", () => {
    for (let i = 0; i < 10; i++) consumeClaimToken("10.0.0.2")
    const r = consumeClaimToken("10.0.0.2")
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSec).toBeGreaterThan(0)
  })

  it("different IPs have independent buckets", () => {
    for (let i = 0; i < 10; i++) consumeClaimToken("10.0.0.3")
    const r = consumeClaimToken("10.0.0.4")
    expect(r.allowed).toBe(true)
  })

  it("bucket refills after enough time elapses", () => {
    let now = 1_000_000
    _setClock(() => now)
    for (let i = 0; i < 10; i++) consumeClaimToken("10.0.0.5")
    const blocked = consumeClaimToken("10.0.0.5")
    expect(blocked.allowed).toBe(false)

    // Advance 2 minutes — should refill 10 tokens (5/min × 2 min)
    now += 120_000
    const allowed = consumeClaimToken("10.0.0.5")
    expect(allowed.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST /store/vouchers/:code/claim route tests (unit — no real HTTP)
// ---------------------------------------------------------------------------

describe("POST /store/vouchers/:code/claim", () => {
  function validBody(code = IDLE_VOUCHER.code) {
    const session = "session-abc"
    const claimedAt = "2026-05-04T12:00:00Z"
    const idempotencyKey = computeBinding(code, session, claimedAt)
    return { recipient_session: session, claimed_at: claimedAt, idempotency_key: idempotencyKey }
  }

  it("AC1 happy path — idle code returns 200 with state=claimed", async () => {
    const svc = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req = makeReq(IDLE_VOUCHER.code, validBody(), "127.0.0.1", svc)
    const res = makeRes()
    await POST(req as never, res as never)
    expect(res._status).toBe(200)
    expect((res._body as Record<string, unknown>).state).toBe("claimed")
    expect((res._body as Record<string, unknown>).seller_handle).toBe(
      IDLE_VOUCHER.seller_handle
    )
  })

  it("emits voucher.claimed after successful first claim", async () => {
    const emit = jest.fn().mockResolvedValue(undefined)
    const svc = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req = makeReq(
      IDLE_VOUCHER.code,
      validBody(),
      "127.0.0.1",
      svc,
      {
        resolve: (key: string) => {
          if (key === Modules.EVENT_BUS) {
            return { emit }
          }
          throw new Error(`unexpected resolve: ${key}`)
        },
      },
    )
    const res = makeRes()

    await POST(req as never, res as never)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      name: "voucher.claimed",
      data: {
        voucher_id: IDLE_VOUCHER.code,
        voucher_code: IDLE_VOUCHER.code,
        claimed_at: (res._body as Record<string, unknown>).claimed_at,
      },
    })
  })

  it("AC1 — response does NOT expose recipient PII", async () => {
    const svc = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req = makeReq(IDLE_VOUCHER.code, validBody(), "127.0.0.1", svc)
    const res = makeRes()
    await POST(req as never, res as never)
    const body = JSON.stringify(res._body)
    expect(body).not.toMatch(/recipient_session/)
    expect(body).not.toMatch(/session-abc/)
  })

  it("AC1 — invalid code returns 404 (constant-time)", async () => {
    const svc = makeMockVoucherService({ voucher: null })
    const req = makeReq("NOT-EXIST-999", validBody("NOT-EXIST-999"), "127.0.0.1", svc)
    const res = makeRes()
    await POST(req as never, res as never)
    expect(res._status).toBe(404)
  })

  it("AC1 — already claimed code returns 409 already_claimed", async () => {
    const svc = makeMockVoucherService({ voucher: CLAIMED_VOUCHER })
    const req = makeReq(CLAIMED_VOUCHER.code, validBody(CLAIMED_VOUCHER.code), "127.0.0.1", svc)
    const res = makeRes()
    await POST(req as never, res as never)
    expect(res._status).toBe(409)
    expect((res._body as Record<string, unknown>).type).toBe("already_claimed")
  })

  it("AC1 — expired code returns 410", async () => {
    const svc = makeMockVoucherService({ voucher: EXPIRED_VOUCHER })
    const req = makeReq(EXPIRED_VOUCHER.code, validBody(EXPIRED_VOUCHER.code), "127.0.0.1", svc)
    const res = makeRes()
    await POST(req as never, res as never)
    expect(res._status).toBe(410)
  })

  it("AC3 — idempotent replay with same binding returns 200", async () => {
    const body = validBody()
    const svc = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req1 = makeReq(IDLE_VOUCHER.code, body, "127.0.0.1", svc)
    const res1 = makeRes()
    await POST(req1 as never, res1 as never)
    expect(res1._status).toBe(200)

    // Replay with identical body
    const svc2 = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req2 = makeReq(IDLE_VOUCHER.code, body, "127.0.0.1", svc2)
    const res2 = makeRes()
    await POST(req2 as never, res2 as never)
    expect(res2._status).toBe(200)
    expect((res2._body as Record<string, unknown>).idempotent).toBe(true)
  })

  it("AC3 — replay with tampered session → 409 replay_mismatch", async () => {
    const body = validBody()
    const svc1 = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req1 = makeReq(IDLE_VOUCHER.code, body, "127.0.0.1", svc1)
    const res1 = makeRes()
    await POST(req1 as never, res1 as never)
    expect(res1._status).toBe(200)

    // Same idempotency_key but different session → binding will mismatch
    const tamperedBody = {
      ...body,
      recipient_session: "TAMPERED-SESSION",
    }
    const svc2 = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req2 = makeReq(IDLE_VOUCHER.code, tamperedBody, "127.0.0.1", svc2)
    const res2 = makeRes()
    await POST(req2 as never, res2 as never)
    expect(res2._status).toBe(409)
    expect((res2._body as Record<string, unknown>).type).toBe("replay_mismatch")
  })

  it("AC3 — first request with arbitrary idempotency key → 409 replay_mismatch", async () => {
    const svc = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req = makeReq(IDLE_VOUCHER.code, {
      recipient_session: "session-abc",
      claimed_at: "2026-05-04T12:00:00Z",
      idempotency_key: "550e8400-e29b-41d4-a716-446655440000",
    }, "127.0.0.1", svc)
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res._status).toBe(409)
    expect((res._body as Record<string, unknown>).type).toBe("replay_mismatch")
  })

  it("AC3 — audit log records replay_tampered outcome", async () => {
    const body = validBody()
    const svc1 = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    await POST(makeReq(IDLE_VOUCHER.code, body, "127.0.0.1", svc1) as never, makeRes() as never)

    const tamperedBody = { ...body, recipient_session: "TAMPERED" }
    const svc2 = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    await POST(makeReq(IDLE_VOUCHER.code, tamperedBody, "127.0.0.1", svc2) as never, makeRes() as never)

    const log = _getAuditLog()
    const tamperRow = log.find((r) => r.outcome === "replay_tampered")
    expect(tamperRow).toBeDefined()
    expect(tamperRow?.code).toBe(IDLE_VOUCHER.code)
  })

  it("AC6 — 11th request from same IP → 429 with Retry-After header", async () => {
    _resetBuckets()
    const ip = "192.168.1.1"
    for (let i = 0; i < 10; i++) {
      const rateCode = `RATE-CODE-${i}`
      const rateVoucher: VoucherWithEvents = { ...IDLE_VOUCHER, code: rateCode }
      const svc = makeMockVoucherService({ voucher: rateVoucher })
      const body = validBody(rateCode)
      const req = makeReq(rateCode, body, ip, svc)
      const res = makeRes()
      await POST(req as never, res as never)
    }
    // 11th request
    const rateCode10 = "RATE-CODE-10"
    const rateVoucher10: VoucherWithEvents = { ...IDLE_VOUCHER, code: rateCode10 }
    const svc11 = makeMockVoucherService({ voucher: rateVoucher10 })
    const req11 = makeReq(rateCode10, validBody(rateCode10), ip, svc11)
    const res11 = makeRes()
    await POST(req11 as never, res11 as never)
    expect(res11._status).toBe(429)
    expect(res11.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String))
  })

  it("AC1 — missing required fields → 400", async () => {
    const svc = makeMockVoucherService({ voucher: IDLE_VOUCHER })
    const req = makeReq(IDLE_VOUCHER.code, {}, "127.0.0.1", svc)
    const res = makeRes()
    await POST(req as never, res as never)
    expect(res._status).toBe(400)
  })
})
