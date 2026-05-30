export const GOOGLE_WALLET_SAVE_BASE =
  "https://pay.google.com/gp/v/save/"

export const GOOGLE_WALLET_DEFAULT_CLASS_ID_TEMPLATE =
  "{issuer_id}.{market_code}_voucher_v1"

export interface GoogleWalletProviderConfig {
  issuer_id: string
  service_account_email: string
  private_key: string
  class_id_template: string
  origin_save_base: string
  market_code?: string
  issuer_name?: string
  request_timeout_ms?: number
}

export class GoogleWalletConfigMissingError extends Error {
  readonly error_code = "GOOGLE_WALLET_CONFIG_MISSING"

  constructor(
    readonly missing_fields: readonly string[],
    readonly audit_event?: unknown
  ) {
    super(
      `Google Wallet configuration is missing: ${missing_fields.join(", ")}`
    )
    this.name = "GoogleWalletConfigMissingError"
  }
}

export function loadGoogleWalletProviderConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GoogleWalletProviderConfig {
  return resolveGoogleWalletProviderConfig({
    issuer_id: env.GOOGLE_WALLET_ISSUER_ID,
    service_account_email: env.GOOGLE_WALLET_SA_EMAIL,
    private_key: env.GOOGLE_WALLET_PRIVATE_KEY,
    class_id_template: env.GOOGLE_WALLET_CLASS_ID_TEMPLATE,
    origin_save_base: env.GOOGLE_WALLET_SAVE_BASE,
    market_code: env.GOOGLE_WALLET_MARKET_CODE,
    issuer_name: env.GOOGLE_WALLET_ISSUER_NAME,
    request_timeout_ms: parseOptionalInteger(
      env.GOOGLE_WALLET_REQUEST_TIMEOUT_MS
    ),
  })
}

export function resolveGoogleWalletProviderConfig(
  input: Partial<GoogleWalletProviderConfig>
): GoogleWalletProviderConfig {
  const config = {
    issuer_id: trimString(input.issuer_id),
    service_account_email: trimString(input.service_account_email),
    private_key: normalizePrivateKey(input.private_key),
    class_id_template:
      trimString(input.class_id_template) ??
      GOOGLE_WALLET_DEFAULT_CLASS_ID_TEMPLATE,
    origin_save_base:
      trimString(input.origin_save_base) ?? GOOGLE_WALLET_SAVE_BASE,
    market_code: trimString(input.market_code) ?? "bonbeauty",
    issuer_name: trimString(input.issuer_name) ?? "Grow Platform",
    request_timeout_ms: input.request_timeout_ms ?? 2_000,
  }
  const required_fields: Array<[string, string | undefined]> = [
    ["issuer_id", config.issuer_id],
    ["service_account_email", config.service_account_email],
    ["private_key", config.private_key],
    ["class_id_template", config.class_id_template],
  ]
  const missing = required_fields.reduce<string[]>((fields, [field, value]) => {
    if (!value) fields.push(field)
    return fields
  }, [])

  if (missing.length > 0) {
    throw new GoogleWalletConfigMissingError(missing)
  }

  return config as GoogleWalletProviderConfig
}

export function buildGoogleWalletClassId(
  config: GoogleWalletProviderConfig
): string {
  // I2: w v1.10.0 BonBeauty obsługuje wyłącznie voucher passes — placeholder
  // {wallet_product} jest expanded do "voucher" bezwarunkowo. Pillar C
  // extension (np. loyalty cards) wymagać będzie parametryzacji per pass kind.
  const expanded = config.class_id_template
    .replaceAll("{issuer_id}", config.issuer_id)
    .replaceAll("{market_code}", sanitizeWalletIdPart(config.market_code))
    .replaceAll("{wallet_product}", "voucher")

  if (expanded.startsWith(`${config.issuer_id}.`)) {
    return expanded
  }

  return `${config.issuer_id}.${sanitizeWalletIdPart(expanded)}`
}

export function buildGoogleWalletObjectId(
  class_id: string,
  entitlement_instance_id: string
): string {
  return `${class_id}.${sanitizeWalletIdPart(entitlement_instance_id)}`
}

export function sanitizeWalletIdPart(value: unknown): string {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")

  if (!sanitized) {
    throw new GoogleWalletConfigMissingError(["wallet_id_part"])
  }

  return sanitized
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizePrivateKey(value: unknown): string | undefined {
  const trimmed = trimString(value)
  if (!trimmed) return undefined

  const escaped = trimmed.replace(/\\n/g, "\n")
  if (escaped.includes("-----BEGIN")) return escaped

  try {
    const decoded = Buffer.from(escaped, "base64").toString("utf8")
    if (decoded.includes("-----BEGIN")) return decoded
  } catch {
    // intentionally swallowed — fail-fast poniżej
  }

  // L5 fail-fast: ani escaped, ani base64-decoded nie zawiera PEM headera —
  // bootstrap powinien zobaczyć GOOGLE_WALLET_CONFIG_MISSING zamiast cichego
  // przejścia do GOOGLE_WALLET_SIGNING_FAILED w runtime.
  throw new GoogleWalletConfigMissingError(["private_key (not PEM)"])
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
