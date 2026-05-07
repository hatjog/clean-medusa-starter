/**
 * Story v160-8-5: Automated rollback — flag ON -> SHADOW on P1 alert breach.
 * Idempotent within 5min window. Writes audit log + notifies operator.
 * Story v160-cleanup-46: Extended RollbackHistoryEntry with status + operator;
 *   configurable limit (default 50), explicit DESC sort, empty-state honesty.
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

export const DEFAULT_ROLLBACK_HISTORY_LIMIT = 50
export const MAX_ROLLBACK_HISTORY_LIMIT = 500

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
  /**
   * v160-cleanup-46: surface only the state the production audit trail actually
   * emits. `triggerRollback()` writes audit rows ONLY on the success path
   * (setState transition); noop early-returns and failures throw before any
   * row is persisted, so the surface narrows to a single literal.
   * Reserved future states (`"failure"` / `"noop"`) can be reintroduced when
   * the audit schema grows an explicit outcome column. Honesty pattern per
   * cleanup-22: don't advertise states the system can't deliver today.
   */
  status: "success"
  /**
   * v160-cleanup-46: identity of the rollback initiator. `auto_rollback_history`
   * is filtered to `triggered_by === "automated_rollback"` upstream, so the
   * surfaced value is the constant `"system:auto_rollback"`. Manual rollbacks
   * are deliberately NOT surfaced via this field — they belong to a separate
   * manual-rollback view that is out of scope for v1.6.0 (no production code
   * path writes manual rollback rows in this release).
   */
  operator: "system:auto_rollback"
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

/**
 * Returns rollback history from the last 24h, sorted DESC by timestamp.
 * v160-cleanup-46: supports configurable limit (default 50, clamp [1, 500]);
 * includes status + operator fields; guarantees empty [] (no throw) when no entries.
 */
export async function getRollbackHistory24h(
  db?: Knex | null,
  opts?: { limit?: number },
): Promise<RollbackHistoryEntry[]> {
  const limit = Math.min(
    Math.max(1, opts?.limit ?? DEFAULT_ROLLBACK_HISTORY_LIMIT),
    MAX_ROLLBACK_HISTORY_LIMIT,
  )
  // Read with headroom to account for filter rejection rate (4× headroom).
  const readBudget = Math.max(200, limit * 4)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000

  const entries = db
    ? await getPersistedAuditTrail(db, readBudget)
    : getAuditTrail(readBudget)

  return entries
    .filter(
      (entry) =>
        entry.triggered_by === "automated_rollback" &&
        Date.parse(entry.at) >= cutoff,
    )
    .map((entry): RollbackHistoryEntry => {
      // Honesty: `triggerRollback()` writes an audit row only on the success
      // path (setState transition). Noop early-returns and failures do NOT
      // persist a row, so any entry that survives the `triggered_by` +
      // 24h-cutoff filter above is, by construction, a successful rollback.
      // The upstream filter also guarantees `triggered_by === "automated_rollback"`,
      // so `operator` is the constant `"system:auto_rollback"`.
      return {
        audit_log_id: entry.audit_log_id,
        alert_id: entry.alert_id ?? null,
        at: entry.at,
        reason: entry.reason ?? null,
        status: "success",
        operator: "system:auto_rollback",
      }
    })
    // Explicit DESC sort by timestamp — not reliant on audit trail ordering.
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
}
