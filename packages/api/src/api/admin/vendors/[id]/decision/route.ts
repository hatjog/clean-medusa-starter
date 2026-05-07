/**
 * Story v160-7-3: POST /admin/vendors/[id]/decision — capture vendor opt-in/opt-out decision.
 * Story v160-cleanup-36: Idempotency-Key support + state-machine guard (P0 TF-90).
 *
 * Idempotency behaviour (cleanup-36):
 *   - Strict policy: Idempotency-Key header (UUIDv4) is REQUIRED (OQ #1).
 *   - Repeat POST with same key + same body → cached 200, no side effects.
 *   - Repeat POST with same key + different body → 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
 *   - State conflict (illegal transition without override) → 409 INVALID_STATE_TRANSITION.
 *   - 409 responses are also persisted so replay is deterministic.
 *
 * Decision state machine (cleanup-36 OQ #3):
 *   - pending → opted_in / opted_out: always allowed (first capture).
 *   - opted_in ↔ opted_out reversal: allowed only with explicit `override: true` in body.
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
  readLifecycleDecision,
} from "../../../../../lib/vendor-decision-store"
import { appendNotificationLogBestEffort } from "../../../../../lib/vendor-notification-log"
import {
  extractIdempotencyKey,
  hashRequestBody,
  findIdempotencyRecord,
  persistIdempotencyRecord,
} from "../../../../../lib/vendor-decision-idempotency"
import {
  canTransitionDecision,
  resolveDecisionState,
} from "../../../../../lib/vendor-decision-transitions"

type CaptureBody = {
  decision: DecisionType
  reason: string
  admin_note?: string
  /** Explicit reversal override — allows opted_in ↔ opted_out flip (OQ #3). */
  override?: boolean
}

type CaptureResponse = {
  vendor_id: string
  decision: DecisionType
  audit_log_id: string
  email_dispatched: boolean
}

type ErrorResponse = {
  error?: string
  error_code?: string
  code?: string
  message?: string
  hint?: string
  current_state?: string
  attempted?: string
}

const VALID_DECISIONS: DecisionType[] = ["opted_in", "opted_out"]

export async function POST(
  req: MedusaRequest<CaptureBody>,
  res: MedusaResponse<CaptureResponse | ErrorResponse>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as Partial<CaptureBody>

  // ── Auth ────────────────────────────────────────────────────────────────────
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

  // ── Idempotency-Key extraction (cleanup-36 AC4 — strict policy) ─────────────
  const keyResult = extractIdempotencyKey(
    req.headers as Record<string, string | string[] | undefined>,
  )
  if (!keyResult.ok) {
    res.status(keyResult.statusCode).json(keyResult.body as ErrorResponse)
    return
  }
  const idempotencyKey = keyResult.key

  // ── Basic body validation ────────────────────────────────────────────────────
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
  const override = body.override === true

  // ── Request hash (stable canonical SHA-256) ──────────────────────────────────
  const requestHash = hashRequestBody({
    decision,
    reason,
    admin_note: adminNote ?? undefined,
    override: override || undefined,
  })

  const scope = req.scope as { resolve: (key: string) => unknown }

  // ── Idempotency lookup ───────────────────────────────────────────────────────
  const lookupResult = await findIdempotencyRecord(scope, idempotencyKey, id)
  if (lookupResult.found) {
    const existing = lookupResult.record
    if (existing.request_hash !== requestHash) {
      // AC3.1 — same key, different body.
      res.status(422).json({
        error_code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        message:
          "The Idempotency-Key was already used with a different request payload",
      })
      return
    }
    // AC2 — same key, same body → replay cached response.
    res.status(existing.status_code).json(existing.response_body as CaptureResponse | ErrorResponse)
    return
  }

  // ── Vendor lookup ────────────────────────────────────────────────────────────
  const seller = await getSellerById(scope, id)

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

  // ── State-machine guard (cleanup-36 AC3) ─────────────────────────────────────
  const existingDecision = readLifecycleDecision(seller)
  const currentDecisionState = resolveDecisionState(
    existingDecision?.decision ?? null,
  )
  const transitionCheck = canTransitionDecision({
    currentState: currentDecisionState,
    attemptedDecision: decision,
    override,
  })

  if (!transitionCheck.allowed) {
    const conflictBody: ErrorResponse = {
      error_code: "INVALID_STATE_TRANSITION",
      current_state: currentDecisionState,
      attempted: decision,
      hint: transitionCheck.reason,
    }
    // Persist 409 so replay is deterministic (AC3 last sub-criterion).
    await persistIdempotencyRecord(scope, {
      idempotencyKey,
      vendorId: id,
      requestHash,
      statusCode: 409,
      responseBody: conflictBody as Record<string, unknown>,
    })
    res.status(409).json(conflictBody)
    return
  }

  // ── Perform the real operation ───────────────────────────────────────────────
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

  await updateSeller(scope, id, { metadata })

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
  try {
    const dispatchResult = await dispatchVendorEmail({
      scope,
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
        code: (err as { code: string }).code,
        message: (err as Error).message,
      })
      return
    }
    throw err
  }

  // Durable audit row (v160-cleanup-7-followup — AC4 closure).
  const audit = await appendNotificationLogBestEffort(scope, {
    id: auditLogId ?? undefined,
    vendor_id: id,
    vendor_handle: seller.handle ?? null,
    notification_type: "decision_capture",
    sent_at: capturedAt,
    locale,
    recipient_email: seller.email,
    status: "sent",
    error_message: null,
    triggered_by: actorId,
    metadata: { decision, reason_length: reason.length, admin_note_present: Boolean(adminNote) },
  })
  auditLogId = audit.entry.id

  const updatedSeller = { ...seller, metadata }
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

  await updateSeller(scope, id, { metadata: persistedMetadata })

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[decision_capture] actor_id=${actorId} vendor_id=${id} decision=${decision} reason=${reason.slice(0, 60)}... admin_note=${adminNote ?? "—"}`,
    )
    // eslint-disable-next-line no-console
    console.info(`[decision_capture] idempotency_key=${idempotencyKey} audit_log_id="${auditLogId}"`)
  }

  const successBody: CaptureResponse = {
    vendor_id: id,
    decision,
    audit_log_id: auditLogId,
    email_dispatched: true,
  }

  // Persist idempotency record AFTER successful operation (AC1 AC2 AC5).
  await persistIdempotencyRecord(scope, {
    idempotencyKey,
    vendorId: id,
    requestHash,
    statusCode: 200,
    responseBody: successBody as Record<string, unknown>,
  })

  res.json(successBody)
}
