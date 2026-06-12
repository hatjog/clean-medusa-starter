import type { AuditEnvelope, AuditProviderValue } from "@gp/audit";

export type ConsentBasis =
  | "transactional_critical"
  | "transactional_supportive"
  | "lifecycle_consented"
  | "marketing";

export type Channel = "email" | "sms" | "push";

export type Locale = "pl-PL" | "en-US" | "uk-UA" | "de-DE";

export type NotificationProvider = Extract<AuditProviderValue, "brevo" | "resend">;

export type NotificationDispatchStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "opened"
  | "clicked"
  | "bounced"
  | "complaint"
  | "unsubscribed";

export type NotificationDeliveryCorrelationState =
  | "matched"
  | "orphan"
  | "deduplicated"
  | "rejected_pre_dispatch";

// Path Y subscriber (Story 5.5) chose silent-skip dla duplicate provider_event_id
// zamiast emitować audit z outcome: "deduplicated". Architecture D-113 invariant
// pozostaje spełniony przez idempotency — każdy unique event produkuje dokładnie
// 1 audit entry. Jeśli future story zmieni tę decyzję, dopisać "deduplicated"
// z powrotem i zaktualizować subscriber.
export type NotificationDeliveryAuditOutcome =
  | "delivered"
  | "opened"
  | "engaged"
  | "failed"
  | "flagged"
  | "opted_out"
  | "rejected";

export interface NotificationRecipient {
  email?: string;
  phone?: string;
  market_id: string;
}

export interface NotificationIntent {
  flow_id: string;
  channel: Channel;
  template_key: string;
  recipient: NotificationRecipient;
  variables: Record<string, unknown>;
  locale: Locale;
  consent_basis: ConsentBasis;
  idempotency_key: string;
}

// Sentinel convention (Story 5.5 Path Y subscriber + Story 5.10 pre-parse reject):
// - Dla event_type: "notification.delivery" z correlation_state: "orphan" lub
//   "rejected_pre_dispatch" pola `flow_id`, `template_key`, `market_id` MOGĄ
//   przyjmować wartość "unknown" gdy Brevo payload nie zawierał kontekstu,
//   a `notification_dispatches` lookup nie znalazł dopasowania. Downstream
//   consumers (PostHog dashboard Story 5.9) MUSZĄ traktować "unknown" jako
//   known-unknown sentinel, nie real bucket.
// - Dla `hashed_recipient` brak recipient hash + brak emaila → sentinel
//   `__no_recipient__` (non-collidable z hex sha256 output).
// - Dla `dispatch_id` reject pre-dispatch → sentinel `__pre_dispatch__`.
// - Dla `locale` reject pre-parse → sentinel `__unknown__`.
export type NotificationAuditEnvelopeFields = {
  audit_id: string;
  event_type: "notification.dispatch" | "notification.delivery";
  status: NotificationDispatchStatus;
  dispatch_id: string;
  provider_event_id?: string;
  correlation_id?: string;
  correlation_state?: NotificationDeliveryCorrelationState;
  outcome?: NotificationDeliveryAuditOutcome;
  flow_id: string;
  template_key: string;
  channel: Channel;
  market_id: string;
  locale: Locale | "__unknown__";
  consent_basis: ConsentBasis;
  idempotency_key: string;
  hashed_recipient: string;
  recipient_hash?: string;
  occurred_at: string;
  error_code?: string;
  error_message?: string;
  request_id?: string;
  body_byte_length?: number;
  signature_hash?: string;
  source_ip_hash?: string;
  gate_source?: "feature_flag";
}

/**
 * Notification-domain audit envelope.
 *
 * The second type parameter narrows `provider` to notification-specific providers
 * (brevo | resend), restoring per-domain precision (L-2 fix).
 */
export type NotificationAuditEnvelope =
  AuditEnvelope<NotificationAuditEnvelopeFields, NotificationProvider>

export interface NotificationDispatch {
  dispatch_id: string;
  provider: NotificationProvider;
  status: NotificationDispatchStatus;
  provider_message_id?: string;
  sent_at?: string;
  audit_event: NotificationAuditEnvelope;
}

export type NotificationDeliveryEventType =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complaint"
  | "unsubscribed"
  | "failed";

export interface NotificationDeliveryEvent {
  dispatch_id: string;
  provider: NotificationProvider;
  event_type: NotificationDeliveryEventType;
  occurred_at: string;
  provider_event_id: string;
  correlation_state?: NotificationDeliveryCorrelationState;
  raw_payload?: Record<string, unknown>;
}
