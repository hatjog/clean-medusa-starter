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
  // market + entitlement_type są wymaganymi, PII-neutralnymi polami WalletPayload
  // (dryf schema-vs-type po Stage-2 re-integration: typ je wymagał, lista allowed/
  // required ich nie miała → walidator fail-closed odrzucał poprawne payloady).
  "market",
  "entitlement_type",
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
  // opcjonalne pola geolokalizacji merchant view (emitowane przez payload-builder
  // jako klucze nawet gdy undefined) — PII-neutralne, dozwolone.
  "latitude",
  "longitude",
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
  "market",
  "entitlement_type",
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

// Parytet semantyczny z JSON Schema (F-05): expires_at = ISO-8601 date-time,
// branding colors = #RRGGBB. Defense-in-depth ma dwa miecze tej samej dlugosci.
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/

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
  for (const colorField of ["primary_color", "accent_color"] as const) {
    if (!HEX_COLOR_PATTERN.test(String(branding[colorField]))) {
      throw new WalletPayloadError(
        "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
        `wallet payload field branding.${colorField} must match #RRGGBB`
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
    "market",
    "entitlement_type",
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
  if (!ISO_DATETIME_PATTERN.test(String(record.expires_at))) {
    throw new WalletPayloadError(
      "WALLET_PAYLOAD_REQUIRED_FIELD_INVALID",
      "wallet payload field expires_at must be ISO-8601 date-time"
    )
  }

  assertBarcodeSpec(record.barcode_spec, "barcode_spec")
  if (record.barcode !== undefined) assertBarcodeSpec(record.barcode, "barcode")
  if (record.qr_code !== undefined) assertStringField(record, "qr_code")
  assertBranding(record.branding)
}

/**
 * Runtime guard fail-closed by default we wszystkich srodowiskach (F-01 fix).
 *
 * Per D-110 + FR-C.12 hardening:adversarial-review (GDPR Art. 5), trzecia
 * warstwa defense-in-depth MUSI dzialac w produkcji. Koszt walidacji jest
 * milisekundowy (Object.keys + Set lookup), wiec domyslnie waliduje takze
 * `NODE_ENV === "production"`. Awaryjny opt-out (gdy hot-fix wymaga skip)
 * jest jawny: `GP_WALLET_PAYLOAD_SCHEMA_VALIDATION=off`. Reviewer gate w
 * `wallet-pii-audit.md` wymaga ze produkcyjny deploy NIE ustawia opt-out.
 */
export function validateWalletPayloadInCurrentEnv(
  payload: WalletPayload
): WalletPayload {
  if (process.env.GP_WALLET_PAYLOAD_SCHEMA_VALIDATION === "off") {
    return payload
  }

  assertWalletPayloadSchema(payload)
  return payload
}

export type WalletPayloadSchemaBranding = WalletBranding
export type WalletPayloadSchemaBarcodeSpec = WalletBarcodeSpec
