import { PAYMENT_PROVIDER_NOT_CONFIGURED, SecretsAdapter, MarketId, SecretType } from "./index"

export class PaymentProviderNotConfiguredError extends Error {
  readonly code = PAYMENT_PROVIDER_NOT_CONFIGURED

  constructor() {
    super("Payment is not available for this market")
    this.name = "PaymentProviderNotConfiguredError"
  }
}

// v1.8.0: BonBeauty only. Other markets activate v1.10.0+ (D10).
const STRIPE_ENABLED_MARKETS: ReadonlySet<MarketId> = new Set(["bonbeauty"])

export function createMarketStripeResolver(adapter: SecretsAdapter) {
  return async function resolveStripeKeyForMarket(
    marketId: string,
    type: SecretType
  ): Promise<string> {
    if (!STRIPE_ENABLED_MARKETS.has(marketId as MarketId)) {
      throw new PaymentProviderNotConfiguredError()
    }
    return adapter.getStripeKey(marketId as MarketId, type)
  }
}
