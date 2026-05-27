import {
  config,
  ENTITLEMENT_LIFECYCLE_EVENTS,
  handleVoucherWalletInvalidation,
  resetVoucherWalletInvalidationStateForTests,
  default as voucherWalletInvalidationSubscriber,
} from "../../subscribers/voucher-wallet-invalidation"
import type { WalletInvalidationReason } from "../../../../wallet/src"

type MockContainer = {
  resolve: jest.Mock
}

const fixedNow = new Date("2026-05-27T10:00:10.000Z")
const eventTimestamp = "2026-05-27T10:00:00.000Z"

function makeContainer(
  facade: {
    invalidatePass: jest.Mock
  }
): MockContainer & {
  auditSink: { append: jest.Mock }
  eventBus: { emit: jest.Mock }
} {
  const auditSink = { append: jest.fn() }
  const eventBus = { emit: jest.fn() }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return {
    auditSink,
    eventBus,
    resolve: jest.fn((key: string) => {
      if (key === "wallet_pass_facade") return facade
      if (key === "audit_event_sink") return auditSink
      if (key === "event_bus") return eventBus
      if (key === "logger") return logger
      throw new Error(`missing ${key}`)
    }),
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    entitlement_instance_id: "ei_123",
    market_id: "bonbeauty",
    timestamp: eventTimestamp,
    ...overrides,
  }
}

describe("voucher-wallet-invalidation subscriber", () => {
  beforeEach(() => {
    resetVoucherWalletInvalidationStateForTests()
    delete process.env.WALLET_APPLE_ENABLED
  })

  it.each([
    ["entitlement_instance.revoked", "revoked"],
    ["entitlement_instance.expired", "expired"],
    ["entitlement_instance.refunded", "refunded"],
  ] as Array<[string, WalletInvalidationReason]>)(
    "mapuje %s na facade.invalidatePass(..., %s)",
    async (eventName, reason) => {
      const facade = { invalidatePass: jest.fn().mockResolvedValue({ audit_event: {} }) }
      const container = makeContainer(facade)

      await handleVoucherWalletInvalidation(
        {
          eventName,
          payload: payload(),
          container,
        },
        { now: () => fixedNow, sleep: async () => undefined }
      )

      expect(facade.invalidatePass).toHaveBeenCalledWith(
        "ei_123",
        "google",
        reason
      )
      expect(container.auditSink.append).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event_type: "wallet.pass_invalidated",
          entitlement_instance_id: "ei_123",
          provider: "google",
          reason,
          outcome: "invalidated",
          latency_ms: 10_000,
          attempt: 1,
          market_id: "bonbeauty",
        })
      )
    }
  )

  it("retry po pierwszym błędzie i publikuje audit envelope dla fail + success", async () => {
    const facade = {
      invalidatePass: jest
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce({ audit_event: {} }),
    }
    const container = makeContainer(facade)

    const result = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload(),
        container,
      },
      { now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).toHaveBeenCalledTimes(2)
    expect(container.auditSink.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outcome: "invalidation_failed",
        attempt: 1,
        error_code: "Error",
        next_retry_at: "2026-05-27T10:00:11.000Z",
      })
    )
    expect(result).toMatchObject({ outcome: "invalidated", attempt: 2 })
  })

  it("po wyczerpaniu retry publikuje invalidation_retry_exhausted", async () => {
    const facade = {
      invalidatePass: jest.fn().mockRejectedValue(new Error("provider down")),
    }
    const container = makeContainer(facade)

    const result = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.refunded",
        payload: payload(),
        container,
      },
      { now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({
      outcome: "invalidation_retry_exhausted",
      attempt: 3,
      error_code: "Error",
      latency_ms: null,
    })
  })

  it("redelivery tego samego entitlement_instance + reason nie wywołuje drugi raz providera", async () => {
    const facade = { invalidatePass: jest.fn().mockResolvedValue({ audit_event: {} }) }
    const container = makeContainer(facade)
    const processedKeys = new Set<string>()

    await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.expired",
        payload: payload(),
        container,
      },
      { processedKeys, now: () => fixedNow, sleep: async () => undefined }
    )
    await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.expired",
        payload: payload(),
        container,
      },
      { processedKeys, now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).toHaveBeenCalledTimes(1)
  })

  it("Apple flag-off daje invalidation_gated i nie woła facade.invalidatePass", async () => {
    const facade = { invalidatePass: jest.fn() }
    const container = makeContainer(facade)

    const result = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload({ provider_hint: "apple" }),
        container,
      },
      { now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      provider: "apple",
      outcome: "invalidation_gated",
      error_code: "APPLE_WALLET_DISABLED",
      gate_reason: "wallet_apple_enabled_false",
    })
  })

  it("kontrakt integracyjny: Medusa subscriber pobiera facade z DI i obsługuje event", async () => {
    const facade = { invalidatePass: jest.fn().mockResolvedValue({ audit_event: {} }) }
    const container = makeContainer(facade)

    await voucherWalletInvalidationSubscriber({
      event: {
        name: "entitlement_instance.refunded",
        data: payload({ provider_hint: "google" }),
      },
      container,
    } as never)

    expect(facade.invalidatePass).toHaveBeenCalledWith(
      "ei_123",
      "google",
      "refunded"
    )
  })

  it("rejestruje trzy lifecycle eventy entitlement_instance", () => {
    expect(config).toEqual({ event: [...ENTITLEMENT_LIFECYCLE_EVENTS] })
  })
})
