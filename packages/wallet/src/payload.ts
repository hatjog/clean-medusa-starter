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

/**
 * Zminimalizowany payload portfela zgodny z D-110.
 *
 * Dozwolone pola provider-facing: `code`, `title`, `status`, `expires_at`,
 * `salon_name`, `salon_address`, `deep_link`, `qr_code`, `branding`.
 * Pola techniczne `entitlement_instance_id`, `barcode_spec`, `barcode` i
 * `locale` zostają wyłącznie w granicy backendowego `@gp/wallet`, żeby adapter
 * providerów mógł deterministycznie zbudować identyfikatory i kod kreskowy.
 *
 * Zabronione: email, imię i nazwisko, telefon lub adres odbiorcy, buyer Anna
 * PII, customer email/phone, IP address oraz device fingerprint.
 */
export interface WalletPayload {
  entitlement_instance_id: string
  code: string
  title: string
  market: string
  entitlement_type: string
  status: WalletPassStatus
  expires_at: string
  salon_name: string
  salon_address: string
  deep_link: string
  barcode_spec: WalletBarcodeSpec
  qr_code?: string
  barcode?: WalletBarcodeSpec
  branding: WalletBranding
  locale: WalletLocale
  // Merchant view (PII-neutralny) projektowany dla wallet renderera; mapper Google
  // Wallet wymaga salon_name/salon_address fail-closed (per AC4 story 3.2).
  salon_name?: string
  salon_address?: string
  latitude?: number
  longitude?: number
}

export type WalletAuditEventType =
  | "wallet.pass_generated"
  | "wallet.pass_failed"
  | "wallet.pass_invalidated"
  | "wallet.pass_invalidation_failed"

export type WalletAuditOutcome = "success" | "failure"

// TODO(F-11, deferred architectural): przenieść do shared @gp/audit po
// konsolidacji pakietu audytu w follow-upie Epic J observability.
export interface AuditEnvelope {
  event_type: WalletAuditEventType
  entitlement_instance_id: string
  provider: string
  save_url?: string
  reason?: WalletInvalidationReason
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
  entitlement_type?: string
  status?: WalletPassStatus
  expires_at?: string | Date | null
  salon_name?: string
  salon_address?: string
  deep_link?: string
  barcode_spec?: WalletBarcodeSpec
  branding?: Partial<WalletBranding>
  salon_name?: string
  salon_address?: string
  latitude?: number
  longitude?: number
}

// TODO: zastąpić read modelem L4 z @gp/voucher, gdy projekcja wallet wyląduje.
export interface EntitlementInstance {
  id: string
  code?: string
  title?: LocalizedWalletText
  market_id?: string
  entitlement_type?: string
  status?: WalletPassStatus
  state?: string
  expires_at?: string | Date | null
  salon_name?: string
  salon_address?: string
  deep_link?: string
  barcode_spec?: WalletBarcodeSpec
  branding?: Partial<WalletBranding>
  salon_name?: string
  salon_address?: string
  latitude?: number
  longitude?: number
  metadata?: {
    wallet?: EntitlementInstanceWalletMetadata
    gp?: {
      market_id?: string
      entitlement_type?: string
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
