import * as crypto from "crypto"

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

export function verifyEd25519Signature(
  payload: Buffer,
  signature: Buffer,
  pubkey: string,
): boolean {
  return crypto.verify(null, payload, createEd25519PublicKey(pubkey), signature)
}

export function buildPublicKeyKid(pubkey: string): string {
  const decoded = decodeBinaryMaterial(pubkey)
  const kidSource = decoded.length >= 32 ? decoded.subarray(decoded.length - 32) : decoded
  return `${kidSource.toString("base64").slice(0, 16)}…`
}

export function exportRawEd25519PublicKey(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer
  const raw = der.subarray(der.length - 32)
  return raw.toString("base64")
}