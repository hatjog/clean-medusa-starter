/**
 * Tests for gp-config-signing.ts helper library.
 * Story v160-cleanup-49: gp-config Ed25519 signing infra activation
 *
 * Covers AC5(f): PEM and hex-encoded pubkeys both accepted for verification.
 * All keypairs are generated at test setup time using Node crypto — NO production keys committed.
 */

import * as crypto from "node:crypto"

import { beforeAll, describe, expect, it } from "@jest/globals"

import {
  buildPublicKeyKid,
  decodeBinaryMaterial,
  extractRawEd25519PublicKey,
  verifyEd25519Signature,
} from "../gp-config-signing"

const ARTIFACT = Buffer.from('{"market":"test","version":"1.0.0"}')

// ──────────────────────────────────────────────────────────────────────────────
// Keypair fixture — generated once per test run via Node crypto
// ──────────────────────────────────────────────────────────────────────────────
let pubKeyPem: string
let pubKeyHex: string
let signature: Buffer

beforeAll(() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519")
  pubKeyPem = publicKey.export({ format: "pem", type: "spki" }) as string

  // Extract raw 32-byte hex from DER
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer
  pubKeyHex = der.subarray(der.length - 32).toString("hex")

  // Sign with private key using Node crypto
  signature = crypto.sign(null, ARTIFACT, privateKey) as Buffer
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5(f): Same valid signature passes whether pubkey is PEM or hex
// ──────────────────────────────────────────────────────────────────────────────
describe("AC5(f): PEM and hex pubkey both accepted", () => {
  it("verifies valid signature with hex-encoded raw 32-byte pubkey", () => {
    const result = verifyEd25519Signature(ARTIFACT, signature, pubKeyHex)
    expect(result).toBe(true)
  })

  it("verifies valid signature with PEM-encoded pubkey", () => {
    const result = verifyEd25519Signature(ARTIFACT, signature, pubKeyPem)
    expect(result).toBe(true)
  })

  it("returns false for tampered artifact with hex pubkey", () => {
    const tampered = Buffer.from(ARTIFACT.toString() + " x")
    const result = verifyEd25519Signature(tampered, signature, pubKeyHex)
    expect(result).toBe(false)
  })

  it("returns false for tampered artifact with PEM pubkey", () => {
    const tampered = Buffer.from(ARTIFACT.toString() + " x")
    const result = verifyEd25519Signature(tampered, signature, pubKeyPem)
    expect(result).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// extractRawEd25519PublicKey helper
// ──────────────────────────────────────────────────────────────────────────────
describe("extractRawEd25519PublicKey", () => {
  it("extracts 32-byte raw key from hex input", () => {
    const raw = extractRawEd25519PublicKey(pubKeyHex)
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw.length).toBe(32)
    expect(Buffer.from(raw).toString("hex")).toBe(pubKeyHex)
  })

  it("extracts 32-byte raw key from PEM input", () => {
    const raw = extractRawEd25519PublicKey(pubKeyPem)
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw.length).toBe(32)
    expect(Buffer.from(raw).toString("hex")).toBe(pubKeyHex)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// decodeBinaryMaterial
// ──────────────────────────────────────────────────────────────────────────────
describe("decodeBinaryMaterial", () => {
  it("decodes hex string to Buffer", () => {
    const hex = "deadbeef01020304"
    const result = decodeBinaryMaterial(hex)
    expect(result).toEqual(Buffer.from(hex, "hex"))
  })

  it("decodes base64 string to Buffer", () => {
    const b64 = Buffer.from("hello world").toString("base64")
    const result = decodeBinaryMaterial(b64)
    expect(result.toString("utf8")).toBe("hello world")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// buildPublicKeyKid
// ──────────────────────────────────────────────────────────────────────────────
describe("buildPublicKeyKid", () => {
  it("returns a string ending with ellipsis for hex pubkey", () => {
    const kid = buildPublicKeyKid(pubKeyHex)
    expect(typeof kid).toBe("string")
    expect(kid.endsWith("…")).toBe(true)
  })

  it("returns consistent kid for same pubkey", () => {
    const kid1 = buildPublicKeyKid(pubKeyHex)
    const kid2 = buildPublicKeyKid(pubKeyHex)
    expect(kid1).toBe(kid2)
  })
})
