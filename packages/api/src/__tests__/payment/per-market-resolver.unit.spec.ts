/**
 * Story 1.9 — Stripe Provider Per-Market Architecture Validation + Resolver Unit Tests
 *
 * Proves the Story 1.1 per-market resolver + Story 1.2 SecretsAdapter contract is
 * per-market ready and fail-closed, so v1.10.0+ multi-market expansion is a
 * CONFIG change, NOT a code change (D-V180-ARCH-10 / ADR-120, NFR11, D10).
 *
 * Pure unit test: mocks the gp-config loader, the SecretsAdapter, and the Stripe
 * SDK. Zero network, zero live `gp-ops/` reads, zero live Stripe. Live
 * multi-method smoke is Story 1.10 (HG-3 / C1-C5), NOT this story.
 *
 * Contract under test (architecture.md#D-V180-ARCH-10 L692-714):
 *   cart.metadata.market_id
 *     -> createMarketStripeResolver(adapter)(market, 'secret')
 *     -> SecretsAdapter.getStripeKey(market, 'secret')  [STRIPE_SECRET_KEY_<MARKET>]
 *     -> Stripe SDK init per request
 *     -> PaymentIntent in that market's Stripe Account
 *     -> idempotency_key = payment_session.id            [D8]
 */
import { PAYMENT_PROVIDER_NOT_CONFIGURED, type MarketId } from "../../lib/secrets/index"
import {
  createMarketStripeResolver,
  PaymentProviderNotConfiguredError,
} from "../../lib/secrets/market-resolver"

// ---------------------------------------------------------------------------
// AC1 — Test fixture: 5 markets with gp-config payment.stripe semantics.
//
// gp-config (Story 0.17 AC3) semantics: `payment.stripe.enabled_methods` is an
// optional closed-enum array. BonBeauty ships all 5 methods; the other 4
// markets keep the `payment.stripe` section ABSENT (empty / not-enabled) ->
// resolver reports "stripe not enabled for market", it does NOT throw on read.
//
// This fixture is MOCKED on purpose: only bonbeauty/bonevent/mercur exist as
// live fixtures under specs/contracts/config/fixtures/markets/; bongarden and
// testmarketb are fixture-only logical markets for this test. The unit test
// must NOT depend on live `gp-ops/` config (Dev Notes "Testing standards").
// ---------------------------------------------------------------------------
type StripeMethod = "card" | "blik" | "p24" | "apple_pay" | "google_pay"

interface MarketPaymentConfig {
  payment?: { stripe?: { enabled_methods: StripeMethod[] } }
}

const ALL_METHODS: StripeMethod[] = ["card", "blik", "p24", "apple_pay", "google_pay"]

const FIXTURE_MARKETS: MarketId[] = [
  "bonbeauty",
  "bonevent",
  "bongarden",
  "mercur",
  "testmarketb",
]

const UNCONFIGURED_MARKETS: MarketId[] = [
  "bonevent",
  "bongarden",
  "mercur",
  "testmarketb",
]

// Mocked gp-config loader output (NO live read). BonBeauty: full section.
// The other 4: the `payment.stripe` section is intentionally ABSENT.
const GP_CONFIG_FIXTURE: Record<MarketId, MarketPaymentConfig> = {
  bonbeauty: { payment: { stripe: { enabled_methods: [...ALL_METHODS] } } },
  bonevent: {},
  bongarden: {},
  mercur: {},
  testmarketb: {},
}

// Mirrors Story 0.17 AC3: an absent `payment.stripe` section means "not enabled
// for this market" — a graceful, non-throwing read.
function isStripeEnabledForMarket(market: MarketId): boolean {
  return (
    (GP_CONFIG_FIXTURE[market]?.payment?.stripe?.enabled_methods?.length ?? 0) > 0
  )
}

// ---------------------------------------------------------------------------
// Mocked SecretsAdapter (Story 1.2 env-adapter behaviour).
// `getStripeKey('bonbeauty', ...)` resolves from a mocked STRIPE_*_BONBEAUTY
// env value; every other market resolves to "not configured" (fail-fast,
// mirroring EnvSecretsAdapter's SecretNotConfiguredError contract).
// ---------------------------------------------------------------------------
function makeMockAdapter() {
  return {
    getStripeKey: jest.fn(async (market: MarketId): Promise<string> => {
      if (market === "bonbeauty") {
        return "sk_test_BONBEAUTY_mock"
      }
      throw Object.assign(
        new Error(`Stripe secret not configured: STRIPE_SECRET_KEY_${market.toUpperCase()}`),
        { code: "SECRET_NOT_CONFIGURED" }
      )
    }),
  }
}

// ---------------------------------------------------------------------------
// Mocked Stripe SDK + the documented PaymentIntent wiring (architecture.md
// Data Flow L3194-3209). We assert the WIRING (per-market key resolve +
// idempotency key = payment_session.id, D8), not a live Stripe call.
// ---------------------------------------------------------------------------
function makeMockStripeSdk() {
  return {
    paymentIntents: {
      create: jest.fn(async (_params: unknown, _opts: { idempotencyKey: string }) => ({
        id: "pi_mock_123",
        client_secret: "pi_mock_123_secret_abc",
        status: "requires_payment_method",
      })),
    },
  }
}

interface PaymentSessionContext {
  market_id: MarketId
  payment_session_id: string
  amount: number
  currency: string
}

async function createPaymentIntentForMarket(
  stripe: ReturnType<typeof makeMockStripeSdk>,
  resolver: (market: string, type: "secret") => Promise<string>,
  ctx: PaymentSessionContext
) {
  // 1) per-market secret resolve (cart.metadata.market_id -> resolver)
  const secretKey = await resolver(ctx.market_id, "secret")
  // 2) Stripe SDK would be init'd with `secretKey` here (per-request, per
  //    market Stripe Account). The mock records the resolved key wiring.
  void secretKey
  // 3) PaymentIntent created with idempotency_key = payment_session.id (D8).
  return stripe.paymentIntents.create(
    {
      amount: ctx.amount,
      currency: ctx.currency,
      metadata: { market_id: ctx.market_id },
    },
    { idempotencyKey: ctx.payment_session_id }
  )
}

// ---------------------------------------------------------------------------
// Audit-envelope vs customer-facing payload split (F-NEW-H2). The operator
// audit envelope keeps `market_id` for internal visibility; the customer
// payload MUST NOT carry it (no information disclosure).
// ---------------------------------------------------------------------------
interface AuditEnvelope {
  code: string
  market_id: MarketId
}

function buildRejectionAudit(
  market_id: MarketId,
  err: PaymentProviderNotConfiguredError
): AuditEnvelope {
  return { code: err.code, market_id }
}

function customerFacingPayload(err: PaymentProviderNotConfiguredError): {
  code: string
  message: string
} {
  // Deliberately omits market_id — the customer never learns which market is
  // (or is not) Stripe-active.
  return { code: err.code, message: err.message }
}

// ===========================================================================

describe("Story 1.9 — per-market Stripe resolver architecture validation", () => {
  describe("AC1 — 5-market gp-config fixture", () => {
    it("defines exactly 5 markets", () => {
      expect(FIXTURE_MARKETS).toHaveLength(5)
      expect(new Set(FIXTURE_MARKETS).size).toBe(5)
    })

    it("bonbeauty ships all 5 enabled_methods (card/blik/p24/apple_pay/google_pay)", () => {
      const methods = GP_CONFIG_FIXTURE.bonbeauty.payment?.stripe?.enabled_methods
      expect(methods).toEqual(["card", "blik", "p24", "apple_pay", "google_pay"])
      expect(isStripeEnabledForMarket("bonbeauty")).toBe(true)
    })

    it.each(UNCONFIGURED_MARKETS)(
      "%s has the payment.stripe section absent (graceful, non-throwing)",
      (market) => {
        expect(GP_CONFIG_FIXTURE[market].payment?.stripe).toBeUndefined()
        // Story 0.17 AC3: absent section => not enabled, NOT an exception.
        expect(() => isStripeEnabledForMarket(market)).not.toThrow()
        expect(isStripeEnabledForMarket(market)).toBe(false)
      }
    )
  })

  describe("AC2 — BonBeauty happy path + D8 idempotency wiring", () => {
    it("getStripeKey('bonbeauty', 'secret') returns the mocked valid key", async () => {
      const adapter = makeMockAdapter()
      const resolver = createMarketStripeResolver(adapter)
      const key = await resolver("bonbeauty", "secret")
      expect(key).toBe("sk_test_BONBEAUTY_mock")
      expect(adapter.getStripeKey).toHaveBeenCalledWith("bonbeauty", "secret")
    })

    it("PaymentIntent creation uses idempotency_key === payment_session.id (D8)", async () => {
      const adapter = makeMockAdapter()
      const resolver = createMarketStripeResolver(adapter)
      const stripe = makeMockStripeSdk()
      const ctx: PaymentSessionContext = {
        market_id: "bonbeauty",
        payment_session_id: "ps_01J9ABCDEFGHIJKLMNOP",
        amount: 4999,
        currency: "pln",
      }

      const intent = await createPaymentIntentForMarket(stripe, resolver, ctx)

      expect(intent.client_secret).toBe("pi_mock_123_secret_abc")
      expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1)
      const [, opts] = stripe.paymentIntents.create.mock.calls[0]
      expect(opts).toEqual({ idempotencyKey: "ps_01J9ABCDEFGHIJKLMNOP" })
      expect(opts.idempotencyKey).toBe(ctx.payment_session_id)
    })
  })

  describe("AC3 — 4 markets graceful reject with PAYMENT_PROVIDER_NOT_CONFIGURED", () => {
    it.each(UNCONFIGURED_MARKETS)(
      "%s rejects with code PAYMENT_PROVIDER_NOT_CONFIGURED",
      async (market) => {
        const resolver = createMarketStripeResolver(makeMockAdapter())
        await expect(resolver(market, "secret")).rejects.toBeInstanceOf(
          PaymentProviderNotConfiguredError
        )
        const err = await resolver(market, "secret").catch((e) => e)
        expect(err.code).toBe(PAYMENT_PROVIDER_NOT_CONFIGURED)
        expect(PAYMENT_PROVIDER_NOT_CONFIGURED).toBe("PAYMENT_PROVIDER_NOT_CONFIGURED")
      }
    )

    it("an unknown / unmapped market_id also rejects fail-closed", async () => {
      const resolver = createMarketStripeResolver(makeMockAdapter())
      await expect(
        resolver("definitely-not-a-market", "secret")
      ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError)
    })
  })

  describe("AC4 — F-NEW-H2 uniform error (no information disclosure)", () => {
    it("all 4 unconfigured markets emit a BYTE-IDENTICAL customer message", async () => {
      const resolver = createMarketStripeResolver(makeMockAdapter())
      const messages = await Promise.all(
        UNCONFIGURED_MARKETS.map((m) =>
          resolver(m, "secret").catch((e: Error) => e.message)
        )
      )
      // Strict equality across all 4 — the F-NEW-H2 guardrail (a weaker
      // "contains" assertion would be insufficient, Dev Notes line 95).
      expect(messages.every((m) => m === messages[0])).toBe(true)
      expect(new Set(messages).size).toBe(1)
    })

    it("the uniform message leaks NO market-name token (no info disclosure)", async () => {
      const resolver = createMarketStripeResolver(makeMockAdapter())
      const message = await resolver("bonevent", "secret").catch(
        (e: Error) => e.message
      )
      const marketTokens = [
        ...FIXTURE_MARKETS,
        "BONBEAUTY",
        "BonBeauty",
        "BonEvent",
        "BonGarden",
      ]
      for (const token of marketTokens) {
        expect(message.toLowerCase()).not.toContain(token.toLowerCase())
      }
    })

    it("the customer message equals the resolver's own canonical constant", async () => {
      // Asserted against the implementation's single source of truth (a fresh
      // error instance), NOT a hard-coded literal — so the test stays robust
      // if Story 1.1 later aligns the wording. See the documented drift below.
      const canonical = new PaymentProviderNotConfiguredError().message
      const resolver = createMarketStripeResolver(makeMockAdapter())
      const message = await resolver("mercur", "secret").catch(
        (e: Error) => e.message
      )
      expect(message).toBe(canonical)
    })

    /**
     * DOCUMENTED DRIFT (AC4 doc text vs Story 1.1 implementation):
     *
     *   AC4 quotes the customer-facing string as
     *     "Payment is not available for this market. Please contact support."
     *   The Story 1.1 `PaymentProviderNotConfiguredError` actually ships
     *     "Payment is not available for this market"   (no ". Please contact support." suffix)
     *
     * The SECURITY-relevant invariant of F-NEW-H2 (uniform across markets +
     * zero market-name disclosure) holds either way and is hard-asserted
     * above. The trailing-sentence delta is a copy/UX nicety owned by Story
     * 1.1 (market-resolver.ts) — this validation story MUST NOT modify
     * `lib/secrets/` (Dev Notes "Scope boundary"). Recorded here and in
     * Completion Notes as a Story 1.1 follow-up rather than silently
     * weakened or fabricated.
     */
    it("documents the AC4-text vs implementation message-suffix drift (non-fatal)", async () => {
      const resolver = createMarketStripeResolver(makeMockAdapter())
      const actual = await resolver("testmarketb", "secret").catch(
        (e: Error) => e.message
      )
      const ac4DocText =
        "Payment is not available for this market. Please contact support."
      // The implemented message is the AC4 text WITHOUT the support suffix.
      expect(actual).toBe("Payment is not available for this market")
      expect(ac4DocText.startsWith(actual)).toBe(true)
      expect(actual.length).toBeLessThan(ac4DocText.length)
    })

    it("audit envelope carries market_id internally; customer payload does NOT", async () => {
      const resolver = createMarketStripeResolver(makeMockAdapter())
      const err: PaymentProviderNotConfiguredError = await resolver(
        "bongarden",
        "secret"
      ).catch((e) => e)

      const audit = buildRejectionAudit("bongarden", err)
      const payload = customerFacingPayload(err)

      // Operator visibility: market_id present in the audit envelope.
      expect(audit.market_id).toBe("bongarden")
      expect(audit.code).toBe(PAYMENT_PROVIDER_NOT_CONFIGURED)

      // Customer payload: NO market_id key, and the message names no market.
      expect(payload).not.toHaveProperty("market_id")
      expect(Object.keys(payload).sort()).toEqual(["code", "message"])
      for (const market of FIXTURE_MARKETS) {
        expect(payload.message.toLowerCase()).not.toContain(market)
      }
    })
  })
})
