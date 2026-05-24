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

export type MagicLinkIssuedRecorder = (
  generated: GeneratedMagicLink
) => void | Promise<void>

export type MagicLinkRevocationChecker = (
  jti: string
) => boolean | Promise<boolean>

export type MagicLinkOptions = {
  now?: Date
  jti?: string
  secret?: string
}

export type GenerateMagicLinkOptions = MagicLinkOptions & {
  recordIssued?: MagicLinkIssuedRecorder
}

export type VerifyMagicLinkOptions = {
  now?: Date
  secret?: string
  isJtiRevoked?: MagicLinkRevocationChecker
}

export type MagicLinkRuntimeBindings = {
  isJtiRevoked?: MagicLinkRevocationChecker
  recordIssued?: MagicLinkIssuedRecorder
}

export const MAGIC_LINK_TTL_SECONDS: Record<MagicLinkPurpose, number> = {
  purchase: 24 * 60 * 60,
  recover: 7 * 24 * 60 * 60,
}

const HS256_ALGORITHM = "HS256"
const JWT_SECRET_MIN_BYTES = 32
const TEST_SECRET_ENV = "MAGIC_LINK_TEST_JWT_SECRET"
const runtimeBindings: MagicLinkRuntimeBindings = {}
const MAGIC_LINK_JTI_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class MagicLinkConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MagicLinkConfigurationError"
  }
}

export function configureMagicLinkRuntime(
  bindings: MagicLinkRuntimeBindings
): void {
  runtimeBindings.isJtiRevoked = bindings.isJtiRevoked
  runtimeBindings.recordIssued = bindings.recordIssued
}

export function resetMagicLinkRuntime(): void {
  delete runtimeBindings.isJtiRevoked
  delete runtimeBindings.recordIssued
}

export function isValidMagicLinkJti(value: unknown): value is string {
  return typeof value === "string" && MAGIC_LINK_JTI_UUID_RE.test(value)
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
    isValidMagicLinkJti(value.jti) &&
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

export function getMagicLinkSubjectEmail(
  subject: MagicLinkSubject
): string | null {
  const value = subject.email
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null
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
  const jti = options.jti ?? randomUUID()
  if (!isValidMagicLinkJti(jti)) {
    throw new Error("Invalid magic link jti")
  }

  const claims: MagicLinkClaims = {
    jti,
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

/**
 * @deprecated v1.9.0 Wave F6 / Epic-2 HIGH-06.
 *
 * Use `issueMagicLink(store, ...)` from
 * `lib/auth/magic-link-revocation` instead. The runtime-singleton
 * `recordIssued` resolution here is hidden plumbing — any new entry point that
 * imports `generateMagicLink` directly and forgets to call
 * `configureMagicLinkRuntime` first will silently lose the magic_link_issued
 * ledger write, which in turn breaks revoke-all market-scope cross-checks.
 * The store-bound `issueMagicLink` form makes the dependency a typed parameter
 * the call site cannot forget.
 *
 * This function is preserved for the 2.14-reopen `/store/auth/magic-link`
 * recover route + tests; new callers MUST go through `issueMagicLink`.
 * `_grow/tools/validate_magic_link_callsites.py` (ra-5 carry-out follow-up)
 * enforces the deprecation at CI time.
 */
export async function generateMagicLink(
  purpose: MagicLinkPurpose,
  subject: MagicLinkSubject,
  options: GenerateMagicLinkOptions = {}
): Promise<string> {
  const generated = generateMagicLinkWithClaims(purpose, subject, options)
  const recordIssued = options.recordIssued ?? runtimeBindings.recordIssued

  if (!recordIssued) {
    throw new MagicLinkConfigurationError(
      "Magic link issued ledger recorder is required for generateMagicLink"
    )
  }

  await recordIssued(generated)

  return generated.token
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
  if (claims.iat > now) {
    return { valid: false, reason: "invalid" }
  }

  if (claims.exp <= now) {
    return { valid: false, reason: "expired" }
  }

  if (claims.exp - claims.iat > MAGIC_LINK_TTL_SECONDS[claims.purpose]) {
    return { valid: false, reason: "invalid" }
  }

  const isJtiRevoked = options.isJtiRevoked ?? runtimeBindings.isJtiRevoked
  if (!isJtiRevoked) {
    return { valid: false, reason: "invalid" }
  }

  try {
    if (await isJtiRevoked(claims.jti)) {
      return { valid: false, reason: "revoked" }
    }
  } catch {
    return { valid: false, reason: "invalid" }
  }

  return {
    valid: true,
    subject: claims.subject,
    purpose: claims.purpose,
    jti: claims.jti,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  }
}
