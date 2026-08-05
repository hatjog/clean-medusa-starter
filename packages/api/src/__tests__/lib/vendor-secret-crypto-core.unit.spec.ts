/**
 * v1.15.0 Story 5.2 — backend crypto-core (ADR-181, ADR-156 §1/§4/§6a).
 *
 * Covers the resolver itself: `config_ref` → value, decrypt-on-boot (exactly one
 * decrypt per process), the fault taxonomy that separates 503 from 401, and the
 * hard rule that no secret material ever reaches an error message.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals"

import {
  VendorSecretCryptoCore,
  CryptoCoreFault,
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
  getVendorSecretCryptoCore,
  vendorSecretCryptoCoreHealth,
  VENDOR_SECRET_SET_PATH_ENV,
} from "../../lib/vendor-secret/crypto-core"

const REF_A = "sops://infra/gp-dev/secrets/vendor-hmac.enc.yaml#seller-A"
const SECRET_A = "per-vendor-secret-for-A-0123456789"

const SECRET_SET = JSON.stringify({
  version: 1,
  entries: [
    {
      seller_id: "seller-A",
      config_ref: REF_A,
      secret_b64: Buffer.from(SECRET_A, "utf8").toString("base64"),
    },
  ],
})

describe("VendorSecretCryptoCore", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    resetVendorSecretCryptoCore()
  })

  afterEach(() => {
    resetVendorSecretCryptoCore()
    process.env = { ...envBackup }
  })

  it("resolves seller → config_ref → secret material", () => {
    const core = VendorSecretCryptoCore.load({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => SECRET_SET,
    })

    expect(core.configRefForSeller("seller-A")).toBe(REF_A)
    expect(core.resolveByConfigRef(REF_A)?.toString("utf8")).toBe(SECRET_A)
    expect(core.resolveForSeller("seller-A")?.toString("utf8")).toBe(SECRET_A)
    expect(core.provisionedCount).toBe(1)
  })

  it("returns null (NOT a shared value) for an unprovisioned seller", () => {
    process.env.VENDOR_HMAC_SECRET = "shared-legacy-vendor-hmac-secret"
    const core = VendorSecretCryptoCore.load({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => SECRET_SET,
    })

    expect(core.resolveForSeller("seller-nobody")).toBeNull()
  })

  it("decrypts ONCE per process, not per resolution (ADR-156 §4)", () => {
    let decryptCalls = 0
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => {
        decryptCalls += 1
        return SECRET_SET
      },
    })

    for (let i = 0; i < 5; i++) {
      const r = getVendorSecretCryptoCore()
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.core.resolveForSeller("seller-A")).not.toBeNull()
    }

    expect(decryptCalls).toBe(1)
  })

  it("classifies faults: unset path, failed decrypt, malformed set", () => {
    delete process.env[VENDOR_SECRET_SET_PATH_ENV]
    expect(() => VendorSecretCryptoCore.load({ decryptor: () => SECRET_SET })).toThrow(
      CryptoCoreFault
    )

    const unset = (() => {
      try {
        VendorSecretCryptoCore.load({ decryptor: () => SECRET_SET })
      } catch (e) {
        return e as CryptoCoreFault
      }
    })()
    expect(unset?.reason).toBe("secret-set-path-unset")

    const failed = (() => {
      try {
        VendorSecretCryptoCore.load({
          secretSetPath: "/test/set.enc.json",
          decryptor: () => {
            throw new Error("age: no identity matched any of the recipients")
          },
        })
      } catch (e) {
        return e as CryptoCoreFault
      }
    })()
    expect(failed?.reason).toBe("decrypt-failed")

    const malformed = (() => {
      try {
        VendorSecretCryptoCore.load({
          secretSetPath: "/test/set.enc.json",
          decryptor: () => '{"entries":[{"seller_id":"x"}]}',
        })
      } catch (e) {
        return e as CryptoCoreFault
      }
    })()
    expect(malformed?.reason).toBe("secret-set-malformed")
  })

  it("a store fault never carries secret material or decryptor output", () => {
    const leaky = `PLAINTEXT-${SECRET_A}`
    const fault = (() => {
      try {
        VendorSecretCryptoCore.load({
          secretSetPath: "/test/set.enc.json",
          decryptor: () => {
            throw new Error(leaky)
          },
        })
      } catch (e) {
        return e as CryptoCoreFault
      }
    })()

    expect(fault).toBeInstanceOf(CryptoCoreFault)
    const surface = `${fault?.message}${fault?.stack ?? ""}`
    expect(surface).not.toContain(SECRET_A)
    expect(surface).not.toContain(leaky)
  })

  it("health is a distinguishable boot-level verdict (ADR-156 §6a)", () => {
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => SECRET_SET,
    })
    expect(vendorSecretCryptoCoreHealth()).toEqual({ healthy: true })

    resetVendorSecretCryptoCore()
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => {
        throw new CryptoCoreFault("decrypt-failed")
      },
    })
    expect(vendorSecretCryptoCoreHealth()).toEqual({
      healthy: false,
      reason: "decrypt-failed",
    })
  })

  it("contains no reference to the shared VENDOR_HMAC_SECRET (AD-20, checked in-source)", () => {
    // Static control kept next to the behavioural ones: a fallback branch would
    // have to name the env var somewhere in this module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const src = fs.readFileSync(
      path.join(__dirname, "../../lib/vendor-secret/crypto-core.ts"),
      "utf8"
    )
    // The only permitted mention is inside the "never reads a shared secret"
    // doc-block; assert there is no `process.env.VENDOR_HMAC_SECRET` read.
    expect(src).not.toContain("process.env.VENDOR_HMAC_SECRET")
    expect(src).not.toContain('process.env["VENDOR_HMAC_SECRET"]')
  })
})
