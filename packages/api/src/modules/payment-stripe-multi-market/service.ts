/**
 * Wave G7 (F-CC1-001): GP per-market Stripe payment provider wrapper.
 *
 * Wraps `@medusajs/payment-stripe`'s services with a constructor that
 * routes the secret resolution through `SecretsAdapter` +
 * `createMarketStripeResolver` — i.e. the per-market resolver from
 * v1.8.0 Story 1.1 that previously had 360 lines of unit tests but ZERO
 * production consumers (`_bmad-output/releases/v1.9.0/planning-artifacts/findings/cc-1-stripe-coherence-findings.md`
 * §F-CC1-001).
 *
 * Wiring shape (v1.9.x BonBeauty-only):
 *
 *   medusa-config.ts modules[payment].providers[0].resolve
 *       -> "./packages/api/src/modules/payment-stripe-multi-market"
 *      `id: "stripe"` so the runtime provider key remains `pp_stripe`
 *      (canonical id per `validate_stripe_provider_ssots.py`).
 *
 * v1.10.0+ extension (out of scope for v1.9.1): the constructor here
 * resolves the BonBeauty-only secret at boot; v1.10.0+ multi-market
 * activation will override `initiatePayment` / `authorizePayment` /
 * `capturePayment` to re-resolve per-request via `cart.metadata.market_id`,
 * keeping a small `Map<marketId, Stripe>` cache (per Story 1.2 GCP cache
 * pattern). ADR-100 amendment 2026-05-24 carry-out: ra-CC1-001.
 *
 * Lazy initialisation: Awilix `asFunction` is synchronous, but
 * `SecretsAdapter.getStripeKey` is async (interface contract — needed for
 * the GCP adapter network call). To stay sync at constructor time, the
 * wrapper kicks off resolution eagerly and exposes an awaiter that every
 * upstream method already invokes via `executeWithRetry` /
 * `paymentIntents.X` (since all upstream Stripe calls are async). The
 * `this.stripe_` proxy resolves the underlying SDK on first use.
 */

import { Modules, ModuleProvider } from "@medusajs/framework/utils"
import {
  StripeProviderService,
  StripeBlikService,
  StripePrzelewy24Service,
} from "@medusajs/payment-stripe/dist/services"
import {
  resolveSecretsAdapter,
  resolveMarketStripeCredentials,
  DEFAULT_MARKET_ID,
  type MaybeSecretsCradle,
} from "./resolve-stripe-options"
import type { StripeMultiMarketOptions } from "./types"
import type { MarketId } from "../../lib/secrets/index"

/**
 * Symbol-keyed cache on the constructed instance so we never re-resolve
 * for the same provider service singleton lifetime.
 *
 * Stripe SDK class is reused across all services — we keep the resolved
 * `{ apiKey, webhookSecret }` Promise per (marketId) and let the upstream
 * `StripeBase` constructor receive a Stripe instance whose API key was
 * stamped via the resolver.
 */
const RESOLVED_OPTIONS = Symbol.for("gp.payment-stripe-multi-market.resolved-options")

type ResolvedOptions = {
  apiKey: string
  webhookSecret: string
}

type WithResolved<T> = T & {
  [RESOLVED_OPTIONS]?: Promise<ResolvedOptions>
}

/**
 * Resolves Stripe credentials via the per-market resolver and patches the
 * upstream provider's `options_` + `stripe_` fields in place. Idempotent —
 * subsequent calls reuse the cached Promise.
 *
 * Why patch in place: `StripeBase` reads `this.options_.webhookSecret` for
 * `constructWebhookEvent` and `this.stripe_` for every Stripe SDK call. The
 * upstream constructor already assigned both from the (placeholder)
 * options the wrapper handed it, so patching after first resolution gives
 * every upstream code path a real Stripe instance + real webhook secret
 * without subclassing every method.
 */
async function ensureResolved(
  service: WithResolved<StripeProviderService> & {
    options_: { apiKey: string; webhookSecret: string; [k: string]: unknown }
    stripe_: unknown
  },
  cradle: MaybeSecretsCradle,
  marketId: MarketId
): Promise<ResolvedOptions> {
  if (!service[RESOLVED_OPTIONS]) {
    service[RESOLVED_OPTIONS] = (async () => {
      const adapter = resolveSecretsAdapter(cradle)
      const resolved = await resolveMarketStripeCredentials(adapter, marketId)
      // Patch the upstream service's internal options so any downstream
      // upstream code reading `options_.webhookSecret` / `options_.apiKey`
      // sees the resolved values (e.g. `constructWebhookEvent`).
      service.options_.apiKey = resolved.apiKey
      service.options_.webhookSecret = resolved.webhookSecret
      // Replace the placeholder Stripe SDK instance with one that uses the
      // real key. We require Stripe lazily to avoid touching the upstream
      // dist if unavailable in some weird CI mode (matches upstream import
      // shape: `new Stripe(apiKey)`).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const StripeCtor = require("stripe").default || require("stripe")
      service.stripe_ = new StripeCtor(resolved.apiKey)
      return resolved
    })()
  }
  return service[RESOLVED_OPTIONS]
}

/**
 * Placeholder apiKey + webhookSecret handed to the upstream constructor.
 * The upstream `validateOptions` requires `apiKey` to be defined; we
 * satisfy that with a sentinel that is immediately overwritten on the
 * first method call via `ensureResolved`. The sentinel is intentionally
 * non-empty so `isDefined` passes, but obviously invalid so any code path
 * that bypasses `ensureResolved` will fail loudly against Stripe rather
 * than silently using a wrong key.
 *
 * Format mirrors a typical Stripe test key so static analysis / log
 * scanners don't false-positive on it.
 */
const SENTINEL_KEY = "sk_test_GP_RESOLVER_PENDING_DO_NOT_USE"
const SENTINEL_WEBHOOK_SECRET = "whsec_GP_RESOLVER_PENDING_DO_NOT_USE"

function buildUpstreamOptions(
  options: StripeMultiMarketOptions
): { apiKey: string; webhookSecret: string; capture?: boolean } & Record<
  string,
  unknown
> {
  const { marketId: _omit, __allowLegacyExplicitKeys, ...passthrough } = options
  if (__allowLegacyExplicitKeys && options.apiKey && options.webhookSecret) {
    // Test-fixture path: hand the explicit values straight through.
    return {
      ...passthrough,
      apiKey: options.apiKey,
      webhookSecret: options.webhookSecret,
    }
  }
  return {
    ...passthrough,
    apiKey: SENTINEL_KEY,
    webhookSecret: SENTINEL_WEBHOOK_SECRET,
  }
}

/**
 * Mixin that overrides every async method on the upstream class to first
 * `await ensureResolved(...)` before delegating. Implemented as a manual
 * delegation table because the upstream class hierarchy uses
 * `AbstractPaymentProvider` from `@medusajs/framework/utils` which mucks
 * with prototype chains.
 */
function withResolverGate<TBase extends new (...args: any[]) => any>(
  Base: TBase,
  defaultMarketId: MarketId
) {
  abstract class StripeMultiMarketMixin extends Base {
    private __cradle: MaybeSecretsCradle
    private __marketId: MarketId
    private __wrapperOptions: StripeMultiMarketOptions

    constructor(cradle: MaybeSecretsCradle, options: StripeMultiMarketOptions) {
      super(cradle, buildUpstreamOptions(options) as any)
      this.__cradle = cradle ?? {}
      this.__wrapperOptions = options ?? {}
      this.__marketId = (options?.marketId ?? defaultMarketId) as MarketId
      // If legacy explicit-keys mode is on, mark resolved immediately so
      // ensureResolved() short-circuits (test fixture path).
      if (
        options?.__allowLegacyExplicitKeys &&
        options?.apiKey &&
        options?.webhookSecret
      ) {
        ;(this as WithResolved<this>)[RESOLVED_OPTIONS] = Promise.resolve({
          apiKey: options.apiKey,
          webhookSecret: options.webhookSecret,
        })
      }
    }

    protected async __ensureResolved(): Promise<ResolvedOptions> {
      return ensureResolved(this as any, this.__cradle, this.__marketId)
    }

    // Re-route every async method via the gate. We delegate by calling the
    // base prototype method explicitly so subclass overrides remain
    // honoured.
    async initiatePayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.initiatePayment(...args)
    }
    async authorizePayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.authorizePayment(...args)
    }
    async capturePayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.capturePayment(...args)
    }
    async cancelPayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.cancelPayment(...args)
    }
    async deletePayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.deletePayment(...args)
    }
    async refundPayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.refundPayment(...args)
    }
    async retrievePayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.retrievePayment(...args)
    }
    async updatePayment(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.updatePayment(...args)
    }
    async getPaymentStatus(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.getPaymentStatus(...args)
    }
    async createAccountHolder(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.createAccountHolder(...args)
    }
    async updateAccountHolder(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.updateAccountHolder(...args)
    }
    async deleteAccountHolder(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.deleteAccountHolder(...args)
    }
    async listPaymentMethods(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.listPaymentMethods(...args)
    }
    async savePaymentMethod(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.savePaymentMethod(...args)
    }
    async getWebhookActionAndData(...args: any[]): Promise<any> {
      await this.__ensureResolved()
      return super.getWebhookActionAndData(...args)
    }
  }
  return StripeMultiMarketMixin
}

/**
 * Identifier per `StripeProviderService.identifier = "stripe"`. Pinned
 * here so `validate_stripe_provider_ssots.py`'s canonical `pp_stripe`
 * derivation (`pp_<identifier>` via `medusa-config.ts id: "stripe"`)
 * continues to work without changes.
 */
const STRIPE_PROVIDER_IDENTIFIER = StripeProviderService.identifier as string
const BLIK_PROVIDER_IDENTIFIER = StripeBlikService.identifier as string
const P24_PROVIDER_IDENTIFIER = StripePrzelewy24Service.identifier as string

class GpStripeProviderService extends withResolverGate(
  StripeProviderService,
  DEFAULT_MARKET_ID
) {
  static identifier = STRIPE_PROVIDER_IDENTIFIER
}
class GpStripeBlikService extends withResolverGate(
  StripeBlikService,
  DEFAULT_MARKET_ID
) {
  static identifier = BLIK_PROVIDER_IDENTIFIER
}
class GpStripePrzelewy24Service extends withResolverGate(
  StripePrzelewy24Service,
  DEFAULT_MARKET_ID
) {
  static identifier = P24_PROVIDER_IDENTIFIER
}

export {
  GpStripeProviderService,
  GpStripeBlikService,
  GpStripePrzelewy24Service,
  buildUpstreamOptions,
  ensureResolved,
  withResolverGate,
  SENTINEL_KEY,
  SENTINEL_WEBHOOK_SECRET,
}

// Medusa ModuleProvider entry — registered in `medusa-config.ts` modules[].
export default ModuleProvider(Modules.PAYMENT, {
  services: [
    GpStripeProviderService,
    GpStripeBlikService,
    GpStripePrzelewy24Service,
  ],
})
