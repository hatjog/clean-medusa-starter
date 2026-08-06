/**
 * v1.15.0 Story 5.4 — the `/vendor/*` matcher, measured BY EXECUTION (AC3, AC4).
 *
 * "The matcher exists" is not a proof that "the matcher authenticates". The
 * dominant defect class in this repo is a mechanism that is alive in a file and
 * dead on the route, so every case here drives the REAL middleware
 * (`vendorHmacGateMiddleware`, the one `api/middlewares.ts` mounts) and asserts
 * on a HANDLER CALL COUNTER, not only on a status code.
 *
 * The route used for the negative control is a FIXTURE path — `/vendor/payouts`
 * exists in no route tree, no inventory and no exemption list. That is the
 * property being measured: a vendor route nobody registered anywhere is
 * authenticated ANYWAY. Before this story the same fixture was wide open.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"

import { buildVendorSignatureHeader } from "../../lib/vendor-hmac"
import {
  VENDOR_HMAC_EXEMPT_ROUTES,
  VENDOR_HMAC_MATCHER,
  isVendorHmacExempt,
  vendorHmacGateMiddleware,
  vendorRequestPath,
} from "../../lib/vendor-auth-matcher"
import { createReplayGuardTestDb } from "../helpers/replay-guard-test-db"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
} from "../../lib/vendor-secret/crypto-core"

const SELLER_ID = "seller-matcher-uuid"
const SECRET = "per-seller-secret-for-the-matcher-suite"

/** A path that appears in NO inventory and NO exemption list. */
const NEW_ROUTE = "/vendor/payouts"

let guardDb: ReturnType<typeof createReplayGuardTestDb>

function buildReq(path: string, headers: Record<string, string> = {}) {
  return {
    originalUrl: path,
    url: path,
    headers,
    body: undefined,
    scope: {
      resolve: (key: string) => {
        if (key === "__pg_connection__") return guardDb
        if (key === "logger") {
          return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        }
        if (key === "gp_core") {
          return { resolveVendorId: async (id: string) => `vendor-of-${id}` }
        }
        return null
      },
    },
  } as any
}

function buildRes() {
  const res: any = { statusCode: 200, body: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((payload: unknown) => {
    res.body = payload
    return res
  })
  return res
}

function signedHeader(sellerId = SELLER_ID, nonce?: string) {
  return buildVendorSignatureHeader(
    sellerId,
    Buffer.from(SECRET, "utf8"),
    Math.floor(Date.now() / 1000),
    nonce
  )
}

/** Runs the gate and reports whether the request reached the handler. */
async function throughGate(req: any) {
  const res = buildRes()
  const handler = jest.fn(async () => {
    res.status(200).json({ ok: true })
  })

  await vendorHmacGateMiddleware(req, res, (async () => {
    await handler()
  }) as any)

  return { res, handler }
}

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED

  // Story 5.4: unset, not empty. The whole suite runs without a shared secret.
  delete process.env.VENDOR_HMAC_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"

  guardDb = createReplayGuardTestDb()
  resetVendorSecretCryptoCore()
  configureVendorSecretCryptoCore({
    secretSetPath: "/test/vendor-auth-matcher.enc.json",
    decryptor: () =>
      JSON.stringify({
        version: 1,
        entries: [
          {
            seller_id: SELLER_ID,
            config_ref: `sops://test#${SELLER_ID}`,
            secret_b64: Buffer.from(SECRET, "utf8").toString("base64"),
          },
        ],
      }),
  })
})

afterEach(() => {
  resetVendorSecretCryptoCore()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("AC4 — a NEW /vendor/* route is unreachable without a signature", () => {
  it("no signature → 401 VENDOR_AUTH_SIGNATURE_MISSING and the handler is NEVER called", async () => {
    const { res, handler } = await throughGate(buildReq(NEW_ROUTE))

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_MISSING" })
    // The load-bearing assertion: refusal happens BEFORE the handler, so the
    // route body never observes the request at all.
    expect(handler).toHaveBeenCalledTimes(0)
  })

  it("valid signature → the handler runs and req.vendorAuth.seller_id is set", async () => {
    // A gate that only refuses is half a mechanism; this is the positive control.
    const req = buildReq(NEW_ROUTE, { "x-vendor-signature": signedHeader() })
    const { res, handler } = await throughGate(req)

    expect(res.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(req.vendorAuth?.seller_id).toBe(SELLER_ID)
    expect(req.vendorAuth?.vendor_id).toBe(`vendor-of-${SELLER_ID}`)
  })

  it("a nested path under the new route is covered too, not just its root", async () => {
    const { res, handler } = await throughGate(buildReq(`${NEW_ROUTE}/2026-08/export`))

    expect(res.statusCode).toBe(401)
    expect(handler).toHaveBeenCalledTimes(0)
  })

  it("refusal carries no new oracle: the body names a code and nothing else", async () => {
    // NFR-2 / 5.2 AC5 — loud on the server, silent to the caller. A body that
    // said "unknown seller" vs "bad signature" would be an enumeration oracle.
    const { res } = await throughGate(buildReq(NEW_ROUTE))

    expect(Object.keys(res.body as object).sort()).toEqual(["code", "message"])
    expect(JSON.stringify(res.body)).not.toContain(SELLER_ID)
  })
})

describe("AC3 — exempt routes are named, and they do not regress", () => {
  it("every exemption passes through the gate untouched", async () => {
    for (const exemption of VENDOR_HMAC_EXEMPT_ROUTES) {
      // `:param` is replaced by a concrete value — the exemption must hold for
      // the route SHAPE, not only for the literal string in the list.
      const path = exemption.matcher.replace(/:[^/]+/g, "some-value")
      const { res, handler } = await throughGate(buildReq(path))

      expect(handler).toHaveBeenCalledTimes(1)
      expect(res.statusCode).toBe(200)
    }
  })

  it("exemptions are matched on the FULL path, not on a prefix", async () => {
    // `/vendor/auth/sessions/steal` must not inherit the exemption of
    // `/vendor/auth/sessions`. Prefix matching is how exemption lists rot open.
    const { res, handler } = await throughGate(buildReq("/vendor/auth/sessions/steal"))

    expect(res.statusCode).toBe(401)
    expect(handler).toHaveBeenCalledTimes(0)
  })

  it("the exemption decision reads the ORIGINAL url, not a mounted-relative path", async () => {
    // Express strips the mount prefix from `req.path`; using it here would
    // silently mis-classify every exemption. This pins the field that is read.
    expect(vendorRequestPath({ originalUrl: "/vendor/auth/sessions?limit=10" } as any)).toBe(
      "/vendor/auth/sessions"
    )
    expect(isVendorHmacExempt("/vendor/auth/sessions")).toBe(true)
    expect(isVendorHmacExempt(NEW_ROUTE)).toBe(false)
  })

  it("the matcher constant still covers /vendor/*", () => {
    expect(VENDOR_HMAC_MATCHER).toBe("/vendor/*")
  })
})

describe("AC3 — ONE authentication point; the double path is a measured failure", () => {
  it("one pass through the gate authenticates; a SECOND pass on the same request is refused as a replay", async () => {
    // This is the regression detector for "matcher AND per-route HOF".
    // `resolveSellerFromRequest` claims the anti-replay key (Story 5.3), so two
    // entry points on one request claim the SAME key twice and every LEGAL
    // request would answer 401. Restoring the HOF makes this test fail on the
    // first assertion instead of failing in production on every request.
    const header = signedHeader(SELLER_ID, "double-path-nonce")

    const first = await throughGate(buildReq(NEW_ROUTE, { "x-vendor-signature": header }))
    expect(first.res.statusCode).toBe(200)
    expect(first.handler).toHaveBeenCalledTimes(1)

    const second = await throughGate(buildReq(NEW_ROUTE, { "x-vendor-signature": header }))
    expect(second.res.statusCode).toBe(401)
    expect(second.res.body).toMatchObject({ code: "VENDOR_AUTH_REPLAY_DETECTED" })
    expect(second.handler).toHaveBeenCalledTimes(0)
  })

  it("the deleted per-route HOF is not exported any more", async () => {
    // Structural companion to the execution test above: nothing can rebuild the
    // double path by importing the old symbol.
    const vendorAuth = await import("../../lib/vendor-auth.js")

    expect("withVendorAuth" in vendorAuth).toBe(false)
    expect(typeof vendorAuth.vendorAuthMiddleware).toBe("function")
  })
})
