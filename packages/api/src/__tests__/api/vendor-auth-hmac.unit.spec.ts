/**
 * Story v160-cleanup-48 — cases 1-8 for the `/vendor/*` HMAC gate.
 *
 * These tests run a handler through the REAL gate middleware with a real signed
 * payload, exercising the full chain (signature verify → per-seller secret →
 * anti-replay claim → resolveVendorId → inject).
 *
 * == Why this file was renamed (v1.15.0 Story 5.4) ==
 * It used to be `vendor-auth-hmac.integration.spec.ts`, which matches NO
 * `testMatch` pattern in `jest.config.js`: `TEST_TYPE=unit` matches
 * `*.unit.spec.ts` and `TEST_TYPE=integration:http` matches
 * `integration-tests/http/*`. Story 5.2 measured this and wrote it down; nobody
 * moved the file, so the suite stayed unexecuted through cc-4 F-10 (v1.9.0),
 * Story 5.2 and Story 5.3. When Story 5.4 finally ran it, SEVEN of its eight
 * cases failed — case 6 still asserted that `VENDOR_HMAC_ENFORCED=false`
 * ACCEPTS a legacy `x-vendor-token`, a path deleted three releases earlier.
 *
 * That is the point of the rename: a suite nobody runs is not coverage, it is a
 * claim of coverage. The cases below are now corrected to the behaviour the
 * production chain actually has, and the file fires under `pnpm test:unit`.
 *
 * Environment: `VENDOR_HMAC_ENFORCED` is controlled via beforeEach/afterEach.
 * `VENDOR_HMAC_SECRET` is deliberately UNSET everywhere in this suite — Story
 * 5.4 removed it from the code, and its absence must not change any verdict.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"

import { buildVendorSignatureHeader } from "../../lib/vendor-hmac"
import type { VendorAuthContext } from "../../lib/vendor-auth"
import { withVendorGate } from "../helpers/vendor-auth-chain"
import { createReplayGuardTestDb } from "../helpers/replay-guard-test-db"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
} from "../../lib/vendor-secret/crypto-core"
import { NotImplementedError } from "../../modules/gp-core/service"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "integration-test-hmac-secret-abc"
const SELLER_ID = "seller-integration-test-uuid"
const VENDOR_ID = "vendor-resolved-uuid-xyz"

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function makeSignedHeader(
  sellerId = SELLER_ID,
  tsOffset = 0,
  nonce?: string
): string {
  return buildVendorSignatureHeader(
    sellerId,
    TEST_SECRET,
    nowSec() + tsOffset,
    nonce
  )
}

// v1.15.0 Story 5.3: the chain claims an anti-replay key and fails CLOSED
// without a barrier. Shared per test so case-5 can replay against itself.
let guardDb: ReturnType<typeof createReplayGuardTestDb>

function buildMockScope(opts?: {
  gpCoreResolveFn?: (id: string) => Promise<string>
  gpCoreAvailable?: boolean
}) {
  const resolveFn = opts?.gpCoreResolveFn ?? (() => Promise.resolve(VENDOR_ID))
  const gpCoreAvailable = opts?.gpCoreAvailable ?? true

  return {
    resolve: jest.fn((key: string) => {
      if (key === "__pg_connection__") {
        return guardDb
      }
      if (key === "logger") {
        return {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }
      }
      if (key === "gp_core" && gpCoreAvailable) {
        return {
          resolveVendorId: jest.fn<(id: string) => Promise<string>>().mockImplementation(resolveFn),
        }
      }
      return null
    }),
  }
}

function buildMockReq(
  headers: Record<string, string | undefined> = {},
  scopeOpts?: Parameters<typeof buildMockScope>[0]
) {
  return {
    headers,
    scope: buildMockScope(scopeOpts),
  } as any
}

function buildMockRes() {
  const res: any = { statusCode: 200, body: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((data: unknown) => {
    res.body = data
    return res
  })
  return res
}

// ---------------------------------------------------------------------------
// Setup / teardown: control env vars
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED
  savedEnv.VENDOR_HMAC_DRIFT_SECONDS = process.env.VENDOR_HMAC_DRIFT_SECONDS

  // Story 5.4 (AC1) — the shared secret is UNSET for the WHOLE suite. Every
  // green case below is therefore evidence that `/vendor/*` no longer depends
  // on it; before 5.4 this single line turned all of them into 503.
  delete process.env.VENDOR_HMAC_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"
  delete process.env.VENDOR_HMAC_DRIFT_SECONDS

  guardDb = createReplayGuardTestDb()
  // Story 5.2 — signing material comes from the seller's own entry, never from
  // the environment.
  resetVendorSecretCryptoCore()
  configureVendorSecretCryptoCore({
    secretSetPath: "/test/vendor-auth-hmac.enc.json",
    decryptor: () =>
      JSON.stringify({
        version: 1,
        entries: [
          {
            seller_id: SELLER_ID,
            config_ref: `sops://test#${SELLER_ID}`,
            secret_b64: Buffer.from(TEST_SECRET, "utf8").toString("base64"),
          },
        ],
      }),
  })
})

afterEach(() => {
  resetVendorSecretCryptoCore()
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = val
    }
  }
  jest.resetModules()
})

// ---------------------------------------------------------------------------
// Case 1: Valid signature → handler invoked, vendorAuth injected
// ---------------------------------------------------------------------------

describe("/vendor/* gate — HMAC enforced", () => {
  it("case-1: valid signature → handler invoked, req.vendorAuth populated", async () => {
    let capturedAuth: VendorAuthContext | undefined
    const handler = jest.fn(async (req: any) => {
      capturedAuth = req.vendorAuth
    })

    const wrapped = withVendorGate(handler as any)
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(handler).toHaveBeenCalled()
    expect(capturedAuth).toBeDefined()
    expect(capturedAuth?.seller_id).toBe(SELLER_ID)
    expect(capturedAuth?.vendor_id).toBe(VENDOR_ID)
    expect(res.statusCode).toBe(200)
  })

  // Case 2: Invalid signature → 401 VENDOR_AUTH_SIGNATURE_INVALID
  it("case-2: invalid signature → 401 VENDOR_AUTH_SIGNATURE_INVALID", async () => {
    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    // Build header with wrong secret
    const wrongHeader = buildVendorSignatureHeader(SELLER_ID, "wrong-secret")
    const req = buildMockReq({ "x-vendor-signature": wrongHeader })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_INVALID" })
    expect(handler).not.toHaveBeenCalled()
  })

  // Case 3: Expired timestamp (drift+1) → 401 VENDOR_AUTH_TIMESTAMP_EXPIRED
  it("case-3: expired timestamp → 401 VENDOR_AUTH_TIMESTAMP_EXPIRED", async () => {
    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    const expiredHeader = makeSignedHeader(SELLER_ID, -(300 + 1))
    const req = buildMockReq({ "x-vendor-signature": expiredHeader })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_TIMESTAMP_EXPIRED" })
    expect(handler).not.toHaveBeenCalled()
  })

  // Case 4: Missing signature header → 401 VENDOR_AUTH_SIGNATURE_MISSING
  it("case-4: missing signature header → 401 VENDOR_AUTH_SIGNATURE_MISSING", async () => {
    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    const req = buildMockReq({}) // no x-vendor-signature
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_MISSING" })
    expect(handler).not.toHaveBeenCalled()
  })

  // Case 5: Replay (same nonce twice) → first 200, second 401 VENDOR_AUTH_REPLAY_DETECTED
  it("case-5: replay (same nonce) → first pass, second 401 VENDOR_AUTH_REPLAY_DETECTED", async () => {
    // Fresh nonce, one barrier: the second call must hit the claim from the first.
    const uniqueNonce = "replay-integration-test-" + Date.now()
    const ts = nowSec()
    const header = buildVendorSignatureHeader(SELLER_ID, TEST_SECRET, ts, uniqueNonce)

    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    // First call
    const req1 = buildMockReq({ "x-vendor-signature": header })
    const res1 = buildMockRes()
    await wrapped(req1, res1, jest.fn())
    expect(res1.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)

    // Second call — replay
    handler.mockReset()
    const req2 = buildMockReq({ "x-vendor-signature": header })
    const res2 = buildMockRes()
    await wrapped(req2, res2, jest.fn())
    expect(res2.statusCode).toBe(401)
    expect(res2.body).toMatchObject({ code: "VENDOR_AUTH_REPLAY_DETECTED" })
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cases 6-7: VENDOR_HMAC_ENFORCED=false — fails CLOSED since cc-4 F-10 (v1.9.0)
// ---------------------------------------------------------------------------

describe("/vendor/* gate — enforcement flag turned off", () => {
  // Until Story 5.4 ran this file, case 6 asserted 200 + a "legacy-accept" warn
  // log: the shape of a path that accepted ANY string as `seller_id` with no
  // signature at all. That path was deleted in v1.9.0 (cc-4 F-10). The suite
  // kept asserting it for three releases because it never executed.
  it("case-6: flag off + legacy x-vendor-token → 503, handler never runs", async () => {
    process.env.VENDOR_HMAC_ENFORCED = "false"

    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    const req = buildMockReq({ "x-vendor-token": SELLER_ID })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_CONFIG_ERROR" })
    expect(handler).not.toHaveBeenCalled()
  })

  it("case-7: flag off + no headers at all → 503 (config error, not 401)", async () => {
    // The DISTINCTION is the point: a misconfigured deployment must be
    // distinguishable from an unauthenticated caller, or operators debug the
    // wrong thing.
    process.env.VENDOR_HMAC_ENFORCED = "false"

    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    const req = buildMockReq({})
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_CONFIG_ERROR" })
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Case 8: the shared secret is UNSET — and that is now a non-event (Story 5.4)
// ---------------------------------------------------------------------------

describe("/vendor/* gate — shared secret removed (Story 5.4, AC1)", () => {
  it("case-8: VENDOR_HMAC_SECRET completely unset + enforced=true → 200", async () => {
    // The INVERTED assertion of this story. Before 5.4 this case expected 503
    // VENDOR_AUTH_CONFIG_ERROR: an operator following the rotation runbook and
    // deleting the env var took `/vendor/*` down entirely, even though every
    // seller had a correctly provisioned secret of their own.
    //
    // `delete`, not `= ""` — "unset" and "set to empty" are different states and
    // only the first one is what a runbook actually produces.
    delete process.env.VENDOR_HMAC_SECRET
    process.env.VENDOR_HMAC_ENFORCED = "true"

    expect(process.env.VENDOR_HMAC_SECRET).toBeUndefined()

    let capturedAuth: VendorAuthContext | undefined
    const handler = jest.fn(async (req: any) => {
      capturedAuth = req.vendorAuth
    })
    const wrapped = withVendorGate(handler as any)

    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(200)
    expect(handler).toHaveBeenCalled()
    expect(capturedAuth?.seller_id).toBe(SELLER_ID)
  })

  it("case-9: an unprovisioned seller still gets 401, not a shared-secret pass", async () => {
    // Removing the shared secret must not blur the failure modes 5.2 separated:
    // "this seller has no secret" is 401, never 503 and never a silent success.
    const handler = jest.fn()
    const wrapped = withVendorGate(handler as any)

    const req = buildMockReq({
      "x-vendor-signature": makeSignedHeader("seller-never-provisioned"),
    })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_INVALID" })
    expect(handler).not.toHaveBeenCalled()
  })
})
