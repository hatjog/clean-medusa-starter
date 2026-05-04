/**
 * cleanup-3 / Story 8.6 hook: Structured alert emission for policy_override events.
 *
 * When an admin uses `override=true` to bypass lifecycle completeness gates,
 * a structured alert is emitted via this hook. In v1.6.0 the alert is written
 * to the logger (structured JSON) and stored in an in-process ring buffer for
 * the GET /admin/operator/alerting endpoint to surface.
 *
 * v1.7.0+: replace ring buffer with real alert store + PagerDuty/Slack webhook.
 *
 * @see specs/operator/alerting-thresholds.md
 * @see Story v160-8-6
 */

export type PolicyOverrideAlertPayload = {
  category: "policy_override"
  severity: "P1" | "P2" | "P3"
  actor_id: string
  vendor_id: string
  prior_state: string
  to_state: string
  audit_log_id: string
  bypassed_checks: string[]
  timestamp?: string
}

type LoggerLike = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * In-process ring buffer — last 100 policy_override alerts.
 * Exported for GET /admin/operator/alerting to surface + tests to assert.
 */
const _policyOverrideRingBuffer: PolicyOverrideAlertPayload[] = []
const RING_BUFFER_MAX = 100

export function getPolicyOverrideAlerts(): ReadonlyArray<PolicyOverrideAlertPayload> {
  return _policyOverrideRingBuffer
}

/**
 * Resets the ring buffer — for use in tests only.
 */
export function _resetPolicyOverrideAlerts(): void {
  _policyOverrideRingBuffer.splice(0, _policyOverrideRingBuffer.length)
}

/**
 * Emits a structured alert for a policy_override event.
 *
 * Writes to logger (structured JSON with category=policy_override) +
 * pushes to in-process ring buffer.
 */
export function emitStructuredAlert(
  payload: Omit<PolicyOverrideAlertPayload, "timestamp">,
  logger?: LoggerLike,
): PolicyOverrideAlertPayload {
  const alert: PolicyOverrideAlertPayload = {
    ...payload,
    timestamp: new Date().toISOString(),
  }

  // Structured log — surfaced by Story 8.5 alert evaluator cron + GET /admin/operator/alerting
  logger?.warn?.("[alert:policy_override] Admin override used — audit required", {
    category: alert.category,
    severity: alert.severity,
    actor_id: alert.actor_id,
    vendor_id: alert.vendor_id,
    prior_state: alert.prior_state,
    to_state: alert.to_state,
    audit_log_id: alert.audit_log_id,
    bypassed_checks: alert.bypassed_checks,
    timestamp: alert.timestamp,
  })

  // Ring buffer
  _policyOverrideRingBuffer.push(alert)
  if (_policyOverrideRingBuffer.length > RING_BUFFER_MAX) {
    _policyOverrideRingBuffer.shift()
  }

  return alert
}
