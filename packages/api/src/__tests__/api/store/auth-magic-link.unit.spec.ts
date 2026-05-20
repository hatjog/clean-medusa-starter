import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { POST as requestMagicLink } from "../../../api/store/auth/magic-link/route"
import { POST as verifyMagicLinkRoute } from "../../../api/store/auth/magic-link/verify/route"
import {
  configureMagicLinkRuntime,
  generateMagicLinkWithClaims,
  resetMagicLinkRuntime,
} from "../../../lib/auth/magic-link"
import { marketContextStorage } from "../../../lib/market-context"

const JWT_SECRET = "test-jwt-secret-for-recover-magic-link-123456789"
const NOW = new Date("2026-05-20T08:00:00.000Z")

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

function request(
  body: Record<string, unknown>,
  services: Record<string, unknown> = {}
): MedusaRequest {
  return {
    body,
    scope: {
      resolve: jest.fn().mockImplementation((key: string) => services[key]),
    },
  } as unknown as MedusaRequest
}

function customerService(customers: Array<Record<string, unknown>>) {
  return {
    listCustomers: jest.fn().mockResolvedValue(customers),
  }
}

function notificationService() {
  return {
    createNotifications: jest.fn().mockResolvedValue({ id: "notif_1" }),
  }
}

function configModule() {
  return {
    projectConfig: {
      http: {
        jwtSecret: JWT_SECRET,
        jwtExpiresIn: "7d",
        jwtOptions: {},
      },
    },
  }
}

function signedRecoverToken(
  subject: Record<string, string | number | boolean | null>,
  options: { jti?: string; now?: Date } = {}
): string {
  return generateMagicLinkWithClaims("recover", subject, {
    secret: JWT_SECRET,
    jti: options.jti ?? "jti-123",
    now: options.now ?? NOW,
  }).token
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
  process.env.STOREFRONT_URL = "https://storefront.example.test"
  configureMagicLinkRuntime({
    isJtiRevoked: async (jti) => jti === "revoked-jti",
    recordIssued: async () => undefined,
  })
})

afterEach(() => {
  resetMagicLinkRuntime()
  delete process.env.JWT_SECRET
  delete process.env.STOREFRONT_URL
})

async function withMarket(callback: () => Promise<void>) {
  await marketContextStorage.run(
    { market_id: "bonbeauty", sales_channel_id: "sc_bb" },
    callback
  )
}

describe("POST /store/auth/magic-link", () => {
  it("issues and emails recover links for an existing market-scoped customer", async () => {
    const customer = customerService([{ id: "cus_1", email: "bonbeauty::anna@example.test" }])
    const notifications = notificationService()
    const res = response()

    await withMarket(async () => {
      await requestMagicLink(
        request(
          { purpose: "recover", email: "anna@example.test", locale: "pl" },
          {
            [Modules.CUSTOMER]: customer,
            [Modules.NOTIFICATION]: notifications,
          }
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({ success: true })
    expect(customer.listCustomers).toHaveBeenCalledWith(
      { email: "bonbeauty::anna@example.test" },
      { take: 1 }
    )
    expect(notifications.createNotifications).toHaveBeenCalledTimes(1)
    const payload = notifications.createNotifications.mock.calls[0][0] as Record<string, any>
    expect(payload.to).toBe("anna@example.test")
    expect(payload.data.ttl_days).toBe(7)
    expect(payload.data.recover_url).toContain("/pl/user/recover/")
    expect(JSON.stringify(res.body)).not.toContain("recover_url")
  })

  it("returns the same success body when the email has no customer", async () => {
    const customer = customerService([])
    const notifications = notificationService()
    const res = response()

    await withMarket(async () => {
      await requestMagicLink(
        request(
          { purpose: "recover", email: "missing@example.test", locale: "pl" },
          {
            [Modules.CUSTOMER]: customer,
            [Modules.NOTIFICATION]: notifications,
          }
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({ success: true })
    expect(notifications.createNotifications).not.toHaveBeenCalled()
  })

  it("rejects malformed request payloads before token generation", async () => {
    const res = response()

    await withMarket(async () => {
      await requestMagicLink(
        request({ purpose: "recover", email: "not-email", locale: "pl" }),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      code: "INVALID_RECOVER_REQUEST",
      message: "Valid recover purpose and email are required",
    })
  })

  it("fails closed when market context is missing", async () => {
    const res = response()

    await requestMagicLink(
      request({ purpose: "recover", email: "anna@example.test", locale: "pl" }),
      res as unknown as MedusaResponse
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      code: "MARKET_CONTEXT_REQUIRED",
      message: "Market context required",
    })
  })

  it("keeps the user-facing response enumeration-safe when runtime is missing", async () => {
    resetMagicLinkRuntime()
    delete process.env.JWT_SECRET
    const customer = customerService([{ id: "cus_1", email: "bonbeauty::anna@example.test" }])
    const notifications = notificationService()
    const res = response()

    await withMarket(async () => {
      await requestMagicLink(
        request(
          { purpose: "recover", email: "anna@example.test", locale: "pl" },
          {
            [Modules.CUSTOMER]: customer,
            [Modules.NOTIFICATION]: notifications,
          }
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({ success: true })
    expect(notifications.createNotifications).not.toHaveBeenCalled()
  })
})

describe("POST /store/auth/magic-link/verify", () => {
  it("maps a valid recover token to a valid customer session without returning magic-link data", async () => {
    const token = signedRecoverToken({
      customer_id: "cus_1",
      market_id: "bonbeauty",
    })
    const res = response()

    await withMarket(async () => {
      await verifyMagicLinkRoute(
        request(
          { token },
          {
            [ContainerRegistrationKeys.CONFIG_MODULE]: configModule(),
          }
        ),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ valid: true, auth_token: expect.any(String) })
    expect(JSON.stringify(res.body)).not.toContain(token)
  })

  it("fails closed when a valid recover token cannot create a customer session", async () => {
    const token = signedRecoverToken({
      customer_id: "cus_1",
      market_id: "bonbeauty",
    })
    const res = response()

    await withMarket(async () => {
      await verifyMagicLinkRoute(
        request({ token }),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ valid: false, reason: "invalid" })
  })

  it.each([
    [
      "expired",
      signedRecoverToken(
        { customer_id: "cus_1", market_id: "bonbeauty" },
        { now: new Date("2000-01-01T00:00:00.000Z") }
      ),
      { valid: false, reason: "expired" },
    ],
    [
      "invalid",
      "not-a-jwt",
      { valid: false, reason: "invalid" },
    ],
    [
      "revoked",
      signedRecoverToken(
        { customer_id: "cus_1", market_id: "bonbeauty" },
        { jti: "revoked-jti" }
      ),
      { valid: false, reason: "revoked" },
    ],
  ] as const)("maps %s token verification result", async (_name, token, expected) => {
    const res = response()

    await withMarket(async () => {
      await verifyMagicLinkRoute(
        request({ token }),
        res as unknown as MedusaResponse
      )
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(expected)
  })

  it("maps non-recover purposes to invalid", async () => {
    const token = generateMagicLinkWithClaims(
      "purchase",
      { customer_id: "cus_1", market_id: "bonbeauty" },
      { secret: JWT_SECRET, now: NOW }
    ).token
    const res = response()

    await withMarket(async () => {
      await verifyMagicLinkRoute(
        request({ token }),
        res as unknown as MedusaResponse
      )
    })

    expect(res.body).toEqual({ valid: false, reason: "invalid" })
  })

  it("fails closed when runtime bindings are missing", async () => {
    resetMagicLinkRuntime()
    const token = signedRecoverToken({
      customer_id: "cus_1",
      market_id: "bonbeauty",
    })
    const res = response()

    await withMarket(async () => {
      await verifyMagicLinkRoute(
        request({ token }),
        res as unknown as MedusaResponse
      )
    })

    expect(res.body).toEqual({ valid: false, reason: "invalid" })
  })
})
