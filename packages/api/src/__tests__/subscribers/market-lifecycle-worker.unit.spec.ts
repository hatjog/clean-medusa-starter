import {
  SchemaValidationError,
  buildMarketCreatedEnvelope,
  type GpEventEnvelope,
  type MarketCreatedPayload,
} from "../../modules/gp-core/market-lifecycle-events"
import type { GpCoreMarketRecord } from "../../modules/gp-core/models"
import { MarketLifecycleWorker } from "../../subscribers/market-lifecycle-worker"

function buildMarket(overrides: Partial<GpCoreMarketRecord> = {}): GpCoreMarketRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    instance_id: "gp-dev",
    name: "BonBeauty",
    slug: "bonbeauty",
    status: "published",
    sales_channel_id: "sc_bonbeauty",
    payload_vendor_id: null,
    created_at: "2026-03-06T10:00:00.000Z",
    updated_at: "2026-03-06T10:00:00.000Z",
    ...overrides,
  }
}

describe("market lifecycle worker", () => {
  it("receives and logs a market_created event", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const invalidateMarketContextCache = jest.fn()
    const worker = new MarketLifecycleWorker({
      logger,
      invalidateMarketContextCache,
    })

    const envelope = buildMarketCreatedEnvelope({
      market: buildMarket(),
    })

    await worker.handle(envelope)

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Market created: bonbeauty")
    )
    expect(invalidateMarketContextCache).toHaveBeenCalledTimes(1)
  })

  it("is idempotent when the same event is handled twice", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const invalidateMarketContextCache = jest.fn()
    const processedKeys = new Set<string>()
    const worker = new MarketLifecycleWorker({
      logger,
      processedKeys,
      invalidateMarketContextCache,
    })

    const envelope = buildMarketCreatedEnvelope({
      market: buildMarket(),
    })

    await worker.handle(envelope)
    await expect(worker.handle(envelope)).resolves.toBeUndefined()

    expect(invalidateMarketContextCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("duplicate event skipped")
    )
  })

  it("throws a schema validation error when required fields are missing", async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const invalidateMarketContextCache = jest.fn()
    const worker = new MarketLifecycleWorker({
      logger,
      invalidateMarketContextCache,
    })

    const validEnvelope = buildMarketCreatedEnvelope({
      market: buildMarket(),
    })
    const invalidEnvelope: GpEventEnvelope<MarketCreatedPayload> = {
      ...validEnvelope,
      payload: {
        ...validEnvelope.payload,
        slug: undefined as unknown as string,
      },
    }

    await expect(worker.handle(invalidEnvelope)).rejects.toBeInstanceOf(
      SchemaValidationError
    )
    expect(invalidateMarketContextCache).not.toHaveBeenCalled()
  })
})