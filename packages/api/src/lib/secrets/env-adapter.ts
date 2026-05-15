import {
  SecretsAdapter,
  SecretNotConfiguredError,
  MarketId,
  SecretType,
} from "./index"

/**
 * AC2 — env var naming convention: `STRIPE_<TYPE>_KEY_<MARKET>` where
 * <TYPE> ∈ {SECRET, PUBLISHABLE, WEBHOOK} (uppercase) and <MARKET> is the
 * uppercase market id. Example: bonbeauty secret → STRIPE_SECRET_KEY_BONBEAUTY.
 *
 * NOTE (cross-story discrepancy — see Dev Agent Record): Story 1.1 shipped
 * the webhook prefix as STRIPE_WEBHOOK_SECRET (→ STRIPE_WEBHOOK_SECRET_<MARKET>).
 * AC2 of Story 1.2 is the binding contract and mandates the uniform
 * `STRIPE_<TYPE>_KEY_<MARKET>` form, so webhook is STRIPE_WEBHOOK_KEY_<MARKET>.
 * This is documented (not silent) per Dev Notes line 73; Story 1.3's webhook
 * consumer MUST read STRIPE_WEBHOOK_KEY_<MARKET>.
 */
const ENV_KEY_PREFIX: Record<SecretType, string> = {
  secret: "STRIPE_SECRET_KEY",
  publishable: "STRIPE_PUBLISHABLE_KEY",
  webhook: "STRIPE_WEBHOOK_KEY",
}

/**
 * Default v1.8.0 adapter. Reads Stripe keys from process.env. No external SDK.
 */
export class EnvSecretsAdapter implements SecretsAdapter {
  async getStripeKey(market: MarketId, type: SecretType): Promise<string> {
    const envVar = `${ENV_KEY_PREFIX[type]}_${market.toUpperCase()}`
    const value = process.env[envVar]
    if (!value) {
      // Fail-fast, no silent fallback. The error names ONLY the missing key —
      // it never echoes the value of this or any other env var (AC2).
      throw new SecretNotConfiguredError(envVar)
    }
    return value
  }
}
