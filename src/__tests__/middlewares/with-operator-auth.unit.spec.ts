/**
 * Unit tests for withOperatorAuth middleware (Story 8.1 — AC-4, AC-5, AC-6).
 *
 * Covers:
 *   - valid admin session (actor_type="user") → injects operatorAuth context
 *   - seller/vendor token (actor_type="seller") → 403
 *   - missing auth_context → 401
 */

import { withOperatorAuth, operatorAuthMiddleware } from "../../middlewares/with-operator-auth"

function createReq(authContext?: Record<string, unknown>) {
  return {
    auth_context: authContext,
    scope: {
      resolve: jest.fn().mockReturnValue(undefined),
    },
  } as any
}

function createRes() {
  return {
    body: null as any,
    statusCode: 0,
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

describe("withOperatorAuth HOF", () => {
  it("injects operatorAuth context for valid admin user (actor_type=user)", async () => {
    const handler = jest.fn()
    const wrapped = withOperatorAuth(handler)

    const req = createReq({ actor_id: "user_123", actor_type: "user" })
    const res = createRes()
    const next = jest.fn()

    await wrapped(req, res as any, next)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(req.operatorAuth).toEqual({
      actor_id: "user_123",
      actor_type: "user",
      auth_identity_id: undefined,
    })
    expect(res.statusCode).toBe(0) // not set = no error response
  })

  it("returns 403 when actor_type is seller (vendor token)", async () => {
    const handler = jest.fn()
    const wrapped = withOperatorAuth(handler)

    const req = createReq({ actor_id: "seller_abc", actor_type: "seller" })
    const res = createRes()
    const next = jest.fn()

    await wrapped(req, res as any, next)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ message: expect.stringContaining("Forbidden") })
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns 403 when actor_type is customer", async () => {
    const handler = jest.fn()
    const wrapped = withOperatorAuth(handler)

    const req = createReq({ actor_id: "cust_abc", actor_type: "customer" })
    const res = createRes()
    const next = jest.fn()

    await wrapped(req, res as any, next)

    expect(res.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns 401 when auth_context is missing", async () => {
    const handler = jest.fn()
    const wrapped = withOperatorAuth(handler)

    const req = createReq(undefined)
    const res = createRes()
    const next = jest.fn()

    await wrapped(req, res as any, next)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ message: expect.stringContaining("Unauthorized") })
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns 401 when auth_context has no actor_id", async () => {
    const handler = jest.fn()
    const wrapped = withOperatorAuth(handler)

    const req = createReq({ actor_type: "user" })
    const res = createRes()
    const next = jest.fn()

    await wrapped(req, res as any, next)

    expect(res.statusCode).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe("operatorAuthMiddleware (standalone)", () => {
  it("calls next() for valid admin user", async () => {
    const req = createReq({ actor_id: "user_123", actor_type: "user" })
    const res = createRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(next).toHaveBeenCalled()
    expect(req.operatorAuth).toBeDefined()
  })

  it("returns 403 for seller token (vendor access attempt)", async () => {
    const req = createReq({ actor_id: "seller_abc", actor_type: "seller" })
    const res = createRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it("returns 401 when no session", async () => {
    const req = createReq(undefined)
    const res = createRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})
