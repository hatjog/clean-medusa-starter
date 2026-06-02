/**
 * voucher module — entitlement 4-layer model (ADR-099 / D-V180-ARCH-6).
 *
 * Story v180-2-1 (Entitlement_Profile Schema + ADR-099 4-Layer Model, BE-10).
 *
 * This file implements the as-built 4-layer model (epics.md Story 2.1 +
 * architecture.md D-V180-ARCH-6 line 495-504 + Story 0.17 schema substrate):
 *
 *   Layer 1 — entitlement_type   : canonical 6-value taxonomy (this file)
 *   Layer 2 — entitlement_boundary: hardcoded platform maxima/minima
 *                                   (see ./entitlement-boundary.ts)
 *   Layer 3 — entitlement_profile : per-market declarative config (YAML —
 *                                   gp-ops market.yaml `entitlement_profiles:`)
 *   Layer 4 — entitlement_instance: runtime per-order snapshot + state machine
 *                                   (this file + create_entitlement_profiles
 *                                   _section migration)
 *
 * Live issue (Stripe webhook Path Y) is Epic 1 Story 1.3 FR1.22 scope — this
 * story delivers only the model + enum + state machine target, NOT the
 * subscriber/workflow.
 */

import type { VatClassification } from "../vat-resolver"

// ---------------------------------------------------------------------------
// Layer 1 — entitlement_type canonical taxonomy
// ---------------------------------------------------------------------------

/**
 * Canonical platform-wide entitlement type taxonomy (6 values).
 *
 * Immutable platform-wide: new types require an ADR + PR (ADR-099). The string
 * values are 1:1 with the `entitlement_type` enum in
 * specs/contracts/config/schemas/market-config.v1.schema.json
 * (properties.entitlement_profiles.items.properties.entitlement_type.enum).
 *
 * v1.8.0 activates VOUCHER_AMOUNT + VOUCHER_SERVICE only (BonBeauty MVP). The
 * other 4 are defined-but-inactive: present in the taxonomy for forward schema
 * stability but MUST NOT surface in UI/runtime (guard via
 * ACTIVE_ENTITLEMENT_TYPES below). Named retry slots v1.9.0/v1.10.0+ per
 * D-V180-ARCH-DEF-8.
 */
export enum EntitlementType {
  VOUCHER_AMOUNT = "VOUCHER_AMOUNT",
  VOUCHER_SERVICE = "VOUCHER_SERVICE",
  // --- inactive in v1.8.0 (defined-but-not-activated) ---
  CREDIT_PACK = "CREDIT_PACK",
  SUBSCRIPTION_B2C = "SUBSCRIPTION_B2C",
  SUBSCRIPTION_B2B = "SUBSCRIPTION_B2B",
  BUNDLE = "BUNDLE",
}

/** All 6 canonical types in schema-declared order. */
export const ALL_ENTITLEMENT_TYPES: readonly EntitlementType[] = [
  EntitlementType.VOUCHER_AMOUNT,
  EntitlementType.VOUCHER_SERVICE,
  EntitlementType.CREDIT_PACK,
  EntitlementType.SUBSCRIPTION_B2C,
  EntitlementType.SUBSCRIPTION_B2B,
  EntitlementType.BUNDLE,
]

/**
 * Types activated in v1.8.0. Anything outside this whitelist is
 * defined-but-inactive and MUST NOT appear in UI/runtime flows.
 */
export const ACTIVE_ENTITLEMENT_TYPES: ReadonlySet<EntitlementType> = new Set([
  EntitlementType.VOUCHER_AMOUNT,
  EntitlementType.VOUCHER_SERVICE,
])

/** Defined-but-inactive types (CREDIT_PACK / SUBSCRIPTION_* / BUNDLE). */
export const INACTIVE_ENTITLEMENT_TYPES: ReadonlySet<EntitlementType> = new Set(
  ALL_ENTITLEMENT_TYPES.filter((t) => !ACTIVE_ENTITLEMENT_TYPES.has(t))
)

/** True iff `t` is activated in v1.8.0 (BonBeauty MVP). */
export function isActiveEntitlementType(t: EntitlementType): boolean {
  return ACTIVE_ENTITLEMENT_TYPES.has(t)
}

/** Narrowing guard: is `v` one of the 6 canonical taxonomy values? */
export function isEntitlementType(v: unknown): v is EntitlementType {
  return (
    typeof v === "string" &&
    (ALL_ENTITLEMENT_TYPES as readonly string[]).includes(v)
  )
}

// ---------------------------------------------------------------------------
// Layer 4 — entitlement_instance state machine
// ---------------------------------------------------------------------------

/**
 * Runtime per-order entitlement instance state.
 *
 * Core path:
 *   ISSUED → ACTIVE → REDEMPTION_REQUESTED →
 *   REDEEMED_PARTIAL | REDEEMED_FULL → SETTLED → CLOSED
 *
 * Exception states: VOIDED / EXPIRED / REFUND_REQUESTED / REFUNDED / DISPUTED.
 */
export enum EntitlementInstanceState {
  // --- core path ---
  ISSUED = "ISSUED",
  ACTIVE = "ACTIVE",
  REDEMPTION_REQUESTED = "REDEMPTION_REQUESTED",
  REDEEMED_PARTIAL = "REDEEMED_PARTIAL",
  REDEEMED_FULL = "REDEEMED_FULL",
  SETTLED = "SETTLED",
  CLOSED = "CLOSED",
  // --- exception states ---
  VOIDED = "VOIDED",
  EXPIRED = "EXPIRED",
  REFUND_REQUESTED = "REFUND_REQUESTED",
  REFUNDED = "REFUNDED",
  DISPUTED = "DISPUTED",
  // --- Story 2.7 BE-6: vendor-decision no-show holding state ---
  PENDING_VENDOR_DECISION = "PENDING_VENDOR_DECISION",
}

/** All instance states (DB CHECK constraint source-of-truth). */
export const ALL_ENTITLEMENT_INSTANCE_STATES: readonly EntitlementInstanceState[] =
  [
    EntitlementInstanceState.ISSUED,
    EntitlementInstanceState.ACTIVE,
    EntitlementInstanceState.REDEMPTION_REQUESTED,
    EntitlementInstanceState.REDEEMED_PARTIAL,
    EntitlementInstanceState.REDEEMED_FULL,
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.EXPIRED,
    EntitlementInstanceState.REFUND_REQUESTED,
    EntitlementInstanceState.REFUNDED,
    EntitlementInstanceState.DISPUTED,
    EntitlementInstanceState.PENDING_VENDOR_DECISION,
  ]

/** Terminal states — no outbound transitions. */
export const TERMINAL_ENTITLEMENT_STATES: ReadonlySet<EntitlementInstanceState> =
  new Set([
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.REFUNDED,
  ])

/**
 * Allowed state transitions. A transition is permitted iff the target state is
 * in `ALLOWED_ENTITLEMENT_TRANSITIONS[from]`. Exception states are reachable
 * from any non-terminal core state (void/expire/dispute can happen anytime).
 */
export const ALLOWED_ENTITLEMENT_TRANSITIONS: Readonly<
  Record<EntitlementInstanceState, readonly EntitlementInstanceState[]>
> = {
  [EntitlementInstanceState.ISSUED]: [
    EntitlementInstanceState.ACTIVE,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.EXPIRED,
  ],
  [EntitlementInstanceState.ACTIVE]: [
    EntitlementInstanceState.REDEMPTION_REQUESTED,
    EntitlementInstanceState.EXPIRED,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.REFUND_REQUESTED,
    EntitlementInstanceState.DISPUTED,
    EntitlementInstanceState.PENDING_VENDOR_DECISION, // BE-6 vendor_decision no-show
  ],
  [EntitlementInstanceState.REDEMPTION_REQUESTED]: [
    EntitlementInstanceState.REDEEMED_PARTIAL,
    EntitlementInstanceState.REDEEMED_FULL,
    EntitlementInstanceState.ACTIVE, // redemption request withdrawn
    EntitlementInstanceState.DISPUTED,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.PENDING_VENDOR_DECISION, // BE-6 vendor_decision no-show
  ],
  [EntitlementInstanceState.REDEEMED_PARTIAL]: [
    EntitlementInstanceState.REDEMPTION_REQUESTED, // further redemption
    EntitlementInstanceState.REDEEMED_FULL,
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.REFUND_REQUESTED,
    EntitlementInstanceState.DISPUTED,
  ],
  [EntitlementInstanceState.REDEEMED_FULL]: [
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.REFUND_REQUESTED,
    EntitlementInstanceState.DISPUTED,
  ],
  [EntitlementInstanceState.SETTLED]: [
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.REFUND_REQUESTED,
    EntitlementInstanceState.DISPUTED,
  ],
  [EntitlementInstanceState.CLOSED]: [],
  [EntitlementInstanceState.VOIDED]: [],
  [EntitlementInstanceState.EXPIRED]: [
    EntitlementInstanceState.REFUND_REQUESTED,
    EntitlementInstanceState.CLOSED,
  ],
  [EntitlementInstanceState.REFUND_REQUESTED]: [
    EntitlementInstanceState.REFUNDED,
    EntitlementInstanceState.DISPUTED,
    EntitlementInstanceState.ACTIVE, // refund denied → restored
  ],
  [EntitlementInstanceState.REFUNDED]: [],
  [EntitlementInstanceState.DISPUTED]: [
    EntitlementInstanceState.ACTIVE, // dispute resolved in customer's favour
    EntitlementInstanceState.REFUNDED,
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.VOIDED,
  ],
  // BE-6 Story 2.7: vendor-decision holding state — full resolution UI is v1.9.0+
  [EntitlementInstanceState.PENDING_VENDOR_DECISION]: [
    EntitlementInstanceState.VOIDED,        // vendor confirms forfeiture
    EntitlementInstanceState.ACTIVE,        // vendor waives no-show
    EntitlementInstanceState.REDEEMED_PARTIAL, // vendor allows partial redemption
    EntitlementInstanceState.REDEEMED_FULL,    // vendor allows full redemption
  ],
}

/** True iff `from → to` is an allowed entitlement-instance transition. */
export function canTransition(
  from: EntitlementInstanceState,
  to: EntitlementInstanceState
): boolean {
  return (ALLOWED_ENTITLEMENT_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Assert a state transition is legal. Throws {@link EntitlementTransitionError}
 * with the offending pair if not. Use this as the single guard before any
 * persisted state change (Epic 1 Story 1.3 issue/redeem workflows consume it).
 */
export function assertTransition(
  from: EntitlementInstanceState,
  to: EntitlementInstanceState
): void {
  if (!canTransition(from, to)) {
    throw new EntitlementTransitionError(from, to)
  }
}

/** Raised when an illegal entitlement-instance state transition is attempted. */
export class EntitlementTransitionError extends Error {
  readonly from: EntitlementInstanceState
  readonly to: EntitlementInstanceState
  constructor(
    from: EntitlementInstanceState,
    to: EntitlementInstanceState
  ) {
    super(
      `Illegal entitlement_instance transition: ${from} → ${to}. ` +
        `Allowed from ${from}: [${(
          ALLOWED_ENTITLEMENT_TRANSITIONS[from] ?? []
        ).join(", ")}]`
    )
    this.name = "EntitlementTransitionError"
    this.from = from
    this.to = to
  }
}

// ---------------------------------------------------------------------------
// Layer 4 — policy snapshot (immutability post-ISSUED, regulamin § 12)
// ---------------------------------------------------------------------------

/**
 * Layer 3 policy block snapshotted onto the instance at ISSUED time. Shape is
 * intentionally open (mirrors the market.yaml `entitlement_profiles[].policy`
 * object); the authoritative schema lives in
 * specs/contracts/config/schemas/market-config.v1.schema.json. The snapshot is
 * stored verbatim so post-issue profile edits never retroactively alter an
 * already-issued entitlement (regulamin § 12 immutability invariant).
 */
export type EntitlementPolicySnapshot = Readonly<Record<string, unknown>>

/**
 * Produce the immutable policy snapshot taken at ISSUED time. Returns a deeply
 * frozen structural clone so callers cannot mutate the profile-derived policy
 * after issue.
 */
export function snapshotPolicy(
  policy: Record<string, unknown>
): EntitlementPolicySnapshot {
  return deepFreeze(structuredClone(policy))
}

/**
 * Enforce the post-ISSUED immutability invariant: once an instance has left
 * ISSUED, its `policy_snapshot` MUST equal the value captured at issue time.
 * Throws if a caller attempts to swap the snapshot on a non-ISSUED instance.
 *
 * Equality is `JSON.stringify`-based and therefore key-order sensitive. This
 * is safe by construction because every snapshot is produced by
 * {@link snapshotPolicy} → `structuredClone`, which preserves the source key
 * order, so equal snapshots always serialise identically. Known limitation: a
 * future caller that hand-builds a snapshot with reordered keys would get a
 * false immutability violation — switch to a structural deep-equal if that
 * call pattern is introduced (Epic 1 Story 1.3 live issue/redeem workflows).
 */
export function assertPolicySnapshotImmutable(
  state: EntitlementInstanceState,
  issuedSnapshot: EntitlementPolicySnapshot,
  candidateSnapshot: EntitlementPolicySnapshot
): void {
  if (state === EntitlementInstanceState.ISSUED) return
  if (
    JSON.stringify(issuedSnapshot) !== JSON.stringify(candidateSnapshot)
  ) {
    throw new Error(
      "entitlement_instance.policy_snapshot is immutable after ISSUED " +
        "(regulamin § 12) — attempted to change the snapshot on a " +
        `${state} instance`
    )
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) {
      deepFreeze(v)
    }
  }
  return o
}

// ---------------------------------------------------------------------------
// Layer 4 — auto_redeem policy (BE-8 / Story 2.9, as-built Story 0.17 substrate)
// ---------------------------------------------------------------------------

/**
 * Drift-reconcile: epics.md Story 2.9 narrates `policy.auto_redeem_on_booking: bool`
 * as a shorthand. The as-built schema (Story 0.17, market-config.v1.schema.json ~335-344)
 * uses `auto_redeem: { enabled: bool (required), trigger?: enum }`. This type
 * captures the as-built shape and is read exclusively from `policy_snapshot`
 * (immutability post-ISSUED, regulamin § 12 — never re-resolved from live profile).
 */
export type AutoRedeemPolicy = {
  enabled: boolean
  trigger?: "on_appointment_confirm" | "on_service_complete" | "manual_only"
}

// Booking-confirmation trigger set (BE-8 scope).
// on_service_complete and manual_only are explicitly out-of-scope for booking-confirm.
// Using a Set for extensibility: if new booking-confirmation trigger variants are added
// to the market-config.v1.schema.json enum in a future story, extend this set.
// (With a single element a direct `=== "on_appointment_confirm"` check would be
// simpler, but the Set pattern is preferred here for forward compatibility — I1.)
const BOOKING_CONFIRM_TRIGGERS: ReadonlySet<string> = new Set([
  "on_appointment_confirm",
])

/**
 * Pure predicate: should this entitlement auto-redeem when a booking-confirmation
 * event is received?
 *
 * Returns true iff `policy_snapshot.auto_redeem.enabled === true` AND
 * `trigger` is in the booking-confirmation trigger set (`on_appointment_confirm`).
 *
 * Drift mapping: `auto_redeem_on_booking=true` (epics narrative) ≡
 * `auto_redeem.enabled=true` + `trigger ∈ {on_appointment_confirm}` (as-built).
 */
export function shouldAutoRedeemOnBookingConfirm(
  policySnapshot: EntitlementPolicySnapshot
): boolean {
  const ar = (policySnapshot as Record<string, unknown>)
    .auto_redeem as AutoRedeemPolicy | undefined
  return (
    ar?.enabled === true &&
    ar.trigger !== undefined &&
    BOOKING_CONFIRM_TRIGGERS.has(ar.trigger)
  )
}

// ---------------------------------------------------------------------------
// Layer 4 — entitlement_instance row type (matches migration DDL)
// ---------------------------------------------------------------------------

/**
 * Persisted shape of the `entitlement_instance` table. `order_id` is nullable
 * until Epic 1 Story 1.3 FR1.22 wires live issue post-payment.
 */
export interface EntitlementInstanceRow {
  id: string
  entitlement_profile_id: string
  entitlement_type: EntitlementType
  /** Nullable until Epic 1 Story 1.3 wires live issue post-payment. */
  order_id: string | null
  /**
   * Ontologia scope (Story 3.2, FR21). Live-wystawiona encja (order_id != null)
   * MUSI nieść niepuste market_id + sales_channel_id (CHECK fail-closed, NFR3);
   * legacy/authored (order_id null) zwolnione. Nullable na poziomie typu dla
   * wierszy legacy.
   */
  market_id: string | null
  /** Ontologia scope (Story 3.2, FR21) — patrz market_id. */
  sales_channel_id: string | null
  /**
   * Snapshot klasyfikacji VAT (SPV/MPV). Kolumnę dodaje Story 3.2; WYPEŁNIENIE
   * (snapshot przy ISSUED + inwariant niereklasyfikacji, FR32) = Story 3.3.
   * Null do czasu snapshotu.
   */
  vat_classification: VatClassification | null
  state: EntitlementInstanceState
  // BE-2 (Story 2.3): active service-booking pointer; reset on cancel_booking.
  booking_pointer: string | null
  /** Immutable policy block snapshotted at ISSUED time (regulamin § 12). */
  policy_snapshot: EntitlementPolicySnapshot
  /** Nullable only for legacy/authored rows before Story 2.2 migration apply. */
  expires_at: Date | null
  /** Count of free extensions used; BE-1 allows max one unpaid extension. */
  unpaid_extension_count: number
  /**
   * Remaining value in minor currency units. Null until migration applied.
   * Set at ISSUED time from the voucher face value; reduced on partial fees
   * (BE-6 charge_partial / charge_full) and partial redemptions. Clamped >= 0.
   * Source: architecture.md D-V180-ARCH-6 (ADR-099 4-layer) — BE-6 no-show partial fee.
   */
  remaining_amount: number | null
  created_at: Date
  updated_at: Date
}
