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
 *
 * An optional `cause` carries the underlying failure (e.g. a GCP
 * access/auth/network error) WITHOUT putting it in the message: this keeps
 * the message leak-free while preserving root cause for post-mortem, so an
 * adapter access fault is never silently indistinguishable from a genuinely
 * absent secret (review F1 — no silent-failure anti-pattern).
 */
export class SecretNotConfiguredError extends Error {
  readonly code = SECRET_NOT_CONFIGURED
  // Declared locally: tsconfig target is ES2021 (no Error.cause in lib);
  // assigned at runtime where Node supports it regardless.
  readonly cause?: unknown

  constructor(missingKeyName: string, cause?: unknown) {
    super(`Stripe secret not configured: ${missingKeyName}`)
    this.name = "SecretNotConfiguredError"
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

// AC1/AC5 — barrel exports the interface + types + the env-adapter (default,
// no external SDK). gcp-adapter is intentionally NOT re-exported here: a
// barrel re-export would pull @google-cloud/secret-manager into every env
// runtime module graph, violating AC5 import isolation. gcp-adapter is only
// reachable via the dynamic import inside the loader's `gcp` branch.
export * from "./env-adapter"
export * from "./market-resolver"
