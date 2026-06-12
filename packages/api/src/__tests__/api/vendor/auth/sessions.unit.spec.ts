import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals"

import { GET } from "../../../../api/vendor/auth/sessions/route"

const SELLER_ID = "seller_session_owner"
const SESSION_JTI = "00000000-0000-4000-8000-000000000011"

type SessionRow = {
  token_jti: string
  issued_at: Date
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
  actorType?: string
  currentJti?: string
}): MedusaRequest {
  const rows = args.rows ?? []
  const query = makeSessionQuery(rows)
  const db = jest.fn((table: string) => {
    expect(table).toBe("magic_link_issued as issued")
    return query
  })
  const sellerId = args.sellerId ?? SELLER_ID
  const actorType = args.actorType ?? "seller"

  return {
    headers: {
      ...(args.currentJti ? { "x-vendor-session-jti": args.currentJti } : {}),
    },
    auth_context: {
      actor_id: sellerId,
      actor_type: actorType,
    },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "logger") return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
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
  it("returns active seller sessions via bearer auth", async () => {
    const issuedAt = new Date("2026-06-12T10:00:00.000Z")
    const req = makeRequest({
      currentJti: SESSION_JTI,
      rows: [
        {
          token_jti: SESSION_JTI,
          issued_at: issuedAt,
        },
      ],
    })
    const res = makeResponse()

    await GET(req as never, res as unknown as MedusaResponse)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      sessions: [
        {
          jti: SESSION_JTI,
          last_active: issuedAt.toISOString(),
          current_session: true,
        },
      ],
    })
  })

  it("fails closed when seller auth context is missing", async () => {
    const req = makeRequest({ actorType: "customer" })
    const res = makeResponse()

    await GET(req as never, res as unknown as MedusaResponse)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "SELLER_AUTH_REQUIRED" })
  })
})
