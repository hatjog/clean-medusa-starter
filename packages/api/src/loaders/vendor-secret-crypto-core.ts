import type { MedusaContainer } from "@medusajs/types"

import {
  vendorSecretCryptoCoreHealth,
  VENDOR_AUTH_SECRET_STORE_UNAVAILABLE,
  VENDOR_SECRET_SET_PATH_ENV,
} from "../lib/vendor-secret/crypto-core"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

function resolveLogger(container: MedusaContainer | undefined): LoggerLike {
  try {
    return (container?.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

/**
 * Boot-time decrypt-health-check for the per-vendor secret crypto-core
 * (ADR-156 §6a, ADR-182, v1.15.0 Story 5.2 AC3 — review-fix H-2).
 *
 * Before this loader existed the crypto-core was decrypted lazily, on the FIRST
 * vendor request. Two consequences, both real:
 *   1. an operator got NO signal at startup — a broken age key surfaced as a
 *      seller's `503` instead of a boot log line. ADR-156 §6a asks for exactly
 *      the opposite;
 *   2. `sopsDecryptor` uses `spawnSync`, so that first request paid for the
 *      `sops` process on the event loop.
 *
 * The loader NEVER throws: a broken secret store degrades `/vendor/*` to `503`
 * (graceful degradation, P6-5b) and MUST NOT take the rest of the API down with
 * it. Boot-time failure is loud in the log, not fatal.
 *
 * `vendorSecretCryptoCoreHealth()` memoises the verdict, so the call on the
 * request path (`lib/vendor-auth.ts`) is an idempotent read of what happened
 * here — the decrypt itself is genuinely once-per-process, at boot.
 */
export default async function vendorSecretCryptoCoreLoader(args: {
  container: MedusaContainer
}): Promise<void> {
  const logger = resolveLogger(args?.container)

  let health: ReturnType<typeof vendorSecretCryptoCoreHealth>
  try {
    health = vendorSecretCryptoCoreHealth()
  } catch (err) {
    // Defensive: the core classifies its own faults, so this is unreachable in
    // practice. The reason CLASS is all that is ever logged — never the error
    // text, which could carry decryptor output (secrets-nonnegotiables §1).
    logger.error?.(
      `[vendor-secret-crypto-core] boot health-check raised an unclassified error (${
        err instanceof Error ? err.name : typeof err
      }) — /vendor/* will answer ${VENDOR_AUTH_SECRET_STORE_UNAVAILABLE}`
    )
    return
  }

  if (health.healthy) {
    logger.info?.("[vendor-secret-crypto-core] boot decrypt OK — per-vendor secrets loaded")
    return
  }

  logger.error?.(
    `[vendor-secret-crypto-core] boot decrypt FAILED reason=${health.reason} — ` +
      `/vendor/* answers 503 ${VENDOR_AUTH_SECRET_STORE_UNAVAILABLE}; the rest of the API is unaffected. ` +
      `Provision the SOPS secret-set and point ${VENDOR_SECRET_SET_PATH_ENV} at it ` +
      `(ADR-182 §3, ADR-156 §7 provision-all).`
  )
}
