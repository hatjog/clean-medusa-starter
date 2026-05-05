/**
 * Story v160-8-5: Automated rollback — flag ON -> SHADOW on P1 alert breach.
 * Idempotent within 5min window. Writes audit log + notifies operator.
 *
 * @see GP/backend/packages/api/src/lib/feature-flag-tri-state.ts (Story 8.3)
 * @see FR66 / NFR-REL-10
 */

import {
  getAuditTrail,
  getCurrentState,
  getPersistedAuditTrail,
  setState,
  type MultiVendorFlagState,
} from "./feature-flag-tri-state"
import type { Knex } from "knex"

export type RollbackResult = {
  rolled_back: boolean
  from_state: MultiVendorFlagState
  to_state: "shadow"
  audit_log_id: string
  reason: string
  alert_id: string
}

export type RollbackHistoryEntry = {
  audit_log_id: string
  alert_id: string | null
  at: string
  reason: string | null
}

const _idempotencyCache = new Map<string, { at: number; result: RollbackResult }>()
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

export async function triggerRollback(
  alert_id: string,
  reason: string,
  db?: Knex | null,
): Promise<RollbackResult> {
  const cached = _idempotencyCache.get(alert_id)
  if (cached && Date.now() - cached.at < IDEMPOTENCY_WINDOW_MS) {
    return cached.result
  }

  const from = await getCurrentState(db ?? null)
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
    db,
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

export async function getRollbackHistory24h(
  db?: Knex | null,
): Promise<RollbackHistoryEntry[]> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const entries = db
    ? await getPersistedAuditTrail(db, 200)
    : getAuditTrail(200)

  return entries
    .filter(
      (entry) =>
        entry.triggered_by === "automated_rollback" &&
        Date.parse(entry.at) >= cutoff,
    )
    .map((entry) => ({
      audit_log_id: entry.audit_log_id,
      alert_id: entry.alert_id ?? null,
      at: entry.at,
      reason: entry.reason ?? null,
    }))
}
