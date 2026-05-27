import {
  normalizeWalletLocale,
  type EntitlementInstance,
  type EntitlementInstanceReadModel,
  type EntitlementInstanceWalletMetadata,
  type LocalizedWalletText,
  type WalletBarcodeSpec,
  type WalletBranding,
  type WalletLocale,
  type WalletPassStatus,
  type WalletPayload,
} from "./payload"

const DEFAULT_BRANDING: WalletBranding = {
  logo_url: "https://assets.growplatform.local/bonbeauty/logo.svg",
  primary_color: "#111827",
  accent_color: "#16A34A",
}

const ACTIVE_STATES = new Set([
  "ISSUED",
  "ACTIVE",
  "REDEMPTION_REQUESTED",
  "REDEEMED_PARTIAL",
  "REDEEMED_FULL",
  "SETTLED",
])

export interface WalletPayloadBuilder {
  build(entitlement_instance: EntitlementInstance, locale: string): WalletPayload

  buildFromEntitlement(
    entitlement_instance_id: string,
    locale: string
  ): Promise<WalletPayload>
}

export interface WalletPayloadBuilderOptions {
  fallback_locale?: WalletLocale
  default_branding?: WalletBranding
}

export class WalletPayloadError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "WalletPayloadError"
  }
}

export class DefaultWalletPayloadBuilder implements WalletPayloadBuilder {
  private readonly fallback_locale: WalletLocale
  private readonly default_branding: WalletBranding

  constructor(
    private readonly read_model?: EntitlementInstanceReadModel,
    options: WalletPayloadBuilderOptions = {}
  ) {
    this.fallback_locale = options.fallback_locale ?? "pl-PL"
    this.default_branding = options.default_branding ?? DEFAULT_BRANDING
  }

  async buildFromEntitlement(
    entitlement_instance_id: string,
    locale: string
  ): Promise<WalletPayload> {
    if (!this.read_model) {
      throw new WalletPayloadError(
        "READ_MODEL_MISSING",
        "EntitlementInstanceReadModel is required for buildFromEntitlement"
      )
    }

    const entitlement_instance = await this.read_model.getById(
      entitlement_instance_id
    )

    if (!entitlement_instance) {
      throw new WalletPayloadError(
        "ENTITLEMENT_INSTANCE_NOT_FOUND",
        `entitlement_instance ${entitlement_instance_id} was not found`
      )
    }

    return this.build(entitlement_instance, locale)
  }

  build(entitlement_instance: EntitlementInstance, locale: string): WalletPayload {
    const normalized_locale = normalizeWalletLocale(locale)
    const wallet_metadata = resolveWalletMetadata(entitlement_instance)
    const code = requireString(
      wallet_metadata.code ?? entitlement_instance.code,
      "CODE_MISSING",
      "entitlement_instance wallet code is required"
    )
    const title = resolveTitle(
      wallet_metadata.title ?? entitlement_instance.title,
      normalized_locale,
      this.fallback_locale
    )
    const status = resolveStatus(
      wallet_metadata.status ?? entitlement_instance.status,
      entitlement_instance.state
    )
    const expires_at = normalizeExpiresAt(
      wallet_metadata.expires_at ?? entitlement_instance.expires_at
    )
    const deep_link = requireString(
      wallet_metadata.deep_link ?? entitlement_instance.deep_link,
      "DEEP_LINK_MISSING",
      "entitlement_instance wallet deep_link is required"
    )
    const barcode_spec = resolveBarcodeSpec(
      wallet_metadata.barcode_spec ?? entitlement_instance.barcode_spec,
      code
    )
    const branding = resolveBranding(
      wallet_metadata.branding ?? entitlement_instance.branding,
      this.default_branding
    )
    const salon_name = pickOptionalString(
      wallet_metadata.salon_name ?? entitlement_instance.salon_name
    )
    const salon_address = pickOptionalString(
      wallet_metadata.salon_address ?? entitlement_instance.salon_address
    )
    const latitude = pickOptionalNumber(
      wallet_metadata.latitude ?? entitlement_instance.latitude
    )
    const longitude = pickOptionalNumber(
      wallet_metadata.longitude ?? entitlement_instance.longitude
    )

    return {
      entitlement_instance_id: entitlement_instance.id,
      code,
      title,
      status,
      expires_at,
      deep_link,
      barcode_spec,
      qr_code: barcode_spec.format === "QR" ? barcode_spec.value : undefined,
      barcode: barcode_spec.format === "PDF417" ? barcode_spec : undefined,
      branding,
      locale: normalized_locale,
      salon_name,
      salon_address,
      latitude,
      longitude,
    }
  }
}

function resolveWalletMetadata(
  entitlement_instance: EntitlementInstance
): EntitlementInstanceWalletMetadata {
  return (
    entitlement_instance.metadata?.wallet ??
    entitlement_instance.metadata?.gp?.wallet ??
    {}
  )
}

function requireString(
  value: unknown,
  code: string,
  message: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WalletPayloadError(code, message)
  }

  return value.trim()
}

function resolveTitle(
  title: LocalizedWalletText | undefined,
  locale: WalletLocale,
  fallback_locale: WalletLocale
): string {
  if (typeof title === "string") {
    return requireString(title, "TITLE_MISSING", "wallet title is required")
  }

  const localized = title?.[locale] ?? title?.[fallback_locale]
  if (localized) return localized

  const first_available = Object.values(title ?? {}).find(
    (value) => typeof value === "string" && value.trim().length > 0
  )
  return requireString(
    first_available,
    "TITLE_MISSING",
    "wallet title is required"
  )
}

function resolveStatus(
  status: WalletPassStatus | undefined,
  state: string | undefined
): WalletPassStatus {
  if (status) return status
  if (!state) {
    throw new WalletPayloadError(
      "STATUS_MISSING",
      "entitlement_instance wallet status is required"
    )
  }

  if (ACTIVE_STATES.has(state)) return "ACTIVE"
  if (state === "EXPIRED") return "EXPIRED"
  if (state === "REFUNDED") return "REFUNDED"
  if (state === "VOIDED" || state === "CLOSED") return "REVOKED"

  throw new WalletPayloadError(
    "STATUS_UNSUPPORTED",
    `entitlement_instance state ${state} cannot be projected to wallet status`
  )
}

function normalizeExpiresAt(value: string | Date | null | undefined): string {
  if (!value) {
    throw new WalletPayloadError(
      "EXPIRES_AT_MISSING",
      "entitlement_instance expires_at is required"
    )
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new WalletPayloadError(
      "EXPIRES_AT_INVALID",
      "entitlement_instance expires_at must be a valid date"
    )
  }

  return date.toISOString()
}

function resolveBarcodeSpec(
  spec: WalletBarcodeSpec | undefined,
  code: string
): WalletBarcodeSpec {
  if (!spec) return { format: "QR", value: code }
  if (spec.format !== "QR" && spec.format !== "PDF417") {
    throw new WalletPayloadError(
      "BARCODE_FORMAT_UNSUPPORTED",
      `wallet barcode format ${spec.format} is not supported`
    )
  }

  return {
    format: spec.format,
    value: requireString(
      spec.value,
      "BARCODE_VALUE_MISSING",
      "wallet barcode value is required"
    ),
  }
}

function pickOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function pickOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function pickString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function resolveBranding(
  branding: Partial<WalletBranding> | undefined,
  fallback: WalletBranding
): WalletBranding {
  return {
    logo_url: pickString(branding?.logo_url, fallback.logo_url),
    primary_color: pickString(branding?.primary_color, fallback.primary_color),
    accent_color: pickString(branding?.accent_color, fallback.accent_color),
  }
}
