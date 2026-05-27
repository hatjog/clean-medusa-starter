import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { POST } from "../../../api/store/account/magic-links/revoke-all/route"
import { PostgresMagicLinkStore } from "../../../lib/auth/magic-link-revocation"
import { marketContextStorage } from "../../../lib/market-context"

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

function request(actorId?: string, email?: string | null): MedusaRequest {
  return {
    auth_context: actorId ? { actor_id: actorId } : undefined,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "customer") {
          return {
            retrieveCustomer: jest.fn().mockResolvedValue({ email }),
          }
        }

        return {}
      }),
    },
  } as unknown as MedusaRequest
}

function requestWithCustomerLookupFailure(actorId: string): MedusaRequest {
  return {
    auth_context: { actor_id: actorId },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "customer") {
          return {
            retrieveCustomer: jest.fn().mockRejectedValue(new Error("db down")),
          }
        }

        return {}
      }),
    },
  } as unknown as MedusaRequest
}

describe("POST /store/account/magic-links/revoke-all", () => {
  let revokeSpy: jest.SpiedFunction<PostgresMagicLinkStore["revokePendingForCustomer"]>

  beforeEach(() => {
    revokeSpy = jest
      .spyOn(PostgresMagicLinkStore.prototype, "revokePendingForCustomer")
      .mockResolvedValue({ revoked_count: 0 })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("requires an authenticated customer", async () => {
    const res = response()

    await POST(request(), res as unknown as MedusaResponse)

    expect(res.statusCode).toBe(401)
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it("revokes pending links for the current customer and market", async () => {
    const res = response()

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await POST(
          request("cus_1", "Customer@Example.test"),
          res as unknown as MedusaResponse
        )
      }
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(revokeSpy).toHaveBeenCalledWith({
      customer_id: "cus_1",
      customer_email: "customer@example.test",
      market_id: "bonbeauty",
      reason: "user_revoke",
      revoked_by: "cus_1",
      actor_type: "customer",
    })
  })

  it("returns the same success body for repeated idempotent calls", async () => {
    const first = response()
    const second = response()

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await POST(
          request("cus_1", "customer@example.test"),
          first as unknown as MedusaResponse
        )
        await POST(
          request("cus_1", "customer@example.test"),
          second as unknown as MedusaResponse
        )
      }
    )

    expect(first.body).toEqual({ success: true })
    expect(second.body).toEqual({ success: true })
  })

  it("fails closed when customer email is not available", async () => {
    const res = response()

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await POST(request("cus_1", null), res as unknown as MedusaResponse)
      }
    )

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      code: "CUSTOMER_EMAIL_REQUIRED",
      message: "Customer email is required to revoke all magic links",
    })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it("fails closed when customer lookup is unavailable", async () => {
    const res = response()

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
      async () => {
        await POST(
          requestWithCustomerLookupFailure("cus_1"),
          res as unknown as MedusaResponse
        )
      }
    )

    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({
      code: "CUSTOMER_LOOKUP_UNAVAILABLE",
      message: "Customer lookup unavailable",
    })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it("fails closed when market context is missing", async () => {
    const res = response()

    await POST(request("cus_1"), res as unknown as MedusaResponse)

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      code: "MARKET_CONTEXT_REQUIRED",
      message: "Market context required",
    })
    expect(revokeSpy).not.toHaveBeenCalled()
  })
})
