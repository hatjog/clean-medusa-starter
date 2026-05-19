import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createHash } from "node:crypto"

import {
  verifyMagicLink,
  type MagicLinkSubject,
} from "../../../../lib/auth/magic-link"
import {
  marketContextStorage,
  type MarketContext,
} from "../../../../lib/market-context"

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

type AuthoritativeConsentContext = {
  age_check_required: boolean
  market_id: string | null
  sales_channel_id: string | null
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

function tokenInvalid(res: MedusaResponse, status = 404): void {
  jsonError(res, status, "TOKEN_INVALID")
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

function normalizedBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value.trim().toLowerCase() === "true"
  return false
}

function authoritativeRowToContext(
  row: Record<string, unknown> | undefined
): AuthoritativeConsentContext | null {
  if (!row) return null

  const market_id =
    typeof row.market_id === "string" && row.market_id.trim()
      ? row.market_id.trim()
      : null
  const sales_channel_id =
    typeof row.sales_channel_id === "string" && row.sales_channel_id.trim()
      ? row.sales_channel_id.trim()
      : null

  return {
    age_check_required: normalizedBoolean(row.requires_age_check),
    market_id,
    sales_channel_id,
  }
}

async function resolveEntitlementAuthorityById(
  db: Db,
  entitlementId: string
): Promise<AuthoritativeConsentContext | null> {
  const result = await db.raw(
    `SELECT
        NULLIF(ei.market_id, '') AS market_id,
        NULL::text AS sales_channel_id,
        (
          LOWER(
            COALESCE(
              ei.policy_snapshot #>> '{voucher_template,requires_age_check}',
              ei.policy_snapshot #>> '{recipient_rules,requires_age_check}',
              ei.policy_snapshot->>'requires_age_check',
              'false'
            )
          ) = 'true'
        ) AS requires_age_check
       FROM entitlement_instance ei
      WHERE ei.id = $1
      LIMIT 1`,
    [entitlementId]
  )

  return authoritativeRowToContext(rowsFromResult(result)[0])
}

async function resolveEntitlementAuthorityByOrderId(
  db: Db,
  orderId: string
): Promise<AuthoritativeConsentContext | null> {
  const result = await db.raw(
    `SELECT
        CASE
          WHEN COUNT(*) = 0 THEN NULL
          WHEN COUNT(DISTINCT NULLIF(ei.market_id, '')) = 1 THEN MIN(NULLIF(ei.market_id, ''))
          ELSE NULL
        END AS market_id,
        NULL::text AS sales_channel_id,
        COALESCE(
          BOOL_OR(
            LOWER(
              COALESCE(
                ei.policy_snapshot #>> '{voucher_template,requires_age_check}',
                ei.policy_snapshot #>> '{recipient_rules,requires_age_check}',
                ei.policy_snapshot->>'requires_age_check',
                'false'
              )
            ) = 'true'
          ),
          false
        ) AS requires_age_check
       FROM entitlement_instance ei
      WHERE ei.order_id = $1`,
    [orderId]
  )

  const row = rowsFromResult(result)[0]
  if (!row || row.market_id === undefined) {
    return null
  }

  const context = authoritativeRowToContext(row)
  if (!context?.market_id) {
    return null
  }

  return context
}

async function resolveOrderIdByVoucherCode(
  db: Db,
  voucherCode: string
): Promise<{ order_id: string | null; market_id: string | null; sales_channel_id: string | null } | null> {
  const result = await db.raw(
    `SELECT
        ge.order_id,
        gm.slug AS market_id,
        gm.sales_channel_id
       FROM gp_core.entitlements ge
       JOIN gp_core.markets gm
         ON gm.id = ge.market_id
      WHERE ge.voucher_code_normalized = LOWER($1)
      LIMIT 1`,
    [voucherCode]
  )

  const row = rowsFromResult(result)[0]
  if (!row) return null

  return {
    order_id:
      typeof row.order_id === "string" && row.order_id.trim() ? row.order_id.trim() : null,
    market_id:
      typeof row.market_id === "string" && row.market_id.trim()
        ? row.market_id.trim()
        : null,
    sales_channel_id:
      typeof row.sales_channel_id === "string" && row.sales_channel_id.trim()
        ? row.sales_channel_id.trim()
        : null,
  }
}

async function resolveAuthoritativeConsentContext(
  db: Db,
  subject: MagicLinkSubject
): Promise<AuthoritativeConsentContext | null> {
  const entitlementId = getStringSubject(subject, "entitlement_id")
  if (entitlementId) {
    const byEntitlement = await resolveEntitlementAuthorityById(db, entitlementId)
    if (byEntitlement) {
      return byEntitlement
    }
  }

  const orderId = getStringSubject(subject, "order_id")
  if (orderId) {
    const byOrder = await resolveEntitlementAuthorityByOrderId(db, orderId)
    if (byOrder) {
      return byOrder
    }
  }

  const voucherCode = getStringSubject(subject, "voucher_code")
  if (voucherCode) {
    const voucherLookup = await resolveOrderIdByVoucherCode(db, voucherCode)
    if (voucherLookup?.order_id) {
      const byVoucherOrder = await resolveEntitlementAuthorityByOrderId(
        db,
        voucherLookup.order_id
      )
      if (byVoucherOrder) {
        return {
          ...byVoucherOrder,
          market_id: byVoucherOrder.market_id ?? voucherLookup.market_id,
          sales_channel_id:
            byVoucherOrder.sales_channel_id ?? voucherLookup.sales_channel_id,
        }
      }
    }
  }

  return null
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

async function consentStatus(
  db: Db,
  tokenJti: string,
  marketId: string
): Promise<ConsentStatus | null> {
  const result = await db.raw(
    `SELECT status
       FROM voucher_consent
      WHERE token_jti = $1
        AND market_id = $2
      LIMIT 1`,
    [tokenJti, marketId]
  )
  const status = rowsFromResult(result)[0]?.status
  return typeof status === "string" ? (status as ConsentStatus) : null
}

async function recordConsentAttempt(args: {
  db: Db,
  recipientId: string,
  tokenJti: string,
  market_id: string,
  sales_channel_id: string,
  ip_address: string | null,
  user_agent: string,
}): Promise<void> {
  await args.db.raw(
    `INSERT INTO voucher_consent_attempt (
        token_jti,
        recipient_id,
        market_id,
        sales_channel_id,
        ip_address,
        user_agent,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::inet, $6, now())`,
    [
      args.tokenJti,
      args.recipientId,
      args.market_id,
      args.sales_channel_id,
      args.ip_address,
      args.user_agent,
    ]
  )
}

async function countRecentBuyerInitiations(
  db: Db,
  recipientId: string,
  marketId: string
): Promise<number> {
  const result = await db.raw(
    `SELECT COUNT(*)::int AS attempts
       FROM voucher_consent_attempt
      WHERE recipient_id = $1
        AND market_id = $2
        AND created_at >= now() - interval '1 hour'`,
    [recipientId, marketId]
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
  market_id: string
  sales_channel_id: string
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
        market_id,
        sales_channel_id,
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::inet, $12, $13, now(), now())
      ON CONFLICT (market_id, token_jti) DO UPDATE SET
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
      args.market_id,
      args.sales_channel_id,
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

function requireMarketContext(res: MedusaResponse): MarketContext | null {
  const context = marketContextStorage.getStore()
  if (context?.market_id && context.sales_channel_id) return context
  res.status(403).json({
    code: "MARKET_CONTEXT_REQUIRED",
    message: "Market context required",
  })
  return null
}

function subjectMatchesMarketContext(
  subject: MagicLinkSubject,
  context: MarketContext
): boolean {
  const subjectMarketId = getStringSubject(subject, "market_id")
  if (subjectMarketId && subjectMarketId !== context.market_id) {
    return false
  }

  const subjectSalesChannelId = getStringSubject(subject, "sales_channel_id")
  if (subjectSalesChannelId && subjectSalesChannelId !== context.sales_channel_id) {
    return false
  }

  return true
}

function authorityMatchesMarketContext(
  authority: AuthoritativeConsentContext,
  context: MarketContext
): boolean {
  if (authority.market_id && authority.market_id !== context.market_id) {
    return false
  }

  if (
    authority.sales_channel_id &&
    authority.sales_channel_id !== context.sales_channel_id
  ) {
    return false
  }

  return true
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  setSecurityHeaders(res)
  const marketContext = requireMarketContext(res)
  if (!marketContext) return

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

  if (!subjectMatchesMarketContext(verification.subject, marketContext)) {
    tokenInvalid(res)
    return
  }

  const authority = await resolveAuthoritativeConsentContext(db, verification.subject)
  if (!authority || !authorityMatchesMarketContext(authority, marketContext)) {
    tokenInvalid(res)
    return
  }

  const minorPath =
    authority.age_check_required || ageCheckRequired(verification.subject)
  const currentStatus = await consentStatus(
    db,
    verification.token_jti,
    marketContext.market_id
  )
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
  const marketContext = requireMarketContext(res)
  if (!marketContext) return

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

  if (!subjectMatchesMarketContext(verification.subject, marketContext)) {
    tokenInvalid(res)
    return
  }

  const authority = await resolveAuthoritativeConsentContext(db, verification.subject)
  if (!authority || !authorityMatchesMarketContext(authority, marketContext)) {
    tokenInvalid(res)
    return
  }

  const minorPath =
    authority.age_check_required || ageCheckRequired(verification.subject)
  const recipientId = buyerAccountId(verification.subject, verification.token_jti)

  await recordConsentAttempt({
    db,
    recipientId,
    tokenJti: verification.token_jti,
    market_id: marketContext.market_id,
    sales_channel_id: marketContext.sales_channel_id,
    ip_address: resolveIpAddress(req),
    user_agent: resolveUserAgent(req),
  })

  const attempts = await countRecentBuyerInitiations(
    db,
    recipientId,
    marketContext.market_id
  )
  if (attempts > RATE_LIMIT_MAX_PER_HOUR) {
    res.setHeader("Retry-After", RETRY_AFTER_SECONDS)
    jsonError(res, 429, "RATE_LIMITED")
    return
  }

  const currentStatus = await consentStatus(
    db,
    verification.token_jti,
    marketContext.market_id
  )
  if (currentStatus === "approved" || currentStatus === "approved_by_guardian") {
    res.status(200).json({
      status: currentStatus,
      redirect_url: "/voucher",
    })
    return
  }

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

  const status: ConsentStatus = minorPath ? "approved_by_guardian" : "approved"
  await persistConsent({
    db,
    token_jti: verification.token_jti,
    recipient_id: recipientId,
    market_id: marketContext.market_id,
    sales_channel_id: marketContext.sales_channel_id,
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
