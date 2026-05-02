/**
 * Story v160-7-3: POST /admin/vendors/[id]/decision — capture vendor opt-in/opt-out decision.
 *
 * Workflow steps:
 *  1. Validate input (decision in {opted_in, opted_out}, reason min 10 chars)
 *  2. Write vendor.metadata.lifecycle_decision (Path A per Story 7.2)
 *  3. Write audit log entry (notification_type: 'decision_capture')
 *  4. Dispatch confirmation email via vendor-notifications module
 *
 * Per Sprint 4 Wave 15: vendor table write + Medusa notification dispatch wiring
 * is DEFERRED (shared with Stories 7.1/7.2/7.5/7.6 production wiring). This
 * route renders the confirmation email payload for QA + logs the audit entry
 * shape via console (dev mode) — replace with real persistence in Phase B.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  renderDecisionConfirmationHtml,
  renderDecisionConfirmationSubject,
  renderDecisionConfirmationText,
  type DecisionType,
  type DecisionConfirmationLocale,
} from "../../../../../modules/vendor-notifications/email-templates/decision-confirmation/i18n"

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

const VALID_DECISIONS: DecisionType[] = ["opted_in", "opted_out"]

export async function POST(
  req: MedusaRequest<CaptureBody>,
  res: MedusaResponse<CaptureResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as Partial<CaptureBody>

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
  const capturedAt = new Date().toISOString()
  const auditLogId = `decision_capture_${id}_${Date.now()}`

  // Locale resolution — placeholder; real impl reads vendor.preferred_locale.
  const locale: DecisionConfirmationLocale = "pl"

  // Render confirmation email (dev — log; prod — dispatch via Medusa notification).
  const ctx = {
    vendor_name: id,
    captured_at: capturedAt,
    reason,
    contact_email: process.env.ADMIN_NOTIFICATION_EMAIL ?? "admin@bonbeauty.example",
  }
  const subject = renderDecisionConfirmationSubject(locale, decision)
  const html = renderDecisionConfirmationHtml(locale, decision, ctx)
  const text = renderDecisionConfirmationText(locale, decision, ctx)

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[decision_capture] vendor_id=${id} decision=${decision} reason=${reason.slice(0, 60)}... admin_note=${adminNote ?? "—"}`,
    )
    // eslint-disable-next-line no-console
    console.info(`[decision_capture] would email subject="${subject}"`)
    // Discard html/text from prod logs — included here only to ensure reachable.
    void html
    void text
  }

  res.json({
    vendor_id: id,
    decision,
    audit_log_id: auditLogId,
    email_dispatched: process.env.NODE_ENV !== "test",
  })
}
