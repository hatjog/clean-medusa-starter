/**
 * Wave G7 (F-CC1-001): public entry point for the GP per-market Stripe
 * payment provider wrapper. Default-exports the
 * `ModuleProvider(Modules.PAYMENT, { services: [...] })` value Medusa's
 * payment module loader expects (`@medusajs/payment/dist/loaders/providers.js`
 * `moduleProviderLoader` invocation).
 *
 * Wiring lives in `GP/backend/medusa-config.ts` modules[payment].providers —
 * the `resolve` field points at this directory; `id: "stripe"` is pinned
 * so the runtime provider key remains `pp_stripe` (canonical id per
 * `_grow/tools/validate_stripe_provider_ssots.py`).
 *
 * Re-exported names (`GpStripeProviderService`, `ensureResolved`, helpers)
 * are intentional surface for the integration test suite.
 */

export {
  default,
  GpStripeProviderService,
  GpStripeBlikService,
  GpStripePrzelewy24Service,
  buildUpstreamOptions,
  ensureResolved,
  withResolverGate,
  SENTINEL_KEY,
  SENTINEL_WEBHOOK_SECRET,
} from "./service"

export {
  DEFAULT_MARKET_ID,
  resolveSecretsAdapter,
  resolveMarketStripeCredentials,
} from "./resolve-stripe-options"
export type { MaybeSecretsCradle } from "./resolve-stripe-options"
export type { StripeMultiMarketOptions } from "./types"
