import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import {
  WalletPassInvalidationError,
  isWalletProviderKind,
  type WalletAuditEnvelope as ProviderAuditEnvelope,
  type WalletInvalidationReason,
  type WalletPassFacade,
  type WalletProviderKind,
} from "@gp/wallet"

export const ENTITLEMENT_LIFECYCLE_EVENTS = [
  "entitlement_instance.revoked",
  "entitlement_instance.expired",
  "entitlement_instance.refunded",
] as const

const REASON_BY_EVENT: Record<
  (typeof ENTITLEMENT_LIFECYCLE_EVENTS)[number],
  WalletInvalidationReason
> = {
  "entitlement_instance.revoked": "revoked",
  "entitlement_instance.expired": "expired",
  "entitlement_instance.refunded": "refunded",
}

// Wariant A (3 attempts = 1 initial + 2 retries): sleep [1s, 3s] = 4s budget
// retry. Evidence + schema spójne. Patrz fr-c-6 evidence i runbook.
const RETRY_DELAYS_BETWEEN_ATTEMPTS_MS = [1_000, 3_000] as const
const MAX_ATTEMPTS = RETRY_DELAYS_BETWEEN_ATTEMPTS_MS.length + 1
const DEFAULT_PROVIDER: WalletProviderKind = "google"
const AUDIT_EVENT_TYPE = "wallet.pass_invalidated"
// Distinct bus topic dla audit emission (M-I3); zapobiega kolizji z innym
// subscriberem nasłuchującym na nazwie envelope.
const AUDIT_BUS_TOPIC = "audit.wallet.pass_invalidated"

// LRU cap dla in-process dedupe (M-M3). 10k entries × ~64B ≈ 0.6MB ceiling;
// TTL 24h pokrywa redelivery window event-busa.
const DEDUPE_MAX_ENTRIES = 10_000
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string, error?: unknown) => void
}

type ContainerLike = {
  resolve?: (key: string) => unknown
  logger?: LoggerLike
  wallet_pass_facade?: WalletPassFacade
}

type AuditSinkLike = {
  append?: (envelope: WalletInvalidationAuditEnvelope) => Promise<void> | void
  record?: (envelope: WalletInvalidationAuditEnvelope) => Promise<void> | void
  publish?: (envelope: WalletInvalidationAuditEnvelope) => Promise<void> | void
}

type EventBusLike = {
  emit?: (event: {
    name: string
    data: WalletInvalidationAuditEnvelope
  }) => Promise<void> | void
}

export type WalletInvalidationOutcome =
  | "invalidated"
  | "invalidation_failed"
  | "invalidation_retry_exhausted"
  | "invalidation_gated"

export type WalletInvalidationPayload = {
  entitlement_instance_id?: string
  entitlement_id?: string
  id?: string
  lifecycle_reason?: WalletInvalidationReason
  reason?: WalletInvalidationReason
  provider_hint?: string
  wallet_pass_provider?: string
  market_id?: string
  timestamp?: string
  emitted_at?: string
}

export type WalletInvalidationAuditEnvelope = {
  event_type: typeof AUDIT_EVENT_TYPE
  entitlement_instance_id: string
  provider: WalletProviderKind
  reason: WalletInvalidationReason
  outcome: WalletInvalidationOutcome
  timestamp: string
  latency_ms: number | null
  attempt: number
  error_code?: string
  error_message?: string
  market_id: string
  gate_reason?: string
  next_retry_at?: string
  was_deduplicated?: boolean
  provider_audit_event?: ProviderAuditEnvelope
}

// Best-effort within-process dedupe. Prawdziwa idempotency = provider-side
// (Google `objects.patch`). Mapa zachowuje oryginalny envelope per
// idempotency key, żeby redelivery po `invalidation_gated` lub
// `invalidation_failed` NIE raportowała fałszywego `invalidated` (H1).
type DedupeEntry = {
  envelope: WalletInvalidationAuditEnvelope
  expires_at: number
}

export class WalletInvalidationDedupeStore {
  private readonly entries = new Map<string, DedupeEntry>()

  constructor(
    private readonly maxEntries: number = DEDUPE_MAX_ENTRIES,
    private readonly ttlMs: number = DEDUPE_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(key: string): WalletInvalidationAuditEnvelope | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires_at <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    // refresh LRU position
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.envelope
  }

  set(key: string, envelope: WalletInvalidationAuditEnvelope): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, {
      envelope,
      expires_at: this.now() + this.ttlMs,
    })
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value
      if (firstKey === undefined) break
      this.entries.delete(firstKey)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }
}

export type WalletInvalidationHandlerOptions = {
  dedupeStore?: WalletInvalidationDedupeStore
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

const processedInvalidations = new WalletInvalidationDedupeStore()

export function resetVoucherWalletInvalidationStateForTests(): void {
  processedInvalidations.clear()
}

export default async function voucherWalletInvalidationSubscriber({
  event,
  container,
}: SubscriberArgs<WalletInvalidationPayload>): Promise<void> {
  await handleVoucherWalletInvalidation({
    eventName: event.name,
    payload: event.data,
    container: container as unknown as ContainerLike,
  })
}

export async function handleVoucherWalletInvalidation(
  input: {
    eventName?: string
    payload: WalletInvalidationPayload
    container: ContainerLike
  },
  options: WalletInvalidationHandlerOptions = {}
): Promise<WalletInvalidationAuditEnvelope> {
  const now = options.now ?? (() => new Date())
  const sleep =
    options.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const dedupe = options.dedupeStore ?? processedInvalidations
  const logger = resolveLogger(input.container)
  const reason = resolveReason(input.eventName, input.payload)
  const entitlementInstanceId = resolveEntitlementInstanceId(input.payload)
  const marketId = readNonEmptyString(input.payload.market_id) ?? "unknown"
  const eventTimestamp = parseEventTimestamp(input.payload, now)

  if (!entitlementInstanceId) {
    const envelope = buildEnvelope({
      entitlementInstanceId: "",
      provider: DEFAULT_PROVIDER,
      reason,
      outcome: "invalidation_failed",
      attempt: 1,
      marketId,
      eventTimestamp,
      now,
      errorCode: "ENTITLEMENT_INSTANCE_ID_MISSING",
    })
    await publishAuditEnvelope(input.container, envelope, logger)
    return envelope
  }

  const provider = resolveProvider(input.payload)
  // L4: provider w kluczu, żeby cross-provider redelivery (Google→Apple
  // migracja) NIE deduplikowała się fałszywie.
  const idempotencyKey = `${entitlementInstanceId}:${provider}:${reason}`

  const previousEnvelope = dedupe.get(idempotencyKey)
  if (previousEnvelope) {
    // H1 + L1: replay oryginalnego envelope, oznacz was_deduplicated=true,
    // latency_ms=null (nie wołamy providera, więc latency nie istnieje).
    const envelope: WalletInvalidationAuditEnvelope = {
      ...previousEnvelope,
      timestamp: now().toISOString(),
      latency_ms: null,
      was_deduplicated: true,
    }
    await publishAuditEnvelope(input.container, envelope, logger)
    logger.info?.(
      `[voucher-wallet-invalidation] duplicate skipped entitlement_instance_id=${entitlementInstanceId} provider=${provider} reason=${reason} replayed_outcome=${previousEnvelope.outcome}`
    )
    return envelope
  }

  if (provider === "apple" && process.env.WALLET_APPLE_ENABLED !== "true") {
    const envelope = buildEnvelope({
      entitlementInstanceId,
      provider,
      reason,
      outcome: "invalidation_gated",
      attempt: 1,
      marketId,
      eventTimestamp,
      now,
      errorCode: "APPLE_WALLET_DISABLED",
      gateReason: "wallet_apple_enabled_false",
    })
    // H1: NIE dodajemy gated do dedupe — flag flip ma umożliwić retry.
    await publishAuditEnvelope(input.container, envelope, logger)
    return envelope
  }

  const facade = resolveWalletPassFacade(input.container)
  if (!facade) {
    const envelope = buildEnvelope({
      entitlementInstanceId,
      provider,
      reason,
      outcome: "invalidation_failed",
      attempt: 1,
      marketId,
      eventTimestamp,
      now,
      errorCode: "WALLET_PASS_FACADE_NOT_RESOLVED",
    })
    // H1: facade-not-resolved to transient infra issue → NIE cache'ujemy.
    await publishAuditEnvelope(input.container, envelope, logger)
    return envelope
  }

  let lastEnvelope: WalletInvalidationAuditEnvelope | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const { audit_event: providerEnvelope } = await facade.invalidatePass(
        entitlementInstanceId,
        provider,
        reason
      )
      const envelope = buildEnvelope({
        entitlementInstanceId,
        provider,
        reason,
        outcome: "invalidated",
        attempt,
        marketId,
        eventTimestamp,
        now,
        providerAuditEvent: providerEnvelope,
      })
      // H1: cache'ujemy tylko sukces — kolejna redelivery zostanie zreplaywana.
      dedupe.set(idempotencyKey, envelope)
      await publishAuditEnvelope(input.container, envelope, logger)
      return envelope
    } catch (error) {
      const exhausted = attempt === MAX_ATTEMPTS
      const delayIndex = attempt - 1
      const nextRetryAt = exhausted
        ? undefined
        : new Date(
            now().getTime() + RETRY_DELAYS_BETWEEN_ATTEMPTS_MS[delayIndex]
          ).toISOString()
      const providerEnvelope =
        error instanceof WalletPassInvalidationError ? error.audit_event : undefined
      lastEnvelope = buildEnvelope({
        entitlementInstanceId,
        provider,
        reason,
        outcome: exhausted
          ? "invalidation_retry_exhausted"
          : "invalidation_failed",
        attempt,
        marketId,
        eventTimestamp,
        now,
        errorCode: providerEnvelope?.error_code ?? errorName(error),
        errorMessage: providerEnvelope?.error_message ?? errorMessage(error),
        nextRetryAt,
        providerAuditEvent: providerEnvelope,
      })
      await publishAuditEnvelope(input.container, lastEnvelope, logger)
      if (!exhausted) {
        await sleep(RETRY_DELAYS_BETWEEN_ATTEMPTS_MS[delayIndex])
      }
    }
  }

  return lastEnvelope as WalletInvalidationAuditEnvelope
}

function resolveReason(
  eventName: string | undefined,
  payload: WalletInvalidationPayload
): WalletInvalidationReason {
  if (payload.lifecycle_reason) return payload.lifecycle_reason
  if (payload.reason) return payload.reason
  if (
    eventName &&
    ENTITLEMENT_LIFECYCLE_EVENTS.includes(
      eventName as (typeof ENTITLEMENT_LIFECYCLE_EVENTS)[number]
    )
  ) {
    return REASON_BY_EVENT[
      eventName as (typeof ENTITLEMENT_LIFECYCLE_EVENTS)[number]
    ]
  }
  return "revoked"
}

function resolveEntitlementInstanceId(
  payload: WalletInvalidationPayload
): string | undefined {
  return (
    readNonEmptyString(payload.entitlement_instance_id) ??
    readNonEmptyString(payload.entitlement_id) ??
    readNonEmptyString(payload.id)
  )
}

function resolveProvider(payload: WalletInvalidationPayload): WalletProviderKind {
  const candidate =
    readNonEmptyString(payload.provider_hint) ??
    readNonEmptyString(payload.wallet_pass_provider)
  return isWalletProviderKind(candidate) ? candidate : DEFAULT_PROVIDER
}

function resolveLogger(container: ContainerLike | undefined): LoggerLike {
  if (container?.logger) return container.logger
  try {
    return (container?.resolve?.("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

function resolveWalletPassFacade(
  container: ContainerLike | undefined
): WalletPassFacade | null {
  if (container?.wallet_pass_facade) return container.wallet_pass_facade
  const resolver = container?.resolve
  if (!resolver) return null

  for (const key of ["wallet_pass_facade", "walletPassFacade", "@gp/wallet"]) {
    try {
      const facade = resolver(key) as WalletPassFacade | null
      if (facade) return facade
    } catch {
      continue
    }
  }
  return null
}

function parseEventTimestamp(
  payload: WalletInvalidationPayload,
  now: () => Date
): Date {
  const raw =
    readNonEmptyString(payload.timestamp) ??
    readNonEmptyString(payload.emitted_at)
  if (!raw) return now()
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? now() : parsed
}

function buildEnvelope(input: {
  entitlementInstanceId: string
  provider: WalletProviderKind
  reason: WalletInvalidationReason
  outcome: WalletInvalidationOutcome
  attempt: number
  marketId: string
  eventTimestamp: Date
  now: () => Date
  errorCode?: string
  errorMessage?: string
  gateReason?: string
  nextRetryAt?: string
  providerAuditEvent?: ProviderAuditEnvelope
}): WalletInvalidationAuditEnvelope {
  const timestamp = input.now()
  const latencyMs =
    input.outcome === "invalidated"
      ? Math.max(0, timestamp.getTime() - input.eventTimestamp.getTime())
      : null

  return {
    event_type: AUDIT_EVENT_TYPE,
    entitlement_instance_id: input.entitlementInstanceId,
    provider: input.provider,
    reason: input.reason,
    outcome: input.outcome,
    timestamp: timestamp.toISOString(),
    latency_ms: latencyMs,
    attempt: input.attempt,
    error_code: input.errorCode,
    error_message: input.errorMessage,
    market_id: input.marketId,
    gate_reason: input.gateReason,
    next_retry_at: input.nextRetryAt,
    provider_audit_event: input.providerAuditEvent,
  }
}

async function publishAuditEnvelope(
  container: ContainerLike | undefined,
  envelope: WalletInvalidationAuditEnvelope,
  logger: LoggerLike
): Promise<void> {
  const sink = resolveOptional<AuditSinkLike>(container, [
    "audit_event_sink",
    "auditEnvelopeSink",
    "audit",
  ])
  if (sink?.append) {
    await sink.append(envelope)
  } else if (sink?.record) {
    await sink.record(envelope)
  } else if (sink?.publish) {
    await sink.publish(envelope)
  }

  const eventBus = resolveOptional<EventBusLike>(container, [
    "event_bus",
    "eventBus",
  ])
  // M-I3: distinct topic `audit.wallet.pass_invalidated` (≠ AUDIT_EVENT_TYPE)
  // dla audit emission, żeby konsument tej story (lifecycle subscriber) NIE
  // mógł zarejestrować się na własny output i wpaść w pętlę.
  await eventBus?.emit?.({
    name: AUDIT_BUS_TOPIC,
    data: envelope,
  })

  logger.info?.(
    `[voucher-wallet-invalidation] outcome=${envelope.outcome} entitlement_instance_id=${envelope.entitlement_instance_id} reason=${envelope.reason} attempt=${envelope.attempt}`
  )
}

function resolveOptional<T>(
  container: ContainerLike | undefined,
  keys: string[]
): T | null {
  const resolver = container?.resolve
  if (!resolver) return null

  for (const key of keys) {
    try {
      const value = resolver(key) as T | null
      if (value) return value
    } catch {
      continue
    }
  }
  return null
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UNKNOWN_ERROR"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const config: SubscriberConfig = {
  event: [...ENTITLEMENT_LIFECYCLE_EVENTS],
}
