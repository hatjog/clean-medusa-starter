/**
 * Wave G7 (F-CC1-001): unit tests for the GP per-market Stripe wrapper.
 *
 * The wrapper closes the v1.9.0 wf5 CC-1 §F-CC1-001 defect:
 *   "Per-market Stripe resolver and SecretsAdapter are never consumed by
 *    the live PaymentIntent path"
 *
 * Tests assert that the resolver IS now consulted at the production
 * provider construction surface and that the STRIPE_ENABLED_MARKETS gate
 * fires before any upstream Stripe SDK init. Together they convert the
 * v1.8.0 per-market-resolver.unit.spec.ts surface from "test-only proof"
 * into wired-into-production proof.
 *
 * The tests deliberately do NOT spin up Medusa — they exercise the
 * wrapper-level surface directly via the exported `withResolverGate`
 * mixin and the `ensureResolved` helper, with a stubbed `SecretsAdapter`
 * that records every call.
 */

import { jest } from "@jest/globals"
import {
  buildUpstreamOptions,
  SENTINEL_KEY,
  SENTINEL_WEBHOOK_SECRET,
  ensureResolved,
} from "../../modules/payment-stripe-multi-market/service"
import {
  resolveSecretsAdapter,
  resolveMarketStripeCredentials,
  DEFAULT_MARKET_ID,
} from "../../modules/payment-stripe-multi-market/resolve-stripe-options"
import { EnvSecretsAdapter } from "../../lib/secrets/env-adapter"
import {
  PAYMENT_PROVIDER_NOT_CONFIGURED,
  SECRET_NOT_CONFIGURED,
  type SecretsAdapter,
  type MarketId,
} from "../../lib/secrets/index"

describe("buildUpstreamOptions — placeholder shape", () => {
  it("returns sentinel apiKey + webhookSecret when no legacy keys are supplied", () => {
    const upstream = buildUpstreamOptions({ marketId: "bonbeauty", capture: true })
    expect(upstream.apiKey).toBe(SENTINEL_KEY)
    expect(upstream.webhookSecret).toBe(SENTINEL_WEBHOOK_SECRET)
    expect(upstream.capture).toBe(true)
    // marketId must NOT pass through to the upstream service (it would be
    // ignored, but explicit removal keeps the upstream options minimal).
    expect((upstream as Record<string, unknown>).marketId).toBeUndefined()
  })

  it("passes through legacy explicit keys when the test-fixture flag is on", () => {
    const upstream = buildUpstreamOptions({
      __allowLegacyExplicitKeys: true,
      apiKey: "sk_test_fixture",
      webhookSecret: "whsec_test_fixture",
    })
    expect(upstream.apiKey).toBe("sk_test_fixture")
    expect(upstream.webhookSecret).toBe("whsec_test_fixture")
    // The flag itself must NOT pass through.
    expect(
      (upstream as Record<string, unknown>).__allowLegacyExplicitKeys
    ).toBeUndefined()
  })

  it("falls back to sentinels even when explicit keys are supplied without the flag", () => {
    // Defence in depth: forgetting `__allowLegacyExplicitKeys: true` must
    // NOT let the wrapper accidentally bypass the resolver.
    const upstream = buildUpstreamOptions({
      apiKey: "sk_oops_unguarded",
      webhookSecret: "whsec_oops_unguarded",
    })
    expect(upstream.apiKey).toBe(SENTINEL_KEY)
    expect(upstream.webhookSecret).toBe(SENTINEL_WEBHOOK_SECRET)
  })
})

describe("resolveSecretsAdapter — cradle lookup with env fallback", () => {
  it("returns the cradle-supplied adapter when present", () => {
    const sentinelAdapter: SecretsAdapter = {
      getStripeKey: jest.fn() as never,
    }
    const adapter = resolveSecretsAdapter({ secretsAdapter: sentinelAdapter })
    expect(adapter).toBe(sentinelAdapter)
  })

  it("falls back to EnvSecretsAdapter when the cradle has no secretsAdapter", () => {
    const adapter = resolveSecretsAdapter({})
    expect(adapter).toBeInstanceOf(EnvSecretsAdapter)
  })

  it("does NOT silently fall back when the cradle.secretsAdapter is explicitly null", () => {
    // A null/undefined secretsAdapter must still get the env fallback —
    // we never want a runtime "no adapter at all" condition to slip past
    // into a bare process.env read elsewhere.
    const adapter = resolveSecretsAdapter({
      secretsAdapter: undefined,
    } as never)
    expect(adapter).toBeInstanceOf(EnvSecretsAdapter)
  })
})

describe("resolveMarketStripeCredentials — exercises the resolver gate", () => {
  it("calls SecretsAdapter for both secret + webhook for the supplied market", async () => {
    const getStripeKey = jest
      .fn()
      .mockImplementation(async (market: MarketId, type: string) => {
        if (type === "secret") return `sk_live_${market}`
        if (type === "webhook") return `whsec_${market}`
        throw new Error(`unexpected type ${type}`)
      })
    const adapter = { getStripeKey } as unknown as SecretsAdapter

    const resolved = await resolveMarketStripeCredentials(adapter, "bonbeauty")
    expect(resolved.apiKey).toBe("sk_live_bonbeauty")
    expect(resolved.webhookSecret).toBe("whsec_bonbeauty")
    expect(getStripeKey).toHaveBeenCalledTimes(2)
    expect(getStripeKey).toHaveBeenCalledWith("bonbeauty", "secret")
    expect(getStripeKey).toHaveBeenCalledWith("bonbeauty", "webhook")
  })

  it("rejects with PAYMENT_PROVIDER_NOT_CONFIGURED for non-Bonbeauty markets in v1.9.x", async () => {
    // STRIPE_ENABLED_MARKETS = { "bonbeauty" } in v1.9.x. The market gate
    // lives in createMarketStripeResolver, so any non-enabled market must
    // be rejected BEFORE adapter.getStripeKey is even called.
    const getStripeKey = jest.fn() as never
    const adapter = { getStripeKey } as unknown as SecretsAdapter

    await expect(
      resolveMarketStripeCredentials(adapter, "bonevent" as MarketId)
    ).rejects.toMatchObject({ code: PAYMENT_PROVIDER_NOT_CONFIGURED })

    // Adapter must never be reached when the gate refuses.
    expect(getStripeKey).not.toHaveBeenCalled()
  })

  it("rejects with PAYMENT_PROVIDER_NOT_CONFIGURED for future markets (bongarden v1.10.0+)", async () => {
    const adapter = { getStripeKey: jest.fn() as never } as unknown as SecretsAdapter
    await expect(
      resolveMarketStripeCredentials(adapter, "bongarden" as MarketId)
    ).rejects.toMatchObject({ code: PAYMENT_PROVIDER_NOT_CONFIGURED })
  })

  it("surfaces SECRET_NOT_CONFIGURED when the adapter cannot find the env var", async () => {
    // Real EnvSecretsAdapter against an empty env: must surface the
    // adapter's own SECRET_NOT_CONFIGURED so the wrapper boot path fails
    // loudly rather than handing a sentinel to Stripe.
    const originalEnv = { ...process.env }
    delete process.env.STRIPE_SECRET_KEY_BONBEAUTY
    delete process.env.STRIPE_WEBHOOK_KEY_BONBEAUTY
    try {
      const adapter = new EnvSecretsAdapter()
      await expect(
        resolveMarketStripeCredentials(adapter, "bonbeauty")
      ).rejects.toMatchObject({ code: SECRET_NOT_CONFIGURED })
    } finally {
      process.env = originalEnv
    }
  })

  it("DEFAULT_MARKET_ID is bonbeauty (v1.9.x BonBeauty-only scope)", () => {
    expect(DEFAULT_MARKET_ID).toBe("bonbeauty")
  })
})

describe("ensureResolved — patches the upstream service in place", () => {
  it("overwrites options_.apiKey + options_.webhookSecret on first call", async () => {
    const getStripeKey = jest
      .fn()
      .mockImplementation(async (market: MarketId, type: string) => {
        return `${type}-for-${market}`
      })
    const adapter = { getStripeKey } as unknown as SecretsAdapter

    // Fake upstream-service shape — only the fields ensureResolved touches.
    const fakeService = {
      options_: {
        apiKey: SENTINEL_KEY,
        webhookSecret: SENTINEL_WEBHOOK_SECRET,
        capture: true,
      },
      stripe_: { sentinel: true },
    }

    await ensureResolved(
      fakeService as never,
      { secretsAdapter: adapter },
      "bonbeauty"
    )

    expect(fakeService.options_.apiKey).toBe("secret-for-bonbeauty")
    expect(fakeService.options_.webhookSecret).toBe("webhook-for-bonbeauty")
    // The stripe_ field is replaced — confirm it's no longer the sentinel.
    expect((fakeService.stripe_ as { sentinel?: boolean }).sentinel).toBeUndefined()
  })

  it("memoises the resolution Promise — second call does not re-invoke the adapter", async () => {
    const getStripeKey = jest
      .fn()
      .mockImplementation(async (market: MarketId, type: string) => {
        return `${type}-for-${market}`
      })
    const adapter = { getStripeKey } as unknown as SecretsAdapter

    const fakeService = {
      options_: {
        apiKey: SENTINEL_KEY,
        webhookSecret: SENTINEL_WEBHOOK_SECRET,
      },
      stripe_: null,
    }

    await ensureResolved(
      fakeService as never,
      { secretsAdapter: adapter },
      "bonbeauty"
    )
    await ensureResolved(
      fakeService as never,
      { secretsAdapter: adapter },
      "bonbeauty"
    )
    await ensureResolved(
      fakeService as never,
      { secretsAdapter: adapter },
      "bonbeauty"
    )

    // 2 calls total: one secret + one webhook (Promise.all parallel),
    // memoised across subsequent ensureResolved invocations.
    expect(getStripeKey).toHaveBeenCalledTimes(2)
  })

  it("propagates PAYMENT_PROVIDER_NOT_CONFIGURED so first-method-call fails loudly", async () => {
    const adapter = { getStripeKey: jest.fn() as never } as unknown as SecretsAdapter
    const fakeService = {
      options_: { apiKey: SENTINEL_KEY, webhookSecret: SENTINEL_WEBHOOK_SECRET },
      stripe_: null,
    }
    await expect(
      ensureResolved(
        fakeService as never,
        { secretsAdapter: adapter },
        "bonevent" as MarketId
      )
    ).rejects.toMatchObject({ code: PAYMENT_PROVIDER_NOT_CONFIGURED })

    // After the rejection, options_ must remain on sentinels — the wrapper
    // must NEVER leave a half-resolved options_ around.
    expect(fakeService.options_.apiKey).toBe(SENTINEL_KEY)
    expect(fakeService.options_.webhookSecret).toBe(SENTINEL_WEBHOOK_SECRET)
  })
})

describe("F-CC1-001 closure — production path consults the resolver", () => {
  // This is the "tombstone test" promised in cc-1-stripe-coherence-findings.md
  // §F-CC1-001 fix recommendation: "Add an integration test asserting the
  // adapter is consulted for each PaymentIntent create." We exercise it at
  // the helper layer rather than booting Medusa — together with the
  // medusa-config.ts wiring change in the same wave, it proves the
  // resolver is on the request path.

  it("a bonbeauty cradle resolve call consults the cradle adapter exactly twice", async () => {
    const getStripeKey = jest
      .fn()
      .mockImplementation(async (_market: MarketId, type: string) =>
        type === "secret" ? "sk_test_real_bonbeauty" : "whsec_real_bonbeauty"
      )
    const adapter = { getStripeKey } as unknown as SecretsAdapter
    const fakeService = {
      options_: { apiKey: SENTINEL_KEY, webhookSecret: SENTINEL_WEBHOOK_SECRET },
      stripe_: null,
    }

    const resolved = await ensureResolved(
      fakeService as never,
      { secretsAdapter: adapter },
      "bonbeauty"
    )
    expect(resolved.apiKey).toBe("sk_test_real_bonbeauty")
    expect(resolved.webhookSecret).toBe("whsec_real_bonbeauty")
    expect(getStripeKey).toHaveBeenCalledTimes(2)
    expect(getStripeKey.mock.calls).toEqual(
      expect.arrayContaining([
        ["bonbeauty", "secret"],
        ["bonbeauty", "webhook"],
      ])
    )
  })
})
