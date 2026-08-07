/**
 * v1.15.0 Story 5.2 review-fix H-2 — decrypt-on-boot is on the BOOT path.
 *
 * Before this loader the crypto-core was decrypted on the first vendor request,
 * so `vendorSecretCryptoCoreHealth()` had zero production callers and an
 * operator got no startup signal. The invariants asserted here are the ones the
 * finding was about:
 *   1. the loader file is discoverable by Medusa's loader convention (a default
 *      exported function in `src/loaders/`) — "registered", not merely present;
 *   2. it really decrypts AT BOOT (the decryptor runs before any request);
 *   3. a broken store does NOT take the boot down — it logs and degrades
 *      `/vendor/*` to 503 (P6-5b);
 *   4. no secret material reaches the boot log.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

import vendorSecretCryptoCoreLoader from "../../loaders/vendor-secret-crypto-core"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
  getVendorSecretCryptoCore,
  CryptoCoreFault,
} from "../../lib/vendor-secret/crypto-core"

const SECRET_A = "per-vendor-secret-for-A-0123456789"
const SECRET_SET = JSON.stringify({
  version: 1,
  entries: [
    {
      seller_id: "seller-A",
      config_ref: "sops://infra/gp-dev/secrets/vendor-hmac.enc.yaml#seller-A",
      secret_b64: Buffer.from(SECRET_A, "utf8").toString("base64"),
    },
  ],
})

function makeContainer(logged: string[]) {
  return {
    container: {
      resolve: (key: string) => {
        if (key === "logger") {
          return {
            info: (m: string) => logged.push(`info:${m}`),
            warn: (m: string) => logged.push(`warn:${m}`),
            error: (m: string) => logged.push(`error:${m}`),
          }
        }
        throw new Error(`unknown container key: ${key}`)
      },
    },
  } as any
}

describe("loaders/vendor-secret-crypto-core", () => {
  beforeEach(() => resetVendorSecretCryptoCore())
  afterEach(() => resetVendorSecretCryptoCore())

  it("lives in src/loaders and default-exports a function (Medusa loader convention)", () => {
    const file = path.join(__dirname, "../../loaders/vendor-secret-crypto-core.ts")
    expect(fs.existsSync(file)).toBe(true)
    expect(typeof vendorSecretCryptoCoreLoader).toBe("function")
  })

  it("decrypts AT BOOT: the decryptor runs during the loader, not on the first request", async () => {
    let decrypts = 0
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => {
        decrypts += 1
        return SECRET_SET
      },
    })

    const logged: string[] = []
    await vendorSecretCryptoCoreLoader(makeContainer(logged))

    expect(decrypts).toBe(1)
    expect(logged.join("\n")).toContain("boot decrypt OK")

    // The request path is then an idempotent read of the boot verdict.
    const onRequest = getVendorSecretCryptoCore()
    expect(onRequest.ok).toBe(true)
    expect(decrypts).toBe(1)
  })

  it("a broken store does NOT fail the boot — it logs the reason CLASS and degrades /vendor/* only", async () => {
    configureVendorSecretCryptoCore({
      secretSetPath: "/test/set.enc.json",
      decryptor: () => {
        throw new CryptoCoreFault("decrypt-failed")
      },
    })

    const logged: string[] = []
    await expect(vendorSecretCryptoCoreLoader(makeContainer(logged))).resolves.toBeUndefined()

    const surface = logged.join("\n")
    expect(surface).toContain("boot decrypt FAILED")
    expect(surface).toContain("reason=decrypt-failed")
    expect(surface).not.toContain(SECRET_A)
  })
})
