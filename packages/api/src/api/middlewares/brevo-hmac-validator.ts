import * as crypto from "node:crypto"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { AuditEnvelope } from "@gp/messaging"

export const BREVO_PROVIDER_ROUTE_PREFIX = "/hooks/notifications/brevo"
export const BREVO_PROVIDER_ROUTE_MATCHER = `${BREVO_PROVIDER_ROUTE_PREFIX}*`
export const BREVO_HMAC_SIGNATURE_HEADER = "x-mailin-custom-signature"
export const BREVO_HMAC_SECRET_ENV = "BREVO_HMAC_SECRET"
export const brevoHmacCrypto = {
  timingSafeEqual: crypto.timingSafeEqual,
}

const RATE_LIMIT_WINDOW_MS = 1_000
const RATE_LIMIT_CAPACITY = 10
const CIRCUIT_FAILURE_WINDOW_MS = 60_000
const CIRCUIT_FAILURE_THRESHOLD = 5
const CIRCUIT_OPEN_MS = 5 * 60_000
const UNKNOWN_FIELD_SENTINEL = "unknown"
const NOT_APPLICABLE_SENTINEL = "__not_applicable__"

export type BrevoWebhookRejectCode =
  | "BREVO_HMAC_HEADER_MISSING"
  | "BREVO_HMAC_SIGNATURE_MISMATCH"
  | "BREVO_HMAC_SECRET_UNSET"
  | "BREVO_HMAC_BODY_UNPARSEABLE"
  | "BREVO_HMAC_RATE_LIMIT_EXCEEDED"
  | "BREVO_HMAC_CIRCUIT_OPEN"

type LoggerLike = {
  info?: (message: string, metadata?: Record<string, unknown>) => void
  warn?: (message: string, metadata?: Record<string, unknown>) => void
  error?: (message: string, metadata?: Record<string, unknown>) => void
}

type AuditSink = {
  record?: (auditEvent: AuditEnvelope) => Promise<void> | void
  write?: (auditEvent: AuditEnvelope) => Promise<void> | void
  append?: (auditEvent: AuditEnvelope) => Promise<void> | void
}

type BrevoWebhookRequest = MedusaRequest & {
  rawBody?: Buffer | string
  body?: unknown
  ip?: string
  originalUrl?: string
  path?: string
  url?: string
  socket?: { remoteAddress?: string }
  connection?: { remoteAddress?: string }
  get?: (headerName: string) => string | string[] | undefined
}

type RateLimitWindow = {
  windowStartMs: number
  count: number
}

type CircuitPhase = "closed" | "open" | "half-open"

type CircuitState = {
  phase: CircuitPhase
  failuresAtMs: number[]
  openedUntilMs: number
  halfOpenProbeInFlight: boolean
}

let clock = () => Date.now()
const rateLimitWindows = new Map<string, RateLimitWindow>()
const circuitStates = new Map<string, CircuitState>()

export function __setBrevoWebhookSecurityClockForTests(nextClock: () => number): void {
  clock = nextClock
}

export function __resetBrevoWebhookSecurityForTests(): void {
  rateLimitWindows.clear()
  circuitStates.clear()
}

export async function brevoWebhookRateLimitMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const sourceIp = resolveSourceIp(req)
  const now = clock()
  const existing = rateLimitWindows.get(sourceIp)
  const current =
    existing && now - existing.windowStartMs < RATE_LIMIT_WINDOW_MS
      ? existing
      : { windowStartMs: now, count: 0 }

  if (current.count >= RATE_LIMIT_CAPACITY) {
    res.setHeader("Retry-After", "1")
    await rejectBrevoWebhook(req, res, 429, "BREVO_HMAC_RATE_LIMIT_EXCEEDED")
    return
  }

  current.count += 1
  rateLimitWindows.set(sourceIp, current)
  pruneRateLimitWindows(now)
  next()
}

export async function brevoWebhookCircuitBreakerMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const sourceIp = resolveSourceIp(req)
  const state = getCircuitState(sourceIp)
  const now = clock()

  if (state.phase === "open") {
    if (now < state.openedUntilMs) {
      const retryAfterSec = Math.max(1, Math.ceil((state.openedUntilMs - now) / 1_000))
      res.setHeader("Retry-After", String(retryAfterSec))
      await rejectBrevoWebhook(req, res, 503, "BREVO_HMAC_CIRCUIT_OPEN")
      return
    }

    state.phase = "half-open"
    state.halfOpenProbeInFlight = false
  }

  if (state.phase === "half-open") {
    if (state.halfOpenProbeInFlight) {
      res.setHeader("Retry-After", "1")
      await rejectBrevoWebhook(req, res, 503, "BREVO_HMAC_CIRCUIT_OPEN")
      return
    }
    state.halfOpenProbeInFlight = true
  }

  let recorded = false
  res.once("finish", () => {
    if (recorded) {
      return
    }
    recorded = true
    recordCircuitOutcome(sourceIp, Number(res.statusCode ?? 0))
  })

  next()
}

export async function brevoHmacValidatorMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const secret = process.env[BREVO_HMAC_SECRET_ENV]
  if (!secret) {
    await rejectBrevoWebhook(req, res, 503, "BREVO_HMAC_SECRET_UNSET")
    return
  }

  const signature = readHeader(req, BREVO_HMAC_SIGNATURE_HEADER)
  if (!signature) {
    await rejectBrevoWebhook(req, res, 401, "BREVO_HMAC_HEADER_MISSING")
    return
  }

  const rawBody = resolveRawBody(req)
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")

  if (!timingSafeHexEqual(expectedSignature, signature)) {
    await rejectBrevoWebhook(req, res, 401, "BREVO_HMAC_SIGNATURE_MISMATCH", {
      signature,
    })
    return
  }

  try {
    ;(req as BrevoWebhookRequest).body = JSON.parse(rawBody.toString("utf8"))
  } catch {
    await rejectBrevoWebhook(req, res, 400, "BREVO_HMAC_BODY_UNPARSEABLE", {
      signature,
    })
    return
  }

  next()
}

async function rejectBrevoWebhook(
  req: MedusaRequest,
  res: MedusaResponse,
  statusCode: number,
  errorCode: BrevoWebhookRejectCode,
  options: { signature?: string } = {},
): Promise<void> {
  const requestId = crypto.randomUUID()
  const auditEvent = buildRejectAuditEnvelope(req, {
    requestId,
    errorCode,
    signature: options.signature,
  })

  await emitAuditEvent(req, auditEvent)

  res.status(statusCode).json({
    message: "Brevo webhook rejected",
    error_code: errorCode,
    request_id: requestId,
  })
}

function buildRejectAuditEnvelope(
  req: MedusaRequest,
  input: {
    requestId: string
    errorCode: BrevoWebhookRejectCode
    signature?: string
  },
): AuditEnvelope {
  const bodyByteLength = resolveRawBody(req).byteLength
  const sourceIp = resolveSourceIp(req)

  return {
    audit_id: input.requestId,
    event_type: "notification.delivery",
    status: "failed",
    dispatch_id: input.requestId,
    provider: "brevo",
    correlation_id: input.requestId,
    correlation_state: "rejected_pre_dispatch",
    outcome: "rejected",
    flow_id: UNKNOWN_FIELD_SENTINEL,
    template_key: UNKNOWN_FIELD_SENTINEL,
    channel: "email",
    market_id: UNKNOWN_FIELD_SENTINEL,
    locale: "pl-PL",
    consent_basis: "transactional_supportive",
    idempotency_key: input.requestId,
    hashed_recipient: NOT_APPLICABLE_SENTINEL,
    occurred_at: new Date(clock()).toISOString(),
    error_code: input.errorCode,
    request_id: input.requestId,
    body_byte_length: bodyByteLength,
    signature_hash: input.signature ? hashValue(input.signature) : undefined,
    source_ip_hash: sourceIp === UNKNOWN_FIELD_SENTINEL ? undefined : hashValue(sourceIp),
  }
}

async function emitAuditEvent(
  req: MedusaRequest,
  auditEvent: AuditEnvelope,
): Promise<void> {
  const request = req as BrevoWebhookRequest
  const sink = resolveOptional<AuditSink | ((auditEvent: AuditEnvelope) => Promise<void> | void)>(
    request,
    [
      "notification_delivery_audit_sink",
      "notificationDeliveryAuditSink",
      "audit_sink",
      "auditSink",
    ],
  )

  if (typeof sink === "function") {
    await sink(auditEvent)
    return
  }
  if (sink?.record) {
    await sink.record(auditEvent)
    return
  }
  if (sink?.write) {
    await sink.write(auditEvent)
    return
  }
  if (sink?.append) {
    await sink.append(auditEvent)
    return
  }

  resolveLogger(request)?.warn?.("[brevo-hmac-validator] audit sink unavailable", {
    request_id: auditEvent.request_id,
    error_code: auditEvent.error_code,
  })
}

function timingSafeHexEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex")
  const normalizedActual = actualHex.trim()

  if (!/^[a-f0-9]{64}$/i.test(normalizedActual)) {
    brevoHmacCrypto.timingSafeEqual(expected, expected)
    return false
  }

  const actual = Buffer.from(normalizedActual, "hex")
  if (actual.length !== expected.length) {
    brevoHmacCrypto.timingSafeEqual(expected, expected)
    return false
  }

  return brevoHmacCrypto.timingSafeEqual(expected, actual)
}

function readHeader(req: MedusaRequest, headerName: string): string | undefined {
  const request = req as BrevoWebhookRequest
  const fromGetter = request.get?.(headerName)
  const getterValue = firstHeaderValue(fromGetter)
  if (getterValue) {
    return getterValue
  }

  const lowerHeaderName = headerName.toLowerCase()
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (key.toLowerCase() !== lowerHeaderName) {
      continue
    }
    return firstHeaderValue(value)
  }

  return undefined
}

function firstHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined
  }
  return typeof value === "string" && value.trim() ? value : undefined
}

function resolveRawBody(req: MedusaRequest): Buffer {
  const request = req as BrevoWebhookRequest
  if (Buffer.isBuffer(request.rawBody)) {
    return request.rawBody
  }
  if (typeof request.rawBody === "string") {
    return Buffer.from(request.rawBody)
  }
  if (Buffer.isBuffer(request.body)) {
    return request.body
  }
  if (typeof request.body === "string") {
    return Buffer.from(request.body)
  }
  if (request.body && typeof request.body === "object") {
    return Buffer.from(JSON.stringify(request.body))
  }
  return Buffer.alloc(0)
}

function resolveSourceIp(req: MedusaRequest): string {
  const request = req as BrevoWebhookRequest
  const trustedRequestIp =
    request.ip ??
    request.socket?.remoteAddress ??
    request.connection?.remoteAddress
  if (trustedRequestIp?.trim()) {
    return trustedRequestIp.trim()
  }

  const forwarded = readHeader(req, "x-forwarded-for")
  if (forwarded) {
    const firstForwardedIp = forwarded.split(",")[0]?.trim()
    if (firstForwardedIp) {
      return firstForwardedIp
    }
  }

  return UNKNOWN_FIELD_SENTINEL
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function getCircuitState(sourceIp: string): CircuitState {
  const existing = circuitStates.get(sourceIp)
  if (existing) {
    return existing
  }

  const state: CircuitState = {
    phase: "closed",
    failuresAtMs: [],
    openedUntilMs: 0,
    halfOpenProbeInFlight: false,
  }
  circuitStates.set(sourceIp, state)
  return state
}

function recordCircuitOutcome(sourceIp: string, statusCode: number): void {
  const state = getCircuitState(sourceIp)
  const failure = statusCode === 401 || statusCode >= 500
  const now = clock()

  if (state.phase === "half-open") {
    state.halfOpenProbeInFlight = false
    if (failure) {
      openCircuit(state, now)
      return
    }
    state.phase = "closed"
    state.failuresAtMs = []
    state.openedUntilMs = 0
    return
  }

  state.failuresAtMs = state.failuresAtMs.filter(
    (failureAtMs) => now - failureAtMs <= CIRCUIT_FAILURE_WINDOW_MS,
  )

  if (!failure) {
    return
  }

  state.failuresAtMs.push(now)
  if (state.failuresAtMs.length >= CIRCUIT_FAILURE_THRESHOLD) {
    openCircuit(state, now)
  }
}

function openCircuit(state: CircuitState, now: number): void {
  state.phase = "open"
  state.openedUntilMs = now + CIRCUIT_OPEN_MS
  state.halfOpenProbeInFlight = false
}

function pruneRateLimitWindows(now: number): void {
  if (rateLimitWindows.size < 1_000) {
    return
  }

  for (const [key, value] of rateLimitWindows) {
    if (now - value.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      rateLimitWindows.delete(key)
    }
  }
}

function resolveLogger(req: BrevoWebhookRequest): LoggerLike | undefined {
  const logger = resolveOptional<LoggerLike>(req, [
    ContainerRegistrationKeys.LOGGER,
    "logger",
  ])
  return logger
}

function resolveOptional<T>(
  req: BrevoWebhookRequest,
  keys: readonly string[],
): T | undefined {
  if (!req.scope?.resolve) {
    return undefined
  }

  for (const key of keys) {
    try {
      return req.scope.resolve(key) as T
    } catch {
      continue
    }
  }

  return undefined
}
