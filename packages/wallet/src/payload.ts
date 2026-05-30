export const WALLET_PROVIDER_KINDS = ["google", "apple"] as const
export type WalletProviderKind = (typeof WALLET_PROVIDER_KINDS)[number]

export const WALLET_LOCALES = ["pl-PL", "en-US", "uk-UA", "de-DE"] as const
export type WalletLocale = (typeof WALLET_LOCALES)[number]

export type WalletPassStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED"
export type WalletBarcodeFormat = "QR" | "PDF417"
export type WalletInvalidationReason = "revoked" | "expired" | "refunded"

// D-110 payload lifecycle (status) enum — wartości, które gate `WalletFeaturePolicy`
// akceptuje jako `input.lifecycle`. Rozdzielone od `WalletPassStatus` (które dopuszcza
// REVOKED/REFUNDED jako pochodne `WalletInvalidationReason`); caller MUSI zmapować
// `WalletInvalidationReason` na ten typ przed wywołaniem `check()`.
export type EntitlementLifecycleStatus =
  | "ACTIVE"
  | "PARTIALLY_REDEEMED"
  | "EXPIRED"
  | "VOIDED"

// Closed union 5 deny reasons gate'a `WalletFeaturePolicy`. Definicja żyje tu, aby
// `WalletAuditOutcome` mogła wykorzystać template-literal i wymusić zgodność
// `rejected_<reason>` bez cyklu importów (`policy.ts` re-eksportuje ten typ).
export type WalletDenyReason =
  | "market_not_ratified"
  | "release_not_promotable"
  | "actor_not_p4_recipient"
  | "lifecycle_not_active"
  | "provider_disabled"

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
  | "wallet.pass_gated"

export type WalletAuditOutcome =
  | "success"
  | "failure"
  | `rejected_${WalletDenyReason}`

// TODO(F-11, deferred architectural): migrate to shared @gp/audit when the
// audit package consolidation lands (Epic J observability follow-up story).
// TODO(F-09, deferred): pole `provider` jest dziś typu `string` aby zachować
// backward-compat z istniejącymi callerami spoza gate path; docelowo zacieśnić
// do `WalletProviderKind` w ramach F-11 migracji do `@gp/audit`.
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
