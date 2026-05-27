import { createHash, randomUUID } from "node:crypto";

import {
  MessagingProviderError,
  MessagingValidationError,
  UnsupportedChannelError,
  UnsupportedProviderError,
} from "./errors";
import type { ICommunicationFlowFlagResolver } from "./feature-flag-resolver";
import type { IMessagingProvider } from "./provider";
import type {
  AuditEnvelope,
  Channel,
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
const DEFAULT_MAX_CACHE_SIZE = 10000;
const SUPPORTED_CHANNELS: ReadonlySet<Channel> = new Set([
  "email",
  "sms",
  "push",
]);

export type MessagingProviderRegistry =
  | Map<string, IMessagingProvider>
  | Partial<Record<string, IMessagingProvider>>;

export interface MessagingGatewayOptions {
  flagResolver?: ICommunicationFlowFlagResolver;
  clock?: () => Date;
  uuid?: () => string;
  idempotencyTtlMs?: number;
  maxCacheSize?: number;
}

export class DefaultMessagingGateway implements MessagingGateway {
  private readonly idempotencyCache = new Map<string, CachedDispatch>();
  // F-12: Map storage zamiast Object — żaden prototypowy klucz (`__proto__`, `constructor`)
  // nie pollutuje lookup; klucze pochodzą wprost z rejestracji providerów.
  private readonly providers: Map<string, IMessagingProvider>;
  private readonly clock: () => Date;
  private readonly uuid: () => string;
  private readonly idempotencyTtlMs: number;
  private readonly maxCacheSize: number;
  private readonly flagResolver?: ICommunicationFlowFlagResolver;

  // F-02: explicit overloady TS rozdzielają nowy options-object API od legacy
  // positional sygnatury Story 5.1 — bez nich TS pozwalał skompilować mieszany
  // call (object + dodatkowe argumenty) gdzie runtime po cichu ignorował uuid/ttl.
  constructor(
    providers: MessagingProviderRegistry,
    defaultProvider: NotificationProvider,
    options?: MessagingGatewayOptions,
  );
  /**
   * @deprecated Sygnatura pozycyjna zachowana dla Story 5.1 callsites; preferuj
   * przekazanie `MessagingGatewayOptions`. Pozycyjne argumenty po `clock` (`uuid`,
   * `idempotencyTtlMs`, `maxCacheSize`) działają TYLKO gdy 3-ci argument jest
   * funkcją; w połączeniu z options-objectem są ignorowane.
   */
  constructor(
    providers: MessagingProviderRegistry,
    defaultProvider: NotificationProvider,
    clock: () => Date,
    uuid?: () => string,
    idempotencyTtlMs?: number,
    maxCacheSize?: number,
  );
  constructor(
    providers: MessagingProviderRegistry,
    private readonly defaultProvider: NotificationProvider,
    optionsOrClock: MessagingGatewayOptions | (() => Date) = {},
    uuid?: () => string,
    idempotencyTtlMs: number = DEFAULT_TTL_MS,
    maxCacheSize: number = DEFAULT_MAX_CACHE_SIZE,
  ) {
    const options =
      typeof optionsOrClock === "function"
        ? {
            clock: optionsOrClock,
            uuid,
            idempotencyTtlMs,
            maxCacheSize,
          }
        : optionsOrClock;

    this.clock = options.clock ?? (() => new Date());
    this.uuid = options.uuid ?? (() => randomUUID());
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_TTL_MS;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.flagResolver = options.flagResolver;
    this.providers =
      providers instanceof Map
        ? new Map(providers)
        : new Map(
            Object.entries(providers).filter(
              (entry): entry is [string, IMessagingProvider] =>
                entry[1] !== undefined,
            ),
          );
  }

  async send(intent: NotificationIntent): Promise<NotificationDispatch> {
    this.validateIntent(intent);

    // F-01: gate ZAWSZE eval przed cache lookup — config flag może się zmienić
    // pomiędzy dwoma send-ami (operator flipuje enabled OFF→ON); gated denial
    // NIE jest cache'owany, żeby kolejny send dostał świeży resolve i flow ruszył.
    const gatedDispatch = this.applyFeatureFlagGate(intent);
    if (gatedDispatch) {
      return gatedDispatch;
    }

    const cacheKey = buildCacheKey(intent);
    const cached = this.getCachedDispatch(cacheKey);
    if (cached) {
      return cached;
    }

    const provider = this.providers.get(this.defaultProvider);
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

      this.cacheDispatch(cacheKey, dispatch);

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
    if (!SUPPORTED_CHANNELS.has(intent.channel as Channel)) {
      throw this.validationError(
        intent,
        "MESSAGING_CHANNEL_INVALID",
        `Channel '${intent.channel}' is not a recognized value (expected one of: email, sms, push)`,
      );
    }

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

  private getCachedDispatch(
    cacheKey: string,
  ): NotificationDispatch | undefined {
    const cached = this.idempotencyCache.get(cacheKey);
    if (!cached) {
      return undefined;
    }

    if (cached.expires_at_ms <= this.clock().getTime()) {
      this.idempotencyCache.delete(cacheKey);
      return undefined;
    }

    return cached.dispatch;
  }

  private cacheDispatch(
    cacheKey: string,
    dispatch: NotificationDispatch,
  ): void {
    // F-03: lazy sweep wygasłych wpisów co N insertów + LRU-eviction po przekroczeniu max size,
    // żeby long-running worker nie rósł w nieskończoność (in-memory bound v1.10.0; v1.11.0+ persistence).
    if (this.idempotencyCache.size > 0 && this.idempotencyCache.size % 1000 === 0) {
      this.pruneExpired();
    }

    while (this.idempotencyCache.size >= this.maxCacheSize) {
      const oldestKey = this.idempotencyCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.idempotencyCache.delete(oldestKey);
    }

    this.idempotencyCache.set(cacheKey, {
      dispatch,
      expires_at_ms: this.clock().getTime() + this.idempotencyTtlMs,
    });
  }

  private pruneExpired(): void {
    const nowMs = this.clock().getTime();
    for (const [key, entry] of this.idempotencyCache) {
      if (entry.expires_at_ms <= nowMs) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  private createAuditEvent(input: {
    intent: NotificationIntent;
    provider: NotificationProvider;
    status: NotificationDispatchStatus;
    dispatch_id: string;
    error_code?: string;
    error_message?: string;
    gate_source?: "feature_flag";
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
      gate_source: input.gate_source,
    };
  }

  private applyFeatureFlagGate(
    intent: NotificationIntent,
  ): NotificationDispatch | undefined {
    if (!this.flagResolver) {
      return undefined;
    }

    const flagState = this.flagResolver.resolve({
      flow_id: intent.flow_id,
      market_id: intent.recipient.market_id,
    });

    if (flagState.enabled) {
      return undefined;
    }

    // F-01: gated denial NIE jest cache'owany — operator flip OFF→ON musi natychmiast
    // odblokować flow bez czekania na TTL idempotency cache. Tradeoff: kolejne retry
    // dla disabled flow generują nowy dispatch_id, ale to akceptowalne dla denial path
    // (consumer i tak nie dostarcza wiadomości; idempotency invariant Story 5.1 zachowany
    // dla success/queued dispatchy).
    const dispatchId = this.uuid();
    return {
      dispatch_id: dispatchId,
      provider: this.defaultProvider,
      status: "failed",
      audit_event: this.createAuditEvent({
        intent,
        provider: this.defaultProvider,
        status: "failed",
        dispatch_id: dispatchId,
        error_code: "FLOW_DISABLED",
        error_message: `Communication flow '${intent.flow_id}' is disabled for market '${intent.recipient.market_id}'`,
        gate_source: "feature_flag",
      }),
    };
  }
}

// F-08: composite cache key (market_id + flow_id + channel + idempotency_key) chroni
// przed cross-tenant kolizją raw idempotency_key z różnych marketów/flow.
function buildCacheKey(intent: NotificationIntent): string {
  return [
    intent.recipient.market_id,
    intent.flow_id,
    intent.channel,
    intent.idempotency_key,
  ].join("|");
}

function hashRecipient(intent: NotificationIntent): string {
  const recipient = intent.recipient.email ?? intent.recipient.phone ?? "";
  return createHash("sha256")
    .update(`${intent.channel}:${recipient.toLowerCase()}`)
    .digest("hex");
}
