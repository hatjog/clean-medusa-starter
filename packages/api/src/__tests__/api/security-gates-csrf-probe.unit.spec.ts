import { afterEach, describe, expect, it } from "@jest/globals"

import { POST } from "../../api/security-gates/csrf-probe/route"
import { deriveCsrfProbeToken } from "../../lib/security-gate-csrf-probe"

function createResponse() {
  return {
    body: null as unknown,
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value
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

describe("security-gates csrf probe route", () => {
  afterEach(() => {
    delete process.env.GP_SEC_GATE_CSRF_ALLOWED_ORIGIN
    delete process.env.GP_SEC_GATE_CSRF_PROBE_TOKEN
    delete process.env.GP_SEC_GATE_CSRF_PROBE_SECRET
    delete process.env.STOREFRONT_URL
    delete process.env.JWT_SECRET
    delete process.env.COOKIE_SECRET
  })

  it("rejects mismatched origin before token validation", async () => {
    process.env.STOREFRONT_URL = "http://localhost:3002"
    process.env.JWT_SECRET = "supersecret"

    const res = createResponse()
    await POST(
      {
        headers: {
          origin: "https://attacker.example.invalid",
        },
      } as never,
      res as never,
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ error: "origin_mismatch" })
  })

  it("accepts same-origin requests with the derived probe token", async () => {
    process.env.STOREFRONT_URL = "http://localhost:3002"
    process.env.JWT_SECRET = "supersecret"
    const token = deriveCsrfProbeToken()

    const first = createResponse()
    await POST(
      {
        headers: {
          origin: "http://localhost:3002",
          "x-csrf-token": token,
        },
      } as never,
      first as never,
    )

    const second = createResponse()
    await POST(
      {
        headers: {
          origin: "http://localhost:3002",
          "x-csrf-token": token,
        },
      } as never,
      second as never,
    )

    expect(first.statusCode).toBe(200)
    expect(first.body).toMatchObject({ ok: true, accepted_probe_runs: 1 })
    expect(second.body).toMatchObject({ ok: true, accepted_probe_runs: 2 })
  })
})