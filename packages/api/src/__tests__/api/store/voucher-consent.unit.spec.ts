import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { GET, POST } from "../../../api/store/voucher-consent/[token]/route"
import {
  configureMagicLinkRuntime,
  generateMagicLinkWithClaims,
  resetMagicLinkRuntime,
} from "../../../lib/auth/magic-link"
import { marketContextStorage } from "../../../lib/market-context"

// Magic-link jti MUST be a UUIDv1-5 per `isValidMagicLinkJti` (auth review
// hardening commit 88f1d2f). Static literals like "jti-123" are rejected at
// generate-time. Tests that need a stable jti use these UUID constants.
const TEST_JTI_DEFAULT = "11111111-1111-4111-8111-111111111111"
const TEST_JTI_REVOKED = "22222222-2222-4222-8222-222222222222"

type MockDb = {
  raw: jest.Mock
}

function response() {
  const headers = new Map<string, string>()
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    setHeader(name: string, value: string) {
      headers.set(name, value)
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

function request(
  body: Record<string, unknown>,
  db: MockDb | null,
  headers: Record<string, string> = {},
  token = signedToken({ customer_id: "cus_1", order_id: "ord_1" })
): MedusaRequest {
  return {
    body,
    params: { token },
    headers,
    scope: {
      resolve: jest.fn().mockImplementation((key: string) => {
        if (key === "__pg_connection__" || key === "pg_connection") return db
        return undefined
      }),
    },
  } as unknown as MedusaRequest
}

function dbWithRows(...rows: Array<Array<Record<string, unknown>>>) {
  const db = {
    raw: jest.fn(),
  }
  for (const rowSet of rows) {
    db.raw.mockResolvedValueOnce({ rows: rowSet })
  }
  db.raw.mockResolvedValue({ rows: [] })
  return db
}

const JWT_SECRET = "test-jwt-secret-for-voucher-consent-123456789"
const revokedJtis = new Set<string>()

function signedToken(
  subject: Record<string, string | number | boolean | null>,
  options: { jti?: string; now?: Date } = {}
): string {
  // Use "now" by default so tokens are always within the 24h purchase TTL
  // window regardless of when the suite is executed. Tests that need an
  // explicitly expired token pass `now` in the distant past.
  return generateMagicLinkWithClaims("purchase", subject, {
    secret: JWT_SECRET,
    jti: options.jti ?? TEST_JTI_DEFAULT,
    now: options.now ?? new Date(),
  }).token
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
  revokedJtis.clear()
  configureMagicLinkRuntime({
    isJtiRevoked: async (jti) => revokedJtis.has(jti),
    recordIssued: async () => undefined,
  })
})

afterEach(() => {
  resetMagicLinkRuntime()
  delete process.env.JWT_SECRET
})

async function withMarket(
  callback: () => Promise<void>,
  context: { market_id: string; sales_channel_id: string } = {
    market_id: "bonbeauty",
    sales_channel_id: "sc_bb",
  }
) {
  await marketContextStorage.run(context, callback)
}

describe("GET /store/voucher-consent/:token", () => {
  it("returns blocked minor state fail-closed from authoritative order data when JWT omits age flags", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_minor",
    })
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: true }],
      []
    )
    const res = response()

    await withMarket(async () => {
      await GET(request({}, db, {}, token), res as unknown as MedusaResponse)
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(
      expect.objectContaining({
        state: "blocked",
        age_check_required: true,
        error: "GUARDIAN_APPROVAL_REQUIRED",
      })
    )
  })

  it("returns TOKEN_INVALID when authoritative consent context cannot be resolved", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_missing",
    })
    const db = dbWithRows([{ market_id: null, sales_channel_id: null, requires_age_check: false }])
    const res = response()

    await withMarket(async () => {
      await GET(request({}, db, {}, token), res as unknown as MedusaResponse)
    })

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: "TOKEN_INVALID" })
  })

  it.each([
    [
      "expired",
      "TOKEN_EXPIRED",
      signedToken({ customer_id: "cus_1" }, { now: new Date("2000-01-01T00:00:00.000Z") }),
    ],
    ["revoked", "TOKEN_REVOKED", signedToken({ customer_id: "cus_1" }, { jti: TEST_JTI_REVOKED })],
    ["invalid", "TOKEN_INVALID", "not-a-jwt"],
  ] as const)("maps %s magic link failures to %s", async (reason, code, token) => {
    if (reason === "revoked") revokedJtis.add(TEST_JTI_REVOKED)
    const res = response()

    await withMarket(async () => {
      await GET(request({}, null, {}, token), res as unknown as MedusaResponse)
    })

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: code })
  })
})

describe("POST /store/voucher-consent/:token", () => {
  it("persists adult consent with market-scoped minimized fields only", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_1",
      market_id: "bonbeauty",
      sales_channel_id: "sc_bb",
    })
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [],
      [{ attempts: "1" }],
      [],
      []
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {
            "user-agent": "jest-agent",
            "x-forwarded-for": "203.0.113.10, 10.0.0.1",
          },
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "approved",
      })
    )
    const insertParams = db.raw.mock.calls[4][1] as unknown[]
    expect(insertParams).toEqual(
      expect.arrayContaining([
        TEST_JTI_DEFAULT,
        "cus_1",
        "bonbeauty",
        "sc_bb",
        true,
        true,
        false,
        null,
        null,
        "approved",
        "203.0.113.10",
        "jest-agent",
      ])
    )
    expect(JSON.stringify(insertParams)).not.toContain("phone")
  })

  it("forces minor guardian validation from authoritative order data when JWT omits age flags", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_minor",
    })
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: true }],
      [],
      [{ attempts: "1" }],
      []
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: "GUARDIAN_EMAIL_INVALID" })
  })

  it("persists guardian consent only after authoritative minor resolution, guardian inputs, and captcha", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_minor",
    })
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: true }],
      [],
      [{ attempts: "1" }],
      [],
      []
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: true,
            guardian_email: "guardian@example.test",
            guardian_is_parent: true,
            captcha_token: "test-captcha-token",
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "approved_by_guardian",
      })
    )
  })

  it("rejects subject market mismatch against ALS context", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_1",
      market_id: "other-market",
    })
    const db = dbWithRows()
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: "TOKEN_INVALID" })
    expect(db.raw).not.toHaveBeenCalled()
  })

  it("rejects authoritative market mismatch against ALS context", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_1",
    })
    const db = dbWithRows(
      [{ market_id: "testmarketb", sales_channel_id: null, requires_age_check: false }]
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: "TOKEN_INVALID" })
  })

  it("treats approved consent as single-use and does not overwrite the row", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_1",
    })
    // v1.9.1 Wave G2 row-order fix: post-F6 the query sequence is
    //   [authority, count, consentStatus, recordAttempt-breadcrumb].
    // Legacy slot order was [authority, ?, count, status] which silently
    // returned count=0 from the empty slot, masking the bug.
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [{ attempts: "2" }],
      [{ status: "approved" }],
      []
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: true,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      status: "approved",
      redirect_url: "/voucher",
    })
    expect(db.raw).toHaveBeenCalledTimes(4)
  })

  it("rate-limits after the fourth recorded attempt, including retries on the same token", async () => {
    const token = signedToken({
      customer_id: "cus_1",
      order_id: "ord_1",
    })
    // v1.9.1 Wave G2 row-order fix: count is call[1] post-F6 (was [2] pre-F6).
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [{ attempts: "4" }]
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("3600")
    expect(res.body).toEqual({ error: "RATE_LIMITED" })
  })

  it("rejects demographic and contact fields outside the allowed payload", async () => {
    const token = signedToken({ customer_id: "cus_1", order_id: "ord_1" })
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [],
      [{ attempts: "1" }],
      []
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
            phone: "+48123123123",
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: "FIELD_NOT_ALLOWED", field: "phone" })
  })

  it.each([
    [{ consent_rodo: false, consent_service_execution: true }, "RODO_CONSENT_REQUIRED"],
    [{ consent_rodo: true, consent_service_execution: false }, "SERVICE_CONSENT_REQUIRED"],
  ] as const)("rejects mandatory consent failure %j as %s", async (body, code) => {
    const token = signedToken({ customer_id: "cus_1", order_id: "ord_1" })
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [],
      [{ attempts: "1" }],
      []
    )
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_marketing: false,
            ...body,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: code })
  })

  it.each([
    [
      "expired",
      "TOKEN_EXPIRED",
      signedToken({ customer_id: "cus_1" }, { now: new Date("2000-01-01T00:00:00.000Z") }),
    ],
    ["revoked", "TOKEN_REVOKED", signedToken({ customer_id: "cus_1" }, { jti: TEST_JTI_REVOKED })],
    ["invalid", "TOKEN_INVALID", "not-a-jwt"],
  ] as const)("maps %s magic link failures to %s", async (reason, code, token) => {
    if (reason === "revoked") revokedJtis.add(TEST_JTI_REVOKED)
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          null,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: code })
  })
})

// v1.9.1 Wave G2 — HIGH-10/11 regression-guard tests for `voucher_consent_attempt`
// DoS write amplifier elimination. The fix landed in v1.9.0 Wave F6 (reorder
// gates to record-after-validate); these tests pin the invariant so a future
// refactor cannot silently reintroduce the write amplifier.
//
// Invariant (assert across all branches):
//   `voucher_consent_attempt` INSERTs occur ONLY on a code path where
//   (a) the per-recipient rate limit was checked AND OK, AND
//   (b) the payload was validated OR a duplicate-grant breadcrumb was emitted
//       under the rate-limit cap.
// Malformed bodies, rate-limited requests, and pre-validation rejections
// MUST NOT touch `voucher_consent_attempt`.

const INSERT_ATTEMPT_PATTERN = /INSERT\s+INTO\s+voucher_consent_attempt/i

function countInsertAttemptCalls(db: MockDb): number {
  return db.raw.mock.calls.filter((call) => {
    const sql = call[0]
    return typeof sql === "string" && INSERT_ATTEMPT_PATTERN.test(sql)
  }).length
}

/**
 * v1.9.1 Wave G2 — HIGH-10/11 regression-guard test helper.
 *
 * The legacy slot-positional `dbWithRows` does not survive a refactor of the
 * route's query order. For the write-amplifier guard tests we need a mock
 * that routes by SQL pattern so the assertions remain stable across F6/F7
 * reorderings of the gate sequence.
 *
 * Supported routes (matched in priority order):
 *   - `INSERT INTO voucher_consent_attempt` → returns `{ rows: [] }`
 *   - `INSERT INTO voucher_consent`          → returns `{ rows: [] }`
 *   - `SELECT ... FROM voucher_consent`      → consentStatus row (configurable)
 *   - `SELECT COUNT(*) ... FROM voucher_consent_attempt` → countRecent row
 *   - `SELECT ... FROM entitlement_instance ei ... WHERE ei.id`     → authorityById
 *   - `SELECT ... FROM entitlement_instance ei ... WHERE ei.order_id` → authorityByOrderId
 *   - `SELECT ... FROM entitlement_instance ei JOIN voucher v`        → voucherCode lookup
 *
 * Any unmatched call returns `{ rows: [] }`.
 */
type SqlRouterConfig = {
  authority?: Record<string, unknown> | null
  count?: number
  consentStatus?: ConsentStatusValue
}
type ConsentStatusValue = "pending" | "approved" | "approved_by_guardian" | "rejected" | null

function makeRoutedDb(cfg: SqlRouterConfig = {}): MockDb {
  const authority =
    cfg.authority === undefined
      ? { market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }
      : cfg.authority
  const count = cfg.count ?? 0
  const consentStatus = cfg.consentStatus ?? null

  return {
    raw: jest.fn().mockImplementation((sql: string) => {
      if (/INSERT\s+INTO\s+voucher_consent_attempt/i.test(sql)) {
        return Promise.resolve({ rows: [] })
      }
      if (/INSERT\s+INTO\s+voucher_consent\b/i.test(sql)) {
        return Promise.resolve({ rows: [] })
      }
      if (/SELECT\s+status\s+FROM\s+voucher_consent\b/i.test(sql)) {
        return Promise.resolve({
          rows: consentStatus === null ? [] : [{ status: consentStatus }],
        })
      }
      if (/COUNT\(\*\)\s*::int\s+AS\s+attempts/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: count }] })
      }
      if (/FROM\s+entitlement_instance\s+ei/i.test(sql)) {
        return Promise.resolve({ rows: authority === null ? [] : [authority] })
      }
      return Promise.resolve({ rows: [] })
    }),
  }
}

describe("POST /store/voucher-consent/:token — HIGH-10/11 write amplifier guard", () => {
  it("records ZERO voucher_consent_attempt rows when the payload is malformed (HIGH-11)", async () => {
    const token = signedToken({ customer_id: "cus_dos", order_id: "ord_dos" })
    // Authority OK + count well under limit; the gate that MUST fire is
    // payload validation, BEFORE any INSERT into voucher_consent_attempt.
    const db = makeRoutedDb({ count: 0 })
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          // Bot payload — fails ALLOWED_FIELDS check (`phone` not allowed).
          // Pre-F6 this would have already INSERTed a row before validation.
          { phone: "+48000000000" },
          db,
          { "user-agent": "bot/1.0" },
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(400)
    expect(countInsertAttemptCalls(db)).toBe(0)
  })

  it("records ZERO voucher_consent_attempt rows for empty {} body (HIGH-11)", async () => {
    const token = signedToken({ customer_id: "cus_dos", order_id: "ord_dos" })
    const db = makeRoutedDb({ count: 0 })
    const res = response()

    await withMarket(async () => {
      await POST(
        request({}, db, {}, token),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: "RODO_CONSENT_REQUIRED" })
    expect(countInsertAttemptCalls(db)).toBe(0)
  })

  it("records ZERO voucher_consent_attempt rows when the request is rate-limited (HIGH-10)", async () => {
    const token = signedToken({ customer_id: "cus_dos", order_id: "ord_dos" })
    // count == RATE_LIMIT_MAX_PER_HOUR → 429, NO INSERT.
    const db = makeRoutedDb({ count: 3 })
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("3600")
    expect(countInsertAttemptCalls(db)).toBe(0)
  })

  it("flooding 100 invalid payloads yields ZERO voucher_consent_attempt INSERTs (HIGH-10 + HIGH-11)", async () => {
    // Per HIGH-10 fix recommendation: count first, INSERT only after rate-limit
    // honoured AND payload validated. This test exercises the amplification
    // surface: 100 distinct bot payloads (alternating malformed/over-limit)
    // MUST NOT cause any audit-table writes.
    const token = signedToken({ customer_id: "cus_flood", order_id: "ord_flood" })

    let insertCount = 0
    const flood = 100
    for (let i = 0; i < flood; i++) {
      // Alternate: half over-limit (HIGH-10), half under-limit but malformed
      // body (HIGH-11). Neither path should INSERT.
      const overLimit = i % 2 === 1
      const db = makeRoutedDb({ count: overLimit ? 10 : 0 })
      const res = response()

      const body = overLimit
        ? {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          }
        : { unknown_field_xyz: i }

      await withMarket(async () => {
        await POST(
          request(body, db, { "x-forwarded-for": `203.0.113.${i % 256}` }, token),
          res as unknown as MedusaResponse
        )
      })

      // Either 400 (malformed) or 429 (rate-limited) — never 201.
      expect([400, 429]).toContain(res.statusCode)
      insertCount += countInsertAttemptCalls(db)
    }

    // Write amplifier eliminated: 100 abusive requests → 0 audit-table writes.
    expect(insertCount).toBe(0)
  })

  it("records exactly ONE voucher_consent_attempt row on a happy-path approval (regression guard)", async () => {
    // Counterpart to the negative tests: confirms the audit row IS written on
    // a well-formed, rate-limit-honouring approval. Prevents an over-correction
    // that suppresses ALL audit writes.
    const token = signedToken({ customer_id: "cus_ok", order_id: "ord_ok" })
    const db = makeRoutedDb({ count: 0, consentStatus: null })
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: false,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(201)
    expect(countInsertAttemptCalls(db)).toBe(1)
  })

  it("records exactly ONE voucher_consent_attempt breadcrumb on duplicate-approved replay (F6 MED-15, post rate-limit)", async () => {
    // The duplicate-approved short-circuit IS allowed to write a breadcrumb,
    // but only AFTER the rate-limit gate. This pins both halves of MED-15.
    const token = signedToken({ customer_id: "cus_dup", order_id: "ord_dup" })
    const db = makeRoutedDb({ count: 1, consentStatus: "approved" })
    const res = response()

    await withMarket(async () => {
      await POST(
        request(
          {
            consent_rodo: true,
            consent_service_execution: true,
            consent_marketing: true,
          },
          db,
          {},
          token
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(200)
    expect(countInsertAttemptCalls(db)).toBe(1)
  })
})
