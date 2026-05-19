import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createHash } from "node:crypto"

import {
  verifyMagicLink,
  type MagicLinkSubject,
} from "../../../../lib/auth/magic-link"
import { marketContextStorage } from "../../../../lib/market-context"

type Db = {
  raw: (sql: string, params?: unknown[]) => Promise<unknown>
}

type ConsentErrorCode =
  | "RODO_CONSENT_REQUIRED"
  | "SERVICE_CONSENT_REQUIRED"
  | "GUARDIAN_EMAIL_INVALID"
  | "GUARDIAN_CONSENT_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "RATE_LIMITED"
  | "TOKEN_EXPIRED"
  | "TOKEN_REVOKED"
  | "TOKEN_INVALID"
  | "FIELD_NOT_ALLOWED"

type ConsentStatus = "pending" | "approved" | "approved_by_guardian" | "rejected"

type ConsentPayload = {
  consent_rodo: true
  consent_service_execution: true
  consent_marketing: boolean
  guardian_email: string | null
  guardian_is_parent: boolean | null
  captcha_token: string | null
}

const ALLOWED_FIELDS = new Set([
  "consent_rodo",
  "consent_service_execution",
  "consent_marketing",
  "guardian_email",
  "guardian_is_parent",
  "captcha_token",
])

const RATE_LIMIT_MAX_PER_HOUR = 3
const RETRY_AFTER_SECONDS = "3600"
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

function setSecurityHeaders(res: MedusaResponse): void {
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("X-Content-Type-Options", "nosniff")
}

function jsonError(
  res: MedusaResponse,
  status: number,
  error: ConsentErrorCode,
  extra: Record<string, unknown> = {}
): void {
  res.status(status).json({ error, ...extra })
}

function tokenFromRequest(req: MedusaRequest): string {
  const params = (req as unknown as { params?: Record<string, unknown> }).params
  const token = params?.token
  return typeof token === "string" ? token.trim() : ""
}

function resolveDb(req: MedusaRequest): Db | null {
  try {
    const resolved = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Db | undefined
    return resolved ?? null
  } catch {
    return null
  }
}

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown[] })?.rows
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

function mapTokenReason(reason: "expired" | "invalid" | "revoked"): ConsentErrorCode {
  if (reason === "expired") return "TOKEN_EXPIRED"
  if (reason === "revoked") return "TOKEN_REVOKED"
  return "TOKEN_INVALID"
}

async function verifyPurchaseToken(token: string): Promise<
  | {
      ok: true
      subject: MagicLinkSubject
      token_jti: string
    }
  | {
      ok: false
      error: ConsentErrorCode
    }
> {
  const verification = await verifyMagicLink(token)
  if (!verification.valid) {
    return { ok: false, error: mapTokenReason(verification.reason) }
  }
  if (verification.purpose !== "purchase") {
    return { ok: false, error: "TOKEN_INVALID" }
  }
  return {
    ok: true,
    subject: verification.subject,
    token_jti: verification.jti,
  }
}

function getStringSubject(subject: MagicLinkSubject, key: string): string | null {
  const value = subject[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function buyerAccountId(subject: MagicLinkSubject, tokenJti: string): string {
  return (
    getStringSubject(subject, "buyer_account_id") ??
    getStringSubject(subject, "customer_id") ??
    getStringSubject(subject, "order_id") ??
    `anonymous:${tokenJti}`
  )
}

function ageCheckRequired(subject: MagicLinkSubject): boolean {
  const recipientAge = subject.recipient_age
  const ageRequiresGuardian =
    typeof recipientAge === "number" && Number.isFinite(recipientAge) && recipientAge < 18

  return (
    ageRequiresGuardian ||
    subject.requires_age_check === true ||
    subject.voucher_template_requires_age_check === true ||
    subject.age_check_required === true
  )
}

function validatePayload(
  body: unknown,
  minorPath: boolean
): ConsentPayload | { error: ConsentErrorCode; field?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "RODO_CONSENT_REQUIRED" }
  }

  const record = body as Record<string, unknown>
  for (const field of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(field)) {
      return { error: "FIELD_NOT_ALLOWED", field }
    }
  }

  if (record.consent_rodo !== true) return { error: "RODO_CONSENT_REQUIRED" }
  if (record.consent_service_execution !== true) {
    return { error: "SERVICE_CONSENT_REQUIRED" }
  }
  if (
    record.consent_marketing !== undefined &&
    typeof record.consent_marketing !== "boolean"
  ) {
    return { error: "FIELD_NOT_ALLOWED", field: "consent_marketing" }
  }

  const consentMarketing = record.consent_marketing === true
  const guardianEmail =
    typeof record.guardian_email === "string" && record.guardian_email.trim()
      ? record.guardian_email.trim()
      : null
  const guardianIsParent =
    typeof record.guardian_is_parent === "boolean" ? record.guardian_is_parent : null
  const captchaToken =
    typeof record.captcha_token === "string" && record.captcha_token.trim()
      ? record.captcha_token.trim()
      : null

  if (minorPath) {
    if (!guardianEmail || !EMAIL_PATTERN.test(guardianEmail)) {
      return { error: "GUARDIAN_EMAIL_INVALID" }
    }
    if (guardianIsParent !== true) {
      return { error: "GUARDIAN_CONSENT_REQUIRED" }
    }
    if (!captchaToken) {
      return { error: "CAPTCHA_REQUIRED" }
    }
  }

  return {
    consent_rodo: true,
    consent_service_execution: true,
    consent_marketing: consentMarketing,
    guardian_email: minorPath ? guardianEmail : null,
    guardian_is_parent: minorPath ? true : null,
    captcha_token: minorPath ? captchaToken : null,
  }
}

function stablePayloadHash(payload: ConsentPayload): string {
  const minimized = {
    consent_marketing: payload.consent_marketing,
    consent_rodo: payload.consent_rodo,
    consent_service_execution: payload.consent_service_execution,
    guardian_email: payload.guardian_email,
    guardian_is_parent: payload.guardian_is_parent,
  }
  return createHash("sha256").update(JSON.stringify(minimized)).digest("hex")
}

function requestHeader(req: MedusaRequest, header: string): string | null {
  const headers = (req as unknown as { headers?: Record<string, unknown> }).headers ?? {}
  const value = headers[header] ?? headers[header.toLowerCase()]
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function resolveIpAddress(req: MedusaRequest): string | null {
  const forwarded = requestHeader(req, "x-forwarded-for")
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || null
  }
  const ip = (req as unknown as { ip?: unknown }).ip
  return typeof ip === "string" && ip.trim() ? ip.trim() : null
}

function resolveUserAgent(req: MedusaRequest): string {
  return requestHeader(req, "user-agent") ?? ""
}

async function consentStatus(db: Db, tokenJti: string): Promise<ConsentStatus | null> {
  const result = await db.raw(
    `SELECT status
       FROM voucher_consent
      WHERE token_jti = $1
      LIMIT 1`,
    [tokenJti]
  )
  const status = rowsFromResult(result)[0]?.status
  return typeof status === "string" ? (status as ConsentStatus) : null
}

async function countRecentBuyerInitiations(
  db: Db,
  recipientId: string,
  tokenJti: string
): Promise<number> {
  const result = await db.raw(
    `SELECT COUNT(*)::int AS attempts
       FROM voucher_consent
      WHERE recipient_id = $1
        AND token_jti <> $2
        AND created_at >= now() - interval '1 hour'`,
    [recipientId, tokenJti]
  )
  const attempts = rowsFromResult(result)[0]?.attempts
  return typeof attempts === "number" ? attempts : Number(attempts ?? 0)
}

async function verifyCaptchaToken(token: string | null, req: MedusaRequest): Promise<boolean> {
  if (!token) return false
  const secret = process.env.HCAPTCHA_SECRET
  if (!secret) {
    return process.env.NODE_ENV !== "production" && token.length >= 8
  }

  const params = new URLSearchParams()
  params.set("secret", secret)
  params.set("response", token)
  const ip = resolveIpAddress(req)
  if (ip) params.set("remoteip", ip)

  try {
    const response = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
    const result = (await response.json()) as { success?: unknown }
    return result.success === true
  } catch {
    return false
  }
}

async function persistConsent(args: {
  db: Db
  token_jti: string
  recipient_id: string
  payload: ConsentPayload
  status: ConsentStatus
  ip_address: string | null
  user_agent: string
  payload_hash: string
}): Promise<void> {
  await args.db.raw(
    `INSERT INTO voucher_consent (
        token_jti,
        recipient_id,
        consent_rodo,
        consent_service_execution,
        consent_marketing,
        guardian_email,
        guardian_is_parent,
        status,
        ip_address,
        user_agent,
        payload_hash,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10, $11, now(), now())
      ON CONFLICT (token_jti) DO UPDATE SET
        consent_rodo = EXCLUDED.consent_rodo,
        consent_service_execution = EXCLUDED.consent_service_execution,
        consent_marketing = EXCLUDED.consent_marketing,
        guardian_email = EXCLUDED.guardian_email,
        guardian_is_parent = EXCLUDED.guardian_is_parent,
        status = EXCLUDED.status,
        ip_address = EXCLUDED.ip_address,
        user_agent = EXCLUDED.user_agent,
        payload_hash = EXCLUDED.payload_hash,
        updated_at = now()`,
    [
      args.token_jti,
      args.recipient_id,
      args.payload.consent_rodo,
      args.payload.consent_service_execution,
      args.payload.consent_marketing,
      args.payload.guardian_email,
      args.payload.guardian_is_parent,
      args.status,
      args.ip_address,
      args.user_agent,
      args.payload_hash,
    ]
  )
}

function requireMarketContext(res: MedusaResponse): boolean {
  const context = marketContextStorage.getStore()
  if (context?.market_id) return true
  res.status(403).json({
    code: "MARKET_CONTEXT_REQUIRED",
    message: "Market context required",
  })
  return false
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  setSecurityHeaders(res)
  if (!requireMarketContext(res)) return

  const token = tokenFromRequest(req)
  const verification = await verifyPurchaseToken(token)
  if (!verification.ok) {
    jsonError(res, 401, verification.error)
    return
  }

  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({ error: "SERVICE_UNAVAILABLE" })
    return
  }

  const minorPath = ageCheckRequired(verification.subject)
  const currentStatus = await consentStatus(db, verification.token_jti)
  const blocked = minorPath && currentStatus !== "approved_by_guardian"

  res.status(200).json({
    state: blocked ? "blocked" : "ready",
    age_check_required: minorPath,
    consent_status: currentStatus ?? "pending",
    error: blocked ? "GUARDIAN_APPROVAL_REQUIRED" : null,
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  setSecurityHeaders(res)
  if (!requireMarketContext(res)) return

  const token = tokenFromRequest(req)
  const verification = await verifyPurchaseToken(token)
  if (!verification.ok) {
    jsonError(res, 401, verification.error)
    return
  }

  const minorPath = ageCheckRequired(verification.subject)
  const validation = validatePayload(req.body, minorPath)
  if ("error" in validation) {
    jsonError(
      res,
      400,
      validation.error,
      validation.field ? { field: validation.field } : {}
    )
    return
  }

  if (minorPath && !(await verifyCaptchaToken(validation.captcha_token, req))) {
    jsonError(res, 400, "CAPTCHA_REQUIRED")
    return
  }

  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({ error: "SERVICE_UNAVAILABLE" })
    return
  }

  const recipientId = buyerAccountId(verification.subject, verification.token_jti)
  const attempts = await countRecentBuyerInitiations(db, recipientId, verification.token_jti)
  if (attempts >= RATE_LIMIT_MAX_PER_HOUR) {
    res.setHeader("Retry-After", RETRY_AFTER_SECONDS)
    jsonError(res, 429, "RATE_LIMITED")
    return
  }

  const status: ConsentStatus = minorPath ? "approved_by_guardian" : "approved"
  await persistConsent({
    db,
    token_jti: verification.token_jti,
    recipient_id: recipientId,
    payload: validation,
    status,
    ip_address: resolveIpAddress(req),
    user_agent: resolveUserAgent(req),
    payload_hash: stablePayloadHash(validation),
  })

  res.status(201).json({
    status,
    redirect_url: "/voucher",
  })
}
