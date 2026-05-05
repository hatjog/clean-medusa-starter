/**
 * Story v160-7-4: POST /admin/vendors/[id]/lifecycle-status — transition vendor lifecycle.
 *
 * cleanup-15a: State machine bypass closure (Batch A H5):
 *   - REJECT `current_metadata` from request body (400) — state should be read
 *     from DB, not supplied by the caller (anti-spoofing guard).
 *   - Gate `override=true` via `checkLifecycleOverrideCapability` — non-admin
 *     callers receive 403.
 *   - Emit `policy_override` alert when override is granted.
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
import {
  buildLifecycleMetadataSnapshot,
  getSellerById,
  mergeSellerGpMetadata,
  updateSeller,
} from "../../../../../lib/vendor-decision-store"
import {
  checkLifecycleOverrideCapability,
  extractActorIdOrThrow,
} from "../../../../../lib/capability-check"
import { emitStructuredAlert } from "../../../../../lib/alert-emit"

type TransitionBody = {
  to_status: LifecycleStatus
  admin_note?: string
  override?: boolean
  // current_metadata is REJECTED (see bypass closure below).
  // Keep type definition for TS-correct rejection error message.
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

  let actorId: string
  try {
    actorId = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ error: "Valid admin session required" })
    return
  }

  if (!body.to_status) {
    res.status(400).json({ error: "to_status is required" })
    return
  }

  // AC4 — State machine bypass closure: reject current_metadata in request body.
  // All state must be authoritative from DB; caller-supplied metadata is an
  // anti-pattern that allows actors to fabricate valid transition starting points.
  if (body.current_metadata !== undefined && body.current_metadata !== null) {
    res.status(400).json({
      error: "current_metadata in request body is not allowed — vendor state is resolved server-side",
    })
    return
  }

  // AC4 — Capability gate on override=true.
  // Non-admin callers (or unauthenticated) receive 403.
  if (body.override === true) {
    const hasCapability = await checkLifecycleOverrideCapability(req)
    if (!hasCapability) {
      res.status(403).json({
        error: "lifecycle.override capability required for override=true transitions",
      })
      return
    }

    // Emit policy_override alert for audit trail
    emitStructuredAlert({
      severity: "WARN",
      code: "policy_override",
      message: `Admin override transition: vendor ${id} → ${body.to_status}`,
      context: {
        vendor_id: id,
        to_status: body.to_status,
        actor_id: actorId,
        admin_note: body.admin_note ?? null,
      },
    })
  }

  const seller = await getSellerById(
    req.scope as { resolve: (key: string) => unknown },
    id,
  )

  if (!seller) {
    res.status(404).json({ error: `Vendor ${id} was not found` })
    return
  }

  const meta: VendorMetadataSnapshot = buildLifecycleMetadataSnapshot(seller)

  const fromStatus = meta.lifecycle_status
  const toStatus = body.to_status

  const result = validateTransition(fromStatus, toStatus, meta, body.override)
  if (!result.valid) {
    res
      .status(body.override ? 403 : 400)
      .json({ error: result.reason ?? "Invalid transition" })
    return
  }

  const changedAt = new Date().toISOString()
  const metadata = mergeSellerGpMetadata(seller, {
    lifecycle_status: toStatus,
    lifecycle_last_action_at: changedAt,
    lifecycle_last_transition: {
      from_status: fromStatus,
      to_status: toStatus,
      changed_at: changedAt,
      changed_by: actorId,
      admin_note: body.admin_note?.trim() ?? null,
      override: body.override === true,
    },
  })

  await updateSeller(
    req.scope as { resolve: (key: string) => unknown },
    id,
    {
      status: toStatus,
      metadata,
    },
  )

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
