/**
 * v1.15.0 Story 5.2 — per-vendor HMAC secret resolution ON THE REQUEST ROUTE.
 *
 * Every case here runs through `withVendorAuth`, NOT through a direct call to
 * `verifyVendorSignature`: a proof from a pure function is not a proof about the
 * route (NFR-1). AC1/AC2/AC3/AC5.
 *
 * NOTE ON THE FILE NAME (measured, not assumed): the pre-existing
 * `__tests__/api/vendor-auth-hmac.integration.spec.ts` matches NO `testMatch`
 * pattern in `jest.config.js` — `TEST_TYPE=unit` matches `*.unit.spec.ts` and
 * `TEST_TYPE=integration:http` matches `integration-tests/http/*`. That file has
 * therefore never run. This suite is named `*.unit.spec.ts` so it actually fires
 * under `pnpm test:unit`.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"

import { buildVendorSignatureHeader } from "../../lib/vendor-hmac"
import { withVendorAuth } from "../../lib/vendor-auth"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
  VENDOR_AUTH_SECRET_STORE_UNAVAILABLE,
  VENDOR_AUTH_SECRET_NOT_PROVISIONED,
  CryptoCoreFault,
} from "../../lib/vendor-secret/crypto-core"

const SELLER_A = "seller-A-uuid"
const SELLER_B = "seller-B-uuid"
const SELLER_UNPROVISIONED = "seller-C-no-secret"

// Test-only material. Never a real secret; never asserted by value in output.
const SECRET_A = "per-vendor-secret-for-A-0123456789"
const SECRET_B = "per-vendor-secret-for-B-9876543210"
const SHARED_SECRET = "shared-legacy-vendor-hmac-secret"

const SECRET_SET = JSON.stringify({
  version: 1,
  entries: [
    {
      seller_id: SELLER_A,
      config_ref: "sops://infra/gp-dev/secrets/vendor-hmac.enc.yaml#seller-A",
      secret_b64: Buffer.from(SECRET_A, "utf8").toString("base64"),
    },
    {
      seller_id: SELLER_B,
      config_ref: "sops://infra/gp-dev/secrets/vendor-hmac.enc.yaml#seller-B",
      secret_b64: Buffer.from(SECRET_B, "utf8").toString("base64"),
    },
  ],
})

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

type Logged = { level: string; message: string }

function buildMockReq(headers: Record<string, string | undefined>, logged: Logged[]) {
  return {
    headers,
    scope: {
      resolve: (key: string) => {
        if (key === "logger") {
          return {
            info: (m: string) => logged.push({ level: "info", message: m }),
            warn: (m: string) => logged.push({ level: "warn", message: m }),
            error: (m: string) => logged.push({ level: "error", message: m }),
          }
        }
        if (key === "gp_core") {
          return { resolveVendorId: (id: string) => Promise.resolve(`vendor-of-${id}`) }
        }
        return null
      },
    },
  } as any
}

function buildMockRes() {
  const captured: { status: number | null; body: any } = { status: null, body: null }
  const res: any = {
    status: (code: number) => {
      captured.status = code
      return res
    },
    json: (payload: any) => {
      captured.body = payload
      return res
    },
  }
  return { res, captured }
}

/** Runs a signed request through the real HOF and reports what the route did. */
async function callRoute(header: string | undefined) {
  const logged: Logged[] = []
  const { res, captured } = buildMockRes()
  const seen: { sellerId?: string } = {}

  const handler = jest.fn(async (req: any) => {
    seen.sellerId = req.vendorAuth?.seller_id
    res.status(200).json({ ok: true })
  })

  const wrapped = withVendorAuth(handler as any)
  await wrapped(
    buildMockReq(header === undefined ? {} : { "x-vendor-signature": header }, logged),
    res,
    (() => {}) as any
  )

  return { status: captured.status, body: captured.body, logged, seen, handler }
}

describe("Story 5.2 — per-vendor secret resolution through withVendorAuth", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    // AC1 anti-fallback control: the SHARED secret is present AND valid in the
    // environment for every case below. If any fallback branch survived, case
    // (3) and (4) would answer 200 instead of 401.
    process.env.VENDOR_HMAC_SECRET = SHARED_SECRET
    process.env.VENDOR_HMAC_ENFORCED = "true"
    process.env.VENDOR_HMAC_DRIFT_SECONDS = "300"
    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/vendor-secret-set.enc.json",
      decryptor: () => SECRET_SET,
    })
  })

  afterEach(() => {
    resetVendorSecretCryptoCore()
    process.env = { ...envBackup }
  })

  it("(1) positive control: seller A signing with A's secret is authenticated as A", async () => {
    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())
    const r = await callRoute(header)

    expect(r.status).toBe(200)
    expect(r.seen.sellerId).toBe(SELLER_A)
    expect(r.handler).toHaveBeenCalled()
  })

  it("(2) seller A's secret signing as seller B → 401 (AD-20: nobody signs as somebody else)", async () => {
    // Header carries sellerId=B, material is A's — the classic impersonation.
    const header = buildVendorSignatureHeader(SELLER_B, SECRET_A, nowSec())
    const r = await callRoute(header)

    expect(r.status).toBe(401)
    expect(r.handler).not.toHaveBeenCalled()
  })

  it("(3) seller with NO per-vendor secret → 401 even though a valid shared secret is set (no fallback)", async () => {
    expect(process.env.VENDOR_HMAC_SECRET).toBe(SHARED_SECRET)

    const header = buildVendorSignatureHeader(SELLER_UNPROVISIONED, SHARED_SECRET, nowSec())
    const r = await callRoute(header)

    expect(r.status).toBe(401)
    expect(r.handler).not.toHaveBeenCalled()
    // The discriminator AC1 asks for lives in the log, not in the body.
    expect(
      r.logged.some((l) => l.message.includes(VENDOR_AUTH_SECRET_NOT_PROVISIONED))
    ).toBe(true)
  })

  it("(4) shared secret used for a seller that HAS a per-vendor secret → 401", async () => {
    const header = buildVendorSignatureHeader(SELLER_A, SHARED_SECRET, nowSec())
    const r = await callRoute(header)

    expect(r.status).toBe(401)
    expect(r.handler).not.toHaveBeenCalled()
  })

  it("(5) crypto-core unavailable → 503 with a store code, distinguishable from case (3)", async () => {
    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/vendor-secret-set.enc.json",
      decryptor: () => {
        throw new CryptoCoreFault("decrypt-failed")
      },
    })

    const header = buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec())
    const r = await callRoute(header)

    expect(r.status).toBe(503)
    expect(r.body.code).toBe(VENDOR_AUTH_SECRET_STORE_UNAVAILABLE)
    expect(r.handler).not.toHaveBeenCalled()
  })

  it("AC5 non-disclosure: 'not your secret' and 'unknown seller' bodies are byte-identical", async () => {
    const notMine = await callRoute(
      buildVendorSignatureHeader(SELLER_B, SECRET_A, nowSec())
    )
    const unknown = await callRoute(
      buildVendorSignatureHeader(SELLER_UNPROVISIONED, SHARED_SECRET, nowSec())
    )

    expect(notMine.status).toBe(unknown.status)
    expect(JSON.stringify(notMine.body)).toBe(JSON.stringify(unknown.body))
  })

  it("no secret material leaks into any log line or response body", async () => {
    const cases = [
      buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec()),
      buildVendorSignatureHeader(SELLER_B, SECRET_A, nowSec()),
      buildVendorSignatureHeader(SELLER_UNPROVISIONED, SHARED_SECRET, nowSec()),
    ]

    for (const header of cases) {
      const r = await callRoute(header)
      const surface = r.logged.map((l) => l.message).join("\n") + JSON.stringify(r.body)
      for (const material of [SECRET_A, SECRET_B, SHARED_SECRET]) {
        expect(surface).not.toContain(material)
        // Not even a prefix long enough to be useful.
        expect(surface).not.toContain(material.slice(0, 12))
        expect(surface).not.toContain(
          Buffer.from(material, "utf8").toString("base64").slice(0, 12)
        )
      }
    }
  })

  it("AC2 shape regression on the route: 3-part and 5-part headers still fail as signature-invalid, not as a resolver error", async () => {
    const three = await callRoute("only:three:parts")
    expect(three.status).toBe(401)
    expect(three.body.code).toBe("VENDOR_AUTH_SIGNATURE_INVALID")

    const five = await callRoute(`${SELLER_A}:${nowSec()}:nonce:sig:extra`)
    expect(five.status).toBe(401)
    expect(five.body.code).toBe("VENDOR_AUTH_SIGNATURE_INVALID")
  })

  it("review-fix L-3: an unsigned request gets 401 (not 503) even when the secret store is broken", async () => {
    // The state of the secret store must not be readable by an unauthenticated
    // caller: no signature header ⇒ VENDOR_AUTH_SIGNATURE_MISSING, decided
    // BEFORE the crypto-core health check.
    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/vendor-secret-set.enc.json",
      decryptor: () => {
        throw new CryptoCoreFault("decrypt-failed")
      },
    })

    const r = await callRoute(undefined)

    expect(r.status).toBe(401)
    expect(r.body.code).toBe("VENDOR_AUTH_SIGNATURE_MISSING")
    expect(JSON.stringify(r.body)).not.toContain(VENDOR_AUTH_SECRET_STORE_UNAVAILABLE)

    // ...and a SIGNED request in the same state still gets the distinguishable
    // 503 (AC3 is untouched by the reordering).
    const signed = await callRoute(buildVendorSignatureHeader(SELLER_A, SECRET_A, nowSec()))
    expect(signed.status).toBe(503)
    expect(signed.body.code).toBe(VENDOR_AUTH_SECRET_STORE_UNAVAILABLE)
  })

  it("AC2 step order: an expired timestamp is rejected BEFORE secret resolution, for a seller that has no secret", async () => {
    const header = buildVendorSignatureHeader(
      SELLER_UNPROVISIONED,
      SHARED_SECRET,
      nowSec() - 10_000
    )
    const r = await callRoute(header)

    expect(r.status).toBe(401)
    expect(r.body.code).toBe("VENDOR_AUTH_TIMESTAMP_EXPIRED")
  })
})
