import {
  WalletInvalidationDedupeStore,
  config,
  ENTITLEMENT_LIFECYCLE_EVENTS,
  handleVoucherWalletInvalidation,
  resetVoucherWalletInvalidationStateForTests,
  default as voucherWalletInvalidationSubscriber,
} from "../../subscribers/voucher-wallet-invalidation"
import { WalletPassInvalidationError, type WalletInvalidationReason } from "@gp/wallet"

type MockContainer = {
  resolve: jest.Mock
}

const fixedNow = new Date("2026-05-27T10:00:10.000Z")
const eventTimestamp = "2026-05-27T10:00:00.000Z"

function makeContainer(
  facade: {
    invalidatePass: jest.Mock
  } | null
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
      if (key === "wallet_pass_facade") {
        if (!facade) throw new Error("facade not registered")
        return facade
      }
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
      const facade = {
        invalidatePass: jest
          .fn()
          .mockResolvedValue({
            audit_event: {
              event_type: "wallet.pass_invalidated",
              entitlement_instance_id: "ei_123",
              provider: "google",
              reason,
              outcome: "success",
              timestamp: fixedNow.toISOString(),
            },
          }),
      }
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
          provider_audit_event: expect.objectContaining({
            outcome: "success",
          }),
        })
      )
      // M-I3: audit topic ≠ event_type, distinct bus channel.
      expect(container.eventBus.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: "audit.wallet.pass_invalidated" })
      )
    }
  )

  it("retry po pierwszym błędzie i publikuje audit envelope dla fail + success", async () => {
    const facade = {
      invalidatePass: jest
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce({ audit_event: { outcome: "success" } }),
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

  it("po wyczerpaniu retry publikuje invalidation_retry_exhausted (3 attempts wariant A)", async () => {
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

  it("error fallback propaguje provider error_code/error_message z WalletPassInvalidationError", async () => {
    const providerEnvelope = {
      event_type: "wallet.pass_invalidation_failed" as const,
      entitlement_instance_id: "ei_123",
      provider: "google" as const,
      outcome: "failure" as const,
      timestamp: fixedNow.toISOString(),
      error_code: "GOOGLE_WALLET_API_403",
      error_message: "permission denied on objects.patch",
    }
    const facade = {
      invalidatePass: jest
        .fn()
        .mockRejectedValue(
          new WalletPassInvalidationError("provider failed", providerEnvelope)
        ),
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

    expect(result).toMatchObject({
      outcome: "invalidation_retry_exhausted",
      error_code: "GOOGLE_WALLET_API_403",
      error_message: "permission denied on objects.patch",
      provider_audit_event: expect.objectContaining({
        error_code: "GOOGLE_WALLET_API_403",
      }),
    })
  })

  it("redelivery po sukcesie zwraca was_deduplicated=true i zachowuje outcome=invalidated", async () => {
    const facade = {
      invalidatePass: jest.fn().mockResolvedValue({ audit_event: { outcome: "success" } }),
    }
    const container = makeContainer(facade)
    const dedupeStore = new WalletInvalidationDedupeStore()

    await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.expired",
        payload: payload(),
        container,
      },
      { dedupeStore, now: () => fixedNow, sleep: async () => undefined }
    )
    const replay = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.expired",
        payload: payload(),
        container,
      },
      { dedupeStore, now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).toHaveBeenCalledTimes(1)
    expect(replay).toMatchObject({
      outcome: "invalidated",
      was_deduplicated: true,
      latency_ms: null,
    })
  })

  it("redelivery po invalidation_gated NIE zwraca fałszywego invalidated (H1)", async () => {
    process.env.WALLET_APPLE_ENABLED = "false"
    const facade = { invalidatePass: jest.fn() }
    const container = makeContainer(facade)
    const dedupeStore = new WalletInvalidationDedupeStore()

    const first = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload({ provider_hint: "apple" }),
        container,
      },
      { dedupeStore, now: () => fixedNow, sleep: async () => undefined }
    )
    expect(first.outcome).toBe("invalidation_gated")

    // Po flag flip do true druga delivery musi spróbować realnego providera.
    process.env.WALLET_APPLE_ENABLED = "true"
    const facade2Resolution = { audit_event: { outcome: "success" as const } }
    facade.invalidatePass.mockResolvedValueOnce(facade2Resolution)
    const second = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload({ provider_hint: "apple" }),
        container,
      },
      { dedupeStore, now: () => fixedNow, sleep: async () => undefined }
    )
    expect(facade.invalidatePass).toHaveBeenCalledTimes(1)
    expect(second.outcome).toBe("invalidated")
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

  it("L2: payload bez entitlement_instance_id daje envelope ENTITLEMENT_INSTANCE_ID_MISSING", async () => {
    const facade = { invalidatePass: jest.fn() }
    const container = makeContainer(facade)

    const result = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: { market_id: "bonbeauty" } as never,
        container,
      },
      { now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      outcome: "invalidation_failed",
      error_code: "ENTITLEMENT_INSTANCE_ID_MISSING",
      entitlement_instance_id: "",
    })
  })

  it("L2: brak wallet_pass_facade w containerze daje envelope WALLET_PASS_FACADE_NOT_RESOLVED", async () => {
    const container = makeContainer(null)

    const result = await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload(),
        container,
      },
      { now: () => fixedNow, sleep: async () => undefined }
    )

    expect(result).toMatchObject({
      outcome: "invalidation_failed",
      error_code: "WALLET_PASS_FACADE_NOT_RESOLVED",
    })
  })

  it("L4: dedupe key zawiera provider — Google→Apple migracja nie deduplikuje fałszywie", async () => {
    const facade = {
      invalidatePass: jest.fn().mockResolvedValue({ audit_event: { outcome: "success" } }),
    }
    const container = makeContainer(facade)
    const dedupeStore = new WalletInvalidationDedupeStore()

    await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload({ provider_hint: "google" }),
        container,
      },
      { dedupeStore, now: () => fixedNow, sleep: async () => undefined }
    )
    // Apple z włączoną flagą — nie powinien się zdeduplikować z Google.
    process.env.WALLET_APPLE_ENABLED = "true"
    await handleVoucherWalletInvalidation(
      {
        eventName: "entitlement_instance.revoked",
        payload: payload({ provider_hint: "apple" }),
        container,
      },
      { dedupeStore, now: () => fixedNow, sleep: async () => undefined }
    )

    expect(facade.invalidatePass).toHaveBeenCalledTimes(2)
    expect(facade.invalidatePass).toHaveBeenNthCalledWith(
      1,
      "ei_123",
      "google",
      "revoked"
    )
    expect(facade.invalidatePass).toHaveBeenNthCalledWith(
      2,
      "ei_123",
      "apple",
      "revoked"
    )
  })

  it("M3: dedupe store ma LRU cap i TTL (eviction)", () => {
    let nowMs = 1_000_000
    const store = new WalletInvalidationDedupeStore(2, 1_000, () => nowMs)
    const stub = (key: string) =>
      ({
        event_type: "wallet.pass_invalidated",
        entitlement_instance_id: key,
        provider: "google",
        reason: "revoked",
        outcome: "invalidated",
        timestamp: new Date(nowMs).toISOString(),
        latency_ms: 0,
        attempt: 1,
        market_id: "bonbeauty",
      }) as never

    store.set("a", stub("a"))
    store.set("b", stub("b"))
    store.set("c", stub("c"))
    // LRU eviction: "a" usunięte po przekroczeniu cap=2.
    expect(store.get("a")).toBeUndefined()
    expect(store.size()).toBe(2)

    // TTL expiry: po 1001ms entry "b" wygasa.
    nowMs += 1_001
    expect(store.get("b")).toBeUndefined()
  })

  it("kontrakt integracyjny: Medusa subscriber pobiera facade z DI i obsługuje event", async () => {
    const facade = {
      invalidatePass: jest.fn().mockResolvedValue({ audit_event: { outcome: "success" } }),
    }
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
