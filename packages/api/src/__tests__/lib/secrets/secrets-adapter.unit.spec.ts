import { EnvSecretsAdapter } from "../../../lib/secrets/env-adapter"
import { PAYMENT_PROVIDER_NOT_CONFIGURED } from "../../../lib/secrets/index"
import {
  createMarketStripeResolver,
  PaymentProviderNotConfiguredError,
} from "../../../lib/secrets/market-resolver"

describe("EnvSecretsAdapter", () => {
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

  it("reads STRIPE_WEBHOOK_SECRET_BONBEAUTY for webhook type", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_BONBEAUTY = "whsec_test"
    const key = await adapter.getStripeKey("bonbeauty", "webhook")
    expect(key).toBe("whsec_test")
  })

  it("throws PAYMENT_PROVIDER_NOT_CONFIGURED when env var is missing", async () => {
    delete process.env.STRIPE_SECRET_KEY_BONBEAUTY
    await expect(adapter.getStripeKey("bonbeauty", "secret")).rejects.toMatchObject({
      code: PAYMENT_PROVIDER_NOT_CONFIGURED,
      message: "Payment is not available for this market",
    })
  })
})

describe("createMarketStripeResolver — per-market routing", () => {
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
})
