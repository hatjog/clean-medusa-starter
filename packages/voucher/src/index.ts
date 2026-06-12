/**
 * @gp/voucher — shared read-model contracts for GP voucher/entitlement domain.
 *
 * Design note (M-2 fix): this package must remain a leaf package with no
 * runtime dependencies on `packages/api/src` (which would invert the
 * dependency graph). L4 canonical types (EntitlementType / EntitlementInstanceState)
 * are intentionally mirrored here as string-literal unions derived from the
 * L4 canonical enum values. A structural conformance comment below documents
 * the source-of-truth: `packages/api/src/modules/voucher/models/entitlement.ts`.
 *
 * If L4 enum values change, update both the L4 source AND the mirrors here.
 * The mirror must match the L4 canonical at all times (ADR-099 / ADR-143).
 */

// ---------------------------------------------------------------------------
// L4 canonical mirrors — SSOT: packages/api/src/modules/voucher/models/entitlement.ts
// Do NOT diverge from the values in EntitlementType / EntitlementInstanceState
// defined there. These are string-literal mirrors, not independent definitions.
// ---------------------------------------------------------------------------

/**
 * Mirror of L4 `EntitlementType` enum values.
 * Source: `packages/api/src/modules/voucher/models/entitlement.ts` (ADR-099).
 */
export type EntitlementTypeValue =
  | "VOUCHER_AMOUNT"
  | "VOUCHER_SERVICE"
  | "CREDIT_PACK"
  | "SUBSCRIPTION_B2C"
  | "SUBSCRIPTION_B2B"
  | "BUNDLE"

/**
 * Mirror of L4 `EntitlementInstanceState` enum values.
 * Source: `packages/api/src/modules/voucher/models/entitlement.ts` (ADR-099).
 */
export type EntitlementInstanceStateValue =
  | "ISSUED"
  | "ACTIVE"
  | "REDEMPTION_REQUESTED"
  | "REDEEMED_PARTIAL"
  | "REDEEMED_FULL"
  | "SETTLED"
  | "CLOSED"
  | "VOIDED"
  | "EXPIRED"
  | "REFUND_REQUESTED"
  | "REFUNDED"
  | "DISPUTED"
  | "PENDING_VENDOR_DECISION"

// ---------------------------------------------------------------------------
// Shared wallet-metadata types (wallet-projection fields; not present in L4)
// ---------------------------------------------------------------------------

export type LocalizedWalletText =
  | string
  | Partial<Record<string, string>>
  | Record<string, string>

export type EntitlementInstanceWalletMetadata = {
  code?: string
  title?: LocalizedWalletText
  entitlement_type?: string
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED"
  expires_at?: string | Date | null
  salon_name?: string
  salon_address?: string
  deep_link?: string
  barcode_spec?: {
    format: "QR" | "PDF417"
    value: string
  }
  branding?: {
    logo_url?: string
    primary_color?: string
    accent_color?: string
  }
  latitude?: number
  longitude?: number
}

// ---------------------------------------------------------------------------
// EntitlementInstance read-model
//
// Derive discipline (ADR-143 / L-1 fix):
//   - id          : string (L4 canonical field)
//   - market_id   : string | null (mirrors EntitlementInstanceRow["market_id"])
//   - state       : EntitlementInstanceStateValue | string (mirrors L4 state enum)
//   - expires_at  : Date | string | null (mirrors L4 expires_at shape)
//   - entitlement_type: EntitlementTypeValue | string (mirrors L4 entitlement_type enum — L-1 fix)
//   - status      : wallet-projection subset (not in L4 state machine; wallet-only concept)
//   - remaining fields: wallet-projection fields (salon_name, branding, etc.) absent from L4
// ---------------------------------------------------------------------------

export type EntitlementInstance = {
  /** L4 canonical primary key. */
  id: string
  code?: string
  title?: LocalizedWalletText
  /** Mirrors L4 `EntitlementInstanceRow["market_id"]` (string | null). */
  market_id?: string | null
  /**
   * Mirrors L4 `EntitlementType` enum values (EntitlementTypeValue).
   * Use `EntitlementTypeValue` for exhaustive checks. The `| string` broadening
   * covers wallet-projection callers that map raw DB strings.
   */
  entitlement_type?: EntitlementTypeValue | string
  /**
   * Wallet-projection lifecycle status (subset of L4 states relevant to wallet
   * rendering). Distinct from `state` (full L4 state machine value).
   */
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED"
  /**
   * Mirrors L4 `EntitlementInstanceState` enum values.
   * The `| string` broadening covers callers that hold raw DB strings.
   */
  state?: EntitlementInstanceStateValue | string
  /** Mirrors L4 `EntitlementInstanceRow["expires_at"]` (Date | null), with `| string` for serialised forms. */
  expires_at?: Date | string | null
  salon_name?: string
  salon_address?: string
  deep_link?: string
  barcode_spec?: EntitlementInstanceWalletMetadata["barcode_spec"]
  branding?: EntitlementInstanceWalletMetadata["branding"]
  latitude?: number
  longitude?: number
  metadata?: {
    wallet?: EntitlementInstanceWalletMetadata
    gp?: {
      market_id?: string
      entitlement_type?: string
      wallet?: EntitlementInstanceWalletMetadata
    }
  } & Record<string, unknown>
}

export interface EntitlementInstanceReadModel {
  getById(entitlement_instance_id: string): Promise<EntitlementInstance | null>
}
