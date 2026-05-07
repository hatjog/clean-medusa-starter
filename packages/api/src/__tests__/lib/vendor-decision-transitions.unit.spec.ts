/**
 * Story v160-cleanup-36 — vendor decision state-machine unit tests.
 *
 * Covers the 4 transition types × allowed/denied matrix:
 *   - pending → opted_in (first capture — always allowed)
 *   - pending → opted_out (first capture — always allowed)
 *   - opted_in → opted_out (reversal — denied without override, allowed with)
 *   - opted_out → opted_in (reversal — denied without override, allowed with)
 *
 * Also covers resolveDecisionState helper.
 */

import { describe, it, expect } from "@jest/globals"

import {
  canTransitionDecision,
  resolveDecisionState,
} from "../../../src/lib/vendor-decision-transitions"

describe("canTransitionDecision", () => {
  // ── First capture (pending → *) ──────────────────────────────────────────────
  it("allows pending → opted_in", () => {
    const result = canTransitionDecision({
      currentState: "pending",
      attemptedDecision: "opted_in",
    })
    expect(result.allowed).toBe(true)
  })

  it("allows pending → opted_out", () => {
    const result = canTransitionDecision({
      currentState: "pending",
      attemptedDecision: "opted_out",
    })
    expect(result.allowed).toBe(true)
  })

  // ── Same-state is idempotent — allowed ───────────────────────────────────────
  it("allows opted_in → opted_in (same-state no-op)", () => {
    const result = canTransitionDecision({
      currentState: "opted_in",
      attemptedDecision: "opted_in",
    })
    expect(result.allowed).toBe(true)
  })

  it("allows opted_out → opted_out (same-state no-op)", () => {
    const result = canTransitionDecision({
      currentState: "opted_out",
      attemptedDecision: "opted_out",
    })
    expect(result.allowed).toBe(true)
  })

  // ── Reversal without override — denied ───────────────────────────────────────
  it("denies opted_in → opted_out without override", () => {
    const result = canTransitionDecision({
      currentState: "opted_in",
      attemptedDecision: "opted_out",
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("override=true")
  })

  it("denies opted_out → opted_in without override", () => {
    const result = canTransitionDecision({
      currentState: "opted_out",
      attemptedDecision: "opted_in",
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("override=true")
  })

  it("denies reversal when override=false explicitly", () => {
    const result = canTransitionDecision({
      currentState: "opted_in",
      attemptedDecision: "opted_out",
      override: false,
    })
    expect(result.allowed).toBe(false)
  })

  // ── Reversal with override=true — allowed ────────────────────────────────────
  it("allows opted_in → opted_out with override=true", () => {
    const result = canTransitionDecision({
      currentState: "opted_in",
      attemptedDecision: "opted_out",
      override: true,
    })
    expect(result.allowed).toBe(true)
  })

  it("allows opted_out → opted_in with override=true", () => {
    const result = canTransitionDecision({
      currentState: "opted_out",
      attemptedDecision: "opted_in",
      override: true,
    })
    expect(result.allowed).toBe(true)
  })
})

describe("resolveDecisionState", () => {
  it('returns "opted_in" for the string "opted_in"', () => {
    expect(resolveDecisionState("opted_in")).toBe("opted_in")
  })

  it('returns "opted_out" for the string "opted_out"', () => {
    expect(resolveDecisionState("opted_out")).toBe("opted_out")
  })

  it('returns "pending" for null', () => {
    expect(resolveDecisionState(null)).toBe("pending")
  })

  it('returns "pending" for undefined', () => {
    expect(resolveDecisionState(undefined)).toBe("pending")
  })

  it('returns "pending" for an unrecognised string', () => {
    expect(resolveDecisionState("forced")).toBe("pending")
    expect(resolveDecisionState("")).toBe("pending")
  })
})
