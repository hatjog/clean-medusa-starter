/**
 * policy-contract.ts — per-offer evaluation contract for v1.5.0 MoR runtime.
 *
 * @see D-71 — Vendor MoR Policy Evaluation Contract (mandatory array signature)
 * @see specs/adr/2026-04-30-adr-079-mor-runtime-per-offer-signature.md
 * @see _bmad-output/planning-artifacts/architecture.md §D-71
 *
 * v1.5.0 introduces the per-offer mandatory array signature
 * `evaluate(order, offer_contexts: OfferContext[])`. The single-offer wrapper
 * `evaluateForOrder(order, singleOffer)` is provided for backwards
 * compatibility with v1.4.0 callsites, annotated `@deprecated v1.6.0`.
 *
 * Cross-validation gate D-78: validator `validate_mor_per_offer_capability.py`
 * checks (a) the array signature regex landed, (b) the empty-array guard is
 * present, (c) `evaluateForOrder` carries the `@deprecated v1.6.0` annotation,
 * (d) `signOffer(` is called within `evaluate`. WARN in v1.5.0; ERROR in
 * v1.6.0+ when `multi_vendor_pricing_enabled=true`.
 */

import type { MorContext, MorResolution, VoucherKind } from "./types"
import type { SignedOffer } from "../../lib/mor-policy/sign-offer"

/**
 * OfferContext — input shape for a single vendor offer being evaluated.
 *
 * Carries the per-offer information required to compute a MoR resolution
 * + sign the outcome. Multi-vendor v1.6.0 will pass an array of these; v1.5.0
 * passes a single-element array via the wrapper.
 */
export interface OfferContext {
  /** Offer identifier — opaque vendor offer ref. */
  offer_id: string
  /** Vendor identifier (settlement subject). */
  vendor_id: string
  /** Voucher kind discriminator (mirrors {@link MorContext.voucher_kind}). */
  voucher_kind: VoucherKind
  /** Optional per-offer breakage policy override (forward hook). */
  breakage_override?: string
}

/**
 * MorEvaluationOutcome — per-offer outcome of an `evaluate()` call.
 *
 * Each offer produces:
 *  - the canonical MorResolution (downstream wire contract)
 *  - a decision_path[] (capped 50 entries; rule names ≤32 chars per FM-71-8)
 *  - a SignedOffer (HMAC-SHA256 signature for tamper-evidence)
 *  - timing + retry telemetry (fed into `mor.policy.evaluated.v1` event)
 */
export interface MorEvaluationOutcome {
  offer_id: string
  resolution: MorResolution
  decision_path: string[]
  signed_offer: SignedOffer
  latency_ms: number
  retry_count: number
  outcome: "ok" | "retry-replayed" | "dlq"
}

/**
 * EvaluationRequest — top-level input wrapping the order + per-offer contexts
 * + idempotency key. The composite `(order_id, evaluation_request_id)` keys
 * the audit/snapshot tables (D-71 Composite Idempotency Key Pattern).
 */
export interface EvaluationRequest {
  /** Order identifier — stable for a checkout. */
  order_id: string
  /** Market identifier — multi-tenant isolation guard. */
  market_id: string
  /**
   * Client-generated idempotency token. MUST be persisted in order context
   * BEFORE first call; retry MUST reuse the same token (per D-71 client-side
   * discipline).
   */
  evaluation_request_id: string
  /** Base context — fields shared across all offers. */
  base_context: Pick<MorContext, "market_id" | "product_category">
  /** Per-offer evaluation contexts. v1.5.0 single-element; v1.6.0 multi. */
  offer_contexts: OfferContext[]
}

/**
 * Maximum number of decision_path entries before truncation (FM-71-8).
 */
export const DECISION_PATH_MAX_ENTRIES = 50

/**
 * Maximum length of a single rule name in decision_path (FM-71-8).
 */
export const DECISION_PATH_RULE_NAME_MAX_LEN = 32

/**
 * truncateDecisionPath — apply FM-71-8 caps to a decision_path array.
 *
 * - cap entry count at {@link DECISION_PATH_MAX_ENTRIES}
 * - cap each rule name at {@link DECISION_PATH_RULE_NAME_MAX_LEN}
 *
 * Returns a NEW array; does NOT mutate the input.
 */
export function truncateDecisionPath(input: readonly string[]): string[] {
  return input
    .slice(0, DECISION_PATH_MAX_ENTRIES)
    .map((entry) =>
      entry.length > DECISION_PATH_RULE_NAME_MAX_LEN
        ? entry.slice(0, DECISION_PATH_RULE_NAME_MAX_LEN)
        : entry
    )
}

/**
 * assertNonEmptyOfferContexts — throws if `offer_contexts` is empty.
 *
 * Per D-71: an empty array is a contract violation; `evaluate()` rejects it
 * synchronously (no retry, no DLQ).
 */
export function assertNonEmptyOfferContexts(
  contexts: readonly OfferContext[]
): asserts contexts is readonly [OfferContext, ...OfferContext[]] {
  if (contexts.length === 0) {
    throw new Error("offer_context cannot be empty array")
  }
}
