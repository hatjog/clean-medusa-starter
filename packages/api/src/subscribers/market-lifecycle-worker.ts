import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import { marketContextCache } from "../loaders/market-context-cache"
import {
  MARKET_CREATED_EVENT,
  MARKET_UPDATED_EVENT,
  assertEventEnvelopeMatchesContract,
  type GpEventEnvelope,
  type MarketCreatedPayload,
} from "../modules/gp-core/market-lifecycle-events"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type MarketLifecycleWorkerDependencies = {
  logger?: LoggerLike
  processedKeys?: Set<string>
  invalidateMarketContextCache?: () => void | Promise<void>
}

function resolveLogger(container: Record<string, unknown> | undefined): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined
  if (direct) {
    return direct
  }

  const resolver = container?.resolve as ((key: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console
    } catch (_error) {
      return console
    }
  }

  return console
}

const PROCESSED_KEYS_MAX_SIZE = 10_000
const sharedProcessedKeys = new Set<string>()

export class MarketLifecycleWorker {
  private readonly logger_: LoggerLike
  private readonly processedKeys_: Set<string>
  private readonly invalidateMarketContextCache_: (() => void | Promise<void>) | undefined

  constructor(dependencies: MarketLifecycleWorkerDependencies = {}) {
    this.logger_ = dependencies.logger ?? console
    this.processedKeys_ = dependencies.processedKeys ?? new Set<string>()
    this.invalidateMarketContextCache_ = dependencies.invalidateMarketContextCache
  }

  async handle(eventEnvelope: GpEventEnvelope<Record<string, unknown>>): Promise<void> {
    const eventType = (eventEnvelope as { event_type?: string }).event_type

    if (eventType === MARKET_UPDATED_EVENT) {
      return this.handleUpdated(eventEnvelope)
    }

    return this.handleCreated(eventEnvelope as GpEventEnvelope<MarketCreatedPayload>)
  }

  private async handleCreated(eventEnvelope: GpEventEnvelope<MarketCreatedPayload>): Promise<void> {
    assertEventEnvelopeMatchesContract<MarketCreatedPayload>(
      eventEnvelope,
      MARKET_CREATED_EVENT
    )

    if (this.processedKeys_.has(eventEnvelope.idempotency_key)) {
      this.logger_.info?.(
        `[market-lifecycle-worker] duplicate event skipped: ${eventEnvelope.idempotency_key}`
      )
      return
    }

    if (this.processedKeys_.size >= PROCESSED_KEYS_MAX_SIZE) {
      const oldest = this.processedKeys_.values().next().value
      if (oldest !== undefined) {
        this.processedKeys_.delete(oldest)
      }
    }
    this.processedKeys_.add(eventEnvelope.idempotency_key)

    try {
      this.logger_.info?.(
        `[market-lifecycle-worker] Market created: ${eventEnvelope.payload.slug}`
      )
      await this.runCreatedPipeline(eventEnvelope)
    } catch (error) {
      this.processedKeys_.delete(eventEnvelope.idempotency_key)
      throw error
    }
  }

  private async handleUpdated(eventEnvelope: GpEventEnvelope<Record<string, unknown>>): Promise<void> {
    const slug = (eventEnvelope.payload as { slug?: string }).slug ?? "unknown"
    this.logger_.info?.(
      `[market-lifecycle-worker] Market updated: ${slug} (stub — no pipeline actions yet)`
    )
  }

  private async runCreatedPipeline(
    eventEnvelope: GpEventEnvelope<MarketCreatedPayload>
  ): Promise<void> {
    const slug = eventEnvelope.payload.slug

    this.logger_.info?.(
      `[market-lifecycle-worker] TODO gp-market-storefront-key for ${slug}`
    )
    this.logger_.info?.(
      `[market-lifecycle-worker] TODO portal init-market for ${slug}`
    )
    this.logger_.info?.(
      `[market-lifecycle-worker] TODO gp-config-sync-catalog for ${slug}`
    )
    this.logger_.info?.(
      `[market-lifecycle-worker] TODO MarketContextCache.invalidate() for ${slug}`
    )

    await this.invalidateMarketContextCache_?.()
  }
}

export default async function marketLifecycleWorkerHandler({
  event,
  container,
}: SubscriberArgs<GpEventEnvelope<Record<string, unknown>>>): Promise<void> {
  const worker = new MarketLifecycleWorker({
    logger: resolveLogger(container as Record<string, unknown> | undefined),
    processedKeys: sharedProcessedKeys,
    invalidateMarketContextCache: () => marketContextCache.invalidate(),
  })

  await worker.handle(event.data)
}

export const config: SubscriberConfig = {
  event: [MARKET_CREATED_EVENT, MARKET_UPDATED_EVENT],
  context: {
    subscriberId: "market-lifecycle-worker",
  },
}