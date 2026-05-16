/**
 * voucher module — Layer 2 entitlement_boundary (ADR-099 / D-V180-ARCH-6).
 *
 * Story v180-2-1 (Entitlement_Profile Schema + ADR-099 4-Layer Model, BE-10).
 *
 * Layer 2 = hardcoded GP platform maxima/minima. These constraints are
 * platform-wide and are NOT overridable by market/vendor: a per-market Layer 3
 * profile (gp-ops market.yaml `entitlement_profiles:`) MUST fit inside this
 * boundary. This module is the backend runtime source-of-truth.
 *
 * Single-source note: the Python governance gate
 * `_grow/tools/validate_entitlement_profiles.py` carries its OWN copy of these
 * maxima/minima so it can validate the fixture/config corpus without a
 * submodule checkout. The two declarations MUST stay in sync — any change here
 * requires the matching change in the validator (and an ADR per ADR-099, since
 * the boundary is immutable platform-wide). This drift risk is documented in
 * _grow/VALIDATORS.md.
 */

import { EntitlementPolicySnapshot, EntitlementType } from "./models/entitlement"

/** Allowed `policy.no_show.policy` values (platform-wide enum). */
export const NO_SHOW_POLICIES = [
  "charge_full",
  "charge_partial",
  "no_charge",
  "forfeit_voucher",
  "vendor_decision", // additive — Story 2.7 / FR1.17; vendor-decision resolution UI v1.9.0+
] as const
export type NoShowPolicy = (typeof NO_SHOW_POLICIES)[number]

/**
 * Allowed `policy.transferability` values (platform-wide enum, BE-5 / FR1.16).
 *
 * Single-source note: the Python governance gate
 * `_grow/tools/validate_entitlement_profiles.py` carries its OWN copy
 * (`TRANSFERABILITY_VALUES`) so it can validate the fixture/config corpus
 * without a submodule checkout. The two copies MUST stay in sync.
 */
export const TRANSFERABILITY_VALUES = [
  "bearer",
  "personalized",
  "hybrid",
] as const
export type Transferability = (typeof TRANSFERABILITY_VALUES)[number]

/**
 * Allowed `policy.refund_channel` values (platform-wide enum).
 *
 * Single-source note: `_grow/tools/validate_entitlement_profiles.py`
 * carries a synced governance copy (REFUND_CHANNELS tuple). Both
 * declarations MUST be updated together. Drift requires an ADR per ADR-099.
 */
export const REFUND_CHANNELS = [
  "original_payment",
  "store_credit",
  "vendor_wallet",
] as const
export type RefundChannel = (typeof REFUND_CHANNELS)[number]

/**
 * Hardcoded GP platform boundary. Numeric fields are inclusive bounds; enum
 * fields list the only permitted values. A Layer 3 profile violates the
 * boundary if any policy field falls outside these.
 */
export const ENTITLEMENT_BOUNDARY = {
  /** Per-type validity ceiling (months from ISSUED). */
  validity_months_max: 24,
  /** validity_months floor (a profile must grant at least 1 month). */
  validity_months_min: 1,
  policy: {
    extension: {
      /** Extension fee as percent of voucher value. */
      fee_pct_max: 15,
      fee_pct_min: 5,
    },
    cancellation: {
      /** Minimum cancellation cutoff window (hours before appointment). */
      cutoff_hours_min: 12,
      /** cancellation fee percent domain is 0..100. */
      fee_pct_max: 100,
      fee_pct_min: 0,
      /** Allowed cancellation fee deduction methods. */
      deduct_method: ["forfeit_credit", "charge_card"] as const,
    },
    no_show: {
      /** Allowed no-show policy enum values. */
      policy: NO_SHOW_POLICIES,
      charge_pct_min: 0,
      charge_pct_max: 100,
    },
    /** Allowed transferability enum values (BE-5 / FR1.16). */
    transferability: TRANSFERABILITY_VALUES,
    /** Allowed refund channel enum values. */
    refund_channel: REFUND_CHANNELS,
  },
} as const

/** Lost-code recovery is admin-triggered and platform-wide in v1.8.0. */
export const LOST_CODE_REISSUE_WINDOW_DAYS = 30

/**
 * Retention voucher amount boundaries (GP platform hardcoded, BE-9 / FR1.20).
 *
 * RETENTION_AMOUNT_PCT_MIN = 100: retention ≥ par value of the original —
 * retention is an incentive to stay, not a masked partial refund.
 *
 * RETENTION_AMOUNT_PCT_MAX = 200: anti-abuse ceiling that prevents unlimited
 * value escalation via admin-initiated retention while remaining permissive
 * enough for legitimate high-value retention offers. Not a tight 120% hard
 * cap — the operation is discretionary (per product guidance "zwykle 110-120%"
 * but cap allows higher offers where business judgment warrants it).
 *
 * Single-source note: Python governance gate `validate_entitlement_profiles.py`
 * does NOT carry these constants (retention is admin-triggered, not profile-
 * driven in v1.8.0). If profile-level retention bounds are added in a future
 * story, the validator must be updated in sync with this file.
 */
export const RETENTION_AMOUNT_PCT_MIN = 100
export const RETENTION_AMOUNT_PCT_MAX = 200

/**
 * Pure boundary check for retention voucher amount (BE-9 / AC4).
 *
 * When `originalAmount` is provided, enforces incentive ratio within GP
 * boundary ([RETENTION_AMOUNT_PCT_MIN, RETENTION_AMOUNT_PCT_MAX] of original).
 * When `originalAmount` is undefined/null (DDL drift — column not present),
 * degrades gracefully to `amount > 0` only (deterministically documented per
 * AC4 / Dev Notes DDL drift posture from Story 2.5).
 */
export function isRetentionAmountWithinBoundary(
  amount: number,
  originalAmount?: number | null
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false
  if (
    originalAmount == null ||
    !Number.isFinite(originalAmount) ||
    originalAmount <= 0
  ) {
    // DDL drift degradation: original value not resolvable — enforce amount > 0 only.
    return true
  }
  const pct = (amount / originalAmount) * 100
  return pct >= RETENTION_AMOUNT_PCT_MIN && pct <= RETENTION_AMOUNT_PCT_MAX
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Inclusive 30-day lost-code recovery boundary, counted from the original
 * entitlement issue date. The boundary is deliberately not market/vendor
 * configurable.
 */
export function isWithinReissueWindow(
  originalIssuedAt: Date,
  now: Date = new Date()
): boolean {
  const issuedMs = originalIssuedAt.getTime()
  const nowMs = now.getTime()
  if (!Number.isFinite(issuedMs) || !Number.isFinite(nowMs)) return false
  return nowMs - issuedMs <= LOST_CODE_REISSUE_WINDOW_DAYS * DAY_MS
}

/**
 * The validity ceiling is uniform across the v1.8.0-active types
 * (VOUCHER_AMOUNT + VOUCHER_SERVICE) but is keyed by type so future inactive
 * types can carry a different ceiling without changing call sites.
 */
export function validityMonthsMax(_type: EntitlementType): number {
  return ENTITLEMENT_BOUNDARY.validity_months_max
}

export interface BoundaryViolation {
  /** Dotted path within the profile policy, e.g. `policy.extension.fee_pct`. */
  field: string
  message: string
}

/**
 * Check a Layer 3 profile `policy` object against the Layer 2 boundary.
 * Returns the list of violations (empty == within boundary). Pure + dependency
 * free so it can run in unit tests and (conceptually mirrored) in the Python
 * governance gate.
 */
export function checkPolicyAgainstBoundary(
  policy: Record<string, unknown>
): BoundaryViolation[] {
  const v: BoundaryViolation[] = []
  const B = ENTITLEMENT_BOUNDARY

  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) ? x : undefined

  const validity = num(policy.validity_months)
  if (validity === undefined) {
    v.push({
      field: "policy.validity_months",
      message: "validity_months is required and must be a number",
    })
  } else if (
    validity < B.validity_months_min ||
    validity > B.validity_months_max
  ) {
    v.push({
      field: "policy.validity_months",
      message: `validity_months ${validity} outside [${B.validity_months_min}, ${B.validity_months_max}]`,
    })
  }

  const ext = policy.extension as Record<string, unknown> | undefined
  if (ext) {
    const fee = num(ext.fee_pct)
    const paid = ext.paid === true
    if (paid) {
      // Paid extension: fee_pct must be within [fee_pct_min, fee_pct_max].
      if (
        fee !== undefined &&
        (fee < B.policy.extension.fee_pct_min ||
          fee > B.policy.extension.fee_pct_max)
      ) {
        v.push({
          field: "policy.extension.fee_pct",
          message: `extension.fee_pct ${fee} outside [${B.policy.extension.fee_pct_min}, ${B.policy.extension.fee_pct_max}] for paid extension`,
        })
      }
    } else {
      // Unpaid extension: fee_pct must be exactly 0 (or absent) to prevent
      // garbage values from silently passing governance (L1 fix).
      if (fee !== undefined && fee !== 0) {
        v.push({
          field: "policy.extension.fee_pct",
          message: `extension.fee_pct must be 0 for unpaid extension, got ${fee}`,
        })
      }
    }
  }

  const cancel = policy.cancellation as Record<string, unknown> | undefined
  if (cancel) {
    const cutoff = num(cancel.cutoff_hours)
    if (
      cutoff !== undefined &&
      cutoff < B.policy.cancellation.cutoff_hours_min
    ) {
      v.push({
        field: "policy.cancellation.cutoff_hours",
        message: `cancellation.cutoff_hours ${cutoff} below minimum ${B.policy.cancellation.cutoff_hours_min}`,
      })
    }
    const fee = num(cancel.fee_pct)
    if (
      fee !== undefined &&
      (fee < B.policy.cancellation.fee_pct_min ||
        fee > B.policy.cancellation.fee_pct_max)
    ) {
      v.push({
        field: "policy.cancellation.fee_pct",
        message: `cancellation.fee_pct ${fee} outside [${B.policy.cancellation.fee_pct_min}, ${B.policy.cancellation.fee_pct_max}]`,
      })
    }
    const method = cancel.deduct_method
    if (
      method !== undefined &&
      !(B.policy.cancellation.deduct_method as readonly string[]).includes(
        method as string
      )
    ) {
      v.push({
        field: "policy.cancellation.deduct_method",
        message: `cancellation.deduct_method '${String(method)}' not in [${B.policy.cancellation.deduct_method.join(", ")}]`,
      })
    }
  }

  const noShow = policy.no_show as Record<string, unknown> | undefined
  if (noShow && noShow.policy !== undefined) {
    if (
      !(NO_SHOW_POLICIES as readonly string[]).includes(
        noShow.policy as string
      )
    ) {
      v.push({
        field: "policy.no_show.policy",
        message: `no_show.policy '${String(noShow.policy)}' not in [${NO_SHOW_POLICIES.join(", ")}]`,
      })
    }
  }

  if (policy.transferability !== undefined) {
    if (
      !(TRANSFERABILITY_VALUES as readonly string[]).includes(
        policy.transferability as string
      )
    ) {
      v.push({
        field: "policy.transferability",
        message: `transferability '${String(policy.transferability)}' not in [${TRANSFERABILITY_VALUES.join(", ")}]`,
      })
    }
  }

  if (policy.refund_channel !== undefined) {
    if (
      !(REFUND_CHANNELS as readonly string[]).includes(
        policy.refund_channel as string
      )
    ) {
      v.push({
        field: "policy.refund_channel",
        message: `refund_channel '${String(policy.refund_channel)}' not in [${REFUND_CHANNELS.join(", ")}]`,
      })
    }
  }

  return v
}

// ---------------------------------------------------------------------------
// BE-5 — Transferability guard (AC4 / FR1.16)
// ---------------------------------------------------------------------------

/**
 * Redeem context supplied to {@link assertTransferabilityAllowed}.
 *
 * `customer_id` is the identity of the party attempting to redeem the
 * entitlement. May be `null`/`undefined` for anonymous (bearer) flows.
 *
 * `recipient_customer_id` is the identity bound to the instance at ISSUED
 * time (FR1.22 issuance scope). May be `null`/`undefined` when no recipient
 * binding exists (e.g. bearer issuance, or pre-FR1.22 authored rows).
 */
export interface RedeemContext {
  customer_id?: string | null
  recipient_customer_id?: string | null
}

/**
 * Raised when a `personalized` transferability check fails — the redeeming
 * party's identity does not match the bound recipient. Sentry-capturable;
 * fail-loud (never silent-pass). Follows the {@link EntitlementTransitionError}
 * pattern from Story 2.1.
 */
export class TransferabilityError extends Error {
  readonly transferability: Transferability
  readonly redeemCustomerId: string | null
  readonly recipientCustomerId: string | null

  constructor(
    transferability: Transferability,
    redeemCustomerId: string | null,
    recipientCustomerId: string | null
  ) {
    super(
      `Transferability check failed (policy=${transferability}): ` +
        `redeeming customer_id '${redeemCustomerId ?? "none"}' does not match ` +
        `recipient customer_id '${recipientCustomerId ?? "none"}'`
    )
    this.name = "TransferabilityError"
    this.transferability = transferability
    this.redeemCustomerId = redeemCustomerId
    this.recipientCustomerId = recipientCustomerId
  }
}

/**
 * Pure transferability guard for the redemption path (AC4 / FR1.16).
 *
 * Reads `policy_snapshot.transferability` — NEVER the live profile (immutability
 * post-ISSUED, regulamin § 12). Caller must supply the snapshot captured at
 * ISSUED time and the redeem context.
 *
 * Semantics:
 *   `bearer`      — no identity check; anonymous redeem OK (no-op).
 *   `personalized`— redeeming customer_id MUST equal recipient customer_id;
 *                   mismatch or absent identity → throws {@link TransferabilityError}.
 *   `hybrid`      — identity check optional; when known and mismatched → allow
 *                   with soft log (NOT throw); caller receives soft-flag via
 *                   return value.
 *
 * Returns `{ softFlag: true }` when a `hybrid` mismatch was detected (caller
 * may log/audit). Returns `{ softFlag: false }` in all other allowed cases.
 *
 * Authored-vs-applied posture (Story 2.2 M5 precedent): a live redeem
 * entry-point does not yet exist in v1.8.0. This guard is delivered as a
 * tested pure function; wiring happens when the issuance/redeem story lands
 * (tracked dependency — FR1.22 joint Story 1.3 / downstream issuance story).
 */
export function assertTransferabilityAllowed(
  policySnapshot: EntitlementPolicySnapshot,
  redeemContext: RedeemContext
): { softFlag: boolean } {
  const raw = (policySnapshot as Record<string, unknown>).transferability
  const transferability = (raw ?? "bearer") as Transferability

  if (
    transferability !== "bearer" &&
    transferability !== "personalized" &&
    transferability !== "hybrid"
  ) {
    // Data-integrity guard: the snapshot carries an unrecognised enum value.
    // This is a policy-data defect (not an identity-check failure), so we throw
    // a plain Error with the actual offending value rather than misusing
    // TransferabilityError (which is reserved for identity-check rejections).
    throw new Error(
      `assertTransferabilityAllowed: invalid transferability enum '${String(raw)}' ` +
        `in policy_snapshot — expected one of [${TRANSFERABILITY_VALUES.join(", ")}]`
    )
  }

  if (transferability === "bearer") {
    return { softFlag: false }
  }

  const redeemId = redeemContext.customer_id ?? null
  const recipientId = redeemContext.recipient_customer_id ?? null

  if (transferability === "personalized") {
    if (!redeemId || redeemId !== recipientId) {
      throw new TransferabilityError(transferability, redeemId, recipientId)
    }
    return { softFlag: false }
  }

  // hybrid: allow; flag mismatch softly when both IDs are known and differ
  if (redeemId && recipientId && redeemId !== recipientId) {
    return { softFlag: true }
  }
  return { softFlag: false }
}
