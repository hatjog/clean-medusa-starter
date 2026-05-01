/**
 * vendor-offer/lifecycle.ts — state machine + transition guards for
 * VendorOfferLifecycleState (v1.5.0 schema-only).
 *
 * @see ADR-070 — vendor-selection-policy.
 * @see ADR-074 — tri-state-flag-semantics (composite state pattern).
 * @see types.ts — VendorOfferLifecycleState union.
 *
 * Transition matrix (frozen by AC-MVF-4.1-02, AC-MVF-4.1-03):
 *
 *   active    → suspended  (allowed)
 *   active    → archived   (allowed — terminal)
 *   suspended → active     (allowed — opt-back-in)
 *   suspended → archived   (allowed — terminal)
 *   archived  → *          (FORBIDDEN — terminal state)
 *   any       → same       (no-op; not allowed via assertCanTransition)
 *
 * v1.6.0 may add a 'pending_review' state for vendor-onboarding governance
 * (per ADR-075 deferred). Adding new states is MAJOR.
 */

import type { VendorOfferLifecycleState } from "./types"
import { VendorOfferError } from "./types"

/**
 * Transition table — explicit allow-list. Every entry maps `from` to the
 * Set of allowed `to` states. Absence of `to` in the Set === forbidden.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<VendorOfferLifecycleState, ReadonlySet<VendorOfferLifecycleState>>
> = Object.freeze({
  active: new Set<VendorOfferLifecycleState>(["suspended", "archived"]),
  suspended: new Set<VendorOfferLifecycleState>(["active", "archived"]),
  archived: new Set<VendorOfferLifecycleState>(),
})

/**
 * canTransition — pure predicate. Returns true iff the transition is allowed.
 *
 * Same-state (e.g. active → active) returns false — same-state mutations are
 * a service-layer concern (price update with same status), not a lifecycle
 * transition.
 */
export function canTransition(
  from: VendorOfferLifecycleState,
  to: VendorOfferLifecycleState
): boolean {
  if (from === to) {
    return false
  }
  return ALLOWED_TRANSITIONS[from].has(to)
}

/**
 * assertCanTransition — throws VendorOfferError(INVALID_TRANSITION) if the
 * transition is not allowed. Service layer MUST call this before issuing the
 * UPDATE; the DB has no CHECK constraint enforcing transitions (only the set
 * of valid states).
 */
export function assertCanTransition(
  from: VendorOfferLifecycleState,
  to: VendorOfferLifecycleState
): void {
  if (canTransition(from, to)) {
    return
  }
  throw new VendorOfferError({
    code: "INVALID_TRANSITION",
    message: `vendor-offer lifecycle: transition ${from} → ${to} is not allowed`,
    context: { from, to },
  })
}

/**
 * isTerminal — true iff the state has no outgoing transitions.
 */
export function isTerminal(state: VendorOfferLifecycleState): boolean {
  return ALLOWED_TRANSITIONS[state].size === 0
}

/**
 * allowedNextStates — enumerates the next states from a given state. Used by
 * admin UIs to render valid actions.
 */
export function allowedNextStates(
  from: VendorOfferLifecycleState
): VendorOfferLifecycleState[] {
  return Array.from(ALLOWED_TRANSITIONS[from]).sort()
}
