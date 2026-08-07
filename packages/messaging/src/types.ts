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

/**
 * Załącznik wiadomości (R-2.2-M1).
 *
 * Kontrakt jest JEDNOZNACZNY: `content_base64` to zawsze base64 — normalizacja
 * (np. surowy tekst ICS → base64) należy do warstwy mapującej payload
 * call-site'u na intent, nie do providera. Dzięki temu adapter Brevo nie zgaduje
 * kodowania i nie może po cichu wysłać uszkodzonego pliku.
 */
export interface NotificationAttachment {
  name: string;
  content_base64: string;
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
  /**
   * Załączniki (R-2.2-M1). Przed 2.2 pole nie istniało, a `attachments`
   * z `ProviderSendNotificationDTO` były cicho gubione — dla maila potwierdzenia
   * wizyty sens biznesowy = plik ICS, więc utrata była cichą utratą treści.
   */
  attachments?: NotificationAttachment[];
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
  /**
   * Klasa zdarzenia dostawy po klasyfikacji wielodzielnej (FR-9d, ADR-192).
   * Bez niej koperta niosla tylko `status`/`outcome`, ktore zwijaja piec roznych
   * odpowiedzi dostawcy do jednego `failed` — czyli rozroznienie wymagane przez
   * FR-9d bylo obserwowalne wylacznie wewnatrz procesu.
   */
  delivery_class?: NotificationDeliveryEventType;
  /**
   * Rozstrzygnieta reakcja na klase — czynnik, ktory czyni skutek KAZDEJ z klas
   * obserwowalnie rozny. Ksztalt odpowiada `DeliveryEventReaction`.
   */
  delivery_reaction?: {
    terminal: boolean;
    escalate: boolean;
    retryable: boolean;
    retry_policy: string | null;
    consumes_recipient_attempt: boolean;
    suppress_recipient: boolean;
    bounce_family: boolean;
    next_attempt_number: number | null;
    backoff_delay_ms: number | null;
  };
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

/**
 * Dziedzina klas zdarzenia dostawy (FR-9d, ADR-192).
 *
 * Wartosc `"bounced"` ZOSTALA USUNIETA celowo. Do v1.15.0 zwijala piec roznych
 * odpowiedzi dostawcy (`hard_bounce`, `soft_bounce`, `invalid_email`, `blocked`,
 * `deferred`) w jedna wartosc, przez co rozroznienie wymagane przez FR-9d bylo
 * kasowane w pierwszym kroku normalizacji — zanim jakakolwiek reakcja mogla je
 * zobaczyc. Kazda z tych piec odpowiedzi ma teraz WLASNA, rozlaczna klase.
 *
 * `"deferred"` (opoznienie) NIE JEST odbiciem: nie nalezy do rodziny
 * `isBounceFamily`, nie dostaje kodu z rodziny `*BOUNCE*` i nie konsumuje budzetu
 * prob. Do v1.15.0 bylo klasyfikowane jako odbicie — to bylo bledne, nie brakujace.
 *
 * Dziedzina jest wyliczona i domkniety jest kazdy jej konsument (`assertNever`),
 * wiec dodanie klasy bez obslugi NIE KOMPILUJE SIE (AD-19).
 */
export type NotificationDeliveryEventType =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced_permanent"
  | "bounced_transient"
  | "blocked"
  | "invalid_address"
  | "deferred"
  | "complaint"
  | "unsubscribed"
  | "failed";

/** Pelna, wyliczona dziedzina klas — nosnik wyczerpalnosci dla testow i bramek. */
export const NOTIFICATION_DELIVERY_EVENT_TYPES = Object.freeze([
  "delivered",
  "opened",
  "clicked",
  "bounced_permanent",
  "bounced_transient",
  "blocked",
  "invalid_address",
  "deferred",
  "complaint",
  "unsubscribed",
  "failed",
] as const satisfies readonly NotificationDeliveryEventType[]);

export interface NotificationDeliveryEvent {
  dispatch_id: string;
  provider: NotificationProvider;
  event_type: NotificationDeliveryEventType;
  occurred_at: string;
  provider_event_id: string;
  correlation_state?: NotificationDeliveryCorrelationState;
  raw_payload?: Record<string, unknown>;
}
