import { EnvSecretsAdapter } from "../../../lib/secrets/env-adapter"
import {
  PAYMENT_PROVIDER_NOT_CONFIGURED,
  SECRET_NOT_CONFIGURED,
} from "../../../lib/secrets/index"
import {
  createMarketStripeResolver,
  PaymentProviderNotConfiguredError,
} from "../../../lib/secrets/market-resolver"

describe("EnvSecretsAdapter (Story 1.2 AC2)", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  const adapter = new EnvSecretsAdapter()

  it("reads STRIPE_SECRET_KEY_BONBEAUTY for secret type", async () => {
    process.env.STRIPE_SECRET_KEY_BONBEAUTY = "sk_test_secret"
    const key = await adapter.getStripeKey("bonbeauty", "secret")
    expect(key).toBe("sk_test_secret")
  })

  it("reads STRIPE_PUBLISHABLE_KEY_BONBEAUTY for publishable type", async () => {
    process.env.STRIPE_PUBLISHABLE_KEY_BONBEAUTY = "pk_test_pub"
    const key = await adapter.getStripeKey("bonbeauty", "publishable")
    expect(key).toBe("pk_test_pub")
  })

  // AC2: uniform STRIPE_<TYPE>_KEY_<MARKET> naming — webhook is
  // STRIPE_WEBHOOK_KEY_<MARKET> (NOT Story 1.1's STRIPE_WEBHOOK_SECRET_*;
  // documented discrepancy — see story Dev Agent Record).
  it("reads STRIPE_WEBHOOK_KEY_BONBEAUTY for webhook type", async () => {
    process.env.STRIPE_WEBHOOK_KEY_BONBEAUTY = "whsec_test"
    const key = await adapter.getStripeKey("bonbeauty", "webhook")
    expect(key).toBe("whsec_test")
  })

  it("throws SECRET_NOT_CONFIGURED when env var is missing", async () => {
    delete process.env.STRIPE_SECRET_KEY_BONBEAUTY
    await expect(
      adapter.getStripeKey("bonbeauty", "secret")
    ).rejects.toMatchObject({ code: SECRET_NOT_CONFIGURED })
  })

  it("error names the missing key but never leaks other env values", async () => {
    delete process.env.STRIPE_SECRET_KEY_BONBEAUTY
    process.env.SOME_OTHER_SECRET = "do-not-leak-me"
    const err = await adapter
      .getStripeKey("bonbeauty", "secret")
      .catch((e: Error) => e)
    expect((err as Error).message).toContain("STRIPE_SECRET_KEY_BONBEAUTY")
    expect((err as Error).message).not.toContain("do-not-leak-me")
    expect((err as Error).message).not.toContain("SOME_OTHER_SECRET")
  })

  it("does not return another market's value on a market typo", async () => {
    // Only bonbeauty is configured; a typo'd / different market id must NOT
    // fall back to bonbeauty's value — it must fail-fast.
    process.env.STRIPE_SECRET_KEY_BONBEAUTY = "sk_test_secret"
    delete process.env.STRIPE_SECRET_KEY_BONEVENT
    await expect(
      adapter.getStripeKey("bonevent", "secret")
    ).rejects.toMatchObject({ code: SECRET_NOT_CONFIGURED })
  })
})

// Story 1.1 resolver — UNCHANGED by Story 1.2. The resolver keeps its own
// PAYMENT_PROVIDER_NOT_CONFIGURED market-gating error (distinct concern from
// the adapter's SECRET_NOT_CONFIGURED). Preserved verbatim to prove 1.1 is
// not broken.
describe("createMarketStripeResolver — per-market routing (Story 1.1, preserved)", () => {
  const mockAdapter = {
    getStripeKey: jest.fn().mockResolvedValue("sk_test_key"),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  const resolver = createMarketStripeResolver(mockAdapter)

  it("bonbeauty market delegates to adapter", async () => {
    const key = await resolver("bonbeauty", "secret")
    expect(key).toBe("sk_test_key")
    expect(mockAdapter.getStripeKey).toHaveBeenCalledWith("bonbeauty", "secret")
  })

  it("bonevent market throws PaymentProviderNotConfiguredError", async () => {
    await expect(resolver("bonevent", "secret")).rejects.toThrow(
      PaymentProviderNotConfiguredError
    )
  })

  it("bongarden market throws PaymentProviderNotConfiguredError", async () => {
    await expect(resolver("bongarden", "secret")).rejects.toThrow(
      PaymentProviderNotConfiguredError
    )
  })

  it("mercur market throws PaymentProviderNotConfiguredError", async () => {
    await expect(resolver("mercur", "secret")).rejects.toThrow(
      PaymentProviderNotConfiguredError
    )
  })

  it("testmarketb market throws PaymentProviderNotConfiguredError", async () => {
    await expect(resolver("testmarketb", "secret")).rejects.toThrow(
      PaymentProviderNotConfiguredError
    )
  })

  it("F-NEW-H2: all unconfigured markets emit identical error message", async () => {
    const unconfiguredMarkets = ["bonevent", "bongarden", "mercur", "testmarketb"]
    const messages = await Promise.all(
      unconfiguredMarkets.map((market) =>
        resolver(market, "secret").catch((e: Error) => e.message)
      )
    )
    const uniqueMessages = new Set(messages)
    expect(uniqueMessages.size).toBe(1)
    expect(messages[0]).toBe("Payment is not available for this market")
  })

  it("unknown market_id throws PaymentProviderNotConfiguredError", async () => {
    await expect(resolver("unknown-market", "secret")).rejects.toThrow(
      PaymentProviderNotConfiguredError
    )
  })

  it("PAYMENT_PROVIDER_NOT_CONFIGURED code is still exported and stable", () => {
    expect(PAYMENT_PROVIDER_NOT_CONFIGURED).toBe("PAYMENT_PROVIDER_NOT_CONFIGURED")
  })
})
