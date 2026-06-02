import { describe, expect, it, jest } from "@jest/globals"

import { GET } from "../../../api/v1/voucher-appointment-ics/[token]/route"
import {
  buildSignedToken,
  getHmacSecret,
} from "../../../modules/voucher-delivery/storage/hmac"

function buildResponse() {
  const res = {
    setHeader: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
  }
  res.status.mockReturnValue(res)
  return res
}

describe("GET /api/v1/voucher-appointment-ics/:token", () => {
  it("serves stored .ics artifact for a valid scoped token", async () => {
    const storageKey = "voucher-appointment-ics/entinst_apt_001/appt_001.ics"
    const token = buildSignedToken(
      storageKey,
      Date.now() + 60_000,
      getHmacSecret(),
    )
    const retrieve = jest.fn(async () => ({
      pdf_buffer: Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "utf8"),
      metadata: {
        delivery_id: "appointment:entinst_apt_001",
        recipient_token: "appointment:entinst_apt_001",
        generated_at: "2026-06-02T08:00:00.000Z",
        vendor_handles: ["salon-alfa"],
      },
    }))
    const req = {
      params: { token },
      scope: {
        resolve: jest.fn(() => ({ retrieve })),
      },
    }
    const res = buildResponse()

    await GET(req as any, res as any)

    expect(retrieve).toHaveBeenCalledWith(storageKey)
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/calendar; charset=utf-8",
    )
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="appt_001.ics"',
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith(
      Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "utf8"),
    )
  })

  it("rejects token outside appointment .ics scope without resolving storage", async () => {
    const token = buildSignedToken(
      "voucher-pdf/entinst_apt_001/file.pdf",
      Date.now() + 60_000,
      getHmacSecret(),
    )
    const resolve = jest.fn()
    const req = {
      params: { token },
      scope: { resolve },
    }
    const res = buildResponse()

    await GET(req as any, res as any)

    expect(resolve).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({
      type: "not_found",
      message: "Calendar file not found.",
    })
  })

  // L-3: negative-path coverage for the public download route
  it("returns 404 for an expired token (expires_at in the past)", async () => {
    const storageKey = "voucher-appointment-ics/entinst_apt_001/appt_001.ics"
    const token = buildSignedToken(
      storageKey,
      Date.now() - 1_000, // already expired
      getHmacSecret(),
    )
    const resolve = jest.fn()
    const req = {
      params: { token },
      scope: { resolve },
    }
    const res = buildResponse()

    await GET(req as any, res as any)

    expect(resolve).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({
      type: "not_found",
      message: "Calendar file not found.",
    })
  })

  it("returns 404 for a token with a tampered signature", async () => {
    const storageKey = "voucher-appointment-ics/entinst_apt_001/appt_001.ics"
    const validToken = buildSignedToken(
      storageKey,
      Date.now() + 60_000,
      getHmacSecret(),
    )
    // Replace last 4 chars of the signature with "XXXX" to tamper it
    const tamperedToken = validToken.slice(0, -4) + "XXXX"
    const resolve = jest.fn()
    const req = {
      params: { token: tamperedToken },
      scope: { resolve },
    }
    const res = buildResponse()

    await GET(req as any, res as any)

    expect(resolve).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({
      type: "not_found",
      message: "Calendar file not found.",
    })
  })

  it("returns 503 when storage is unavailable (resolve throws)", async () => {
    const storageKey = "voucher-appointment-ics/entinst_apt_001/appt_001.ics"
    const token = buildSignedToken(
      storageKey,
      Date.now() + 60_000,
      getHmacSecret(),
    )
    const req = {
      params: { token },
      scope: {
        resolve: jest.fn(() => {
          throw new Error("storage not registered")
        }),
      },
    }
    const res = buildResponse()

    await GET(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({
      type: "service_unavailable",
      message: "Calendar storage unavailable.",
    })
  })

  it("returns 404 when artifact is missing from storage (retrieve returns null)", async () => {
    const storageKey = "voucher-appointment-ics/entinst_apt_001/appt_001.ics"
    const token = buildSignedToken(
      storageKey,
      Date.now() + 60_000,
      getHmacSecret(),
    )
    const retrieve = jest.fn(async () => null)
    const req = {
      params: { token },
      scope: {
        resolve: jest.fn(() => ({ retrieve })),
      },
    }
    const res = buildResponse()

    await GET(req as any, res as any)

    expect(retrieve).toHaveBeenCalledWith(storageKey)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({
      type: "not_found",
      message: "Calendar file not found.",
    })
  })
})
