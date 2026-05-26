import { createHash, randomUUID } from "node:crypto";

import {
  MessagingProviderError,
  MessagingValidationError,
  UnsupportedChannelError,
  UnsupportedProviderError,
} from "./errors";
import type { IMessagingProvider } from "./provider";
import type {
  AuditEnvelope,
  NotificationDispatch,
  NotificationDispatchStatus,
  NotificationIntent,
  NotificationProvider,
} from "./types";

export interface MessagingGateway {
  send(intent: NotificationIntent): Promise<NotificationDispatch>;
}

interface CachedDispatch {
  dispatch: NotificationDispatch;
  expires_at_ms: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class DefaultMessagingGateway implements MessagingGateway {
  private readonly idempotencyCache = new Map<string, CachedDispatch>();

  constructor(
    private readonly providers: Partial<Record<string, IMessagingProvider>>,
    private readonly defaultProvider: NotificationProvider,
    private readonly clock: () => Date = () => new Date(),
    private readonly uuid: () => string = () => randomUUID(),
    private readonly idempotencyTtlMs: number = DEFAULT_TTL_MS,
  ) {}

  async send(intent: NotificationIntent): Promise<NotificationDispatch> {
    this.validateIntent(intent);

    const cached = this.getCachedDispatch(intent.idempotency_key);
    if (cached) {
      return cached;
    }

    const provider = this.providers[this.defaultProvider];
    if (!provider) {
      throw new UnsupportedProviderError(
        `Messaging provider '${this.defaultProvider}' is not registered`,
        {
          error_code: "MESSAGING_PROVIDER_UNSUPPORTED",
          audit_event: this.createAuditEvent({
            intent,
            provider: this.defaultProvider,
            status: "failed",
            dispatch_id: this.uuid(),
            error_code: "MESSAGING_PROVIDER_UNSUPPORTED",
            error_message: `Provider '${this.defaultProvider}' is not registered`,
          }),
        },
      );
    }

    try {
      const providerResponse = await provider.send(intent);
      const dispatch: NotificationDispatch = {
        dispatch_id: providerResponse.dispatch_id,
        provider: provider.key,
        status: providerResponse.status,
        provider_message_id: providerResponse.provider_message_id,
        sent_at: providerResponse.sent_at,
        audit_event: this.createAuditEvent({
          intent,
          provider: provider.key,
          status: providerResponse.status,
          dispatch_id: providerResponse.dispatch_id,
        }),
      };

      this.idempotencyCache.set(intent.idempotency_key, {
        dispatch,
        expires_at_ms: this.clock().getTime() + this.idempotencyTtlMs,
      });

      return dispatch;
    } catch (error) {
      if (error instanceof MessagingProviderError) {
        const dispatchId = this.uuid();
        return {
          dispatch_id: dispatchId,
          provider: provider.key,
          status: "failed",
          audit_event: this.createAuditEvent({
            intent,
            provider: provider.key,
            status: "failed",
            dispatch_id: dispatchId,
            error_code: error.error_code,
            error_message: error.message,
          }),
        };
      }

      throw error;
    }
  }

  private validateIntent(intent: NotificationIntent): void {
    if (intent.channel !== "email") {
      throw new UnsupportedChannelError(
        `Messaging channel '${intent.channel}' is not supported in v1.10.0`,
        {
          error_code: "MESSAGING_CHANNEL_UNSUPPORTED",
          audit_event: this.createAuditEvent({
            intent,
            provider: this.defaultProvider,
            status: "failed",
            dispatch_id: this.uuid(),
            error_code: "MESSAGING_CHANNEL_UNSUPPORTED",
            error_message: `Channel '${intent.channel}' is not supported in v1.10.0`,
          }),
        },
      );
    }

    if (!intent.recipient.email?.trim()) {
      throw this.validationError(
        intent,
        "MESSAGING_RECIPIENT_EMAIL_REQUIRED",
        "Email recipient is required for email channel",
      );
    }

    if (!intent.recipient.market_id?.trim()) {
      throw this.validationError(
        intent,
        "MESSAGING_MARKET_ID_REQUIRED",
        "Recipient market_id is required",
      );
    }

    if (!intent.idempotency_key.trim()) {
      throw this.validationError(
        intent,
        "MESSAGING_IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency key is required",
      );
    }
  }

  private validationError(
    intent: NotificationIntent,
    errorCode: string,
    message: string,
  ): MessagingValidationError {
    return new MessagingValidationError(message, {
      error_code: errorCode,
      audit_event: this.createAuditEvent({
        intent,
        provider: this.defaultProvider,
        status: "failed",
        dispatch_id: this.uuid(),
        error_code: errorCode,
        error_message: message,
      }),
    });
  }

  private getCachedDispatch(idempotencyKey: string): NotificationDispatch | undefined {
    const cached = this.idempotencyCache.get(idempotencyKey);
    if (!cached) {
      return undefined;
    }

    if (cached.expires_at_ms <= this.clock().getTime()) {
      this.idempotencyCache.delete(idempotencyKey);
      return undefined;
    }

    return cached.dispatch;
  }

  private createAuditEvent(input: {
    intent: NotificationIntent;
    provider: NotificationProvider;
    status: NotificationDispatchStatus;
    dispatch_id: string;
    error_code?: string;
    error_message?: string;
  }): AuditEnvelope {
    return {
      audit_id: this.uuid(),
      event_type: "notification.dispatch",
      status: input.status,
      dispatch_id: input.dispatch_id,
      provider: input.provider,
      flow_id: input.intent.flow_id,
      template_key: input.intent.template_key,
      channel: input.intent.channel,
      market_id: input.intent.recipient.market_id,
      locale: input.intent.locale,
      consent_basis: input.intent.consent_basis,
      idempotency_key: input.intent.idempotency_key,
      hashed_recipient: hashRecipient(input.intent),
      occurred_at: this.clock().toISOString(),
      error_code: input.error_code,
      error_message: input.error_message,
    };
  }
}

function hashRecipient(intent: NotificationIntent): string {
  const recipient = intent.recipient.email ?? intent.recipient.phone ?? "";
  return createHash("sha256")
    .update(`${intent.channel}:${recipient.toLowerCase()}`)
    .digest("hex");
}
