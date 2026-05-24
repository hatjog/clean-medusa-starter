/**
 * Wave G7 (F-CC1-001): boot-time secret resolution that ROUTES THROUGH the
 * per-market resolver instead of the previous raw `process.env.STRIPE_*`
 * read. The function:
 *
 *   1. Resolves (or constructs) a `SecretsAdapter` (env adapter by default;
 *      gcp adapter via the v1.10.0+ flip path).
 *   2. Wraps it in `createMarketStripeResolver(adapter)`, which enforces
 *      the `STRIPE_ENABLED_MARKETS` gate.
 *   3. Awaits the resolver's two `getStripeKey(market, "secret"|"webhook")`
 *      calls.
 *
 * v1.9.x ships BonBeauty-only — but unlike v1.9.0 (where the resolver was
 * literally never called outside unit tests), the production path now
 * exercises:
 *   - the `STRIPE_ENABLED_MARKETS` gate (an out-of-set marketId fails fast
 *     with PaymentProviderNotConfiguredError before any Stripe SDK init)
 *   - the env-var contract (`STRIPE_<TYPE>_KEY_<MARKET>` shape from Story
 *     1.2 AC2 — fail-fast SecretNotConfiguredError if missing)
 *
 * This is the wiring closure that converts the unit-test-only surface
 * (`per-market-resolver.unit.spec.ts`) into real production protection,
 * closing F-CC1-001 carry-out (ra-CC1-001).
 *
 * The synchronous Awilix factory wrap that hosts this resolver is in
 * `service.ts`'s `static newInstance()` static — that factory is
 * synchronous, so the secret resolution is performed eagerly and the
 * resolved value is closed over inside the provider service. The wrapper
 * therefore uses `resolveStripeOptionsSync()` which is implemented in
 * `service.ts`.
 *
 * v1.10.0+ extension (out of scope for v1.9.1): per-request resolution
 * (read `cart.metadata.market_id` and call the resolver per `initiatePayment`)
 * will likely replace this boot-time path entirely. The shape kept here is
 * intentionally narrow to make that future replacement obvious.
 */

import type { SecretsAdapter, MarketId } from "../../lib/secrets/index"
import { EnvSecretsAdapter } from "../../lib/secrets/env-adapter"
import { createMarketStripeResolver } from "../../lib/secrets/market-resolver"

export const DEFAULT_MARKET_ID: MarketId = "bonbeauty"

/**
 * Cradle shape consulted at provider construction. Only `secretsAdapter` is
 * read; everything else is ignored. Marked as optional so we can fall back
 * to constructing the default `EnvSecretsAdapter` when the secrets loader
 * (`loaders/secrets.ts`) has not run (e.g. in the current Medusa boot path
 * where custom `src/loaders/` are not auto-discovered — see ra-CC1-001
 * carry-out followup).
 */
export interface MaybeSecretsCradle {
  secretsAdapter?: SecretsAdapter
}

export function resolveSecretsAdapter(cradle: MaybeSecretsCradle): SecretsAdapter {
  if (cradle?.secretsAdapter) {
    return cradle.secretsAdapter
  }
  // Fallback: SECRETS_ADAPTER=gcp would be required to opt-in to GCP — for
  // v1.9.x BonBeauty-only env-only path the env adapter is the safe default.
  // This mirrors `loaders/secrets.ts` AC3 default behaviour.
  return new EnvSecretsAdapter()
}

export async function resolveMarketStripeCredentials(
  adapter: SecretsAdapter,
  marketId: MarketId
): Promise<{ apiKey: string; webhookSecret: string }> {
  const resolver = createMarketStripeResolver(adapter)
  const [apiKey, webhookSecret] = await Promise.all([
    resolver(marketId, "secret"),
    resolver(marketId, "webhook"),
  ])
  return { apiKey, webhookSecret }
}
