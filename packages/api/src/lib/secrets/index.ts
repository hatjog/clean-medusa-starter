export type MarketId =
  | "bonbeauty"
  | "bonevent"
  | "bongarden"
  | "mercur"
  | "testmarketb"

export type SecretType = "secret" | "publishable" | "webhook"

// Story 1.1 resolver concern: market is not Stripe-enabled (per-market gating).
export const PAYMENT_PROVIDER_NOT_CONFIGURED = "PAYMENT_PROVIDER_NOT_CONFIGURED"

// Story 1.2 adapter concern: a required Stripe secret is absent for an
// otherwise Stripe-enabled market. Distinct from PAYMENT_PROVIDER_NOT_CONFIGURED
// (which is the resolver's market-gating error) — see Dev Agent Record note.
export const SECRET_NOT_CONFIGURED = "SECRET_NOT_CONFIGURED"

/**
 * AC1 — SecretsAdapter is the sole contract consumed by the Story 1.1
 * per-market resolver. No consumer references a concrete implementation.
 * Signature is frozen: `getStripeKey(market, type): Promise<string>`.
 */
export interface SecretsAdapter {
  getStripeKey(market: MarketId, type: SecretType): Promise<string>
}

/**
 * Thrown by a SecretsAdapter implementation when the backing store has no
 * value for the requested (market, type). Mirrors the local error pattern
 * established by Story 1.1's PaymentProviderNotConfiguredError
 * (Error subclass + readonly `code`). The message MUST NOT leak any env
 * values — it may name the missing key only.
 */
export class SecretNotConfiguredError extends Error {
  readonly code = SECRET_NOT_CONFIGURED

  constructor(missingKeyName: string) {
    super(`Stripe secret not configured: ${missingKeyName}`)
    this.name = "SecretNotConfiguredError"
  }
}

// AC1/AC5 — barrel exports the interface + types + the env-adapter (default,
// no external SDK). gcp-adapter is intentionally NOT re-exported here: a
// barrel re-export would pull @google-cloud/secret-manager into every env
// runtime module graph, violating AC5 import isolation. gcp-adapter is only
// reachable via the dynamic import inside the loader's `gcp` branch.
export * from "./env-adapter"
export * from "./market-resolver"
