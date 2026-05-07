/**
 * Story v160-cleanup-36 — vendor decision state-machine for opt-in/opt-out.
 *
 * Guards the POST /admin/vendors/[id]/decision endpoint against unbounded
 * state flipping. Tracks the decision lifecycle:
 *
 *   pending  →  opted_in   (any first decision)
 *   pending  →  opted_out  (any first decision)
 *   opted_in →  opted_out  (reversal; requires override=true)
 *   opted_out → opted_in   (reversal; requires override=true)
 *
 * OQ #3 resolution: reversals ARE allowed with explicit override=true in the
 * request body. Without the flag, any attempt to change an already-captured
 * decision returns 409 with a human-readable hint. This preserves operator
 * flexibility (e.g. vendor sends a correction email) while making accidental
 * flips impossible.
 *
 * Note: this module is distinct from vendor-lifecycle-state-machine.ts which
 * governs the broader lifecycle_status (pending_approval / open / suspended /
 * terminated). The decision state machine here governs only the opt-in/opt-out
 * capture within the "open" lifecycle window.
 */

export type DecisionState = "pending" | "opted_in" | "opted_out"

export interface CanTransitionOptions {
  /** Current decision state of the vendor. */
  currentState: DecisionState
  /** Attempted new decision. */
  attemptedDecision: "opted_in" | "opted_out"
  /**
   * Explicit override flag from the request body.
   * When true, reversal transitions (opted_in ↔ opted_out) are allowed.
   */
  override?: boolean
}

export interface TransitionResult {
  allowed: boolean
  /**
   * Human-readable reason for denial, present only when allowed=false.
   * Surfaced in 409 response body as `hint`.
   */
  reason?: string
}

/**
 * Determine whether a decision transition is allowed.
 *
 * @returns { allowed: true } when transition is legal.
 * @returns { allowed: false, reason } when transition is denied.
 */
export function canTransitionDecision(
  options: CanTransitionOptions,
): TransitionResult {
  const { currentState, attemptedDecision, override = false } = options

  // Transition from pending is always allowed — first capture.
  if (currentState === "pending") {
    return { allowed: true }
  }

  // Same-state is a no-op; allowed (idempotent by intent, but the
  // idempotency-key layer will already have short-circuited before here
  // for true replays).
  if (currentState === attemptedDecision) {
    return { allowed: true }
  }

  // Reversal (opted_in ↔ opted_out) — requires explicit override flag.
  if (override) {
    return { allowed: true }
  }

  return {
    allowed: false,
    reason: `include override=true to force reversal`,
  }
}

/**
 * Map a raw metadata value to a DecisionState.
 * Returns "pending" for any unrecognised / missing value.
 */
export function resolveDecisionState(
  raw: unknown,
): DecisionState {
  if (raw === "opted_in" || raw === "opted_out") {
    return raw
  }
  return "pending"
}
