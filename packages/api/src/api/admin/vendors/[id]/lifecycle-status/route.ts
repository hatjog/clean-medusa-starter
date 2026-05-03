/**
 * Story v160-7-4: POST /admin/vendors/[id]/lifecycle-status — transition vendor lifecycle.
 *
 * Validates transition via state machine + writes vendor.metadata.lifecycle_status
 * + appends audit log entry. Real Mercur 2 vendor table writes DEFERRED (shared
 * production wiring across Stories 7.1-7.6).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  validateTransition,
  type LifecycleStatus,
  type VendorMetadataSnapshot,
} from "../../../../../lib/vendor-lifecycle-state-machine"

type TransitionBody = {
  to_status: LifecycleStatus
  admin_note?: string
  override?: boolean
  // For dev fixture support — production reads vendor metadata from DB.
  current_metadata?: VendorMetadataSnapshot
}

type TransitionResponse = {
  vendor_id: string
  from_status: LifecycleStatus
  to_status: LifecycleStatus
  audit_log_id: string
}

export async function POST(
  req: MedusaRequest<TransitionBody>,
  res: MedusaResponse<TransitionResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as Partial<TransitionBody>

  if (!body.to_status) {
    res.status(400).json({ error: "to_status is required" })
    return
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
      .status(body.override ? 403 : 400)
      .json({ error: result.reason ?? "Invalid transition" })
    return
  }

  const auditLogId = `lifecycle_transition_${id}_${Date.now()}`

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
