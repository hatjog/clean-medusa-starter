/**
 * vendor-hmac-config — Environment resolver for HMAC vendor auth settings.
 *
 * Keeps vendor-auth.ts testable by separating env resolution from logic.
 *
 * v1.15.0 Story 5.4 (FR-11 closure, D-5, AD-20, SM-6):
 *   The shared `VENDOR_HMAC_SECRET` is GONE from this module — not deprecated,
 *   not behind a flag, not a fallback. Signing material is resolved PER SELLER
 *   by `lib/vendor-secret/crypto-core.ts` (Story 5.2). What remains here is
 *   POLICY, not secret material:
 *     * enforcement (is a signature required at all),
 *     * drift tolerance (how far a timestamp may be off).
 *   Keeping those two is not a partial payment of the debt: neither is key
 *   material, and neither can be used to authenticate a request.
 *
 *   Consequence that is the point of the story: `/vendor/*` now serves a
 *   correctly signed request with `VENDOR_HMAC_SECRET` COMPLETELY UNSET. Before
 *   5.4 the same environment produced `503 VENDOR_AUTH_CONFIG_ERROR`, so the
 *   route was a hostage of a secret it no longer used.
 *
 * Environment variables:
 *   VENDOR_HMAC_ENFORCED     — "false" fails closed (503); the legacy
 *                               `x-vendor-token` path was deleted in v1.9.0.
 *                               Default: true (fail-closed).
 *   VENDOR_HMAC_DRIFT_SECONDS — Replay window in seconds. Default: 300.
 *
 * @module vendor-hmac-config
 */

export type VendorHmacConfig = {
  /** When true, HMAC is required on all vendor-auth requests. */
  enforced: boolean
  /** Timestamp drift tolerance in seconds (default 300 = 5 min). */
  driftSeconds: number
}

/**
 * Resolves HMAC POLICY from environment.
 *
 * Does not throw: there is no longer any secret material whose absence could be
 * fatal here. A misconfigured `VENDOR_HMAC_ENFORCED=false` is surfaced by
 * `vendor-auth.ts` as a readable 503, which keeps that failure distinguishable
 * from "secret store unavailable" and from "this seller has no secret".
 */
export function resolveVendorHmacConfig(): VendorHmacConfig {
  const enforcedRaw = process.env.VENDOR_HMAC_ENFORCED
  const enforced = enforcedRaw !== "false"

  const driftRaw = process.env.VENDOR_HMAC_DRIFT_SECONDS
  const driftSeconds = driftRaw ? parseInt(driftRaw, 10) : 300

  return {
    enforced,
    driftSeconds,
  }
}
