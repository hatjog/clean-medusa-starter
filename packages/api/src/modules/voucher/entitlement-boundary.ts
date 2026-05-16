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

import { EntitlementType } from "./models/entitlement"

/** Allowed `policy.no_show.policy` values (platform-wide enum). */
export const NO_SHOW_POLICIES = [
  "charge_full",
  "charge_partial",
  "no_charge",
  "forfeit_voucher",
] as const
export type NoShowPolicy = (typeof NO_SHOW_POLICIES)[number]

/** Allowed `policy.refund_channel` values (platform-wide enum). */
export const REFUND_CHANNELS = [
  "original_payment",
  "store_credit",
  "bank_transfer",
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
      /** refund_pct domain is 0..100. */
      refund_pct_max: 100,
      refund_pct_min: 0,
    },
    no_show: {
      /** Allowed no-show policy enum values. */
      policy: NO_SHOW_POLICIES,
      charge_pct_min: 0,
      charge_pct_max: 100,
    },
    transferability: {
      /** max_transfers must be a non-negative integer. */
      max_transfers_min: 0,
    },
    /** Allowed refund channel enum values. */
    refund_channel: REFUND_CHANNELS,
  },
} as const

/** Lost-code recovery is admin-triggered and platform-wide in v1.8.0. */
export const LOST_CODE_REISSUE_WINDOW_DAYS = 30

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
    const refund = num(cancel.refund_pct)
    if (
      refund !== undefined &&
      (refund < B.policy.cancellation.refund_pct_min ||
        refund > B.policy.cancellation.refund_pct_max)
    ) {
      v.push({
        field: "policy.cancellation.refund_pct",
        message: `cancellation.refund_pct ${refund} outside [${B.policy.cancellation.refund_pct_min}, ${B.policy.cancellation.refund_pct_max}]`,
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

  const transfer = policy.transferability as
    | Record<string, unknown>
    | undefined
  if (transfer) {
    const maxT = num(transfer.max_transfers)
    if (
      maxT !== undefined &&
      (maxT < B.policy.transferability.max_transfers_min ||
        !Number.isInteger(maxT))
    ) {
      v.push({
        field: "policy.transferability.max_transfers",
        message: `transferability.max_transfers ${maxT} must be a non-negative integer`,
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
