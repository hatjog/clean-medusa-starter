import type { walletobjects_v1 } from "googleapis"

import {
  WALLET_LOCALES,
  type WalletLocale,
  type WalletPayload,
  type WalletPassStatus,
} from "../payload"

export const GOOGLE_WALLET_DEFAULT_BACKGROUND = "#F5E6D3"

const FORBIDDEN_PII_KEYS = new Set([
  "recipient_email",
  "recipient_phone",
  "recipient_name",
  "recipient_full_name",
  "recipient_address",
  "buyer_email",
  "buyer_phone",
  "buyer_name",
])

export interface GoogleWalletMarketBranding {
  class_id: string
  object_id: string
  issuer_name: string
  background?: string
  logo?: string
  logo_url?: string
  salon_name?: string
  salon_address?: string
  latitude?: number
  longitude?: number
  localized_titles?: Partial<Record<WalletLocale, string>>
  now?: () => Date
  [key: string]: unknown
}

// I1: redemptionChannel = "BOTH" jest poprawne dla BonBeauty pilot (salon in-store
// + online). Dla przyszłych marketów (gp-config z redemption_channel != both) trzeba
// będzie sparametryzować — flag dla story 3.4 (policy gate) lub gp-config branding.

/**
 * Pola merchant view które Google Wallet mapper czyta z WalletPayload (per AC4
 * story 3.2). Eksportowane dla backward compat z testami przed H1; nowy kod
 * powinien używać `WalletPayload` bezpośrednio.
 */
export interface GoogleWalletPayloadFields {
  salon_name?: string
  salon_address?: string
  latitude?: number
  longitude?: number
}

export interface GoogleWalletMerchantLocation {
  address: string
  latitude?: number
  longitude?: number
}

// M1: branding (hexBackgroundColor / titleImage / localizedTitle / provider /
// merchantLocations) trafia wyłącznie do OfferClass — Google Wallet REST v1
// renderer czyta je z klasy, nie z per-pass OfferObject.
export type GoogleOfferClass = walletobjects_v1.Schema$OfferClass & {
  merchantLocations?: GoogleWalletMerchantLocation[]
}

// M1+L3: OfferObject zawiera wyłącznie per-pass dane (id, classId, state,
// redemptionCode, smartTapRedemptionValue, validTimeInterval, barcode,
// linksModuleData, textModulesData, locations).
export type GoogleOfferObject = walletobjects_v1.Schema$OfferObject & {
  redemptionCode: string
}

export class GoogleWalletPayloadError extends Error {
  constructor(
    readonly error_code: string,
    message: string
  ) {
    super(message)
    this.name = "GoogleWalletPayloadError"
  }
}

export function buildGoogleOfferClass(
  walletPayload: WalletPayload,
  locale: WalletLocale,
  marketBranding: GoogleWalletMarketBranding
): GoogleOfferClass {
  assertNoForbiddenPii(marketBranding)

  const provider = resolveSalonName(walletPayload, marketBranding)
  const background = resolveBackground(marketBranding)
  const logo = resolveLogo(walletPayload, marketBranding)
  const location = resolveMerchantLocation(walletPayload, marketBranding)
  const localizedTitle = buildLocalizedString(
    walletPayload.title,
    locale,
    marketBranding.localized_titles
  )

  return {
    id: marketBranding.class_id,
    issuerName: marketBranding.issuer_name,
    reviewStatus: "UNDER_REVIEW",
    redemptionChannel: "BOTH",
    provider,
    title: walletPayload.title,
    localizedTitle,
    localizedProvider: buildLocalizedString(provider, locale),
    hexBackgroundColor: background,
    titleImage: logo,
    merchantLocations: [location],
    textModulesData: [
      buildTextModule("wallet_salon_address", "Adres salonu", location.address),
    ],
  }
}

export function buildOfferClassPayload(
  walletPayload: WalletPayload,
  locale: WalletLocale,
  marketBranding: GoogleWalletMarketBranding,
  prebuiltOfferClass?: GoogleOfferClass
): GoogleOfferObject {
  assertNoForbiddenPii(marketBranding)

  // L2: gdy provider już zbudował OfferClass (validate + PII guard już
  // przepuszczone), reużywamy zamiast budować po raz drugi.
  const offerClass =
    prebuiltOfferClass ??
    buildGoogleOfferClass(walletPayload, locale, marketBranding)
  void offerClass

  const barcodeValue = walletPayload.qr_code ?? walletPayload.deep_link
  const startDate = (marketBranding.now?.() ?? new Date()).toISOString()
  const endDate = ensureIso8601(
    walletPayload.expires_at,
    "GOOGLE_WALLET_EXPIRES_AT_INVALID",
    "Google Wallet payload requires valid ISO8601 expires_at"
  )
  // Wymuszamy odczyt salon_address z payloadu (fail-closed gdy missing) — pole
  // potrzebne także w textModulesData.
  const location = resolveMerchantLocation(walletPayload, marketBranding)

  return {
    id: marketBranding.object_id,
    classId: marketBranding.class_id,
    state: mapWalletStatus(walletPayload.status),
    redemptionCode: walletPayload.code,
    smartTapRedemptionValue: walletPayload.code,
    validTimeInterval: {
      start: { date: startDate },
      end: { date: endDate },
    },
    barcode: {
      type: "QR_CODE",
      value: barcodeValue,
      alternateText: walletPayload.code,
    },
    linksModuleData: {
      uris: [
        {
          id: "voucher_deep_link",
          uri: walletPayload.deep_link,
          description: "Voucher",
        },
      ],
    },
    locations:
      location.latitude !== undefined && location.longitude !== undefined
        ? [{ latitude: location.latitude, longitude: location.longitude }]
        : undefined,
    textModulesData: [
      buildTextModule("wallet_status", "Status", walletPayload.status),
      buildTextModule("wallet_expires_at", "Wazny do", walletPayload.expires_at),
    ],
  }
}

export function assertNoForbiddenPii(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_PII_KEYS.has(key)) {
      throw new GoogleWalletPayloadError(
        "GOOGLE_WALLET_PII_FORBIDDEN",
        `Google Wallet payload cannot include recipient or buyer PII field: ${key}`
      )
    }
  }
}

function buildLocalizedString(
  defaultValue: string,
  locale: WalletLocale,
  localizedValues: Partial<Record<WalletLocale, string>> = {}
): walletobjects_v1.Schema$LocalizedString {
  const fallback = localizedValues[locale] ?? defaultValue

  return {
    defaultValue: {
      language: locale,
      value: fallback,
    },
    translatedValues: WALLET_LOCALES.map((language) => ({
      language,
      value: localizedValues[language] ?? fallback,
    })),
  }
}

function resolveSalonName(
  walletPayload: WalletPayload,
  marketBranding: GoogleWalletMarketBranding
): string {
  return requirePayloadString(
    trimString(walletPayload.salon_name) ?? marketBranding.salon_name,
    "GOOGLE_WALLET_SALON_NAME_MISSING",
    "Google Wallet payload requires salon_name"
  )
}

function resolveMerchantLocation(
  walletPayload: WalletPayload,
  marketBranding: GoogleWalletMarketBranding
): GoogleWalletMerchantLocation {
  const address = requirePayloadString(
    trimString(walletPayload.salon_address) ?? marketBranding.salon_address,
    "GOOGLE_WALLET_SALON_ADDRESS_MISSING",
    "Google Wallet payload requires salon_address"
  )

  return {
    address,
    latitude: payloadNumber(walletPayload.latitude) ?? marketBranding.latitude,
    longitude:
      payloadNumber(walletPayload.longitude) ?? marketBranding.longitude,
  }
}

function resolveBackground(
  marketBranding: GoogleWalletMarketBranding
): string {
  return trimString(marketBranding.background) ?? GOOGLE_WALLET_DEFAULT_BACKGROUND
}

function resolveLogo(
  walletPayload: WalletPayload,
  marketBranding: GoogleWalletMarketBranding
): walletobjects_v1.Schema$Image | undefined {
  const uri =
    trimString(marketBranding.logo) ??
    trimString(marketBranding.logo_url) ??
    trimString(walletPayload.branding.logo_url)

  if (!uri) return undefined

  return {
    sourceUri: { uri },
    contentDescription: buildLocalizedString("Logo", walletPayload.locale),
  }
}

// M2: rozróżnia EXPIRED od INACTIVE (Google Wallet REST v1 ma osobny stan
// EXPIRED dla automatycznego ukrycia passu po terminie). REVOKED/REFUNDED
// pozostają INACTIVE — Google nie ma dedykowanego stanu dla cofniętych passów.
function mapWalletStatus(status: WalletPassStatus): string {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE"
    case "EXPIRED":
      return "EXPIRED"
    case "REVOKED":
    case "REFUNDED":
      return "INACTIVE"
  }
}

function buildTextModule(
  id: string,
  header: string,
  body: string
): walletobjects_v1.Schema$TextModuleData {
  return { id, header, body }
}

function payloadNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function requirePayloadString(
  value: unknown,
  error_code: string,
  message: string
): string {
  const trimmed = trimString(value)
  if (!trimmed) {
    throw new GoogleWalletPayloadError(error_code, message)
  }

  return trimmed
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function ensureIso8601(
  value: unknown,
  error_code: string,
  message: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GoogleWalletPayloadError(error_code, message)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new GoogleWalletPayloadError(error_code, message)
  }
  return parsed.toISOString()
}
