export enum AuditProvider {
  APPLE = "apple",
  BREVO = "brevo",
  GOOGLE = "google",
  RESEND = "resend",
  SAMSUNG = "samsung",
}

export type AuditProviderValue = `${AuditProvider}`

/**
 * Generic audit envelope.
 *
 * @param TFields  - domain-specific fields for the event (e.g. WalletAuditFields).
 * @param TProvider - narrows the `provider` field to a subset of `AuditProviderValue`.
 *   Defaults to the full union so that code without a specific provider constraint
 *   compiles without explicit annotation. Use a narrowed literal union in domain
 *   envelopes (e.g. `"google" | "apple"` for wallet) to restore per-domain precision
 *   (L-2 fix).
 */
export type AuditEnvelope<
  TFields extends object = Record<string, never>,
  TProvider extends AuditProviderValue = AuditProviderValue,
> = {
  event_type: string
  provider: TProvider
} & TFields

export function toAuditProvider(value: string): AuditProviderValue {
  switch (value) {
    case AuditProvider.APPLE:
      return AuditProvider.APPLE
    case AuditProvider.BREVO:
      return AuditProvider.BREVO
    case AuditProvider.GOOGLE:
      return AuditProvider.GOOGLE
    case AuditProvider.RESEND:
      return AuditProvider.RESEND
    case AuditProvider.SAMSUNG:
      return AuditProvider.SAMSUNG
    default:
      throw new Error(`Unsupported audit provider: ${value}`)
  }
}

/**
 * Safe variant of `toAuditProvider` used in error/fallback paths where the
 * provider value is known to be unrecognised. Returns the raw string cast to
 * `AuditProviderValue` so that audit envelopes on error paths preserve the
 * actual value seen at runtime rather than throwing a secondary error.
 *
 * Use `toAuditProvider` (throwing) on success paths; use this on paths that
 * already determined the provider is unsupported (e.g. building an
 * UnsupportedWalletProviderError audit envelope).
 */
export function toAuditProviderSafe(value: string): AuditProviderValue {
  switch (value) {
    case AuditProvider.APPLE:
      return AuditProvider.APPLE
    case AuditProvider.BREVO:
      return AuditProvider.BREVO
    case AuditProvider.GOOGLE:
      return AuditProvider.GOOGLE
    case AuditProvider.RESEND:
      return AuditProvider.RESEND
    case AuditProvider.SAMSUNG:
      return AuditProvider.SAMSUNG
    default:
      // Cast: envelope must carry provider field typed as AuditProviderValue;
      // unknown runtime value is preserved verbatim for telemetry diagnostics.
      return value as AuditProviderValue
  }
}
