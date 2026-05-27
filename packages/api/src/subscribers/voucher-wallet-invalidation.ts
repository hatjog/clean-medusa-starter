import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import {
  isWalletProviderKind,
  type WalletInvalidationReason,
  type WalletProviderKind,
} from "../../../wallet/src"
import type { WalletPassFacade } from "../../../wallet/src/facade"

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

const RETRY_BACKOFF_MS = [1_000, 3_000, 9_000] as const
const DEFAULT_PROVIDER: WalletProviderKind = "google"
const AUDIT_EVENT_TYPE = "wallet.pass_invalidated"

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
  market_id: string
  gate_reason?: string
  next_retry_at?: string
}

export type WalletInvalidationHandlerOptions = {
  processedKeys?: Set<string>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

const processedInvalidations = new Set<string>()

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
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const processedKeys = options.processedKeys ?? processedInvalidations
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
  const idempotencyKey = `${entitlementInstanceId}:${reason}`

  if (processedKeys.has(idempotencyKey)) {
    const envelope = buildEnvelope({
      entitlementInstanceId,
      provider,
      reason,
      outcome: "invalidated",
      attempt: 1,
      marketId,
      eventTimestamp,
      now,
    })
    await publishAuditEnvelope(input.container, envelope, logger)
    logger.info?.(
      `[voucher-wallet-invalidation] duplicate skipped entitlement_instance_id=${entitlementInstanceId} reason=${reason}`
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
    processedKeys.add(idempotencyKey)
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
    await publishAuditEnvelope(input.container, envelope, logger)
    return envelope
  }

  let lastEnvelope: WalletInvalidationAuditEnvelope | null = null
  for (let index = 0; index < RETRY_BACKOFF_MS.length; index += 1) {
    const attempt = index + 1
    try {
      await facade.invalidatePass(entitlementInstanceId, provider, reason)
      const envelope = buildEnvelope({
        entitlementInstanceId,
        provider,
        reason,
        outcome: "invalidated",
        attempt,
        marketId,
        eventTimestamp,
        now,
      })
      processedKeys.add(idempotencyKey)
      await publishAuditEnvelope(input.container, envelope, logger)
      return envelope
    } catch (error) {
      const exhausted = attempt === RETRY_BACKOFF_MS.length
      const nextRetryAt = exhausted
        ? undefined
        : new Date(now().getTime() + RETRY_BACKOFF_MS[index]).toISOString()
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
        errorCode: errorName(error),
        nextRetryAt,
      })
      await publishAuditEnvelope(input.container, lastEnvelope, logger)
      if (!exhausted) {
        await sleep(RETRY_BACKOFF_MS[index])
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
  const raw = readNonEmptyString(payload.timestamp) ?? readNonEmptyString(payload.emitted_at)
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
  gateReason?: string
  nextRetryAt?: string
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
    market_id: input.marketId,
    gate_reason: input.gateReason,
    next_retry_at: input.nextRetryAt,
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
  await eventBus?.emit?.({
    name: AUDIT_EVENT_TYPE,
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

export const config: SubscriberConfig = {
  event: [...ENTITLEMENT_LIFECYCLE_EVENTS],
}
