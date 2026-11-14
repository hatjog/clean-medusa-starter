import { EventEmitter } from "node:events"
import * as crypto from "node:crypto"

import {
  __resetBrevoWebhookSecurityForTests,
  __setBrevoWebhookSecurityClockForTests,
  brevoHmacValidatorMiddleware,
  brevoHmacCrypto,
  brevoWebhookCircuitBreakerMiddleware,
  brevoWebhookRateLimitMiddleware,
} from "../../api/middlewares/brevo-hmac-validator"

const TEST_SECRET = "test-secret-do-not-use-in-prod"
const SIGNATURE_HEADER = "X-Mailin-Custom-Signature"

type AuditEvent = Record<string, unknown>
type FakeRequest = {
  headers: Record<string, string | string[]>
  ip?: string
  rawBody?: Buffer | string
  body?: unknown
  get?: jest.Mock<string | string[] | undefined, [string]>
  scope: {
    resolve: jest.Mock<unknown, [string]>
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  payload: unknown
  readonly headers = new Map<string, string>()

  status(code: number): this {
    this.statusCode = code
    return this
  }

  json(payload: unknown): this {
    this.payload = payload
    this.emit("finish")
    return this
  }

  setHeader(name: string, value: string | number): this {
    this.headers.set(name.toLowerCase(), String(value))
    return this
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase())
  }
}

function sign(rawBody: string, secret = TEST_SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex")
}

function makeRequest(options: {
  rawBody?: string
  signature?: string
  headerName?: string
  ip?: string | null
  auditEvents?: AuditEvent[]
}) {
  const auditEvents = options.auditEvents ?? []
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  const sink = {
    record: jest.fn(async (auditEvent: AuditEvent) => {
      auditEvents.push(auditEvent)
    }),
  }

  const headers: Record<string, string | string[]> = {}
  if (options.signature !== undefined) {
    headers[options.headerName ?? SIGNATURE_HEADER] = options.signature
  }

  const req: FakeRequest = {
    headers,
    ip: options.ip === null ? undefined : options.ip ?? "203.0.113.10",
    rawBody: Buffer.from(options.rawBody ?? JSON.stringify({ event: "delivered" })),
    scope: {
      resolve: jest.fn<unknown, [string]>((key: string) => {
        if (key === "notification_delivery_audit_sink") return sink
        if (key === "logger") return logger
        throw new Error(`Unknown container key: ${key}`)
      }),
    },
  }

  return {
    auditEvents,
    req,
    sink,
    logger,
  }
}

async function invokeFullChain(
  req: Record<string, unknown>,
  downstream?: (res: FakeResponse) => void,
): Promise<{ res: FakeResponse; nextCalled: boolean }> {
  const res = new FakeResponse()
  let nextCalled = false
  let rateAllowed = false
  let circuitAllowed = false

  await brevoWebhookRateLimitMiddleware(req as never, res as never, () => {
    rateAllowed = true
  })
  if (!rateAllowed) {
    return { res, nextCalled }
  }

  await brevoWebhookCircuitBreakerMiddleware(req as never, res as never, () => {
    circuitAllowed = true
  })
  if (!circuitAllowed) {
    return { res, nextCalled }
  }

  await brevoHmacValidatorMiddleware(req as never, res as never, () => {
    nextCalled = true
    downstream?.(res)
  })

  return { res, nextCalled }
}

describe("Brevo webhook HMAC middleware", () => {
  const originalSecret = process.env.BREVO_HMAC_SECRET
  let nowMs = 1_775_000_000_000

  beforeEach(() => {
    process.env.BREVO_HMAC_SECRET = TEST_SECRET
    nowMs = 1_775_000_000_000
    __setBrevoWebhookSecurityClockForTests(() => nowMs)
    __resetBrevoWebhookSecurityForTests()
  })

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.BREVO_HMAC_SECRET
    } else {
      process.env.BREVO_HMAC_SECRET = originalSecret
    }
    jest.restoreAllMocks()
  })

  it("valid HMAC signature and body calls next", async () => {
    const rawBody = JSON.stringify({ event: "delivered", email: "buyer@example.test" })
    const { req } = makeRequest({ rawBody, signature: sign(rawBody) })

    const { nextCalled, res } = await invokeFullChain(req)

    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(req.body).toEqual({ event: "delivered", email: "buyer@example.test" })
  })

  it("accepts case-insensitive header lookup through req.get and string rawBody", async () => {
    const rawBody = JSON.stringify({ event: "clicked" })
    const { req } = makeRequest({ rawBody, signature: sign(rawBody) })
    req.rawBody = rawBody
    req.headers = {}
    req.get = jest.fn((name: string) =>
      name.toLowerCase() === "x-mailin-custom-signature" ? sign(rawBody) : undefined,
    )

    const { nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(true)
    expect(req.get).toHaveBeenCalledWith("x-mailin-custom-signature")
  })

  it("missing X-Mailin-Custom-Signature returns 401 with rejected audit envelope", async () => {
    const { req, auditEvents } = makeRequest({})

    const { nextCalled, res } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(auditEvents[0]).toMatchObject({
      provider: "brevo",
      outcome: "rejected",
      correlation_state: "rejected_pre_dispatch",
      error_code: "BREVO_HMAC_HEADER_MISSING",
    })
    expect(auditEvents[0].body).toBeUndefined()
    expect(auditEvents[0].recipient_email).toBeUndefined()
  })

  it("signature mismatch returns 401 and uses constant-time comparison", async () => {
    const rawBody = JSON.stringify({ event: "bounced" })
    const timingSafeEqual = jest.spyOn(brevoHmacCrypto, "timingSafeEqual")
    const { req, auditEvents } = makeRequest({
      rawBody,
      signature: sign(rawBody, "wrong-secret"),
      headerName: "x-mailin-custom-signature",
    })

    const { nextCalled, res } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(timingSafeEqual).toHaveBeenCalled()
    // F-13: prove the real compare path executed by checking that at least
    // one invocation passed two *distinct* buffers (the decoy call passes
    // the expected buffer to itself; only the genuine real-compare branch
    // compares against the attacker-supplied signature).
    const realCompareCall = timingSafeEqual.mock.calls.find(
      ([a, b]) =>
        Buffer.isBuffer(a) &&
        Buffer.isBuffer(b) &&
        a.length === b.length &&
        !a.equals(b),
    )
    expect(realCompareCall).toBeDefined()
    expect(auditEvents[0]).toMatchObject({
      error_code: "BREVO_HMAC_SIGNATURE_MISMATCH",
      outcome: "rejected",
    })
    // F-10: signature_hash was removed from reject envelope.
    expect(auditEvents[0].signature_hash).toBeUndefined()
  })

  it("malformed hex signature returns 401 without raw payload leakage", async () => {
    const rawBody = JSON.stringify({ event: "opened", email: "buyer@example.test" })
    const { req, auditEvents } = makeRequest({
      rawBody,
      signature: "not-a-hex-signature",
    })

    const { res } = await invokeFullChain(req)

    expect(res.statusCode).toBe(401)
    expect(auditEvents[0]).toMatchObject({
      error_code: "BREVO_HMAC_SIGNATURE_MISMATCH",
      outcome: "rejected",
    })
    expect(JSON.stringify(auditEvents[0])).not.toContain("buyer@example.test")
  })

  it("unset BREVO_HMAC_SECRET fails closed with 503", async () => {
    delete process.env.BREVO_HMAC_SECRET
    const rawBody = JSON.stringify({ event: "delivered" })
    const { req, auditEvents } = makeRequest({ rawBody, signature: sign(rawBody) })

    const { nextCalled, res } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(503)
    expect(auditEvents[0]).toMatchObject({
      error_code: "BREVO_HMAC_SECRET_UNSET",
      outcome: "rejected",
    })
  })

  it("valid signature over unparseable body returns 400 after validation", async () => {
    const rawBody = "{not-json"
    const { req, auditEvents } = makeRequest({ rawBody, signature: sign(rawBody) })

    const { nextCalled, res } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(400)
    expect(auditEvents[0]).toMatchObject({
      error_code: "BREVO_HMAC_BODY_UNPARSEABLE",
      outcome: "rejected",
    })
  })

  it("rate-limits the 11th request within one second per source IP", async () => {
    const rawBody = JSON.stringify({ event: "opened" })
    const auditEvents: AuditEvent[] = []

    for (let i = 0; i < 10; i += 1) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody),
        auditEvents,
        ip: "198.51.100.5",
      })
      const result = await invokeFullChain(req, (res) => {
        res.status(204)
        res.emit("finish")
      })
      expect(result.nextCalled).toBe(true)
    }

    const { req } = makeRequest({
      rawBody,
      signature: sign(rawBody),
      auditEvents,
      ip: "198.51.100.5",
    })
    const { nextCalled, res } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(429)
    expect(res.getHeader("retry-after")).toBe("1")
    expect(auditEvents.at(-1)).toMatchObject({
      error_code: "BREVO_HMAC_RATE_LIMIT_EXCEEDED",
      outcome: "rejected",
    })
  })

  it("prefers req.ip over x-forwarded-for and falls back when request IP is missing", async () => {
    const rawBody = JSON.stringify({ event: "opened" })
    const auditEvents: AuditEvent[] = []

    for (let i = 0; i < 10; i += 1) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody),
        auditEvents,
        ip: `198.51.100.${i}`,
      })
      req.headers["x-forwarded-for"] = "198.51.100.77, 10.0.0.1"
      const result = await invokeFullChain(req, (res) => {
        res.status(204)
        res.emit("finish")
      })
      expect(result.nextCalled).toBe(true)
    }

    const { req } = makeRequest({
      rawBody,
      signature: sign(rawBody),
      auditEvents,
      ip: "198.51.100.200",
    })
    req.headers["x-forwarded-for"] = "198.51.100.77, 10.0.0.1"

    const spoofAttempt = await invokeFullChain(req, (res) => {
      res.status(204)
      res.emit("finish")
    })

    expect(spoofAttempt.nextCalled).toBe(true)
    expect(spoofAttempt.res.statusCode).toBe(204)

    __resetBrevoWebhookSecurityForTests()

    for (let i = 0; i < 10; i += 1) {
      const fallback = makeRequest({
        rawBody,
        signature: sign(rawBody),
        auditEvents,
        ip: null,
      })
      fallback.req.headers["x-forwarded-for"] = "198.51.100.77, 10.0.0.1"
      const result = await invokeFullChain(fallback.req, (res) => {
        res.status(204)
        res.emit("finish")
      })
      expect(result.nextCalled).toBe(true)
    }

    const fallbackLimited = makeRequest({
      rawBody,
      signature: sign(rawBody),
      auditEvents,
      ip: null,
    })
    fallbackLimited.req.headers["x-forwarded-for"] = "198.51.100.77, 10.0.0.1"
    const fallbackResult = await invokeFullChain(fallbackLimited.req)

    expect(fallbackResult.res.statusCode).toBe(429)
    expect(auditEvents.at(-1)?.source_ip_hash).toBe(
      crypto.createHash("sha256").update("198.51.100.77").digest("hex"),
    )
  })

  it("opens circuit after five HMAC failures and allows one half-open probe after five minutes", async () => {
    const rawBody = JSON.stringify({ event: "complaint" })
    const auditEvents: AuditEvent[] = []

    for (let i = 0; i < 5; i += 1) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody, "wrong-secret"),
        auditEvents,
        ip: "192.0.2.44",
      })
      const result = await invokeFullChain(req)
      expect(result.res.statusCode).toBe(401)
    }

    const openProbe = makeRequest({
      rawBody,
      signature: sign(rawBody),
      auditEvents,
      ip: "192.0.2.44",
    })
    const openResult = await invokeFullChain(openProbe.req)
    expect(openResult.nextCalled).toBe(false)
    expect(openResult.res.statusCode).toBe(503)
    expect(openResult.res.getHeader("retry-after")).toBe("300")
    expect(auditEvents.at(-1)).toMatchObject({
      error_code: "BREVO_HMAC_CIRCUIT_OPEN",
      outcome: "rejected",
    })

    nowMs += 5 * 60 * 1000

    const halfOpenProbe = makeRequest({
      rawBody,
      signature: sign(rawBody),
      auditEvents,
      ip: "192.0.2.44",
    })
    const halfOpenResult = await invokeFullChain(halfOpenProbe.req, (res) => {
      res.status(204)
      res.emit("finish")
    })

    expect(halfOpenResult.nextCalled).toBe(true)
    expect(halfOpenResult.res.statusCode).toBe(204)
  })

  it("re-opens the circuit when the half-open probe fails", async () => {
    const rawBody = JSON.stringify({ event: "complaint" })

    for (let i = 0; i < 5; i += 1) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody, "wrong-secret"),
        ip: "192.0.2.55",
      })
      await invokeFullChain(req)
    }

    nowMs += 5 * 60 * 1000

    const failedProbe = makeRequest({
      rawBody,
      signature: sign(rawBody, "wrong-secret"),
      ip: "192.0.2.55",
    })
    const failedProbeResult = await invokeFullChain(failedProbe.req)
    expect(failedProbeResult.res.statusCode).toBe(401)

    const openProbe = makeRequest({
      rawBody,
      signature: sign(rawBody),
      ip: "192.0.2.55",
    })
    const openResult = await invokeFullChain(openProbe.req)
    expect(openResult.res.statusCode).toBe(503)
  })

  it("blocks a second half-open probe while the first probe is in flight", async () => {
    const rawBody = JSON.stringify({ event: "complaint" })

    for (let i = 0; i < 5; i += 1) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody, "wrong-secret"),
        ip: "192.0.2.66",
      })
      await invokeFullChain(req)
    }

    nowMs += 5 * 60 * 1000

    const firstProbe = makeRequest({
      rawBody,
      signature: sign(rawBody),
      ip: "192.0.2.66",
    })
    const firstProbeResult = await invokeFullChain(firstProbe.req)
    expect(firstProbeResult.nextCalled).toBe(true)

    const secondProbe = makeRequest({
      rawBody,
      signature: sign(rawBody),
      ip: "192.0.2.66",
    })
    const secondProbeResult = await invokeFullChain(secondProbe.req)
    expect(secondProbeResult.res.statusCode).toBe(503)
    expect(secondProbeResult.res.getHeader("retry-after")).toBe("1")
  })

  it("supports alternate audit sink shapes and logger fallback", async () => {
    const rawBody = JSON.stringify({ event: "opened" })
    const functionSinkEvents: AuditEvent[] = []
    const writeSinkEvents: AuditEvent[] = []
    const appendSinkEvents: AuditEvent[] = []

    for (const sink of [
      async (auditEvent: AuditEvent) => {
        functionSinkEvents.push(auditEvent)
      },
      {
        write: jest.fn(async (auditEvent: AuditEvent) => {
          writeSinkEvents.push(auditEvent)
        }),
      },
      {
        append: jest.fn(async (auditEvent: AuditEvent) => {
          appendSinkEvents.push(auditEvent)
        }),
      },
    ]) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody, "wrong-secret"),
        ip: crypto.randomUUID(),
      })
      req.scope.resolve = jest.fn<unknown, [string]>((key: string) => {
        if (key === "notification_delivery_audit_sink") return sink
        throw new Error(`Unknown container key: ${key}`)
      })
      await invokeFullChain(req)
    }

    const logger = { warn: jest.fn(), error: jest.fn() }
    const { req } = makeRequest({
      rawBody,
      signature: sign(rawBody, "wrong-secret"),
      ip: crypto.randomUUID(),
    })
    req.scope.resolve = jest.fn<unknown, [string]>((key: string) => {
      if (key === "logger") return logger
      throw new Error(`Unknown container key: ${key}`)
    })
    await invokeFullChain(req)

    expect(functionSinkEvents).toHaveLength(1)
    expect(writeSinkEvents).toHaveLength(1)
    expect(appendSinkEvents).toHaveLength(1)
    // Story 6.6 AC3: niedostepny sink to JAWNY stan (error + nazwany kod), nie warning.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("error_code=BREVO_WEBHOOK_AUDIT_SINK_UNAVAILABLE"),
      expect.objectContaining({
        error_code: "BREVO_WEBHOOK_AUDIT_SINK_UNAVAILABLE",
        rejected_error_code: "BREVO_HMAC_SIGNATURE_MISMATCH",
      }),
    )
  })

  it("missing BREVO_HMAC_SECRET does NOT count toward circuit-breaker failures (F-03)", async () => {
    delete process.env.BREVO_HMAC_SECRET
    const rawBody = JSON.stringify({ event: "delivered" })
    const ip = "203.0.113.30"

    // Send exactly CIRCUIT_FAILURE_THRESHOLD (5) misconfigured requests; if 503
    // SECRET_UNSET counted as failure, the circuit would now be open.
    for (let i = 0; i < 5; i += 1) {
      const { req } = makeRequest({ rawBody, signature: sign(rawBody), ip })
      const { res } = await invokeFullChain(req)
      expect(res.statusCode).toBe(503)
    }

    // Advance past rate-limit window so the next request is not blocked by
    // the per-IP per-second cap; circuit state is what we are exercising here.
    nowMs += 2 * 1000

    process.env.BREVO_HMAC_SECRET = TEST_SECRET
    const { req } = makeRequest({ rawBody, signature: sign(rawBody), ip })
    const { res, nextCalled } = await invokeFullChain(req, (response) => {
      response.status(204)
      response.emit("finish")
    })

    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBe(204)
  })

  it("missing raw body fails closed with 503 BREVO_HMAC_RAW_BODY_UNAVAILABLE (F-04)", async () => {
    const rawBody = JSON.stringify({ event: "delivered" })
    const { req, auditEvents } = makeRequest({ rawBody, signature: sign(rawBody) })
    delete req.rawBody
    // Provide an already-parsed body — production fallback used to
    // JSON.stringify(req.body) here, which would silently break HMAC.
    req.body = { event: "delivered" }

    const { res, nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(503)
    expect(auditEvents.at(-1)).toMatchObject({
      error_code: "BREVO_HMAC_RAW_BODY_UNAVAILABLE",
      outcome: "rejected",
    })
  })

  it("reject envelope uses sentinel dispatch_id, locale, hashed_recipient and deterministic idempotency_key (F-06/F-07/F-08)", async () => {
    const rawBody = JSON.stringify({ event: "bounced" })
    const auditEvents: AuditEvent[] = []
    const ip = "203.0.113.40"

    for (let i = 0; i < 3; i += 1) {
      const { req } = makeRequest({
        rawBody,
        signature: sign(rawBody, "wrong-secret"),
        ip,
        auditEvents,
      })
      await invokeFullChain(req)
    }

    const idempotencyKeys = new Set(
      auditEvents.map((event) => event.idempotency_key as string),
    )
    expect(idempotencyKeys.size).toBe(1)
    expect(auditEvents[0]).toMatchObject({
      dispatch_id: "__pre_dispatch__",
      locale: "__unknown__",
      hashed_recipient: "__no_recipient__",
    })
    expect(auditEvents[0].correlation_id).toBeUndefined()
  })

  it("logs info on accepted webhook (F-15)", async () => {
    const rawBody = JSON.stringify({ event: "delivered" })
    const { req, logger } = makeRequest({ rawBody, signature: sign(rawBody) })

    const { nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      "[brevo-hmac-validator] accepted",
      expect.objectContaining({ body_byte_length: Buffer.byteLength(rawBody) }),
    )
  })

  it("test-only export refuses to run outside NODE_ENV=test (F-01)", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => __resetBrevoWebhookSecurityForTests()).toThrow(/test-only/)
      expect(() =>
        __setBrevoWebhookSecurityClockForTests(() => 0),
      ).toThrow(/test-only/)
    } finally {
      process.env.NODE_ENV = previous
      __setBrevoWebhookSecurityClockForTests(() => nowMs)
    }
  })

  it("reject audit events never include raw body, email, or secret", async () => {
    const rawBody = JSON.stringify({
      event: "delivered",
      email: "sensitive@example.test",
      body: "PII payload",
      secret: TEST_SECRET,
    })
    const { req, auditEvents } = makeRequest({
      rawBody,
      signature: sign(rawBody, "wrong-secret"),
    })

    await invokeFullChain(req)

    const serializedAudit = JSON.stringify(auditEvents[0])
    expect(serializedAudit).not.toContain("sensitive@example.test")
    expect(serializedAudit).not.toContain("PII payload")
    expect(serializedAudit).not.toContain(TEST_SECRET)
    expect(auditEvents[0]).toMatchObject({
      body_byte_length: Buffer.byteLength(rawBody),
    })
  })
})

/**
 * Story 6.6 (ADR-213 A+C, DW-15-184, DW-15-185) — wariant A: sekret w sciezce.
 *
 * Koperta jest w ksztalcie z dokumentacji Brevo (webhook transakcyjny, zdarzenie
 * `hard_bounce`): Brevo NIE wysyla naglowka podpisu, wiec do v1.15.0 kazde takie
 * zadanie konczylo sie `401 BREVO_HMAC_HEADER_MISSING`.
 */
const REALISTIC_BREVO_HARD_BOUNCE = {
  event: "hard_bounce",
  email: "example@domain.com",
  id: 123456,
  date: "2026-11-14 08:00:00",
  ts: 1794643200,
  "message-id": "<202611140800.12345678901@smtp-relay.mailin.fr>",
  ts_event: 1794643205,
  subject: "Twoj voucher",
  "X-Mailin-custom": "gp",
  sending_ip: "185.41.28.109",
  template_id: 22,
  tags: ["voucher_purchase_confirmation"],
  reason: "550 5.1.1 user unknown",
  ts_epoch: 1794643205000,
}
const PATH_TOKEN = "story-6-6-path-token-0123456789abcdef"

describe("Story 6.6 — ingress A+C: token w sciezce i jawna odmowa", () => {
  const originalToken = process.env.BREVO_WEBHOOK_PATH_TOKEN
  const originalSecret = process.env.BREVO_HMAC_SECRET

  beforeEach(() => {
    process.env.BREVO_WEBHOOK_PATH_TOKEN = PATH_TOKEN
    process.env.BREVO_HMAC_SECRET = TEST_SECRET
    __resetBrevoWebhookSecurityForTests()
  })

  afterAll(() => {
    if (originalToken === undefined) delete process.env.BREVO_WEBHOOK_PATH_TOKEN
    else process.env.BREVO_WEBHOOK_PATH_TOKEN = originalToken
    if (originalSecret === undefined) delete process.env.BREVO_HMAC_SECRET
    else process.env.BREVO_HMAC_SECRET = originalSecret
  })

  function pathRequest(token: string | null, ip = crypto.randomUUID()) {
    const made = makeRequest({ rawBody: JSON.stringify(REALISTIC_BREVO_HARD_BOUNCE), ip })
    ;(made.req as Record<string, unknown>).originalUrl =
      token === null
        ? "/hooks/notifications/brevo"
        : `/hooks/notifications/brevo/${encodeURIComponent(token)}`
    return made
  }

  it("kontrola DODATNIA — realistyczna koperta Brevo bez podpisu przechodzi z poprawnym tokenem", async () => {
    const { req, logger } = pathRequest(PATH_TOKEN)
    const { res, nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect((req as Record<string, unknown>).body).toMatchObject({
      event: "hard_bounce",
      "message-id": REALISTIC_BREVO_HARD_BOUNCE["message-id"],
    })
    expect(logger.info).toHaveBeenCalledWith(
      "[brevo-hmac-validator] accepted",
      expect.objectContaining({ auth_variant: "path_token" }),
    )
  })

  it("kontrola UJEMNA — zly token: 401 BREVO_WEBHOOK_PATH_TOKEN_MISMATCH, bez next()", async () => {
    const { req, auditEvents } = pathRequest("not-the-token")
    const { res, nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.payload).toMatchObject({ error_code: "BREVO_WEBHOOK_PATH_TOKEN_MISMATCH" })
    expect(auditEvents).toHaveLength(1)
  })

  it("kontrola UJEMNA — bez tokenu i bez podpisu nadal 401 BREVO_HMAC_HEADER_MISSING", async () => {
    const { req } = pathRequest(null)
    const { res, nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.payload).toMatchObject({ error_code: "BREVO_HMAC_HEADER_MISSING" })
  })

  it("kontrola UJEMNA — token w sciezce przy nieskonfigurowanym sekrecie: 503 BREVO_WEBHOOK_PATH_TOKEN_UNSET", async () => {
    delete process.env.BREVO_WEBHOOK_PATH_TOKEN
    const { req } = pathRequest(PATH_TOKEN)
    const { res, nextCalled } = await invokeFullChain(req)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(503)
    expect(res.payload).toMatchObject({ error_code: "BREVO_WEBHOOK_PATH_TOKEN_UNSET" })
  })

  it("AC3 — dwa powody odmowy daja dwa ROZNE nazwane kody z request id w logu, kopercie i odpowiedzi", async () => {
    const missing = pathRequest(null)
    const mismatch = pathRequest("not-the-token")
    const first = await invokeFullChain(missing.req)
    const second = await invokeFullChain(mismatch.req)

    const results = [
      { made: missing, res: first.res },
      { made: mismatch, res: second.res },
    ].map(({ made, res }) => {
      const payload = res.payload as { error_code: string; request_id: string }
      const audit = made.auditEvents[0] as { error_code: string; request_id: string }
      const logged = made.logger.warn.mock.calls.find((call) =>
        String(call[0]).startsWith("[brevo-hmac-validator] rejected"),
      )
      expect(logged).toBeDefined()
      expect(String(logged![0])).toContain(`error_code=${payload.error_code}`)
      expect(String(logged![0])).toContain(`request_id=${payload.request_id}`)
      expect(audit.error_code).toBe(payload.error_code)
      expect(audit.request_id).toBe(payload.request_id)
      // Wariant A niesie sekret w sciezce — log nie moze go zawierac.
      for (const call of made.logger.warn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(PATH_TOKEN)
      }
      return payload
    })

    expect(results[0].error_code).toBe("BREVO_HMAC_HEADER_MISSING")
    expect(results[1].error_code).toBe("BREVO_WEBHOOK_PATH_TOKEN_MISMATCH")
    expect(results[0].request_id).not.toBe(results[1].request_id)
  })

  it("AC3 — niedostepny sink audytu jest jawnym stanem: kod w logu error, pole odpowiedzi i licznik", async () => {
    const { getBrevoWebhookAuditSinkState } = jest.requireActual(
      "../../api/middlewares/brevo-hmac-validator",
    ) as typeof import("../../api/middlewares/brevo-hmac-validator")
    const { req } = pathRequest("not-the-token")
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    req.scope.resolve = jest.fn<unknown, [string]>((key: string) => {
      if (key === "logger") return logger
      throw new Error(`Unknown container key: ${key}`)
    })
    expect(getBrevoWebhookAuditSinkState().state).toBe("available")

    const { res } = await invokeFullChain(req)
    const payload = res.payload as Record<string, unknown>

    expect(payload.audit_state).toBe("BREVO_WEBHOOK_AUDIT_SINK_UNAVAILABLE")
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`request_id=${String(payload.request_id)}`),
      expect.objectContaining({ error_code: "BREVO_WEBHOOK_AUDIT_SINK_UNAVAILABLE" }),
    )
    expect(getBrevoWebhookAuditSinkState()).toEqual({
      state: "unavailable_observed",
      unavailable_total: 1,
    })
  })

  it("R-6 — wyjatek ZAREJESTROWANEGO sinka to ta sama jawna niedostepnosc: odpowiedz odmowy, kod, licznik", async () => {
    const { getBrevoWebhookAuditSinkState } = jest.requireActual(
      "../../api/middlewares/brevo-hmac-validator",
    ) as typeof import("../../api/middlewares/brevo-hmac-validator")
    const { req } = pathRequest("not-the-token")
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const sink = { record: jest.fn(async () => { throw new Error("sink write refused") }) }
    req.scope.resolve = jest.fn<unknown, [string]>((key: string) => {
      if (key === "logger") return logger
      if (key === "notification_delivery_audit_sink") return sink
      throw new Error(`Unknown container key: ${key}`)
    })

    const { res, nextCalled } = await invokeFullChain(req)
    const payload = res.payload as Record<string, unknown>

    expect(sink.record).toHaveBeenCalledTimes(1)
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(payload).toMatchObject({
      error_code: "BREVO_WEBHOOK_PATH_TOKEN_MISMATCH",
      audit_state: "BREVO_WEBHOOK_AUDIT_SINK_UNAVAILABLE",
    })
    expect(typeof payload.request_id).toBe("string")
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("reason=sink_threw"),
      expect.objectContaining({
        error_code: "BREVO_WEBHOOK_AUDIT_SINK_UNAVAILABLE",
        request_id: payload.request_id,
      }),
    )
    expect(getBrevoWebhookAuditSinkState()).toEqual({
      state: "unavailable_observed",
      unavailable_total: 1,
    })
  })
})
