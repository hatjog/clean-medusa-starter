/**
 * mor-policy-evaluator.test.ts — D-71 runtime evaluator tests, 6 ACs verbatim.
 *
 * AC #1: implements IMorPolicyEvaluator; replaces stub.ts runtime path
 * AC #2: per-offer HMAC-SHA256 signature on every evaluate() call
 * AC #3: D-78 cross-validation gate (validator-side; smoke here)
 * AC #4: DLQ classification per FM-71-RT-1..10 + FM-71-DLQ-1..2
 * AC #5: signing-key rotation (dual-key 30-day window)
 * AC #6: emits mor.policy.evaluated.v1 event using STORY-1-1 audit primitives
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"

import {
  InMemorySnapshotStore,
  MorPolicyEvaluator,
  NoopAuditLog,
} from "../MorPolicyEvaluator"
import type { IMorPolicyEvaluator } from "../types"
import { MorEvaluationError } from "../types"
import type { EvaluationRequest, OfferContext } from "../policy-contract"
import { verifySignature } from "../../../lib/mor-policy/sign-offer"
import { classifyFailure, promoteExhaustedRetry } from "../dlq"

const baseRequest = (
  overrides: Partial<EvaluationRequest> = {}
): EvaluationRequest => ({
  order_id: "order_1",
  market_id: "bonbeauty",
  evaluation_request_id: "eval-req-AAA",
  base_context: { market_id: "bonbeauty", product_category: "voucher" },
  offer_contexts: [
    {
      offer_id: "offer_1",
      vendor_id: "salon-1",
      voucher_kind: "mpv",
    } satisfies OfferContext,
  ],
  ...overrides,
})

describe("MorPolicyEvaluator (D-71 runtime)", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.MOR_POLICY_SIGNING_KEY = "test-active-key-AAA"
    delete process.env.MOR_POLICY_SIGNING_KEY_PREV
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  // ---------- AC #1: implements IMorPolicyEvaluator + replaces stub --------

  it("AC#1: is structurally an IMorPolicyEvaluator and preserves stub semantics on resolve()", () => {
    const evaluator: IMorPolicyEvaluator = new MorPolicyEvaluator()
    const result = evaluator.resolve({
      market_id: "bonbeauty",
      vendor_id: "salon-1",
      voucher_kind: "mpv",
    })
    expect(result.sale_mor_type).toBe("operator")
    expect(result.service_mor_type).toBe("vendor")
    expect(result.service_mor_subject).toBe("salon-1")
  })

  // ---------- AC #2: per-offer HMAC-SHA256 signature -----------------------

  it("AC#2: every evaluate() call produces a verifiable HMAC-SHA256 signature", async () => {
    const evaluator = new MorPolicyEvaluator()
    const outcomes = await evaluator.evaluate(baseRequest())
    expect(outcomes).toHaveLength(1)
    const [outcome] = outcomes
    expect(outcome.signed_offer.signature.startsWith("mor-sig-v1:")).toBe(true)
    const fp = verifySignature(
      {
        offer_id: "offer_1",
        vendor_id: "salon-1",
        order_id: "order_1",
        market_id: "bonbeauty",
        policy_version: outcome.resolution.mor_policy_version,
      },
      outcome.signed_offer.signature
    )
    expect(fp).toBe(outcome.signed_offer.key_fingerprint)
  })

  it("AC#2: signature is recorded in audit decision_path (signature_key_fingerprint propagated)", async () => {
    const audit = new NoopAuditLog()
    const evaluator = new MorPolicyEvaluator({ auditLog: audit })
    await evaluator.evaluate(baseRequest())
    expect(audit.entries).toHaveLength(1)
    expect(audit.entries[0].signature_key_fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(audit.entries[0].decision_path.some((e) => e.startsWith("policy:"))).toBe(true)
  })

  it("AC#2: empty offer_contexts array throws contract error (no signature attempted)", async () => {
    const evaluator = new MorPolicyEvaluator()
    await expect(
      evaluator.evaluate(baseRequest({ offer_contexts: [] }))
    ).rejects.toThrow("offer_context cannot be empty array")
  })

  // ---------- AC #3: cross-validation gate (smoke; full validator in py) ---

  it("AC#3 smoke: evaluateForOrder wrapper exists and is annotated @deprecated v1.6.0", async () => {
    // Annotation presence is verified by the python validator; this test
    // verifies wrapper behaviour (single-offer → single-element array).
    const evaluator = new MorPolicyEvaluator()
    const outcome = await evaluator.evaluateForOrder(
      {
        order_id: "order_2",
        market_id: "bonbeauty",
        evaluation_request_id: "eval-req-BBB",
        base_context: { market_id: "bonbeauty", product_category: "voucher" },
      },
      { offer_id: "o1", vendor_id: "v1", voucher_kind: "spv" }
    )
    expect(outcome.offer_id).toBe("o1")
    expect(outcome.outcome).toBe("ok")
  })

  // ---------- AC #4: DLQ classification ------------------------------------

  it("AC#4: classifies 40001 serialization_failure as transient (FM-71-RT-1)", () => {
    const err = Object.assign(new Error("could not serialize"), { code: "40001" })
    const c = classifyFailure(err)
    expect(c.tier).toBe("transient")
    expect(c.failure_mode).toBe("FM-71-RT-1")
    expect(c.is_retryable).toBe(true)
  })

  it("AC#4: classifies 40P01 deadlock as transient (FM-71-RT-2)", () => {
    const err = Object.assign(new Error("deadlock"), { code: "40P01" })
    expect(classifyFailure(err).failure_mode).toBe("FM-71-RT-2")
  })

  it("AC#4: classifies timeout as FM-71-RT-5 transient", () => {
    const c = classifyFailure(new Error("query timed out after 1000ms"))
    expect(c.failure_mode).toBe("FM-71-RT-5")
    expect(c.is_retryable).toBe(true)
  })

  it("AC#4: classifies 23xxx integrity violation as terminal ops_review (FM-71-RT-9)", () => {
    const err = Object.assign(new Error("FK violation"), { code: "23503" })
    const c = classifyFailure(err)
    expect(c.tier).toBe("dlq_pending_ops_review")
    expect(c.failure_mode).toBe("FM-71-RT-9")
    expect(c.is_retryable).toBe(false)
  })

  it("AC#4: classifies non-PG error as FM-71-DLQ-2 ops_review", () => {
    const c = classifyFailure(new Error("network is down"))
    expect(c.tier).toBe("dlq_pending_ops_review")
    expect(c.failure_mode).toBe("FM-71-DLQ-2")
  })

  it("AC#4: promoteExhaustedRetry escalates transient → dlq_pending_retry", () => {
    const t = classifyFailure(
      Object.assign(new Error("deadlock"), { code: "40P01" })
    )
    const escalated = promoteExhaustedRetry(t)
    expect(escalated.tier).toBe("dlq_pending_retry")
    expect(escalated.is_retryable).toBe(false)
  })

  it("AC#4: terminal failure short-circuits retry budget and emits DLQ audit", async () => {
    let invocations = 0
    const failingInner: IMorPolicyEvaluator = {
      resolve: () => {
        invocations += 1
        throw Object.assign(new Error("FK violation"), { code: "23503" })
      },
    }
    const audit = new NoopAuditLog()
    const evaluator = new MorPolicyEvaluator({
      innerEvaluator: failingInner,
      auditLog: audit,
      sleep: async () => undefined,
    })
    await expect(evaluator.evaluate(baseRequest())).rejects.toThrow(
      MorEvaluationError
    )
    expect(invocations).toBe(1) // not retried (terminal)
    expect(audit.entries[0].outcome).toBe("dlq")
    expect(audit.entries[0].dlq_classification?.failure_mode).toBe("FM-71-RT-9")
  })

  // ---------- AC #5: signing-key rotation (dual-key 30-day window) ---------

  it("AC#5: dual-key window — old signature still verifies after rotation", async () => {
    process.env.MOR_POLICY_SIGNING_KEY = "old-key"
    const evaluator = new MorPolicyEvaluator()
    const [out] = await evaluator.evaluate(baseRequest())

    // Operator rotates: new key live, prev kept for 30-day window.
    process.env.MOR_POLICY_SIGNING_KEY = "new-key"
    process.env.MOR_POLICY_SIGNING_KEY_PREV = "old-key"

    const fp = verifySignature(
      {
        offer_id: "offer_1",
        vendor_id: "salon-1",
        order_id: "order_1",
        market_id: "bonbeauty",
        policy_version: out.resolution.mor_policy_version,
      },
      out.signed_offer.signature
    )
    expect(fp).not.toBeNull()
  })

  // ---------- AC #6: emits mor.policy.evaluated.v1 event -------------------

  it("AC#6: emits one mor.policy.evaluated.v1 audit entry per evaluated offer", async () => {
    const audit = new NoopAuditLog()
    const evaluator = new MorPolicyEvaluator({ auditLog: audit })
    await evaluator.evaluate(baseRequest())
    expect(audit.entries).toHaveLength(1)
    const e = audit.entries[0]
    expect(e.market_id).toBe("bonbeauty")
    expect(e.order_id).toBe("order_1")
    expect(e.evaluation_request_id).toBe("eval-req-AAA")
    expect(e.policy_version_snapshot).toBeTruthy()
    expect(typeof e.latency_ms).toBe("number")
    expect(e.retry_count).toBe(0)
    expect(e.outcome).toBe("ok")
    expect(e.signature_key_fingerprint).toBeTruthy()
    expect(e.decision_path.length).toBeGreaterThan(0)
    expect(e.decision_path.length).toBeLessThanOrEqual(50)
  })

  it("AC#6: idempotent replay reuses snapshot (decision_path identical, outcome=retry-replayed)", async () => {
    const snapshot = new InMemorySnapshotStore()
    const audit = new NoopAuditLog()
    const evaluator = new MorPolicyEvaluator({
      snapshotStore: snapshot,
      auditLog: audit,
    })

    const [first] = await evaluator.evaluate(baseRequest())
    const [second] = await evaluator.evaluate(baseRequest())

    expect(first.decision_path).toEqual(second.decision_path)
    expect(first.outcome).toBe("ok")
    expect(second.outcome).toBe("retry-replayed")
    expect(audit.entries).toHaveLength(2)
    expect(audit.entries[1].outcome).toBe("retry-replayed")
  })

  it("AC#6: decision_path is capped at 50 entries (FM-71-8)", async () => {
    const audit = new NoopAuditLog()
    const evaluator = new MorPolicyEvaluator({ auditLog: audit })
    await evaluator.evaluate(baseRequest())
    expect(audit.entries[0].decision_path.length).toBeLessThanOrEqual(50)
    for (const rule of audit.entries[0].decision_path) {
      expect(rule.length).toBeLessThanOrEqual(32)
    }
  })
})
