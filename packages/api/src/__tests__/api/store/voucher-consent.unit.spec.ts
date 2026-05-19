import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { GET, POST } from "../../../api/store/voucher-consent/[token]/route"
import {
  configureMagicLinkRuntime,
  generateMagicLinkWithClaims,
  resetMagicLinkRuntime,
} from "../../../lib/auth/magic-link"
import { marketContextStorage } from "../../../lib/market-context"

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
  return generateMagicLinkWithClaims("purchase", subject, {
    secret: JWT_SECRET,
    jti: options.jti ?? "jti-123",
    now: options.now ?? new Date("2026-05-19T08:00:00.000Z"),
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
    ["revoked", "TOKEN_REVOKED", signedToken({ customer_id: "cus_1" }, { jti: "revoked-jti" })],
    ["invalid", "TOKEN_INVALID", "not-a-jwt"],
  ] as const)("maps %s magic link failures to %s", async (reason, code, token) => {
    if (reason === "revoked") revokedJtis.add("revoked-jti")
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
        "jti-123",
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
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [],
      [{ attempts: "2" }],
      [{ status: "approved" }]
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
    const db = dbWithRows(
      [{ market_id: "bonbeauty", sales_channel_id: null, requires_age_check: false }],
      [],
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
    ["revoked", "TOKEN_REVOKED", signedToken({ customer_id: "cus_1" }, { jti: "revoked-jti" })],
    ["invalid", "TOKEN_INVALID", "not-a-jwt"],
  ] as const)("maps %s magic link failures to %s", async (reason, code, token) => {
    if (reason === "revoked") revokedJtis.add("revoked-jti")
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
