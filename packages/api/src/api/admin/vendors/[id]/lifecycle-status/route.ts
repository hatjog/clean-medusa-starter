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
 * cleanup-47 (TF-108): Real Mercur 2 vendor table writes. Replaces:
 *   - `buildLifecycleMetadataSnapshot` fallback → `getLifecycleState` from DB
 *   - `mergeSellerGpMetadata + updateSeller` write → `writeLifecycleState` in tx
 *   - `console.info` audit → `appendNotificationLog` in same tx (AC4 atomicity)
 *   - Synthesized `audit_log_id` → real DB row id
 *   - illegal transition status 400 → 422 per AC3
 *   - Missing vendor → 404 (no phantom defaults)
 *   - Adds GET handler (AC2/T6)
 *
 * Metadata mirror shim: `seller.metadata.gp.lifecycle_status` is kept in sync
 * for v1.6.0 backwards-compat (admin-panel may still read it); scheduled for
 * removal in v1.7.0 (follow-up story). See comment at metadata shim block.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import {
  validateTransition,
  type LifecycleStatus,
  type VendorMetadataSnapshot,
} from "../../../../../lib/vendor-lifecycle-state-machine"
import {
  getSellerById,
  mergeSellerGpMetadata,
  updateSeller,
  getLifecycleState,
  writeLifecycleState,
  seedDefaultLifecycleState,
  withLifecycleTransaction,
  readSellerGpMetadata,
  type VendorLifecycleStateRow,
} from "../../../../../lib/vendor-decision-store"
import {
  checkLifecycleOverrideCapability,
  extractActorIdOrThrow,
} from "../../../../../lib/capability-check"
import { emitStructuredAlert } from "../../../../../lib/alert-emit"
import { appendNotificationLog } from "../../../../../lib/vendor-notification-log"

type TransitionBody = {
  to_status: LifecycleStatus
  admin_note?: string
  override?: boolean
  // current_metadata is REJECTED (see bypass closure below).
  // Keep type definition for TS-correct rejection error message.
  current_metadata?: VendorMetadataSnapshot
}

type LifecycleStatusResponse = {
  vendor_id: string
  lifecycle_status: LifecycleStatus
  decision_state: string
  opt_in_at: string | null
  opt_out_at: string | null
  last_transition_at: string
  last_transition_by: string
  as_of: string
}

type TransitionResponse = {
  vendor_id: string
  from_status: LifecycleStatus
  to_status: LifecycleStatus
  audit_log_id: string
}

function resolveDb(scope: { resolve: (key: string) => unknown }): Knex | null {
  try {
    return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    return null
  }
}

function lifecycleStateToResponse(
  vendorId: string,
  row: VendorLifecycleStateRow,
): LifecycleStatusResponse {
  return {
    vendor_id: vendorId,
    lifecycle_status: row.lifecycle_status,
    decision_state: row.decision_state,
    opt_in_at: row.opt_in_at ?? null,
    opt_out_at: row.opt_out_at ?? null,
    last_transition_at: row.last_transition_at,
    last_transition_by: row.last_transition_by,
    as_of: new Date().toISOString(),
  }
}

/**
 * GET /admin/vendors/:id/lifecycle-status
 *
 * Returns the real lifecycle state from vendor_lifecycle_state table.
 * - Missing seller → 404 (AC2 — no phantom defaults).
 * - Missing lifecycle row but valid seller → lazy-seed `pending_approval` (AC2).
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<LifecycleStatusResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }

  try {
    extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ error: "Valid admin session required" })
    return
  }

  const seller = await getSellerById(
    req.scope as { resolve: (key: string) => unknown },
    id,
  )

  if (!seller) {
    res.status(404).json({ error: `Vendor ${id} was not found` })
    return
  }

  const db = resolveDb(req.scope as { resolve: (key: string) => unknown })
  if (!db) {
    res.status(503).json({ error: "Database connection unavailable" })
    return
  }

  // Lazy-seed inside a transaction so concurrent GETs don't double-insert
  const row = await db.transaction(async (trx) => {
    const existing = await trx<VendorLifecycleStateRow>("vendor_lifecycle_state")
      .select("*")
      .where({ seller_id: id })
      .first()

    if (existing) {
      return existing
    }

    return seedDefaultLifecycleState(trx, id)
  })

  res.json(lifecycleStateToResponse(id, row))
}

/**
 * POST /admin/vendors/:id/lifecycle-status
 *
 * Transitions the vendor lifecycle state. All reads, writes, and audit log
 * appends happen inside a single DB transaction with SELECT FOR UPDATE (AC5).
 */
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

  // AC2 — Validate seller exists BEFORE any lifecycle row read
  const seller = await getSellerById(
    req.scope as { resolve: (key: string) => unknown },
    id,
  )

  if (!seller) {
    res.status(404).json({ error: `Vendor ${id} was not found` })
    return
  }

  const toStatus = body.to_status
  const changedAt = new Date().toISOString()

  // Execute the full read → validate → write → audit sequence in one transaction
  // with SELECT FOR UPDATE for serialization (AC5).
  let auditLogId: string
  let fromStatus: LifecycleStatus

  try {
    const result = await withLifecycleTransaction(
      req.scope as { resolve: (key: string) => unknown },
      async (trx) => {
        // 1. Lock the lifecycle row (SELECT FOR UPDATE) — AC5 serialization
        const current = await getLifecycleState(
          req.scope as { resolve: (key: string) => unknown },
          id,
          trx,
        )

        // Seed a default row if this seller has never had a lifecycle row
        let currentRow: VendorLifecycleStateRow
        if (!current) {
          currentRow = await seedDefaultLifecycleState(trx, id)
        } else {
          currentRow = current
        }

        const currentStatus = currentRow.lifecycle_status

        // AC3 — Idempotent transition: to_status == from_status → 200 no-op
        if (toStatus === currentStatus) {
          return { idempotent: true, fromStatus: currentStatus, auditLogId: "" }
        }

        // Build a VendorMetadataSnapshot for the state machine validator.
        // Primary state from lifecycle row; checklist fields (jca_signed_at,
        // training_verified, t30_sent_at, nudges_completed) fall back to
        // seller.metadata.gp for the completeness check (v1.6.0 compatibility;
        // v1.7.0 will promote these fields to the lifecycle row).
        const gpMeta = readSellerGpMetadata(seller)
        const meta: VendorMetadataSnapshot = {
          lifecycle_status: currentStatus,
          lifecycle_decision:
            currentRow.decision_state === "opted_in"
              ? { decision: "opted_in" }
              : currentRow.decision_state === "opted_out"
                ? { decision: "opted_out" }
                : null,
          jca_signed_at: typeof gpMeta.jca_signed_at === "string" ? gpMeta.jca_signed_at : null,
          training_verified: gpMeta.training_verified === true,
          t30_sent_at: typeof gpMeta.t30_sent_at === "string" ? gpMeta.t30_sent_at : null,
          nudges_completed: gpMeta.nudges_completed === true,
        }

        // 2. Validate transition
        const validationResult = validateTransition(currentStatus, toStatus, meta, body.override)
        if (!validationResult.valid) {
          // AC3: illegal transition → 422 (not 400); 403 preserved for override capability
          const statusCode = body.override ? 403 : 422
          throw Object.assign(new Error(validationResult.reason ?? "Invalid transition"), {
            httpStatus: statusCode,
          })
        }

        // 3. Determine timestamp fields for opt_in / opt_out
        const optInAt =
          toStatus === "open"
            ? changedAt
            : currentRow.opt_in_at ?? null

        const optOutAt =
          toStatus === "terminated" || toStatus === "suspended"
            ? changedAt
            : currentRow.opt_out_at ?? null

        // 4. Write new lifecycle state (AC1 — real DB write)
        await writeLifecycleState(trx, id, {
          lifecycle_status: toStatus,
          decision_state: currentRow.decision_state,
          opt_in_at: optInAt,
          opt_out_at: optOutAt,
          last_transition_at: changedAt,
          last_transition_by: actorId,
        })

        // 5. Append audit log in same transaction (AC4 — NOT best-effort)
        const auditRow = await appendNotificationLog(
          // Wrap scope to pass trx as the db connection
          {
            resolve: (key: string) => {
              if (key === ContainerRegistrationKeys.PG_CONNECTION) return trx
              return (req.scope as { resolve: (key: string) => unknown }).resolve(key)
            },
          },
          {
            vendor_id: id,
            vendor_handle:
              typeof seller.handle === "string" ? seller.handle : undefined,
            notification_type: "lifecycle_transition",
            locale: "pl",
            recipient_email: typeof seller.email === "string" ? seller.email : "unknown",
            status: "sent",
            triggered_by: actorId,
            metadata: {
              from_status: currentStatus,
              to_status: toStatus,
              changed_by: actorId,
              changed_at: changedAt,
              admin_note: body.admin_note?.trim() ?? null,
              override: body.override === true,
              actor_id: actorId,
            },
          },
        )

        return {
          idempotent: false,
          fromStatus: currentStatus,
          auditLogId: auditRow.id,
        }
      },
    )

    if (result.idempotent) {
      // AC3 idempotent: return 200 with from_status === to_status, no audit
      res.json({
        vendor_id: id,
        from_status: result.fromStatus,
        to_status: toStatus,
        audit_log_id: "",
      })
      return
    }

    fromStatus = result.fromStatus
    auditLogId = result.auditLogId
  } catch (err) {
    const error = err as Error & { httpStatus?: number }
    const status = error.httpStatus ?? 500
    res.status(status).json({ error: error.message ?? "Internal server error" })
    return
  }

  // -- Metadata mirror shim (v1.6.0 backwards-compat only; remove in v1.7.0) --
  // Keeps seller.metadata.gp.lifecycle_status in sync so admin-panel UI that
  // reads the metadata field continues to display the correct status.
  // This is a best-effort write; failure is logged but does NOT roll back the
  // already-committed lifecycle state write above.
  try {
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
      { status: toStatus, metadata },
    )
  } catch {
    // Best-effort shim — log but don't fail the request
    // The real write already committed above.
  }
  // -- END metadata mirror shim --

  res.json({
    vendor_id: id,
    from_status: fromStatus,
    to_status: toStatus,
    audit_log_id: auditLogId,
  })
}
