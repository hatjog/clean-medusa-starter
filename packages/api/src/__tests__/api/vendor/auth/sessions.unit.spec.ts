import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals"

import { GET } from "../../../../api/vendor/auth/sessions/route"
import { buildVendorSignatureHeader } from "../../../../lib/vendor-hmac"

const HMAC_SECRET = "vendor-session-test-secret"
const SELLER_ID = "seller_session_owner"
const OTHER_SELLER_ID = "seller_other"
const VENDOR_ID = "vendor_session_owner"
const SESSION_JTI = "00000000-0000-4000-8000-000000000011"

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED
  process.env.VENDOR_HMAC_SECRET = HMAC_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type SessionRow = {
  token_jti: string
  issued_at: Date
  subject: Record<string, unknown>
}

function makeSessionQuery(rows: SessionRow[]) {
  const query = {
    leftJoin: jest.fn(() => query),
    select: jest.fn(() => query),
    where: jest.fn(() => query),
    whereNull: jest.fn(() => query),
    orderBy: jest.fn(() => query),
    limit: jest.fn(async () => rows),
  }
  return query
}

function makeRequest(args: {
  rows?: SessionRow[]
  sellerId?: string
  signature?: string
  currentJti?: string
}): MedusaRequest {
  const rows = args.rows ?? []
  const query = makeSessionQuery(rows)
  const db = jest.fn((table: string) => {
    expect(table).toBe("magic_link_issued as issued")
    return query
  })
  const signature =
    args.signature ??
    buildVendorSignatureHeader(
      args.sellerId ?? SELLER_ID,
      Buffer.from(HMAC_SECRET, "utf8"),
      Math.floor(Date.now() / 1000),
      `sessions-${Date.now()}-${Math.random()}`
    )

  return {
    headers: {
      "x-vendor-signature": signature,
      ...(args.currentJti ? { "x-vendor-session-jti": args.currentJti } : {}),
    },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "logger") return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        if (key === "gp_core")
          return {
            resolveVendorId: async (sellerId: string) =>
              sellerId === OTHER_SELLER_ID ? "vendor_other" : VENDOR_ID,
          }
        if (key === "__pg_connection__") return db
        return {}
      }),
    },
  } as unknown as MedusaRequest
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
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

describe("GET /vendor/auth/sessions", () => {
  it("returns active seller sessions through withVendorAuth HMAC", async () => {
    const issuedAt = new Date("2026-06-12T10:00:00.000Z")
    const req = makeRequest({
      currentJti: SESSION_JTI,
      rows: [
        {
          token_jti: SESSION_JTI,
          issued_at: issuedAt,
          subject: {
            device_class: "desktop",
            ip_region: "PL-MZ",
          },
        },
      ],
    })
    const res = makeResponse()

    await GET(req as never, res as unknown as MedusaResponse, jest.fn() as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      sessions: [
        {
          jti: SESSION_JTI,
          device_class: "desktop",
          last_active: issuedAt.toISOString(),
          ip_region: "PL-MZ",
          current_session: true,
        },
      ],
    })
  })

  it("fails closed when the HMAC signature is missing", async () => {
    const req = makeRequest({ signature: undefined })
    ;(req as unknown as { headers: Record<string, string> }).headers = {}
    const res = makeResponse()

    await GET(req as never, res as unknown as MedusaResponse, jest.fn() as never)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_MISSING" })
  })
})
