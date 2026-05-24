/**
 * Wave G7 (F-CC1-001): types for the GP per-market Stripe payment provider
 * wrapper around `@medusajs/payment-stripe`. v1.9.1 fixes the
 * "resolver-never-on-the-request-path" defect from v1.9.0 wf5 CC-1 review
 * (`_bmad-output/releases/v1.9.0/planning-artifacts/findings/cc-1-stripe-coherence-findings.md`
 * §F-CC1-001) by routing the boot-time secret read through `SecretsAdapter` +
 * `createMarketStripeResolver` instead of the raw `process.env.STRIPE_*`
 * lookup that lived in `medusa-config.ts:62-63` before this wave.
 *
 * v1.9.x BonBeauty-only: the wrapper resolves a single market secret at
 * construction time. v1.10.0+ multi-market activation extends to per-request
 * resolution via `cart.metadata.market_id` (ADR-100 amendment 2026-05-24
 * carry-out: ra-CC1-001).
 */

import type { MarketId } from "../../lib/secrets/index"

/**
 * Options recognised by the wrapper's provider services. They are passed
 * straight through to `@medusajs/payment-stripe`'s upstream services at the
 * end of the constructor — EXCEPT for `apiKey` and `webhookSecret`, which
 * the wrapper resolves itself via the `SecretsAdapter` + per-market resolver
 * (and overwrites/asserts before delegating).
 *
 * The `marketId` field selects the market whose Stripe credentials the
 * wrapper should resolve. v1.9.x BonBeauty-only: defaults to `"bonbeauty"`
 * when omitted. v1.10.0+ multi-market activation will likely keep `marketId`
 * configurable per-provider and additionally support per-request resolution
 * via `cart.metadata.market_id` (see service-level TODO).
 */
export interface StripeMultiMarketOptions {
  /**
   * Optional market id whose secret + webhook key should be resolved at boot.
   * Defaults to `"bonbeauty"` (v1.9.x BonBeauty-only scope).
   */
  marketId?: MarketId
  /**
   * Optional flag — `true` means capture immediately, `false` defers.
   * Passes through to `@medusajs/payment-stripe`'s `StripeOptions.capture`.
   */
  capture?: boolean
  /**
   * If true (default false), the wrapper accepts an explicitly-provided
   * `apiKey` / `webhookSecret` on the options object instead of resolving via
   * `SecretsAdapter`. This is for test fixtures only — production wiring
   * must rely on the resolver to keep the secrets path consistent.
   */
  __allowLegacyExplicitKeys?: boolean
  /**
   * Legacy explicit keys (test fixtures only — see `__allowLegacyExplicitKeys`).
   * Production code MUST omit these.
   */
  apiKey?: string
  webhookSecret?: string
  /**
   * Any additional options accepted by upstream `@medusajs/payment-stripe`
   * (e.g. `automaticPaymentMethods`, `paymentDescription`, ...) are passed
   * through unchanged.
   */
  [extra: string]: unknown
}
