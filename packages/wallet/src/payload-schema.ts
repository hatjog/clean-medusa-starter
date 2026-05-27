import { WalletPayloadError } from "./errors"
import type {
  WalletBarcodeSpec,
  WalletBranding,
  WalletPayload,
} from "./payload"

export const WALLET_PAYLOAD_ALLOWED_FIELDS = [
  "entitlement_instance_id",
  "code",
  "title",
  "status",
  "expires_at",
  "salon_name",
  "salon_address",
  "deep_link",
  "barcode_spec",
  "qr_code",
  "barcode",
  "branding",
  "locale",
] as const

export const WALLET_PAYLOAD_FORBIDDEN_FIELDS = [
  "recipient_email",
  "recipient_full_name",
  "recipient_name",
  "recipient_phone",
  "recipient_address",
  "buyer_email",
  "buyer_full_name",
  "buyer_phone",
  "buyer_address",
  "buyer_anna_pii",
  "customer_email",
  "customer_phone",
  "ip_address",
  "device_fingerprint",
] as const

const ALLOWED_FIELDS = new Set<string>(WALLET_PAYLOAD_ALLOWED_FIELDS)
const REQUIRED_FIELDS = [
  "entitlement_instance_id",
  "code",
  "title",
  "status",
  "expires_at",
  "salon_name",
  "salon_address",
  "deep_link",
  "barcode_spec",
  "branding",
  "locale",
] as const

const WALLET_STATUSES = new Set(["ACTIVE", "EXPIRED", "REVOKED", "REFUNDED"])
const WALLET_LOCALES = new Set(["pl-PL", "en-US", "uk-UA", "de-DE"])
const BARCODE_FORMATS = new Set(["QR", "PDF417"])

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function assertStringField(record: UnknownRecord, field: string): void {
  if (typeof record[field] !== "string" || record[field].trim().length === 0) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      `wallet payload field ${field} must be a non-empty string`
    )
  }
}

function assertBarcodeSpec(value: unknown, field: string): void {
  const barcode = asRecord(value)
  if (!barcode) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      `wallet payload field ${field} must be an object`
    )
  }
  const keys = Object.keys(barcode)
  for (const key of keys) {
    if (key !== "format" && key !== "value") {
      throw new WalletPayloadError(
        "WALLET_PAYLOAD_UNKNOWN_FIELD",
        `wallet payload field ${field}.${key} is not allowed`
      )
    }
  }
  if (!BARCODE_FORMATS.has(String(barcode.format))) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      `wallet payload field ${field}.format is invalid`
    )
  }
  if (typeof barcode.value !== "string" || barcode.value.trim().length === 0) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      `wallet payload field ${field}.value must be a non-empty string`
    )
  }
}

function assertBranding(value: unknown): void {
  const branding = asRecord(value)
  if (!branding) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      "wallet payload field branding must be an object"
    )
  }
  const allowed = new Set(["logo_url", "primary_color", "accent_color"])
  for (const key of Object.keys(branding)) {
    if (!allowed.has(key)) {
      throw new WalletPayloadError(
        "WALLET_PAYLOAD_UNKNOWN_FIELD",
        `wallet payload field branding.${key} is not allowed`
      )
    }
  }
  for (const field of allowed) {
    if (
      typeof branding[field] !== "string" ||
      String(branding[field]).trim().length === 0
    ) {
      throw new WalletPayloadError(
        "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
        `wallet payload field branding.${field} must be a non-empty string`
      )
    }
  }
}

export function assertWalletPayloadSchema(
  payload: unknown
): asserts payload is WalletPayload {
  const record = asRecord(payload)
  if (!record) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_INVALID",
      "wallet payload must be an object"
    )
  }

  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new WalletPayloadError(
        "WALLET_PAYLOAD_UNKNOWN_FIELD",
        `wallet payload field ${key} is not allowed`
      )
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      throw new WalletPayloadError(
        "WALLET_PAYLOAD_REQUIRED_FIELD_MISSING",
        `wallet payload field ${field} is required`
      )
    }
  }

  for (const field of [
    "entitlement_instance_id",
    "code",
    "title",
    "expires_at",
    "salon_name",
    "salon_address",
    "deep_link",
  ]) {
    assertStringField(record, field)
  }

  if (!WALLET_STATUSES.has(String(record.status))) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      "wallet payload field status is invalid"
    )
  }
  if (!WALLET_LOCALES.has(String(record.locale))) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      "wallet payload field locale is invalid"
    )
  }

  assertBarcodeSpec(record.barcode_spec, "barcode_spec")
  if (record.barcode !== undefined) assertBarcodeSpec(record.barcode, "barcode")
  if (record.qr_code !== undefined) assertStringField(record, "qr_code")
  assertBranding(record.branding)
}

export function validateWalletPayloadInCurrentEnv(
  payload: WalletPayload
): WalletPayload {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.GP_WALLET_PAYLOAD_SCHEMA_VALIDATION !== "on"
  ) {
    return payload
  }

  assertWalletPayloadSchema(payload)
  return payload
}

export type WalletPayloadSchemaBranding = WalletBranding
export type WalletPayloadSchemaBarcodeSpec = WalletBarcodeSpec
