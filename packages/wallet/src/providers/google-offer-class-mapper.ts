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

export type GoogleOfferClass = walletobjects_v1.Schema$OfferClass & {
  merchantLocations?: GoogleWalletMerchantLocation[]
}

export type GoogleOfferObject = walletobjects_v1.Schema$OfferObject & {
  redemptionCode: string
  localizedTitle: walletobjects_v1.Schema$LocalizedString
  provider: string
  merchantLocations: GoogleWalletMerchantLocation[]
  hexBackgroundColor: string
  logo?: walletobjects_v1.Schema$Image
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
  const background = resolveBackground(walletPayload, marketBranding)
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
      buildTextModule("wallet_status", "Status", walletPayload.status),
      buildTextModule("wallet_expires_at", "Wazny do", walletPayload.expires_at),
    ],
  }
}

export function buildOfferClassPayload(
  walletPayload: WalletPayload,
  locale: WalletLocale,
  marketBranding: GoogleWalletMarketBranding
): GoogleOfferObject {
  assertNoForbiddenPii(marketBranding)

  const provider = resolveSalonName(walletPayload, marketBranding)
  const background = resolveBackground(walletPayload, marketBranding)
  const logo = resolveLogo(walletPayload, marketBranding)
  const location = resolveMerchantLocation(walletPayload, marketBranding)
  const barcodeValue = walletPayload.qr_code ?? walletPayload.deep_link
  const localizedTitle = buildLocalizedString(
    walletPayload.title,
    locale,
    marketBranding.localized_titles
  )
  const offerClass = buildGoogleOfferClass(walletPayload, locale, marketBranding)

  return {
    id: marketBranding.object_id,
    classId: marketBranding.class_id,
    classReference: offerClass,
    state: mapWalletStatus(walletPayload.status),
    redemptionCode: walletPayload.code,
    smartTapRedemptionValue: walletPayload.code,
    validTimeInterval: {
      start: { date: (marketBranding.now?.() ?? new Date()).toISOString() },
      end: { date: walletPayload.expires_at },
    },
    localizedTitle,
    provider,
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
    merchantLocations: [location],
    locations:
      location.latitude !== undefined && location.longitude !== undefined
        ? [{ latitude: location.latitude, longitude: location.longitude }]
        : undefined,
    textModulesData: [
      buildTextModule("wallet_status", "Status", walletPayload.status),
      buildTextModule("wallet_expires_at", "Wazny do", walletPayload.expires_at),
      buildTextModule("wallet_salon_address", "Adres salonu", location.address),
    ],
    hexBackgroundColor: background,
    logo,
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
    googlePayloadField(walletPayload, "salon_name") ?? marketBranding.salon_name,
    "GOOGLE_WALLET_SALON_NAME_MISSING",
    "Google Wallet payload requires salon_name"
  )
}

function resolveMerchantLocation(
  walletPayload: WalletPayload,
  marketBranding: GoogleWalletMarketBranding
): GoogleWalletMerchantLocation {
  const address = requirePayloadString(
    googlePayloadField(walletPayload, "salon_address") ??
      marketBranding.salon_address,
    "GOOGLE_WALLET_SALON_ADDRESS_MISSING",
    "Google Wallet payload requires salon_address"
  )

  return {
    address,
    latitude:
      googlePayloadNumber(walletPayload, "latitude") ?? marketBranding.latitude,
    longitude:
      googlePayloadNumber(walletPayload, "longitude") ??
      marketBranding.longitude,
  }
}

function resolveBackground(
  walletPayload: WalletPayload,
  marketBranding: GoogleWalletMarketBranding
): string {
  void walletPayload
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

function mapWalletStatus(status: WalletPassStatus): string {
  return status === "ACTIVE" ? "ACTIVE" : "INACTIVE"
}

function buildTextModule(
  id: string,
  header: string,
  body: string
): walletobjects_v1.Schema$TextModuleData {
  return { id, header, body }
}

function googlePayloadField(
  walletPayload: WalletPayload,
  key: keyof GoogleWalletPayloadFields
): string | undefined {
  const value = (walletPayload as WalletPayload & GoogleWalletPayloadFields)[key]
  return trimString(value)
}

function googlePayloadNumber(
  walletPayload: WalletPayload,
  key: keyof GoogleWalletPayloadFields
): number | undefined {
  const value = (walletPayload as WalletPayload & GoogleWalletPayloadFields)[key]
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
