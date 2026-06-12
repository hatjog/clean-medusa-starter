export interface ClaimAuditRow {
  idempotency_key: string
  code: string
  ip: string
  outcome:
    | "ok"
    | "idempotent_replay"
    | "replay_tampered"
    | "rate_limited"
    | "invalid_code"
    | "expired"
    | "already_claimed"
  occurred_at: string
}

/** In-memory idempotency binding store: idempotency_key -> hex binding. */
export const bindingStore = new Map<string, string>()

/** In-memory audit log (appended in-process). */
export const auditLog: ClaimAuditRow[] = []

/** Exposed for tests only. */
export function _getAuditLog(): ReadonlyArray<ClaimAuditRow> {
  return auditLog
}

export function _clearAuditLog(): void {
  auditLog.splice(0, auditLog.length)
}

export function _clearBindingStore(): void {
  bindingStore.clear()
}
