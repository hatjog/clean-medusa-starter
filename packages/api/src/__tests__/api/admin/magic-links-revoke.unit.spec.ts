import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { POST } from "../../../api/admin/magic-links/[jti]/revoke/route"
import { PostgresMagicLinkStore } from "../../../lib/auth/magic-link-revocation"

const VALID_JTI = "00000000-0000-4000-8000-000000000001"

function response() {
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

function request(params: Record<string, string>, actorId?: string): MedusaRequest {
  return {
    params,
    auth_context: actorId ? { actor_id: actorId } : undefined,
    scope: {
      resolve: jest.fn().mockReturnValue({}),
    },
  } as unknown as MedusaRequest
}

describe("POST /admin/magic-links/:jti/revoke", () => {
  let revokeSpy: jest.SpiedFunction<PostgresMagicLinkStore["revokeJti"]>

  beforeEach(() => {
    revokeSpy = jest
      .spyOn(PostgresMagicLinkStore.prototype, "revokeJti")
      .mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("rejects invalid jti shape before DB mutation", async () => {
    const res = response()

    await POST(
      request({ jti: "not-a-uuid" }, "admin_1"),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ code: "INVALID_JTI" })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it("requires an authenticated admin actor", async () => {
    const res = response()

    await POST(request({ jti: VALID_JTI }), res as unknown as MedusaResponse)

    expect(res.statusCode).toBe(401)
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it("idempotently revokes a valid jti for the admin actor", async () => {
    const res = response()

    await POST(
      request({ jti: VALID_JTI }, "admin_1"),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(revokeSpy).toHaveBeenCalledWith({
      token_jti: VALID_JTI,
      reason: "admin_revoke",
      revoked_by: "admin_1",
    })
  })
})
