/**
 * vendor-notifications module barrel export (Story v160-7-1).
 *
 * Public surface:
 *   - T-30 email template (PL + EN; HTML + plain-text + subject renderers)
 *   - Audit log entry shape contract
 *
 * Backend dispatch wiring (Medusa notification module integration) is OUT OF
 * 7.1 scope — workflow step + admin route consume these renderers + audit
 * shape directly. Production email provider (SendGrid / SMTP) configuration
 * is env-config concern (Phase B activation responsibility).
 */

export type {
  T30EmailCopy,
  T30EmailLocale,
  T30TemplateContext,
} from "./email-templates/t30/i18n"
export {
  T30_EMAIL_COPY,
  hydrateTemplate,
  renderT30Html,
  renderT30Subject,
  renderT30Text,
} from "./email-templates/t30/i18n"

/**
 * Audit log entry shape (FR44 traceability).
 *
 * Persistence target — Path A (preferred): existing Mercur audit log
 * surface. Path B (fallback): GP-owned `vendor_notification_log` table.
 * T3.4 backend probe decides; this shape is stable across both paths
 * (additive-MINOR per ports.ts versioning convention).
 */
export interface VendorNotificationLogEntry {
  id: string
  vendor_id: string
  vendor_handle?: string | null
  notification_type:
    | "t30_migration"
    | "decision_capture"
    | "lifecycle_transition"
    | "jca_generated"
    | "jca_dispatched"
    | "jca_signed"
    | "training_cert_uploaded"
    | "training_cert_approved"
    | "training_cert_rejected"
  sent_at: string // ISO 8601
  locale: "pl" | "en"
  recipient_email: string
  status: "sent" | "failed"
  error_message?: string | null
  triggered_by: string // admin user id OR "system" for cron
}

// Story v160-7-3: decision confirmation (opt-in / opt-out)
export type {
  DecisionConfirmationCopy,
  DecisionConfirmationLocale,
  DecisionConfirmationContext,
  DecisionType,
} from "./email-templates/decision-confirmation/i18n"
export {
  DECISION_CONFIRMATION_EMAIL_COPY,
  renderDecisionConfirmationHtml,
  renderDecisionConfirmationSubject,
  renderDecisionConfirmationText,
} from "./email-templates/decision-confirmation/i18n"

// Story v160-7-6: training cert (pending / approved / rejected)
export type {
  TrainingCertCopy,
  TrainingCertLocale,
  TrainingCertState,
  TrainingCertContext,
} from "./email-templates/training-cert/i18n"
export {
  TRAINING_CERT_PENDING_EMAIL_COPY,
  TRAINING_CERT_APPROVED_EMAIL_COPY,
  TRAINING_CERT_REJECTED_EMAIL_COPY,
  renderTrainingCertSubject,
  renderTrainingCertText,
} from "./email-templates/training-cert/i18n"
