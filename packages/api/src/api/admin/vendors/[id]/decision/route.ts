/**
 * Story v160-7-3: POST /admin/vendors/[id]/decision — capture vendor opt-in/opt-out decision.
 *
 * Writes durable seller metadata (`metadata.gp.lifecycle_decision`) and keeps
 * confirmation email dispatch as a visible no-op until delivery wiring lands.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  renderDecisionConfirmationHtml,
  renderDecisionConfirmationSubject,
  renderDecisionConfirmationText,
  type DecisionConfirmationLocale,
  type DecisionType,
} from "../../../../../modules/vendor-notifications/email-templates/decision-confirmation/i18n"
import { extractActorIdOrThrow } from "../../../../../lib/capability-check"
import {
  dispatchVendorEmail,
  NotificationModuleUnavailableError,
} from "../../../../../lib/vendor-notification-dispatch"
import { NotificationProviderNotReadyError } from "../../../../../lib/vendor-notification-provider-readiness"
import {
  getSellerById,
  mergeSellerGpMetadata,
  resolveLifecycleStatus,
  resolvePreferredLocale,
  updateSeller,
} from "../../../../../lib/vendor-decision-store"
import { appendNotificationLogBestEffort } from "../../../../../lib/vendor-notification-log"

type CaptureBody = {
  decision: DecisionType
  reason: string
  admin_note?: string
}

type CaptureResponse = {
  vendor_id: string
  decision: DecisionType
  audit_log_id: string
  email_dispatched: boolean
}

type ErrorResponse = {
  error?: string
  code?: string
  message?: string
}

const VALID_DECISIONS: DecisionType[] = ["opted_in", "opted_out"]

export async function POST(
  req: MedusaRequest<CaptureBody>,
  res: MedusaResponse<CaptureResponse | ErrorResponse>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as Partial<CaptureBody>

  let actorId: string
  try {
    actorId = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
    })
    return
  }

  if (!body.decision || !VALID_DECISIONS.includes(body.decision)) {
    res.status(400).json({
      error: `Invalid decision: must be one of ${VALID_DECISIONS.join(", ")}`,
    })
    return
  }

  if (!body.reason || body.reason.trim().length < 10) {
    res.status(400).json({
      error: "Reason is required and must be at least 10 characters",
    })
    return
  }

  const decision = body.decision
  const reason = body.reason.trim()
  const adminNote = body.admin_note?.trim() ?? null
  const seller = await getSellerById(
    req.scope as { resolve: (key: string) => unknown },
    id,
  )

  if (!seller) {
    res.status(404).json({
      code: "VENDOR_NOT_FOUND",
      message: `Vendor ${id} was not found`,
    })
    return
  }

  const lifecycleStatus = resolveLifecycleStatus(seller)
  if (lifecycleStatus !== "open") {
    res.status(400).json({
      error: `Decision capture requires lifecycle_status='open' (current: '${lifecycleStatus}')`,
    })
    return
  }

  if (!seller.email || seller.email.trim().length === 0) {
    res.status(409).json({
      code: "VENDOR_EMAIL_NOT_CONFIGURED",
      message: `Vendor ${id} does not have an email address configured for confirmation delivery`,
    })
    return
  }

  const capturedAt = new Date().toISOString()
  const metadata = mergeSellerGpMetadata(seller, {
    lifecycle_status: lifecycleStatus,
    decision_status: decision,
    lifecycle_decision: {
      decision,
      reason,
      admin_note: adminNote,
      captured_at: capturedAt,
      captured_by: actorId,
    },
  })

  await updateSeller(
    req.scope as { resolve: (key: string) => unknown },
    id,
    { metadata },
  )

  const locale: DecisionConfirmationLocale = resolvePreferredLocale(seller)
  const ctx = {
    vendor_name: seller.name ?? seller.handle ?? id,
    captured_at: capturedAt,
    reason,
    contact_email: process.env.ADMIN_NOTIFICATION_EMAIL ?? "admin@bonbeauty.example",
  }
  const subject = renderDecisionConfirmationSubject(locale, decision)
  const html = renderDecisionConfirmationHtml(locale, decision, ctx)
  const text = renderDecisionConfirmationText(locale, decision, ctx)

  let auditLogId: string | null = null
  let dispatchStatus: "sent" | "failed" = "sent"
  let dispatchError: string | null = null
  try {
    const dispatchResult = await dispatchVendorEmail({
      scope: req.scope as { resolve: (key: string) => unknown },
      to: seller.email,
      subject,
      text,
      html,
      template: "vendor-decision-confirmation",
      triggerBy: actorId,
      metadata: {
        vendor_id: id,
        decision,
        notification_type: "decision_capture",
      },
    })
    auditLogId =
      dispatchResult.notificationId ?? `decision_capture_${id}_${Date.now()}`
  } catch (err) {
    if (
      err instanceof NotificationProviderNotReadyError ||
      err instanceof NotificationModuleUnavailableError
    ) {
      res.status(503).json({
        code: err.code,
        message: err.message,
      })
      return
    }
    throw err
  }

  // Story v160-cleanup-7-followup — durable audit row (AC4 closure).
  // Best-effort persist: dispatch already succeeded; surfacing 5xx here would
  // mislead the operator. Persistence failure is captured in `metadata.persisted`.
  const audit = await appendNotificationLogBestEffort(
    req.scope as { resolve: (key: string) => unknown },
    {
      id: auditLogId ?? undefined,
      vendor_id: id,
      vendor_handle: seller.handle ?? null,
      notification_type: "decision_capture",
      sent_at: capturedAt,
      locale,
      recipient_email: seller.email,
      status: dispatchStatus,
      error_message: dispatchError,
      triggered_by: actorId,
      metadata: { decision, reason_length: reason.length, admin_note_present: Boolean(adminNote) },
    },
  )
  auditLogId = audit.entry.id

  const updatedSeller = {
    ...seller,
    metadata,
  }
  const persistedMetadata = mergeSellerGpMetadata(updatedSeller, {
    lifecycle_decision_confirmation: {
      audit_log_id: auditLogId,
      dispatched_at: capturedAt,
      recipient_email: seller.email,
      locale,
      template: "vendor-decision-confirmation",
      dispatched_by: actorId,
      status: "sent",
    },
  })

  await updateSeller(
    req.scope as { resolve: (key: string) => unknown },
    id,
    { metadata: persistedMetadata },
  )

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[decision_capture] actor_id=${actorId} vendor_id=${id} decision=${decision} reason=${reason.slice(0, 60)}... admin_note=${adminNote ?? "—"}`,
    )
    // eslint-disable-next-line no-console
    console.info(`[decision_capture] dispatched notification audit_log_id="${auditLogId}" subject="${subject}"`)
  }

  res.json({
    vendor_id: id,
    decision,
    audit_log_id: auditLogId,
    email_dispatched: true,
  })
}
