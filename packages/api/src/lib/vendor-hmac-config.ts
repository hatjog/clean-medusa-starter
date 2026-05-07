/**
 * vendor-hmac-config — Environment resolver for HMAC vendor auth settings.
 *
 * Keeps vendor-auth.ts testable by separating env resolution from logic.
 *
 * Environment variables:
 *   VENDOR_HMAC_SECRET       — Required when VENDOR_HMAC_ENFORCED=true.
 *                               Single shared secret for v1.6.0 topology.
 *                               (v1.7.0 ADR follow-up: per-vendor secret store)
 *   VENDOR_HMAC_ENFORCED     — "false" to enable legacy transition window.
 *                               Default: true (fail-closed).
 *   VENDOR_HMAC_DRIFT_SECONDS — Replay window in seconds. Default: 300.
 *
 * @module vendor-hmac-config
 */

export type VendorHmacConfig = {
  /** Raw secret bytes (Buffer) for HMAC-SHA256. */
  secret: Buffer
  /** When true, HMAC is required on all vendor-auth requests. */
  enforced: boolean
  /** Timestamp drift tolerance in seconds (default 300 = 5 min). */
  driftSeconds: number
}

/**
 * Resolves HMAC config from environment.
 *
 * Throws if `VENDOR_HMAC_ENFORCED` is not `false` and `VENDOR_HMAC_SECRET` is unset.
 * Called lazily on first request to surface the fatal condition at runtime.
 */
export function resolveVendorHmacConfig(): VendorHmacConfig {
  const enforcedRaw = process.env.VENDOR_HMAC_ENFORCED
  const enforced = enforcedRaw !== "false"

  const secretRaw = process.env.VENDOR_HMAC_SECRET ?? ""
  if (enforced && !secretRaw) {
    throw new Error(
      "[vendor-hmac-config] FATAL: VENDOR_HMAC_SECRET is unset but VENDOR_HMAC_ENFORCED is true. " +
        "Set VENDOR_HMAC_SECRET or set VENDOR_HMAC_ENFORCED=false for transition window. " +
        "See v1.6.0 cleanup-48 implementation notes."
    )
  }

  const driftRaw = process.env.VENDOR_HMAC_DRIFT_SECONDS
  const driftSeconds = driftRaw ? parseInt(driftRaw, 10) : 300

  return {
    secret: Buffer.from(secretRaw, "utf8"),
    enforced,
    driftSeconds,
  }
}
