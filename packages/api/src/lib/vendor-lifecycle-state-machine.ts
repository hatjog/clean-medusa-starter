/**
 * Story v160-7-4: Vendor lifecycle state machine.
 *
 * Centralizes ALLOWED_TRANSITIONS + validation logic. Single source of truth
 * for backend workflow + admin-panel UI button enable/disable logic.
 *
 * Forward-only design: terminated = terminal state. Reversal scenarios out of
 * v1.6.0 scope (manual DB intervention if needed; future story 7.4.1).
 */

export type LifecycleStatus =
  | "pending_approval"
  | "open"
  | "suspended"
  | "terminated"

export const ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  pending_approval: ["open", "suspended", "terminated"],
  open: ["suspended", "terminated"],
  suspended: ["open", "terminated"],
  terminated: [],
}

export interface ChecklistItem {
  key:
    | "t30_sent"
    | "nudges_sent"
    | "decision_captured"
    | "jca_signed"
    | "training_verified"
  done: boolean
  na: boolean
}

export interface ChecklistResult {
  items: ChecklistItem[]
  complete: number
  total: number
}

export interface VendorMetadataSnapshot {
  lifecycle_status: LifecycleStatus
  lifecycle_decision?: {
    decision: "opted_in" | "opted_out"
  } | null
  jca_signed_at?: string | null
  training_verified?: boolean
  t30_sent_at?: string | null
  nudges_completed?: boolean
}

/**
 * Validates a transition between lifecycle statuses.
 *
 * @param from - current status
 * @param to - target status
 * @param vendor - optional vendor metadata for completeness checks (open requires opted_in + ≥4/5)
 * @param override - bypass completeness requirement (admin escalation)
 */
export function validateTransition(
  from: LifecycleStatus,
  to: LifecycleStatus,
  vendor?: VendorMetadataSnapshot,
  override?: boolean,
): { valid: boolean; reason?: string } {
  const allowed = ALLOWED_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    return {
      valid: false,
      reason: `Transition not allowed: ${from} → ${to}. Allowed: ${allowed.join(", ") || "none (terminal state)"}`,
    }
  }

  // Completeness check for `open` target — vendor must be opted_in + ≥4/5 checklist
  if (to === "open" && vendor && !override) {
    if (vendor.lifecycle_decision?.decision !== "opted_in") {
      return {
        valid: false,
        reason:
          "Cannot transition to 'open' — vendor decision must be 'opted_in'",
      }
    }
    const checklist = getCompletenessChecklist(vendor)
    if (checklist.complete < 4) {
      return {
        valid: false,
        reason: `Cannot transition to 'open' — completeness ${checklist.complete}/${checklist.total} (≥4/5 required)`,
      }
    }
  }

  return { valid: true }
}

/**
 * Derives the 5-item completeness checklist from vendor metadata + audit log.
 *
 * Per AC2: 5 items map to Stories 7.1 (T-30), 7.2 (nudges), 7.3 (decision),
 * 7.5 (JCA), 7.6 (training).
 */
export function getCompletenessChecklist(
  vendor: VendorMetadataSnapshot,
): ChecklistResult {
  const optedOut = vendor.lifecycle_decision?.decision === "opted_out"

  const items: ChecklistItem[] = [
    {
      key: "t30_sent",
      done: Boolean(vendor.t30_sent_at),
      na: false,
    },
    {
      key: "nudges_sent",
      done: Boolean(vendor.nudges_completed),
      na: false,
    },
    {
      key: "decision_captured",
      done: Boolean(vendor.lifecycle_decision),
      na: false,
    },
    {
      key: "jca_signed",
      done: Boolean(vendor.jca_signed_at),
      na: optedOut,
    },
    {
      key: "training_verified",
      done: Boolean(vendor.training_verified),
      na: optedOut,
    },
  ]

  const complete = items.filter((i) => i.done || i.na).length

  return {
    items,
    complete,
    total: items.length,
  }
}

/**
 * Returns the list of allowed next-status transitions for a given vendor.
 * Used by admin-panel UI to enable/disable transition buttons.
 */
export function getAllowedTransitions(
  from: LifecycleStatus,
): LifecycleStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? []
}
