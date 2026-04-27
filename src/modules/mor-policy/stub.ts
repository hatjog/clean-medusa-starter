import type { IMorPolicyEvaluator, MorContext, MorResolution } from "./types"
import { MorEvaluationError } from "./types"

/** Stub policy version string — v1.5.0 will read this from the policy YAML. */
const STUB_POLICY_VERSION = "stub-v0"

/** Hardcoded operator id used by the stub for `sale_mor_subject`. */
const STUB_OPERATOR_SUBJECT = "operator"

/**
 * StubMorPolicyEvaluator — v1.4.0 hardcoded MoR resolver per D-42.
 *
 * Behaviour matrix (frozen by AC #2):
 *  - `sale_mor_type` is always `'operator'` (matches the voucher-first
 *    default in mor-hybrid-voucher-first-analysis.md §5.1).
 *  - `service_mor_type` is `'vendor'` for `voucher_kind ∈ {spv, mpv}`,
 *    `null` for `voucher_kind === 'none'`.
 *  - `service_mor_subject` echoes `ctx.vendor_id` for voucher kinds, `null`
 *    otherwise.
 *  - Throws `MorEvaluationError(MARKET_NOT_FOUND)` for empty/missing
 *    `market_id`.
 *  - Throws `MorEvaluationError(MISSING_CONFIG)` for missing `voucher_kind`
 *    (the stub does not infer voucher kind from `product_category`).
 *  - `mor_policy_version` is the literal `'stub-v0'`.
 *  - `breakage_policy` is intentionally omitted in the stub — v1.5.0
 *    populates per §10.3.
 *
 * @see D-42 — mor-policy stub module.
 * @see _bmad-output/planning-artifacts/mor-hybrid-voucher-first-analysis.md
 *      §5.1 (voucher-first default), §6.1 (ontology + events),
 *      §10.3 (per-vendor breakage policy override).
 *
 * v1.5.0 will swap impl with a YAML-policy loader (mor-policy.yaml per
 * market). The interface contract in {@link IMorPolicyEvaluator} stays
 * stable across the swap.
 */
export class StubMorPolicyEvaluator implements IMorPolicyEvaluator {
  resolve(ctx: MorContext): MorResolution {
    if (!ctx.market_id || ctx.market_id.length === 0) {
      throw new MorEvaluationError({
        code: "MARKET_NOT_FOUND",
        message: "StubMorPolicyEvaluator: market_id is required",
        context: ctx,
      })
    }

    if (ctx.voucher_kind === undefined) {
      throw new MorEvaluationError({
        code: "MISSING_CONFIG",
        message:
          "StubMorPolicyEvaluator: voucher_kind is required (stub does not infer from product_category)",
        context: ctx,
      })
    }

    const isVoucher = ctx.voucher_kind === "spv" || ctx.voucher_kind === "mpv"

    return {
      sale_mor_type: "operator",
      sale_mor_subject: STUB_OPERATOR_SUBJECT,
      service_mor_type: isVoucher ? "vendor" : null,
      service_mor_subject: isVoucher ? (ctx.vendor_id ?? null) : null,
      voucher_kind: ctx.voucher_kind,
      mor_policy_version: STUB_POLICY_VERSION,
      // breakage_policy intentionally omitted — v1.5.0 populates per §10.3.
    }
  }
}
