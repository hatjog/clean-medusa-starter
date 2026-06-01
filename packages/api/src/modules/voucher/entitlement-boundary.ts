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

// ---------------------------------------------------------------------------
// v1.11.0 Story 1.1 / ADR-136 D-9 — policy-extension enum SSOT (3-copy / NFR4).
//
// Each `export const ... as const` below is a single-source mirror of the
// matching Python tuple in `_grow/tools/validate_entitlement_profiles.py`.
// Set-equality is enforced by `validate_entitlement_boundary_parity.py`
// (extend its CONSTANTS tuple when adding a new pair here). Drift between these
// two files is the most common defect class (cc-2-voucher-coherence).
// ---------------------------------------------------------------------------

/** Allowed `policy.bonus.mode` values (ADR-136 §Decyzja pkt 1). */
export const BONUS_MODES = [
  "none",
  "balance_topup",
  "separate_grant",
  "in_kind",
] as const
export type BonusMode = (typeof BONUS_MODES)[number]

/** Allowed `policy.withdrawal.basis` values (research §6.2 — art. 38 pkt 1). */
export const WITHDRAWAL_BASIS_VALUES = [
  "art_38_pkt_1_full_performance",
] as const
export type WithdrawalBasis = (typeof WITHDRAWAL_BASIS_VALUES)[number]

/** Allowed `policy.withdrawal.terminating_event` values. */
export const WITHDRAWAL_TERMINATING_EVENTS = ["REDEEMED_FULL"] as const
export type WithdrawalTerminatingEvent =
  (typeof WITHDRAWAL_TERMINATING_EVENTS)[number]

/**
 * Allowed `policy.on_expiry_convert_to` values. Forfeiture/przepadek is
 * deliberately absent — it is an abusive clause (art. 385¹ KC) and the
 * defensive FAIL lives in Story 1.2, not here.
 */
export const ON_EXPIRY_CONVERT_TARGETS = [
  "extend",
  "refund",
  "store_credit",
] as const
export type OnExpiryConvertTarget = (typeof ON_EXPIRY_CONVERT_TARGETS)[number]

/** Allowed `policy.kybc.verification_method` values (DSA art. 30 — a+c). */
export const KYBC_VERIFICATION_METHODS = ["a_plus_c", "a", "c"] as const
export type KybcVerificationMethod =
  (typeof KYBC_VERIFICATION_METHODS)[number]

/** Required `policy.kybc` fields for vendor KYBC completeness (DSA art. 30). */
export const KYBC_REQUIRED_FIELDS = [
  "traceability_required",
  "legal_name_collected",
  "registration_number_collected",
  "contact_details_collected",
  "payment_account_collected",
  "self_certification_collected",
  "verification_method",
  "retention_months",
] as const
export type KybcRequiredField = (typeof KYBC_REQUIRED_FIELDS)[number]

/** Allowed `policy.regulatory_basis.kind` values (EMI — ADR-134 capability). */
export const REGULATORY_BASIS_KINDS = [
  "emi_license_ref",
  "emi_agent_ref",
] as const
export type RegulatoryBasisKind = (typeof REGULATORY_BASIS_KINDS)[number]

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
    // --- v1.11.0 Story 1.1 / ADR-136 D-9 additions ---
    withdrawal: {
      basis: WITHDRAWAL_BASIS_VALUES,
      terminating_event: WITHDRAWAL_TERMINATING_EVENTS,
    },
    renewal: {
      /** reminder_before_renewal_days domain [1, 90]. */
      reminder_days_min: 1,
      reminder_days_max: 90,
    },
    bonus: {
      /** Allowed bonus mode enum values. */
      mode: BONUS_MODES,
    },
    /** reissue validity floor (days, inclusive minimum). */
    reissue_validity_floor_days_min: 30,
    /** Allowed on_expiry conversion targets (forfeiture excluded). */
    on_expiry_convert_to: ON_EXPIRY_CONVERT_TARGETS,
    kybc: {
      /** Allowed KYBC verification methods (DSA art. 30). */
      verification_method: KYBC_VERIFICATION_METHODS,
      /** Required KYBC fields when a vendor profile declares `policy.kybc`. */
      required_fields: KYBC_REQUIRED_FIELDS,
      /** KYBC data retention floor (months, inclusive minimum). */
      retention_months_min: 6,
    },
    regulatory_basis: {
      /** Allowed regulatory basis kinds (EMI). */
      kind: REGULATORY_BASIS_KINDS,
    },
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

  // --- v1.11.0 Story 1.1 / ADR-136 D-9 — new policy fields (mirror of the
  //     Python governance gate `_check_policy_boundary`). Pure + enum/bound
  //     checks only; absent fields are a no-op (additive, optional). ---
  const inEnum = (vals: readonly string[], x: unknown): boolean =>
    vals.includes(x as string)

  const withdrawal = policy.withdrawal as Record<string, unknown> | undefined
  if (withdrawal) {
    if (
      withdrawal.basis !== undefined &&
      !inEnum(WITHDRAWAL_BASIS_VALUES, withdrawal.basis)
    ) {
      v.push({
        field: "policy.withdrawal.basis",
        message: `withdrawal.basis '${String(withdrawal.basis)}' not in [${WITHDRAWAL_BASIS_VALUES.join(", ")}]`,
      })
    }
    if (
      withdrawal.terminating_event !== undefined &&
      !inEnum(WITHDRAWAL_TERMINATING_EVENTS, withdrawal.terminating_event)
    ) {
      v.push({
        field: "policy.withdrawal.terminating_event",
        message: `withdrawal.terminating_event '${String(withdrawal.terminating_event)}' not in [${WITHDRAWAL_TERMINATING_EVENTS.join(", ")}]`,
      })
    }
  }

  const renewal = policy.renewal as Record<string, unknown> | undefined
  if (renewal && renewal.reminder_before_renewal_days !== undefined) {
    const rd = num(renewal.reminder_before_renewal_days)
    if (
      rd === undefined ||
      rd < B.policy.renewal.reminder_days_min ||
      rd > B.policy.renewal.reminder_days_max
    ) {
      v.push({
        field: "policy.renewal.reminder_before_renewal_days",
        message: `renewal.reminder_before_renewal_days ${String(renewal.reminder_before_renewal_days)} outside [${B.policy.renewal.reminder_days_min}, ${B.policy.renewal.reminder_days_max}]`,
      })
    }
  }

  const bonus = policy.bonus as Record<string, unknown> | undefined
  if (
    bonus &&
    bonus.mode !== undefined &&
    !inEnum(B.policy.bonus.mode, bonus.mode)
  ) {
    v.push({
      field: "policy.bonus.mode",
      message: `bonus.mode '${String(bonus.mode)}' not in [${B.policy.bonus.mode.join(", ")}]`,
    })
  }

  if (policy.reissue_validity_floor_days !== undefined) {
    const rf = num(policy.reissue_validity_floor_days)
    if (rf === undefined || rf < B.policy.reissue_validity_floor_days_min) {
      v.push({
        field: "policy.reissue_validity_floor_days",
        message: `reissue_validity_floor_days ${String(policy.reissue_validity_floor_days)} below minimum ${B.policy.reissue_validity_floor_days_min}`,
      })
    }
  }

  if (
    policy.on_expiry_convert_to !== undefined &&
    !inEnum(B.policy.on_expiry_convert_to, policy.on_expiry_convert_to)
  ) {
    v.push({
      field: "policy.on_expiry_convert_to",
      message: `on_expiry_convert_to '${String(policy.on_expiry_convert_to)}' not in [${B.policy.on_expiry_convert_to.join(", ")}] (forfeiture excluded — defensive FAIL in Story 1.2)`,
    })
  }

  const kybc = policy.kybc as Record<string, unknown> | undefined
  if (kybc) {
    const missing = B.policy.kybc.required_fields.filter(
      (field) => kybc[field] === undefined
    )
    if (missing.length > 0) {
      v.push({
        field: "policy.kybc",
        message: `kybc missing required fields for DSA art. 30 (FR50.6): [${missing.join(", ")}]`,
      })
    }
    if (
      kybc.verification_method !== undefined &&
      !inEnum(B.policy.kybc.verification_method, kybc.verification_method)
    ) {
      v.push({
        field: "policy.kybc.verification_method",
        message: `kybc.verification_method '${String(kybc.verification_method)}' not in [${B.policy.kybc.verification_method.join(", ")}]`,
      })
    }
    if (kybc.retention_months !== undefined) {
      const rm = num(kybc.retention_months)
      if (rm === undefined || rm < B.policy.kybc.retention_months_min) {
        v.push({
          field: "policy.kybc.retention_months",
          message: `kybc.retention_months ${String(kybc.retention_months)} below minimum ${B.policy.kybc.retention_months_min} (DSA art. 30)`,
        })
      }
    }
  }

  const regulatory = policy.regulatory_basis as
    | Record<string, unknown>
    | undefined
  if (
    regulatory &&
    regulatory.kind !== undefined &&
    !inEnum(B.policy.regulatory_basis.kind, regulatory.kind)
  ) {
    v.push({
      field: "policy.regulatory_basis.kind",
      message: `regulatory_basis.kind '${String(regulatory.kind)}' not in [${B.policy.regulatory_basis.kind.join(", ")}]`,
    })
  }

  // Boolean policy toggles (consent_snapshot, auto_renew, payment_gating, …)
  // are type-checked at the schema layer (copy 1); the runtime boundary cares
  // only about enum membership + numeric bounds.

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
