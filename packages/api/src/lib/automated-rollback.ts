/**
 * Story v160-8-5: Automated rollback — flag ON -> SHADOW on P1 alert breach.
 * Idempotent within 5min window. Writes audit log + notifies operator.
 *
 * @see GP/backend/packages/api/src/lib/feature-flag-tri-state.ts (Story 8.3)
 * @see FR66 / NFR-REL-10
 */

import {
  getCurrentState,
  setState,
  type MultiVendorFlagState,
} from "./feature-flag-tri-state"

export type RollbackResult = {
  rolled_back: boolean
  from_state: MultiVendorFlagState
  to_state: "shadow"
  audit_log_id: string
  reason: string
  alert_id: string
}

const _idempotencyCache = new Map<string, { at: number; result: RollbackResult }>()
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

export async function triggerRollback(
  alert_id: string,
  reason: string,
): Promise<RollbackResult> {
  const cached = _idempotencyCache.get(alert_id)
  if (cached && Date.now() - cached.at < IDEMPOTENCY_WINDOW_MS) {
    return cached.result
  }

  const from = await getCurrentState()
  if (from !== "on") {
    const result: RollbackResult = {
      rolled_back: false,
      from_state: from,
      to_state: "shadow",
      audit_log_id: "noop_" + Date.now(),
      reason: `flag not in ON state (current=${from}); skipping rollback`,
      alert_id,
    }
    _idempotencyCache.set(alert_id, { at: Date.now(), result })
    return result
  }

  const transition = await setState("shadow", {
    triggered_by: "automated_rollback",
    reason,
    alert_id,
    bypass_smoke_gate: true,
  })

  const result: RollbackResult = {
    rolled_back: true,
    from_state: "on",
    to_state: "shadow",
    audit_log_id: transition.audit_log_id,
    reason,
    alert_id,
  }
  _idempotencyCache.set(alert_id, { at: Date.now(), result })
  return result
}
