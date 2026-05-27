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
  readonly cause?: unknown;

  constructor(message: string, options: MessagingErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.error_code = options.error_code;
    this.audit_event = options.audit_event;
    this.status_code = options.status_code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class MessagingValidationError extends MessagingError {}

export class MessagingProviderError extends MessagingError {}

export class UnsupportedProviderError extends MessagingError {}

export class UnsupportedChannelError extends MessagingError {}
