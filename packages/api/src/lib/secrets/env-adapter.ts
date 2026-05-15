import { PAYMENT_PROVIDER_NOT_CONFIGURED, SecretsAdapter, MarketId, SecretType } from "./index"

const ENV_KEY_PREFIX: Record<SecretType, string> = {
  secret: "STRIPE_SECRET_KEY",
  publishable: "STRIPE_PUBLISHABLE_KEY",
  webhook: "STRIPE_WEBHOOK_SECRET",
}

export class EnvSecretsAdapter implements SecretsAdapter {
  async getStripeKey(market: MarketId, type: SecretType): Promise<string> {
    const envVar = `${ENV_KEY_PREFIX[type]}_${market.toUpperCase()}`
    const value = process.env[envVar]
    if (!value) {
      const err = new Error("Payment is not available for this market") as Error & { code: string }
      err.code = PAYMENT_PROVIDER_NOT_CONFIGURED
      throw err
    }
    return value
  }
}
