import * as crypto from "crypto"

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- @noble/ed25519 is ESM-only; used at runtime via bundler (Medusa handles CJS->ESM interop)
import * as ed from "@noble/ed25519"
import { sha512 } from "@noble/hashes/sha512"

// @noble/ed25519 v2 requires sha512Sync for synchronous API calls.
// Configure once at module load time.
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

function isPemEncoded(value: string): boolean {
  return value.includes("-----BEGIN")
}

function isHexEncoded(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
}

export function decodeBinaryMaterial(value: string): Buffer {
  const normalized = value.trim()
  return Buffer.from(normalized, isHexEncoded(normalized) ? "hex" : "base64")
}

export function createEd25519PublicKey(pubkey: string): crypto.KeyObject {
  if (isPemEncoded(pubkey)) {
    return crypto.createPublicKey(pubkey)
  }

  const decoded = decodeBinaryMaterial(pubkey)
  const der = decoded.length === 32
    ? Buffer.concat([ED25519_SPKI_PREFIX, decoded])
    : decoded

  return crypto.createPublicKey({
    key: der,
    format: "der",
    type: "spki",
  })
}

export function createEd25519PrivateKey(privkey: string): crypto.KeyObject {
  if (isPemEncoded(privkey)) {
    return crypto.createPrivateKey(privkey)
  }

  const decoded = decodeBinaryMaterial(privkey)
  const der = decoded.length === 32
    ? Buffer.concat([ED25519_PKCS8_PREFIX, decoded])
    : decoded

  return crypto.createPrivateKey({
    key: der,
    format: "der",
    type: "pkcs8",
  })
}

/**
 * Extract raw 32-byte Ed25519 public key from PEM, hex, or base64-encoded input.
 * The raw key is what @noble/ed25519 expects for verification.
 *
 * Throws if the input cannot be unambiguously decoded to a 32-byte Ed25519
 * public key. Accepted shapes:
 *   - PEM SPKI block ("-----BEGIN PUBLIC KEY-----...")
 *   - 32-byte raw key (hex or base64)
 *   - SPKI DER (hex or base64) prefixed with the canonical Ed25519 SPKI marker
 */
export function extractRawEd25519PublicKey(pubkey: string): Uint8Array {
  if (isPemEncoded(pubkey)) {
    // Parse via Node crypto, then export DER/SPKI to extract raw 32 bytes
    const keyObj = crypto.createPublicKey(pubkey)
    const der = keyObj.export({ format: "der", type: "spki" }) as Buffer
    // Raw key is last 32 bytes of SPKI DER
    return new Uint8Array(der.subarray(der.length - 32))
  }

  const decoded = decodeBinaryMaterial(pubkey)
  if (decoded.length === 32) {
    return new Uint8Array(decoded)
  }
  // SPKI DER must start with the canonical Ed25519 SPKI prefix; reject other
  // sizes/prefixes to avoid silently truncating arbitrary blobs into a key.
  const expectedSpkiLength = ED25519_SPKI_PREFIX.length + 32
  if (
    decoded.length === expectedSpkiLength &&
    decoded.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return new Uint8Array(decoded.subarray(ED25519_SPKI_PREFIX.length))
  }
  throw new Error(
    `extractRawEd25519PublicKey: invalid pubkey encoding (decoded ${decoded.length} bytes; expected 32 raw or ${expectedSpkiLength} SPKI-DER with Ed25519 prefix)`,
  )
}

/**
 * Verify an Ed25519 signature using @noble/ed25519.
 *
 * @param payload  - The artifact bytes that were signed.
 * @param signature - The 64-byte detached signature.
 * @param pubkey   - Ed25519 public key as PEM, hex (raw 32B), or base64.
 * @returns true if signature is valid, false on mismatch. Throws on malformed input.
 */
export function verifyEd25519Signature(
  payload: Buffer,
  signature: Buffer,
  pubkey: string,
): boolean {
  const rawPub = extractRawEd25519PublicKey(pubkey)
  return ed.verify(new Uint8Array(signature), new Uint8Array(payload), rawPub)
}

export function buildPublicKeyKid(pubkey: string): string {
  // Route through the canonical raw-key extractor so the kid is encoding-invariant
  // (PEM input and hex/base64 input for the same key produce the same kid).
  // Falls back to the previous best-effort base64 prefix on extraction failure
  // so callers get a stable string instead of a crash for diagnostic logging.
  let raw: Uint8Array
  try {
    raw = extractRawEd25519PublicKey(pubkey)
  } catch {
    const decoded = decodeBinaryMaterial(pubkey)
    raw = new Uint8Array(decoded.length >= 32 ? decoded.subarray(decoded.length - 32) : decoded)
  }
  return `${Buffer.from(raw).toString("base64").slice(0, 16)}…`
}

export function exportRawEd25519PublicKey(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer
  const raw = der.subarray(der.length - 32)
  return raw.toString("base64")
}
