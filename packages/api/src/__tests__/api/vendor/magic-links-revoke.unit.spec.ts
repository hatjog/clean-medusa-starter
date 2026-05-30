import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { POST } from "../../../api/vendor/magic-links/[jti]/revoke/route"
import { PostgresMagicLinkStore } from "../../../lib/auth/magic-link-revocation"
import { InMemoryTokenBucketAdapter } from "../../../lib/rate-limit-token-bucket"

const VALID_JTI = "00000000-0000-4000-8000-000000000001"
const OTHER_JTI = "00000000-0000-4000-8000-000000000002"

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    set(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value
      return this
    },
  }
}

function dbWithIssuedRow(row: Record<string, unknown> | undefined) {
  const first = jest.fn().mockResolvedValue(row)
  const where = jest.fn(() => ({ first }))
  const select = jest.fn(() => ({ where }))
  return jest.fn((table: string) => {
    if (table === "magic_link_issued") {
      return { select }
    }
    return {}
  })
}

function request(args: {
  jti?: string
  sellerId?: string
  actorType?: string
  body?: Record<string, unknown>
  issuedRow?: Record<string, unknown>
  logger?: { info: jest.Mock }
  rateLimiter?: InMemoryTokenBucketAdapter
}): MedusaRequest {
  const db = dbWithIssuedRow(args.issuedRow)
  const logger = args.logger ?? { info: jest.fn() }
  const rateLimiter = args.rateLimiter ?? new InMemoryTokenBucketAdapter()

  return {
    params: { jti: args.jti ?? VALID_JTI },
    body: args.body ?? { confirm: true },
    auth_context: args.sellerId
      ? { actor_id: args.sellerId, actor_type: args.actorType ?? "seller" }
      : undefined,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "__pg_connection__") return db
        if (key === "logger") return logger
        if (key === "rate_limit_token_bucket") return rateLimiter
        return {}
      }),
    },
  } as unknown as MedusaRequest
}

describe("POST /vendor/magic-links/:jti/revoke", () => {
  let revokeSpy: jest.SpiedFunction<PostgresMagicLinkStore["revokeJti"]>

  beforeEach(() => {
    revokeSpy = jest
      .spyOn(PostgresMagicLinkStore.prototype, "revokeJti")
      .mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("revokes an owned seller JTI and emits audit envelope", async () => {
    const logger = { info: jest.fn() }
    const res = response()

    await POST(
      request({
        sellerId: "seller_1",
        issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" },
        body: { confirm: true, current_session: true },
        logger,
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toHaveProperty("revoked_at")
    expect(revokeSpy).toHaveBeenCalledWith({
      token_jti: VALID_JTI,
      reason: "seller_revoke",
      revoked_by: "seller_1",
      actor_type: "seller",
    })
    expect(logger.info).toHaveBeenCalledWith(
      "[magic-link-revoke] audit",
      expect.objectContaining({
        actor_type: "vendor",
        outcome: "revoked",
        current_session_revoke: true,
        subject_seller_id_hashed: null,
      })
    )
  })

  it("rejects cross-tenant JTI with 403 and hashed subject seller id", async () => {
    const logger = { info: jest.fn() }
    const res = response()

    await POST(
      request({
        sellerId: "seller_1",
        issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_2" },
        logger,
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ reason: "cross_tenant" })
    expect(revokeSpy).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      "[magic-link-revoke] audit",
      expect.objectContaining({
        outcome: "rejected_cross_tenant",
        subject_seller_id_hashed: expect.any(String),
      })
    )
  })

  it("rejects missing seller JTI as jti_not_found with null hashed subject", async () => {
    const logger = { info: jest.fn() }
    const res = response()

    await POST(
      request({ sellerId: "seller_1", issuedRow: undefined, logger }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ reason: "jti_not_found" })
    expect(logger.info).toHaveBeenCalledWith(
      "[magic-link-revoke] audit",
      expect.objectContaining({
        outcome: "rejected_jti_invalid",
        subject_seller_id_hashed: null,
      })
    )
  })

  it("rejects invalid JTI format with audit when seller is authenticated", async () => {
    const logger = { info: jest.fn() }
    const res = response()

    await POST(
      request({ jti: "not-a-uuid", sellerId: "seller_1", logger }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ code: "INVALID_JTI" })
    expect(logger.info).toHaveBeenCalledWith(
      "[magic-link-revoke] audit",
      expect.objectContaining({ outcome: "rejected_jti_invalid" })
    )
  })

  it("returns 401 without audit when seller auth is missing", async () => {
    const logger = { info: jest.fn() }
    const res = response()

    await POST(
      request({ issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" }, logger }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(401)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it("rate limits the fourth attempt per JTI per minute via shared scope adapter", async () => {
    const sharedRateLimiter = new InMemoryTokenBucketAdapter()

    for (let index = 0; index < 3; index += 1) {
      await POST(
        request({
          jti: OTHER_JTI,
          sellerId: "seller_1",
          issuedRow: { token_jti: OTHER_JTI, subject_seller_id: "seller_1" },
          rateLimiter: sharedRateLimiter,
        }),
        response() as unknown as MedusaResponse
      )
    }

    const logger = { info: jest.fn() }
    const res = response()
    await POST(
      request({
        jti: OTHER_JTI,
        sellerId: "seller_1",
        issuedRow: { token_jti: OTHER_JTI, subject_seller_id: "seller_1" },
        logger,
        rateLimiter: sharedRateLimiter,
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(429)
    expect(res.body).toMatchObject({ code: "RATE_LIMITED" })
    expect(res.headers["Retry-After"]).toBeDefined()
    expect(logger.info).toHaveBeenCalledWith(
      "[magic-link-revoke] audit",
      expect.objectContaining({ outcome: "rejected_rate_limited" })
    )
  })

  it("requires explicit confirmation before consuming rate-limit bucket", async () => {
    const sharedRateLimiter = new InMemoryTokenBucketAdapter()
    const res = response()

    // 5 malformed requests with confirm:false must NOT drain the bucket —
    // verifies F-01 fix (confirm check sits BEFORE consumeRateLimit).
    for (let index = 0; index < 5; index += 1) {
      const r = response()
      await POST(
        request({
          sellerId: "seller_1",
          body: { confirm: false },
          issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" },
          rateLimiter: sharedRateLimiter,
        }),
        r as unknown as MedusaResponse
      )
      expect(r.statusCode).toBe(400)
    }

    // The legit owner attempt that follows must still succeed (bucket unspent).
    await POST(
      request({
        sellerId: "seller_1",
        body: { confirm: true },
        issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" },
        rateLimiter: sharedRateLimiter,
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(200)
    expect(revokeSpy).toHaveBeenCalled()
  })

  it("rejects unknown body fields with 400 (strict schema)", async () => {
    const res = response()

    await POST(
      request({
        sellerId: "seller_1",
        body: { confirm: true, malicious_field: "x" },
        issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" },
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ code: "CONFIRM_REQUIRED" })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it("rejects non-boolean current_session with 400", async () => {
    const res = response()

    await POST(
      request({
        sellerId: "seller_1",
        body: { confirm: true, current_session: "true" },
        issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" },
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(400)
    expect(revokeSpy).not.toHaveBeenCalled()
  })
})
