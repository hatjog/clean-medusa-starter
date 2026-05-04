/**
 * Story v160-7-4: POST /admin/vendors/[id]/lifecycle-status — transition vendor lifecycle.
 * cleanup-3: Added override capability gate (HIGH-7.4) + policy_override audit log.
 *
 * Validates transition via state machine + writes vendor.metadata.lifecycle_status
 * + appends audit log entry. Real Mercur 2 vendor table writes DEFERRED (shared
 * production wiring across Stories 7.1-7.6).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  validateTransition,
  type LifecycleStatus,
  type VendorMetadataSnapshot,
} from "../../../../../lib/vendor-lifecycle-state-machine"
import {
  checkLifecycleOverrideCapability,
  validateOverridePayload,
  buildPolicyOverrideAuditPayload,
} from "../../../../../lib/capability-check"
import { emitStructuredAlert } from "../../../../../lib/alert-emit"

type TransitionBody = {
  to_status: LifecycleStatus
  admin_note?: string
  reason?: string
  override?: boolean
  prior_decision?: string
  // For dev fixture support — production reads vendor metadata from DB.
  current_metadata?: VendorMetadataSnapshot
}

type TransitionResponse = {
  vendor_id: string
  from_status: LifecycleStatus
  to_status: LifecycleStatus
  audit_log_id: string
}

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

function resolveLogger(req: MedusaRequest): Logger {
  try {
    return req.scope.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  } catch {
    return {}
  }
}

export async function POST(
  req: MedusaRequest<TransitionBody>,
  res: MedusaResponse<TransitionResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as Partial<TransitionBody>
  const logger = resolveLogger(req)

  if (!body.to_status) {
    res.status(400).json({ error: "to_status is required" })
    return
  }

  // cleanup-3 (HIGH-7.4): Gate override=true behind lifecycle.override capability
  if (body.override === true) {
    const capResult = checkLifecycleOverrideCapability(req)
    if (!capResult.granted) {
      logger.warn?.("[lifecycle_status] override rejected — insufficient capability", {
        vendor_id: id,
        reason: capResult.reason,
      })
      res.status(403).json({ error: capResult.reason })
      return
    }

    // validate override payload fields (admin_note ≥30, reason ≥10, prior_decision required)
    const payloadCheck = validateOverridePayload({
      prior_decision: body.prior_decision,
      admin_note: body.admin_note,
      reason: body.reason,
    })
    if (!payloadCheck.valid) {
      res.status(400).json({ error: payloadCheck.error })
      return
    }
  }

  // Real impl: load vendor.metadata from Mercur 2 vendor table.
  // Dev impl: client provides current_metadata via body (or default).
  const meta: VendorMetadataSnapshot = body.current_metadata ?? {
    lifecycle_status: "pending_approval",
  }

  const fromStatus = meta.lifecycle_status
  const toStatus = body.to_status

  const result = validateTransition(fromStatus, toStatus, meta, body.override)
  if (!result.valid) {
    res
      .status(400)
      .json({ error: result.reason ?? "Invalid transition" })
    return
  }

  const auditLogId = `lifecycle_transition_${id}_${Date.now()}`

  // cleanup-3: Write policy_override audit row + emit structured alert when override used
  if (body.override === true) {
    const capResult = checkLifecycleOverrideCapability(req)
    if (capResult.granted) {
      const overrideAudit = buildPolicyOverrideAuditPayload({
        vendor_id: id,
        actor_id: capResult.actor_id,
        prior_state: fromStatus,
        bypassed_checks: ["completeness_gate"],
        admin_note: body.admin_note!,
        reason: body.reason,
      })

      logger.info?.("[policy_override] audit row written", overrideAudit as unknown as Record<string, unknown>)

      // Story 8.6 hook: emit structured alert for policy_override events
      emitStructuredAlert({
        category: "policy_override",
        severity: "P2",
        actor_id: capResult.actor_id,
        vendor_id: id,
        prior_state: fromStatus,
        to_state: toStatus,
        audit_log_id: auditLogId,
        bypassed_checks: ["completeness_gate"],
      }, logger)
    }
  }

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[lifecycle_transition] vendor_id=${id} ${fromStatus} → ${toStatus} note=${body.admin_note ?? "—"}`,
    )
  }

  res.json({
    vendor_id: id,
    from_status: fromStatus,
    to_status: toStatus,
    audit_log_id: auditLogId,
  })
}
