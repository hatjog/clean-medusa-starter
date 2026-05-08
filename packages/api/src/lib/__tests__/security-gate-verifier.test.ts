import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, jest } from "@jest/globals"

const ORIGINAL_FETCH = global.fetch

describe("security-gate-verifier", () => {
  afterEach(() => {
    delete process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER
    delete process.env.RECAPTCHA_SECRET_KEY
    delete process.env.HCAPTCHA_SECRET
    delete process.env.GP_SEC_GATE_CAPTCHA_FIXTURE_PATH
    delete process.env.GP_SEC_GATE_CSRF_PROBE_URL
    delete process.env.GP_SEC_GATE_CSRF_ALLOWED_ORIGIN
    delete process.env.GP_SEC_GATE_CSRF_PROBE_TOKEN
    delete process.env.GP_SEC_GATE_CSRF_PROBE_SECRET
    delete process.env.STOREFRONT_URL
    delete process.env.PORT
    delete process.env.JWT_SECRET
    delete process.env.COOKIE_SECRET
    delete process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH
    delete process.env.GP_CONFIG_VERIFY_PUBKEY
    delete process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH
    global.fetch = ORIGINAL_FETCH
    jest.resetModules()
  })

  it("verifies real token-bucket refusal behavior for the rate-limiting gate", async () => {
    const { verifyGate } = await import("../security-gate-verifier.js")
    const result = await verifyGate("rate_limiting")

    expect(result).toMatchObject({
      gate: "rate_limiting",
      status: "pass",
    })
    expect(result.detail).toContain("6th blocked")
  })

  it("treats missing live probe env for captcha/csrf/signing as skip and overall fail", async () => {
    const { verifyAllGates } = await import("../security-gate-verifier.js")
    const result = await verifyAllGates()

    expect(result.overall).toBe("fail")
    expect(result.gates.find((gate) => gate.gate === "rate_limiting")).toMatchObject({
      status: "pass",
    })
    expect(result.gates.find((gate) => gate.gate === "captcha")).toMatchObject({
      status: "skip",
    })
    expect(result.gates.find((gate) => gate.gate === "csrf")).toMatchObject({
      status: "skip",
    })
    expect(result.gates.find((gate) => gate.gate === "gp_config_signing")).toMatchObject({
      status: "skip",
    })
  })

  it("supports fixture-driven CAPTCHA probes with negative and positive expectations", async () => {
    const fixturePath = path.join(
      os.tmpdir(),
      `gp-captcha-fixture-${Date.now()}.json`,
    )

    await fs.writeFile(
      fixturePath,
      JSON.stringify({
        negative: {
          url: "https://staging.example.invalid/store/recipient-claim/init",
          method: "POST",
          body: { email: "probe@example.com" },
        },
        positive: {
          url: "https://staging.example.invalid/store/recipient-claim/init",
          method: "POST",
          headers: { "x-captcha-token": "stub-ok" },
          body: { email: "probe@example.com", captcha_token: "stub-ok" },
        },
      }),
      "utf8",
    )

    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({ status: 403 } as Response)
      .mockResolvedValueOnce({ status: 200 } as Response)

    process.env.GP_SEC_GATE_CAPTCHA_FIXTURE_PATH = fixturePath

    const { verifyGate } = await import("../security-gate-verifier.js")
    const result = await verifyGate("captcha")

    expect(result).toMatchObject({
      gate: "captcha",
      status: "pass",
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it("supports fixture-driven CSRF probes with negative and positive expectations", async () => {
    const fixturePath = path.join(os.tmpdir(), `gp-csrf-fixture-${Date.now()}.json`)

    await fs.writeFile(
      fixturePath,
      JSON.stringify({
        negative: {
          url: "https://staging.example.invalid/admin/orders",
          method: "POST",
          headers: { Origin: "https://attacker.example.invalid" },
          body: {},
        },
        positive: {
          url: "https://staging.example.invalid/admin/orders",
          method: "POST",
          headers: {
            Origin: "https://admin.example.invalid",
            "x-csrf-token": "csrf-ok",
          },
          body: {},
        },
      }),
      "utf8",
    )

    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({ status: 403 } as Response)
      .mockResolvedValueOnce({ status: 302 } as Response)

    process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH = fixturePath

    const { verifyGate } = await import("../security-gate-verifier.js")
    const result = await verifyGate("csrf")

    expect(result).toMatchObject({
      gate: "csrf",
      status: "pass",
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it("supports live CSRF probes with derived defaults", async () => {
    process.env.PORT = "9002"
    process.env.STOREFRONT_URL = "http://localhost:3002"
    process.env.JWT_SECRET = "supersecret"

    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({ status: 403 } as Response)
      .mockResolvedValueOnce({ status: 200 } as Response)

    const { verifyGate } = await import("../security-gate-verifier.js")
    const result = await verifyGate("csrf")

    expect(result).toMatchObject({
      gate: "csrf",
      status: "pass",
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:9002/security-gates/csrf-probe",
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "http://localhost:3002",
          "x-csrf-token": expect.any(String),
        }),
      }),
    )
  })

  it("verifies gp-config signing fixtures with raw base64 Ed25519 public key material", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    const canonical = Buffer.from(JSON.stringify({ market: "staging", version: "fixture" }))
    const signature = crypto.sign(null, canonical, privateKey)
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer
    const rawPublicKey = publicKeyDer.subarray(publicKeyDer.length - 32)
    const fixturePath = path.join(
      os.tmpdir(),
      `gp-signing-fixture-${Date.now()}.json`,
    )

    await fs.writeFile(
      fixturePath,
      JSON.stringify({
        canonical_bytes_base64: canonical.toString("base64"),
        signature_base64: signature.toString("base64"),
      }),
      "utf8",
    )

    process.env.GP_CONFIG_VERIFY_PUBKEY = rawPublicKey.toString("base64")
    process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH = fixturePath

    const { verifyGate } = await import("../security-gate-verifier.js")
    const result = await verifyGate("gp_config_signing")

    expect(result).toMatchObject({
      gate: "gp_config_signing",
      status: "pass",
    })
  })
})