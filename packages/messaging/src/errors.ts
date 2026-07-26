/// <reference lib="es2022.error" />
import type { NotificationAuditEnvelope } from "./types";

interface MessagingErrorOptions {
  error_code: string;
  audit_event?: NotificationAuditEnvelope;
  cause?: unknown;
  status_code?: number;
  /**
   * R-2.2-M2: błąd PRE-FLIGHT — rzucony ZANIM cokolwiek poszło do providera
   * (walidacja payloadu, brak sendera/szablonu w allowliście, brak API key).
   * Semantycznie jednoznaczny: „na pewno nic nie wysłano".
   *
   * Gateway używa tej flagi do rozstrzygnięcia, czy wolno zacache'ować `failed`
   * pod idempotency cache key. Cache'owanie ma sens WYŁĄCZNIE dla błędów
   * niejednoznacznych (timeout-after-send) — dla pre-flight zablokowałoby
   * retry po naprawie konfiguracji na cały TTL (24 h).
   */
  preflight?: boolean;
}

export class MessagingError extends Error {
  readonly error_code: string;
  readonly audit_event?: NotificationAuditEnvelope;
  readonly status_code?: number;
  /** patrz `MessagingErrorOptions.preflight` — „na pewno nic nie wysłano". */
  readonly preflight: boolean;

  constructor(message: string, options: MessagingErrorOptions) {
    // Root tsconfig targets ES2021 (lib.es2021) where Error constructor
    // signature is `(message?: string)` — `{ cause }` ErrorOptions arrived
    // in ES2022. Set `cause` post-construction to stay compatible with the
    // shared baseline without touching the package-level `lib` override.
    super(message);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    this.name = new.target.name;
    this.error_code = options.error_code;
    this.audit_event = options.audit_event;
    this.status_code = options.status_code;
    this.preflight = options.preflight ?? false;
  }
}

export class MessagingValidationError extends MessagingError {}

export class MessagingProviderError extends MessagingError {}

export class UnsupportedProviderError extends MessagingError {}

export class UnsupportedChannelError extends MessagingError {}

export class CommunicationConfigNotFoundError extends MessagingError {}

export class CommunicationConfigValidationError extends MessagingError {}

export class UnknownFlowError extends MessagingError {}
