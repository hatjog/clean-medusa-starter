/**
 * sign-offer.ts — HMAC-SHA256 per-offer signing helper for the v1.5.0 MoR
 * runtime evaluator (D-71 Choice 4 Innovation Architect).
 *
 * @see specs/adr/2026-04-30-adr-079-mor-runtime-per-offer-signature.md
 * @see _bmad-output/planning-artifacts/architecture.md §D-71 (per-offer signature)
 *
 * Signing strategy:
 *  - HMAC-SHA256 chosen via #33 Comparative Matrix (vs RSA / Ed25519 / plain hash):
 *      * symmetric secret = no PKI rotation overhead at evaluator scale
 *      * SHA256 = FIPS-approved, ubiquitous Node `crypto` module support
 *      * 32-byte digest = cheap to store inline w `decision_path[]` (hex 64 chars)
 *  - Dual-key 30-day rotation window (`MOR_POLICY_SIGNING_KEY` primary +
 *    optional `MOR_POLICY_SIGNING_KEY_PREV` legacy). Verifier accepts either.
 *  - Canonical payload = JSON.stringify with sorted keys, locking byte-for-byte
 *    determinism across Node versions.
 *
 * Operational risk: signing-key rotation requires coordinated env update across
 * MoR backend pods + DLQ replay workers. ADR-079 documents the runbook.
 */

import { createHmac, timingSafeEqual } from "crypto"

const HMAC_ALGORITHM = "sha256"
const SIGNATURE_PREFIX = "mor-sig-v1"

/**
 * SignOfferInput — minimal canonical surface signed by `signOffer`.
 *
 * Intentionally a subset of the full `OfferContext` to keep the signature
 * payload stable across additive contract evolutions. New fields require an
 * ADR + signature version bump (`mor-sig-v2`).
 */
export interface SignOfferInput {
  /** Offer identifier — opaque vendor offer ref. */
  offer_id: string
  /** Vendor identifier (settlement subject). */
  vendor_id: string
  /** Order identifier — pins signature to a specific order context. */
  order_id: string
  /** Market identifier — multi-tenant isolation guard. */
  market_id: string
  /** Policy version snapshot (`stub-v0` or YAML version string). */
  policy_version: string
}

/**
 * Result of `signOffer` — signature + signing-key fingerprint for rotation
 * traceability.
 */
export interface SignedOffer {
  /** HMAC-SHA256 hex digest prefixed with `mor-sig-v1:`. */
  signature: string
  /**
   * SHA-prefix of the signing key used (first 8 hex chars of the SHA256 of the
   * key). Stable across rotations + safe to log (no key disclosure risk).
   */
  key_fingerprint: string
  /** ISO-8601 timestamp the signature was generated. */
  signed_at: string
}

/**
 * Read the active signing key from env. Throws if unset.
 *
 * v1.5.0 expects operators to provision `MOR_POLICY_SIGNING_KEY` per market
 * deployment via Vault/secret manager. Empty/whitespace = treat as unset.
 */
export function readSigningKey(envName = "MOR_POLICY_SIGNING_KEY"): string {
  const raw = process.env[envName]
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `[mor-policy/sign-offer] env ${envName} is not set; runtime evaluator REQUIRES a signing key (see ADR-079 §rotation-runbook).`
    )
  }
  return raw
}

/**
 * Read the previous (rotation-window) signing key. Returns `null` if not set
 * — a brand-new install has no prior key.
 */
export function readPreviousSigningKey(
  envName = "MOR_POLICY_SIGNING_KEY_PREV"
): string | null {
  const raw = process.env[envName]
  if (!raw || raw.trim().length === 0) {
    return null
  }
  return raw
}

/**
 * Canonical JSON serializer — stable key ordering for byte-for-byte signing.
 *
 * Object.keys() order is insertion-order under V8/Node, but we re-sort
 * defensively so the signature is invariant under arbitrary object literal
 * reorderings.
 */
export function canonicalize(input: SignOfferInput): string {
  const sortedEntries = Object.keys(input)
    .sort()
    .map((key) => [key, (input as unknown as Record<string, unknown>)[key]] as const)
  // Re-construct object preserving sorted order.
  const sorted: Record<string, unknown> = {}
  for (const [k, v] of sortedEntries) {
    sorted[k] = v
  }
  return JSON.stringify(sorted)
}

/** Compute the 8-char fingerprint of a signing key. */
export function computeKeyFingerprint(key: string): string {
  return createHmac(HMAC_ALGORITHM, "fingerprint-salt-v1")
    .update(key)
    .digest("hex")
    .slice(0, 8)
}

/**
 * signOffer — compute HMAC-SHA256 signature of a canonical offer payload.
 *
 * @param input  the offer payload subset to sign
 * @param key    optional signing key override (defaults to env lookup)
 */
export function signOffer(input: SignOfferInput, key?: string): SignedOffer {
  const signingKey = key ?? readSigningKey()
  const payload = canonicalize(input)
  const digest = createHmac(HMAC_ALGORITHM, signingKey)
    .update(payload)
    .digest("hex")
  return {
    signature: `${SIGNATURE_PREFIX}:${digest}`,
    key_fingerprint: computeKeyFingerprint(signingKey),
    signed_at: new Date().toISOString(),
  }
}

/**
 * verifySignature — constant-time signature verification supporting dual-key
 * rotation window.
 *
 * Returns the matching key fingerprint on success, or `null` on rejection.
 */
export function verifySignature(
  input: SignOfferInput,
  signature: string
): string | null {
  if (!signature.startsWith(`${SIGNATURE_PREFIX}:`)) {
    return null
  }

  const candidates: string[] = []
  try {
    candidates.push(readSigningKey())
  } catch {
    // No active key — verification cannot succeed.
    return null
  }
  const previous = readPreviousSigningKey()
  if (previous) {
    candidates.push(previous)
  }

  const payload = canonicalize(input)
  const incoming = signature.slice(SIGNATURE_PREFIX.length + 1)
  let incomingBuf: Buffer
  try {
    incomingBuf = Buffer.from(incoming, "hex")
  } catch {
    return null
  }
  if (incomingBuf.length === 0) {
    return null
  }

  for (const key of candidates) {
    const expected = createHmac(HMAC_ALGORITHM, key)
      .update(payload)
      .digest()
    if (
      expected.length === incomingBuf.length &&
      timingSafeEqual(expected, incomingBuf)
    ) {
      return computeKeyFingerprint(key)
    }
  }
  return null
}

export const __SIGNATURE_PREFIX_FOR_TESTS__ = SIGNATURE_PREFIX
