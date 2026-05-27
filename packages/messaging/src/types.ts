export type ConsentBasis =
  | "transactional_critical"
  | "transactional_supportive"
  | "lifecycle_consented"
  | "marketing";

export type Channel = "email" | "sms" | "push";

export type Locale = "pl-PL" | "en-US" | "uk-UA" | "de-DE";

export type NotificationProvider = "brevo" | "resend" | string;

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
  | "deduplicated";

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
  | "opted_out";

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

// TODO(F-11/Epic J): migrate this local envelope to shared @gp/audit when it exists.
//
// Sentinel convention (Story 5.5 Path Y subscriber):
// - Dla event_type: "notification.delivery" z correlation_state: "orphan" pola
//   `flow_id`, `template_key`, `market_id` MOGĄ przyjmować wartość "unknown"
//   gdy Brevo payload nie zawierał kontekstu, a `notification_dispatches` lookup
//   nie znalazł dopasowania. Downstream consumers (PostHog dashboard Story 5.9)
//   MUSZĄ traktować "unknown" jako known-unknown sentinel, nie real bucket.
// - Dla `hashed_recipient` brak recipient hash + brak emaila → sentinel
//   `__no_recipient__` (non-collidable z hex sha256 output).
export interface AuditEnvelope {
  audit_id: string;
  event_type: "notification.dispatch" | "notification.delivery";
  status: NotificationDispatchStatus;
  dispatch_id: string;
  provider: NotificationProvider;
  provider_event_id?: string;
  correlation_id?: string;
  correlation_state?: NotificationDeliveryCorrelationState;
  outcome?: NotificationDeliveryAuditOutcome;
  flow_id: string;
  template_key: string;
  channel: Channel;
  market_id: string;
  locale: Locale;
  consent_basis: ConsentBasis;
  idempotency_key: string;
  hashed_recipient: string;
  recipient_hash?: string;
  occurred_at: string;
  error_code?: string;
  error_message?: string;
}

export interface NotificationDispatch {
  dispatch_id: string;
  provider: NotificationProvider;
  status: NotificationDispatchStatus;
  provider_message_id?: string;
  sent_at?: string;
  audit_event: AuditEnvelope;
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
