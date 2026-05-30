/// <reference lib="es2022.error" />
import type { AuditEnvelope } from "./types";

interface MessagingErrorOptions {
  error_code: string;
  audit_event?: AuditEnvelope;
  cause?: unknown;
  status_code?: number;
}

export class MessagingError extends Error {
  readonly error_code: string;
  readonly audit_event?: AuditEnvelope;
  readonly status_code?: number;

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
  }
}

export class MessagingValidationError extends MessagingError {}

export class MessagingProviderError extends MessagingError {}

export class UnsupportedProviderError extends MessagingError {}

export class UnsupportedChannelError extends MessagingError {}
