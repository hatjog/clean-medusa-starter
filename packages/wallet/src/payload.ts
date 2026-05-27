export const WALLET_PROVIDER_KINDS = ["google", "apple"] as const
export type WalletProviderKind = (typeof WALLET_PROVIDER_KINDS)[number]

export const WALLET_LOCALES = ["pl-PL", "en-US", "uk-UA", "de-DE"] as const
export type WalletLocale = (typeof WALLET_LOCALES)[number]

export type WalletPassStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED"
export type WalletBarcodeFormat = "QR" | "PDF417"
export type WalletInvalidationReason = "revoked" | "expired" | "refunded"

export interface WalletBarcodeSpec {
  format: WalletBarcodeFormat
  value: string
}

export interface WalletBranding {
  logo_url: string
  primary_color: string
  accent_color: string
}

export interface WalletPayload {
  entitlement_instance_id: string
  code: string
  title: string
  status: WalletPassStatus
  expires_at: string
  deep_link: string
  barcode_spec: WalletBarcodeSpec
  qr_code?: string
  barcode?: WalletBarcodeSpec
  branding: WalletBranding
  locale: WalletLocale
}

export type WalletAuditEventType =
  | "wallet.pass_generated"
  | "wallet.pass_failed"
  | "wallet.pass_invalidated"
  | "wallet.pass_invalidation_failed"
  | "wallet.pass_gated"

export type WalletAuditOutcome = "success" | "failure" | `rejected_${string}`

// TODO(F-11, deferred architectural): migrate to shared @gp/audit when the
// audit package consolidation lands (Epic J observability follow-up story).
export interface AuditEnvelope {
  event_type: WalletAuditEventType
  entitlement_instance_id: string
  provider: string
  market?: string
  release?: string
  actor_id?: string
  lifecycle?: string
  save_url?: string
  reason?: WalletInvalidationReason
  gate_reason?: string
  timestamp: string
  outcome: WalletAuditOutcome
  error_code?: string
  error_message?: string
  requested_locale?: string
  effective_locale?: WalletLocale
}

export type AuditEvent = AuditEnvelope

export type LocalizedWalletText =
  | string
  | Partial<Record<WalletLocale, string>>
  | Record<string, string>

export interface EntitlementInstanceWalletMetadata {
  code?: string
  title?: LocalizedWalletText
  status?: WalletPassStatus
  expires_at?: string | Date | null
  deep_link?: string
  barcode_spec?: WalletBarcodeSpec
  branding?: Partial<WalletBranding>
}

// TODO: replace with @gp/voucher L4 read model once wallet projection fields land.
export interface EntitlementInstance {
  id: string
  code?: string
  title?: LocalizedWalletText
  status?: WalletPassStatus
  state?: string
  expires_at?: string | Date | null
  deep_link?: string
  barcode_spec?: WalletBarcodeSpec
  branding?: Partial<WalletBranding>
  metadata?: {
    wallet?: EntitlementInstanceWalletMetadata
    gp?: {
      wallet?: EntitlementInstanceWalletMetadata
    }
  } & Record<string, unknown>
}

export interface EntitlementInstanceReadModel {
  getById(entitlement_instance_id: string): Promise<EntitlementInstance | null>
}

export function isWalletProviderKind(value: unknown): value is WalletProviderKind {
  return (
    typeof value === "string" &&
    (WALLET_PROVIDER_KINDS as readonly string[]).includes(value)
  )
}

export function normalizeWalletLocale(locale: string): WalletLocale {
  return (WALLET_LOCALES as readonly string[]).includes(locale)
    ? (locale as WalletLocale)
    : "pl-PL"
}
