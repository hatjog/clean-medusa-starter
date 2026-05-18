import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

export type MagicLinkPurpose = "purchase" | "recover"

export type MagicLinkSubject = Record<string, string | number | boolean | null>

export type MagicLinkVerificationReason = "expired" | "invalid" | "revoked"

export type MagicLinkVerificationResult =
  | {
      valid: true
      subject: MagicLinkSubject
      purpose: MagicLinkPurpose
      jti: string
      expires_at: string
    }
  | {
      valid: false
      reason: MagicLinkVerificationReason
    }

export type MagicLinkClaims = {
  jti: string
  purpose: MagicLinkPurpose
  subject: MagicLinkSubject
  iat: number
  exp: number
}

export type GeneratedMagicLink = {
  token: string
  claims: MagicLinkClaims
}

export type MagicLinkRevocationChecker = (
  jti: string
) => boolean | Promise<boolean>

export type MagicLinkOptions = {
  now?: Date
  jti?: string
  secret?: string
}

export type VerifyMagicLinkOptions = {
  now?: Date
  secret?: string
  isJtiRevoked?: MagicLinkRevocationChecker
}

export const MAGIC_LINK_TTL_SECONDS: Record<MagicLinkPurpose, number> = {
  purchase: 24 * 60 * 60,
  recover: 7 * 24 * 60 * 60,
}

const HS256_ALGORITHM = "HS256"
const JWT_SECRET_MIN_BYTES = 32
const TEST_SECRET_ENV = "MAGIC_LINK_TEST_JWT_SECRET"

export class MagicLinkConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MagicLinkConfigurationError"
  }
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function base64UrlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("invalid base64url")
  }

  const padding = (4 - (value.length % 4)) % 4
  const normalized = `${value}${"=".repeat(padding)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/")

  return Buffer.from(normalized, "base64")
}

function jsonBase64Url(value: unknown): string {
  return base64UrlEncode(JSON.stringify(value))
}

function resolveSecret(explicitSecret?: string): Buffer {
  const secret =
    explicitSecret ??
    process.env.JWT_SECRET ??
    (process.env.NODE_ENV === "test" ? process.env[TEST_SECRET_ENV] : undefined)

  if (!secret) {
    throw new MagicLinkConfigurationError("JWT_SECRET is required for magic links")
  }

  const secretBytes = Buffer.from(secret, "utf8")
  if (secretBytes.byteLength < JWT_SECRET_MIN_BYTES) {
    throw new MagicLinkConfigurationError(
      `JWT_SECRET must be at least ${JWT_SECRET_MIN_BYTES} bytes for HS256 magic links`
    )
  }

  return secretBytes
}

function signInput(input: string, secret: Buffer): string {
  return base64UrlEncode(createHmac("sha256", secret).update(input).digest())
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function isAllowedSubjectValue(
  value: unknown
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
}

function getNonEmptyString(
  subject: Record<string, unknown>,
  key: string
): string | null {
  const value = subject[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function isValidSubjectForPurpose(
  purpose: MagicLinkPurpose,
  subject: unknown
): subject is MagicLinkSubject {
  if (!isPlainObject(subject)) {
    return false
  }

  const entries = Object.entries(subject)
  if (entries.length === 0 || entries.some(([, value]) => !isAllowedSubjectValue(value))) {
    return false
  }

  if (purpose === "recover") {
    return Boolean(
      getNonEmptyString(subject, "customer_id") ||
        getNonEmptyString(subject, "email")
    )
  }

  return Boolean(
    getNonEmptyString(subject, "customer_id") ||
      getNonEmptyString(subject, "order_id") ||
      getNonEmptyString(subject, "entitlement_id") ||
      getNonEmptyString(subject, "voucher_code")
  )
}

function isMagicLinkPurpose(value: unknown): value is MagicLinkPurpose {
  return value === "purchase" || value === "recover"
}

function isMagicLinkClaims(value: unknown): value is MagicLinkClaims {
  if (!isPlainObject(value)) {
    return false
  }

  const purpose = value.purpose
  if (!isMagicLinkPurpose(purpose)) {
    return false
  }

  return (
    typeof value.jti === "string" &&
    value.jti.trim().length > 0 &&
    typeof value.iat === "number" &&
    Number.isFinite(value.iat) &&
    typeof value.exp === "number" &&
    Number.isFinite(value.exp) &&
    value.exp > value.iat &&
    isValidSubjectForPurpose(purpose, value.subject)
  )
}

function parseJsonPart(part: string): unknown {
  return JSON.parse(base64UrlDecode(part).toString("utf8"))
}

function parseSignedToken(
  token: string,
  secret: Buffer
): MagicLinkClaims | "invalid" {
  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return "invalid"
  }

  const [encodedHeader, encodedPayload, signature] = parts

  let header: unknown
  let payload: unknown
  try {
    header = parseJsonPart(encodedHeader)
    payload = parseJsonPart(encodedPayload)
  } catch {
    return "invalid"
  }

  if (!isPlainObject(header) || header.alg !== HS256_ALGORITHM) {
    return "invalid"
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = signInput(signingInput, secret)
  const expected = Buffer.from(expectedSignature)
  const received = Buffer.from(signature)

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return "invalid"
  }

  return isMagicLinkClaims(payload) ? payload : "invalid"
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

export function getMagicLinkSubjectCustomerId(
  subject: MagicLinkSubject
): string | null {
  const value = subject.customer_id
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function getMagicLinkSubjectMarketId(
  subject: MagicLinkSubject
): string | null {
  const value = subject.market_id
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function generateMagicLinkWithClaims(
  purpose: MagicLinkPurpose,
  subject: MagicLinkSubject,
  options: MagicLinkOptions = {}
): GeneratedMagicLink {
  if (!isValidSubjectForPurpose(purpose, subject)) {
    throw new Error("Invalid magic link subject")
  }

  const now = options.now ?? new Date()
  const iat = epochSeconds(now)
  const claims: MagicLinkClaims = {
    jti: options.jti ?? randomUUID(),
    purpose,
    subject,
    iat,
    exp: iat + MAGIC_LINK_TTL_SECONDS[purpose],
  }

  const header = jsonBase64Url({ alg: HS256_ALGORITHM, typ: "JWT" })
  const payload = jsonBase64Url(claims)
  const signingInput = `${header}.${payload}`
  const signature = signInput(signingInput, resolveSecret(options.secret))

  return {
    token: `${signingInput}.${signature}`,
    claims,
  }
}

export function generateMagicLink(
  purpose: MagicLinkPurpose,
  subject: MagicLinkSubject
): string {
  return generateMagicLinkWithClaims(purpose, subject).token
}

export async function verifyMagicLink(
  token: string,
  options: VerifyMagicLinkOptions = {}
): Promise<MagicLinkVerificationResult> {
  let claims: MagicLinkClaims | "invalid"

  try {
    claims = parseSignedToken(token, resolveSecret(options.secret))
  } catch {
    return { valid: false, reason: "invalid" }
  }

  if (claims === "invalid") {
    return { valid: false, reason: "invalid" }
  }

  const now = epochSeconds(options.now ?? new Date())
  if (claims.exp <= now) {
    return { valid: false, reason: "expired" }
  }

  if (options.isJtiRevoked && (await options.isJtiRevoked(claims.jti))) {
    return { valid: false, reason: "revoked" }
  }

  return {
    valid: true,
    subject: claims.subject,
    purpose: claims.purpose,
    jti: claims.jti,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  }
}
