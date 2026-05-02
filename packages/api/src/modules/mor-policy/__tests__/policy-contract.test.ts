/**
 * policy-contract.test.ts — D-71 per-offer signature contract tests.
 *
 * Covers:
 *  - HMAC-SHA256 signing determinism
 *  - canonicalization stability under key reordering
 *  - dual-key rotation window verification
 *  - empty-array contract violation
 *  - decision_path truncation (FM-71-8)
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"

import {
  assertNonEmptyOfferContexts,
  DECISION_PATH_MAX_ENTRIES,
  DECISION_PATH_RULE_NAME_MAX_LEN,
  truncateDecisionPath,
} from "../policy-contract"
import {
  canonicalize,
  computeKeyFingerprint,
  signOffer,
  verifySignature,
} from "../../../lib/mor-policy/sign-offer"

const SAMPLE_INPUT = {
  offer_id: "offer_42",
  vendor_id: "kremidotyk",
  order_id: "order_7",
  market_id: "bonbeauty",
  policy_version: "stub-v0",
} as const

describe("policy-contract — per-offer signature (D-71)", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.MOR_POLICY_SIGNING_KEY = "test-active-key-AAA"
    delete process.env.MOR_POLICY_SIGNING_KEY_PREV
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("signs deterministically — same input + same key → same signature", () => {
    const a = signOffer({ ...SAMPLE_INPUT })
    const b = signOffer({ ...SAMPLE_INPUT })
    expect(a.signature).toBe(b.signature)
    expect(a.key_fingerprint).toBe(b.key_fingerprint)
    expect(a.signature.startsWith("mor-sig-v1:")).toBe(true)
  })

  it("differs across distinct keys — rotation isolates signatures", () => {
    const a = signOffer({ ...SAMPLE_INPUT }, "key-A")
    const b = signOffer({ ...SAMPLE_INPUT }, "key-B")
    expect(a.signature).not.toBe(b.signature)
    expect(a.key_fingerprint).not.toBe(b.key_fingerprint)
  })

  it("verifies with the active key", () => {
    const signed = signOffer({ ...SAMPLE_INPUT })
    const fp = verifySignature({ ...SAMPLE_INPUT }, signed.signature)
    expect(fp).toBe(computeKeyFingerprint("test-active-key-AAA"))
  })

  it("verifies with the previous key during dual-key rotation window", () => {
    // Sign with the OLD key, then rotate.
    const oldSigned = signOffer({ ...SAMPLE_INPUT }, "old-key-BBB")
    process.env.MOR_POLICY_SIGNING_KEY = "new-key-CCC"
    process.env.MOR_POLICY_SIGNING_KEY_PREV = "old-key-BBB"

    const fp = verifySignature({ ...SAMPLE_INPUT }, oldSigned.signature)
    expect(fp).toBe(computeKeyFingerprint("old-key-BBB"))
  })

  it("rejects unsigned offers (missing prefix)", () => {
    const fp = verifySignature({ ...SAMPLE_INPUT }, "deadbeef")
    expect(fp).toBeNull()
  })

  it("rejects tampered signatures", () => {
    const signed = signOffer({ ...SAMPLE_INPUT })
    const tampered = signed.signature.slice(0, -2) + "00"
    const fp = verifySignature({ ...SAMPLE_INPUT }, tampered)
    expect(fp).toBeNull()
  })

  it("canonicalizes invariant under key reordering", () => {
    const a = canonicalize({
      offer_id: "x",
      vendor_id: "v",
      order_id: "o",
      market_id: "m",
      policy_version: "p",
    })
    const b = canonicalize({
      // same fields, different literal order
      policy_version: "p",
      market_id: "m",
      order_id: "o",
      vendor_id: "v",
      offer_id: "x",
    })
    expect(a).toBe(b)
  })

  it("throws when env signing key is unset", () => {
    delete process.env.MOR_POLICY_SIGNING_KEY
    expect(() => signOffer({ ...SAMPLE_INPUT })).toThrow(/MOR_POLICY_SIGNING_KEY/)
  })

  it("assertNonEmptyOfferContexts throws on empty array", () => {
    expect(() => assertNonEmptyOfferContexts([])).toThrow(
      "offer_context cannot be empty array"
    )
  })

  it("truncateDecisionPath caps entry count at FM-71-8 max", () => {
    const tooMany = Array.from({ length: DECISION_PATH_MAX_ENTRIES + 10 }).map(
      (_, i) => `r${i}`
    )
    const result = truncateDecisionPath(tooMany)
    expect(result).toHaveLength(DECISION_PATH_MAX_ENTRIES)
  })

  it("truncateDecisionPath caps rule name length", () => {
    const longName = "x".repeat(DECISION_PATH_RULE_NAME_MAX_LEN + 50)
    const result = truncateDecisionPath([longName])
    expect(result[0]).toHaveLength(DECISION_PATH_RULE_NAME_MAX_LEN)
  })
})
