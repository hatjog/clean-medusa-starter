import * as crypto from "node:crypto"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { AuditProvider } from "@gp/audit"
import type { NotificationAuditEnvelope } from "@gp/messaging"

export const BREVO_PROVIDER_ROUTE_PREFIX = "/hooks/notifications/brevo"
export const BREVO_PROVIDER_ROUTE_MATCHER = `${BREVO_PROVIDER_ROUTE_PREFIX}*`
export const BREVO_HMAC_SIGNATURE_HEADER = "x-mailin-custom-signature"
export const BREVO_HMAC_SECRET_ENV = "BREVO_HMAC_SECRET"
export const brevoHmacCrypto = {
  timingSafeEqual: crypto.timingSafeEqual,
}

const RATE_LIMIT_WINDOW_MS = 1_000
const RATE_LIMIT_CAPACITY = 10
const GLOBAL_RATE_LIMIT_CAPACITY = 100
const GLOBAL_RATE_LIMIT_KEY = "__global__"
const CIRCUIT_FAILURE_WINDOW_MS = 60_000
const CIRCUIT_FAILURE_THRESHOLD = 5
const CIRCUIT_OPEN_MS = 5 * 60_000
const CIRCUIT_STATE_TTL_MS = CIRCUIT_FAILURE_WINDOW_MS * 2
const PRUNE_MAX_ENTRIES = 100
const UNKNOWN_FIELD_SENTINEL = "unknown"
const NO_RECIPIENT_SENTINEL = "__no_recipient__"
const PRE_DISPATCH_SENTINEL = "__pre_dispatch__"
const UNKNOWN_LOCALE_SENTINEL = "__unknown__"
const CIRCUIT_SKIP_FLAG = "brevo_circuit_skip"

export type BrevoWebhookRejectCode =
  | "BREVO_HMAC_HEADER_MISSING"
  | "BREVO_HMAC_SIGNATURE_MISMATCH"
  | "BREVO_HMAC_SECRET_UNSET"
  | "BREVO_HMAC_BODY_UNPARSEABLE"
  | "BREVO_HMAC_RATE_LIMIT_EXCEEDED"
  | "BREVO_HMAC_CIRCUIT_OPEN"
  | "BREVO_HMAC_RAW_BODY_UNAVAILABLE"

type LoggerLike = {
  info?: (message: string, metadata?: Record<string, unknown>) => void
  warn?: (message: string, metadata?: Record<string, unknown>) => void
  error?: (message: string, metadata?: Record<string, unknown>) => void
}

type AuditSink = {
  record?: (auditEvent: NotificationAuditEnvelope) => Promise<void> | void
  write?: (auditEvent: NotificationAuditEnvelope) => Promise<void> | void
  append?: (auditEvent: NotificationAuditEnvelope) => Promise<void> | void
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

function assertTestEnvironment(name: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `[brevo-hmac-validator] ${name} is test-only; refusing to run outside NODE_ENV=test`,
    )
  }
}

export function __setBrevoWebhookSecurityClockForTests(nextClock: () => number): void {
  assertTestEnvironment("__setBrevoWebhookSecurityClockForTests")
  clock = nextClock
}

export function __resetBrevoWebhookSecurityForTests(): void {
  assertTestEnvironment("__resetBrevoWebhookSecurityForTests")
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

  // Global safety-net bucket: keyed independently from per-IP bucket so that a
  // single client cannot exhaust it on its own (per-IP capacity caps that),
  // and conversely a misconfigured `trust proxy` (collapsing all clients into
  // one bucket) does not silently uplift effective capacity beyond the global
  // cap. See F-05 rationale and runbook note in middlewares.ts.
  const globalWindow = takeWindow(GLOBAL_RATE_LIMIT_KEY, now)
  if (globalWindow.count >= GLOBAL_RATE_LIMIT_CAPACITY) {
    res.setHeader("Retry-After", "1")
    await rejectBrevoWebhook(req, res, 429, "BREVO_HMAC_RATE_LIMIT_EXCEEDED")
    return
  }

  const current = takeWindow(sourceIp, now)
  if (current.count >= RATE_LIMIT_CAPACITY) {
    res.setHeader("Retry-After", "1")
    await rejectBrevoWebhook(req, res, 429, "BREVO_HMAC_RATE_LIMIT_EXCEEDED")
    return
  }

  current.count += 1
  rateLimitWindows.set(sourceIp, current)
  globalWindow.count += 1
  rateLimitWindows.set(GLOBAL_RATE_LIMIT_KEY, globalWindow)
  pruneRateLimitWindows(now)
  next()
}

function takeWindow(key: string, now: number): RateLimitWindow {
  const existing = rateLimitWindows.get(key)
  if (existing && now - existing.windowStartMs < RATE_LIMIT_WINDOW_MS) {
    return existing
  }
  return { windowStartMs: now, count: 0 }
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
    const skip = Boolean(
      (res as unknown as { locals?: Record<string, unknown> }).locals?.[CIRCUIT_SKIP_FLAG],
    )
    if (skip) {
      return
    }
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
    // Misconfiguration is operator-driven, not adversarial — do NOT count
    // toward circuit-breaker failures (F-03). Otherwise a brief secret
    // rotation outage would auto-lockout the legitimate Brevo IP pool
    // for `CIRCUIT_OPEN_MS` after the secret comes back.
    markCircuitSkip(res)
    await rejectBrevoWebhook(req, res, 503, "BREVO_HMAC_SECRET_UNSET")
    return
  }

  const signature = readHeader(req, BREVO_HMAC_SIGNATURE_HEADER)
  if (!signature) {
    await rejectBrevoWebhook(req, res, 401, "BREVO_HMAC_HEADER_MISSING")
    return
  }

  const rawBody = resolveRawBody(req)
  if (rawBody === undefined) {
    // Fail-closed when the framework did not preserve the raw payload — a
    // hallucinated `JSON.stringify(req.body)` is not byte-identical to the
    // Brevo wire payload and would either reject all legitimate webhooks or
    // mask a critical config break behind a synthetic buffer (F-04).
    markCircuitSkip(res)
    await rejectBrevoWebhook(req, res, 503, "BREVO_HMAC_RAW_BODY_UNAVAILABLE")
    return
  }

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

  resolveLogger(req as BrevoWebhookRequest)?.info?.(
    "[brevo-hmac-validator] accepted",
    { body_byte_length: rawBody.byteLength },
  )

  next()
}

function markCircuitSkip(res: MedusaResponse): void {
  const target = res as unknown as { locals?: Record<string, unknown> }
  target.locals = target.locals ?? {}
  target.locals[CIRCUIT_SKIP_FLAG] = true
}

async function rejectBrevoWebhook(
  req: MedusaRequest,
  res: MedusaResponse,
  statusCode: number,
  errorCode: BrevoWebhookRejectCode,
  // The legacy `options.signature` argument is intentionally accepted but
  // ignored: F-10 dropped `signature_hash` from the reject envelope.
  _options: { signature?: string } = {},
): Promise<void> {
  const requestId = crypto.randomUUID()
  const auditEvent = buildRejectAuditEnvelope(req, {
    requestId,
    errorCode,
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
  },
): NotificationAuditEnvelope {
  const rawBody = resolveRawBody(req)
  const bodyByteLength = rawBody?.byteLength ?? 0
  const sourceIp = resolveSourceIp(req)
  const nowMs = clock()
  // Deterministic idempotency key (F-06): a burst of identical adversarial
  // requests must collapse into a single audit row at the sink. We bucket by
  // minute so repeat attempts within ~60s deduplicate while genuinely later
  // attempts still produce a new envelope.
  const minuteBucket = Math.floor(nowMs / 60_000)
  const idempotencyKey = hashValue(
    `brevo|reject|${sourceIp}|${input.errorCode}|${minuteBucket}`,
  )

  return {
    audit_id: input.requestId,
    event_type: "notification.delivery",
    status: "failed",
    // Pre-dispatch reject has no upstream dispatch by definition (F-06).
    dispatch_id: PRE_DISPATCH_SENTINEL,
    provider: AuditProvider.BREVO,
    // correlation_id is intentionally omitted: at reject time we have nothing
    // legitimate to correlate against (body is unparsed/untrusted).
    correlation_state: "rejected_pre_dispatch",
    outcome: "rejected",
    flow_id: UNKNOWN_FIELD_SENTINEL,
    template_key: UNKNOWN_FIELD_SENTINEL,
    channel: "email",
    market_id: UNKNOWN_FIELD_SENTINEL,
    // Locale is unknown pre-parse; use the documented sentinel rather than
    // hardcoding pl-PL which would mislead multi-market analytics (F-08).
    locale: UNKNOWN_LOCALE_SENTINEL,
    consent_basis: "transactional_supportive",
    idempotency_key: idempotencyKey,
    // No recipient is known pre-parse; align with the Story 5.5 Path Y
    // sentinel convention rather than an arbitrary "__not_applicable__"
    // string that fails hex-hash schema validation downstream (F-07).
    hashed_recipient: NO_RECIPIENT_SENTINEL,
    occurred_at: new Date(nowMs).toISOString(),
    error_code: input.errorCode,
    request_id: input.requestId,
    body_byte_length: bodyByteLength,
    // signature_hash dropped per F-10 (adds no forensic value over
    // source_ip_hash + error_code + request_id).
    source_ip_hash: sourceIp === UNKNOWN_FIELD_SENTINEL ? undefined : hashValue(sourceIp),
  }
}

async function emitAuditEvent(
  req: MedusaRequest,
  auditEvent: NotificationAuditEnvelope,
): Promise<void> {
  const request = req as BrevoWebhookRequest
  const sink = resolveOptional<AuditSink | ((auditEvent: NotificationAuditEnvelope) => Promise<void> | void)>(
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

function resolveRawBody(req: MedusaRequest): Buffer | undefined {
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
  // Intentionally no JSON.stringify(req.body) fallback (F-04): re-serialising
  // a parsed body is never byte-identical to the Brevo wire payload, so a
  // synthesised buffer would silently break HMAC verification or paper over
  // a missing `bodyParser.preserveRawBody` config. Callers must treat
  // `undefined` as a fail-closed signal.
  return undefined
}

// IMPORTANT (F-11): when the Medusa server runs behind a reverse proxy
// (typical K8s ingress), `req.ip` only reflects the originating client when
// Express's `trust proxy` is configured against a trusted hop count or
// allowlisted proxy CIDR. Without that, `req.ip` is either the proxy address
// (collapsing all clients into the global bucket — see GLOBAL_RATE_LIMIT_*)
// or, with naive `trust proxy: true`, the spoofable `X-Forwarded-For[0]`.
// Deployment runbooks MUST pin `trust proxy` to the ingress CIDR. See
// `specs/architecture/auth-routes.md` for the operational note.
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
  if (rateLimitWindows.size >= PRUNE_MAX_ENTRIES) {
    for (const [key, value] of rateLimitWindows) {
      if (now - value.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
        rateLimitWindows.delete(key)
      }
    }
  }
  pruneCircuitStates(now)
}

function pruneCircuitStates(now: number): void {
  // F-02: bound `circuitStates` so a slow trickle of unique source IPs
  // cannot grow the map without limit. We only evict entries that are
  // fully idle (closed phase, no recent failures, no open window) and at
  // least `CIRCUIT_STATE_TTL_MS` past their last observed activity.
  if (circuitStates.size < PRUNE_MAX_ENTRIES) {
    return
  }
  for (const [key, state] of circuitStates) {
    if (state.phase !== "closed") {
      continue
    }
    if (state.halfOpenProbeInFlight) {
      continue
    }
    const lastActivityMs = state.failuresAtMs.length
      ? Math.max(...state.failuresAtMs)
      : state.openedUntilMs
    if (now - lastActivityMs >= CIRCUIT_STATE_TTL_MS) {
      circuitStates.delete(key)
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
