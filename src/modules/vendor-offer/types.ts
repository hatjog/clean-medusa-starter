/**
 * vendor-offer/types.ts — typed contracts for the multi-vendor-per-product
 * foundation (v1.5.0 schema-only per ADR-070).
 *
 * @see ADR-070 — Multi-vendor-per-product foundation promotion + vendor selection policy.
 * @see _bmad-output/implementation-artifacts/v150/STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA.md
 *
 * v1.5.0 behavior (flag-off, multi_vendor_pricing_enabled=false):
 *   - These types describe the on-disk schema landed by the SQL migrations
 *     1777504097_vendor_offer_table.sql + 1777504098_cart_item_selected_vendor_offer.sql.
 *   - The service-layer write path is GUARDED — see vendor-offer.service.ts
 *     (every CRUD method throws if the runtime feature flag is enabled).
 *   - Flag-off semantics: callsites continue to read product.seller_id; the
 *     vendor_offer table exists but is read-only at the service layer until
 *     v1.6.0 flag-flip release.
 *
 * v1.6.0 follow-up (NOT in this story):
 *   - Flag flip enables the runtime selection mechanism + populates the
 *     cart_item.selected_vendor_offer_id FK; STORY-MIG-C3 zero-violations
 *     gate then promotes the FK to NOT NULL.
 *
 * Field strategy:
 *   - Adding optional fields = additive-MINOR (safe).
 *   - Renaming or removing fields = MAJOR (forces consumer migration).
 *   - Adding lifecycle states = MAJOR (consumers exhaustively switch).
 */

/**
 * VendorOfferLifecycleState — discriminator for the lifecycle state machine.
 *
 * Pattern: NIE soft-delete (per ADR-074 tri-state). 'archived' is the
 * terminal state; rows are NEVER deleted from disk.
 *
 * Transitions (see lifecycle.ts):
 *   active     → suspended   (vendor opt-out / temporary unavailability)
 *   active     → archived    (vendor permanent off-boarding)
 *   suspended  → active      (vendor opt-back-in)
 *   suspended  → archived    (escalation after stabilization window)
 *   archived   → (terminal — no further transitions allowed)
 */
export type VendorOfferLifecycleState = "active" | "suspended" | "archived"

/**
 * VendorOffer — read-side projection of the vendor_offer table row.
 *
 * @see Migration 1777504097_vendor_offer_table.sql
 *
 * v1.6.0 may extend with a `breakage_policy_override` discriminator (per
 * ADR-070 §10.3 + mor-policy `BreakagePolicy`). Adding optional fields is
 * additive-MINOR.
 */
export interface VendorOffer {
  id: string
  vendor_id: string
  product_id: string
  /**
   * Per-offer price — minor-units NOT used; full numeric (NUMERIC(18,4)) per
   * the SQL migration. Service layer handles rounding to currency-specific
   * scale at runtime (v1.6.0 only).
   */
  price: number
  /**
   * Available seat capacity for this offer. Per-vendor seat scoping per
   * ADR-073 (referenced via ADR-070 coupling matrix).
   */
  seat_capacity: number
  status: VendorOfferLifecycleState
  /**
   * Incumbent marker — denormalized convenience column used by the flag-off
   * fast-path (incumbent vendor reads). Per Security Audit elicitation #23,
   * toggling this column requires a separately granted DB role permission;
   * the v1.5.0 service layer is service-layer guarded only.
   */
  incumbent_marker: boolean
  /**
   * Per-offer signature — D-78 MoR runtime gate. Used by
   * validate_mor_per_offer_capability.py to verify settlement attribution
   * paths can hash a stable per-offer identity (NIE per-vendor, NIE per-product).
   */
  signature: string
  /**
   * Optimistic-locking version. Service layer MUST bump this on every UPDATE
   * with a `WHERE version = $expected` guard. Concurrent writers receive
   * VendorOfferConflictError.
   */
  version: number
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

/**
 * VendorOfferDraft — input shape for create operations.
 *
 * The service layer derives `signature`, `version=0`, and validates
 * `incumbent_marker` against the per-product-per-vendor uniqueness index.
 */
export interface VendorOfferDraft {
  vendor_id: string
  product_id: string
  price: number
  seat_capacity: number
  status?: VendorOfferLifecycleState // defaults to 'active'
  incumbent_marker?: boolean // defaults to false
  signature: string
}

/**
 * VendorOfferUpdate — input shape for partial update operations. Optimistic
 * locking is enforced via the `expected_version` field (NIE optional) — every
 * caller MUST read the current version before mutating.
 */
export interface VendorOfferUpdate {
  id: string
  expected_version: number
  patch: {
    price?: number
    seat_capacity?: number
    status?: VendorOfferLifecycleState
    incumbent_marker?: boolean
    signature?: string
  }
}

/**
 * VendorOfferErrorCode — discriminated error class codes.
 *
 * @see VendorOfferError
 */
export type VendorOfferErrorCode =
  | "RUNTIME_DISABLED"
  | "INVALID_TRANSITION"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "DUPLICATE_OFFER"
  | "INVALID_DRAFT"

/**
 * VendorOfferError — discriminated error for vendor-offer service failures.
 *
 * v1.5.0 service throws `RUNTIME_DISABLED` for every write call when the
 * feature flag is on (defensive guard); v1.6.0 unlocks the write path.
 */
export class VendorOfferError extends Error {
  public readonly code: VendorOfferErrorCode
  public readonly context?: Record<string, unknown>

  constructor(args: {
    code: VendorOfferErrorCode
    message: string
    context?: Record<string, unknown>
  }) {
    super(args.message)
    this.name = "VendorOfferError"
    this.code = args.code
    this.context = args.context
    Object.setPrototypeOf(this, VendorOfferError.prototype)
  }
}
