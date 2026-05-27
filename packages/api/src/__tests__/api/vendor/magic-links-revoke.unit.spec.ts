import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  POST,
  __setMagicLinkRevokeRateLimiterForTests,
} from "../../../api/vendor/magic-links/[jti]/revoke/route"
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
}): MedusaRequest {
  const db = dbWithIssuedRow(args.issuedRow)
  const logger = args.logger ?? { info: jest.fn() }

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
        return {}
      }),
    },
  } as unknown as MedusaRequest
}

describe("POST /vendor/magic-links/:jti/revoke", () => {
  let revokeSpy: jest.SpiedFunction<PostgresMagicLinkStore["revokeJti"]>

  beforeEach(() => {
    __setMagicLinkRevokeRateLimiterForTests(new InMemoryTokenBucketAdapter())
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

  it("rejects missing seller JTI as jti_not_found", async () => {
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
      expect.objectContaining({ outcome: "rejected_jti_invalid" })
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

  it("rate limits the fourth attempt per JTI per minute", async () => {
    for (let index = 0; index < 3; index += 1) {
      await POST(
        request({
          jti: OTHER_JTI,
          sellerId: "seller_1",
          issuedRow: { token_jti: OTHER_JTI, subject_seller_id: "seller_1" },
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

  it("requires explicit confirmation before DB lookup/revoke", async () => {
    const res = response()

    await POST(
      request({
        sellerId: "seller_1",
        body: { confirm: false },
        issuedRow: { token_jti: VALID_JTI, subject_seller_id: "seller_1" },
      }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ code: "CONFIRM_REQUIRED" })
    expect(revokeSpy).not.toHaveBeenCalled()
  })
})
