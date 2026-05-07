/**
 * Unit tests for POST /admin/sellers/:id/pause — override=true capability gate.
 * Story: v160-cleanup-37 (TF-91 auth bypass fix)
 *
 * AC1 — capability gate on override=true
 * AC2 — 403 when caller lacks the capability (no DB write)
 * AC3 — audit row includes override=true + override_reason in runtime_context
 * AC4 — reason min-length validation (10 chars) for override path
 * AC5 — regression guard for default (non-override) path + unauthenticated request
 */

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that load the modules
// ---------------------------------------------------------------------------

// Mock flag-propagation so tests don't need the full instrumentation stack.
const mockEmitT1 = jest.fn()
const mockEmitT2 = jest.fn()
jest.mock("../../../../../../lib/instrumentation/flag-propagation", () => ({
  emitFlagPropagationT1: (...args: unknown[]) => mockEmitT1(...args),
  emitFlagPropagationT2: (...args: unknown[]) => mockEmitT2(...args),
}))

// Mock capability-check so we can control grant/deny independently of auth_context.
let mockCheckCapabilityResult = true
const mockRequireCapability = jest.fn()
const mockExtractActorIdOrThrow = jest.fn()

jest.mock("../../../../../../lib/capability-check", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
  extractActorIdOrThrow: (...args: unknown[]) => mockExtractActorIdOrThrow(...args),
}))

// Medusa framework stubs.
jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    LOGGER: "logger",
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<{
  rows: unknown[]
  queryImpl: (text: string, values?: unknown[]) => { rows: unknown[] }
}> = {}) {
  const sellerRow = { id: "seller-1", status: "active", version: 1, market_id: "mkt-1" }
  const auditRow = { changed_at: new Date("2024-01-01T00:00:00.000Z"), affected_orders: [] }

  const client = {
    capturedInserts: [] as Array<{ text: string; values: unknown[] }>,
    queryImpl: overrides.queryImpl,
    async query(text: string, values?: unknown[]) {
      // Capture INSERT for assertion in AC3.
      if (text.includes("INSERT INTO seller_status_change_audit")) {
        client.capturedInserts.push({ text, values: values ?? [] })
      }
      if (client.queryImpl) {
        return client.queryImpl(text, values)
      }
      if (text.includes("SELECT id, status, version")) {
        return { rows: overrides.rows ?? [sellerRow] }
      }
      if (text.includes("INSERT INTO seller_status_change_audit")) {
        return { rows: [auditRow] }
      }
      return { rows: [] }
    },
    release: jest.fn(),
  }
  return client
}

function makePool(clientOverrides?: Parameters<typeof makeClient>[0]) {
  const client = makeClient(clientOverrides)
  return {
    pool: {
      connect: async () => client,
    },
    client,
  }
}

function makeReq(opts: {
  sellerId?: string
  body?: Record<string, unknown>
  actorId?: string | null
  hasPool?: boolean
  hasRedis?: boolean
}) {
  const {
    sellerId = "seller-1",
    body = {},
    actorId = "admin-user-1",
    hasPool = true,
    hasRedis = false,
  } = opts

  const { pool, client } = makePool()
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  const req: Record<string, unknown> = {
    params: { id: sellerId },
    body,
    headers: {},
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "__pg_pool__" && hasPool) return pool
        if (key === "__pg_pool__" && !hasPool) throw new Error("pg pool not registered")
        if (key === "__redis_publisher__" && hasRedis)
          return { publish: jest.fn().mockResolvedValue(1) }
        if (key === "__redis_publisher__" && !hasRedis) throw new Error("no redis")
        throw new Error(`unknown key: ${key}`)
      },
    },
    _testClient: client,
    _testLogger: logger,
  }

  return req
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/sellers/:id/pause — override capability gate (AC1-AC5)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckCapabilityResult = true

    // Default: actor ID extraction succeeds.
    mockExtractActorIdOrThrow.mockImplementation(() => "admin-user-1")

    // Default: capability granted.
    mockRequireCapability.mockResolvedValue({ ok: true })
  })

  // -------------------------------------------------------------------------
  // AC5 — unauthenticated request returns 401 (regression guard)
  // -------------------------------------------------------------------------
  it("AC5 unauthenticated: returns 401 when extractActorIdOrThrow throws", async () => {
    mockExtractActorIdOrThrow.mockImplementation(() => {
      throw new Error("actor_id missing from auth_context — unauthenticated request reached handler")
    })

    const { POST } = await import("../route")
    const req = makeReq({ body: { reason: "test reason here" } })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(401)
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED")
    // No capability check should happen for unauthenticated request.
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC4 — override=true without adequate reason returns 400 (no DB write)
  // -------------------------------------------------------------------------
  it("AC4 missing reason: returns 400 REASON_REQUIRED when reason absent and override=false", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: false } })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("REASON_REQUIRED")
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  it("AC4 short override reason: returns 400 OVERRIDE_REASON_REQUIRED when reason < 10 chars", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: true, reason: "short" } })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("OVERRIDE_REASON_REQUIRED")
    // Must not proceed to capability check or DB write.
    expect(mockRequireCapability).not.toHaveBeenCalled()
    expect(mockExtractActorIdOrThrow).not.toHaveBeenCalled()
  })

  it("AC4 blank override reason (trim): returns 400 OVERRIDE_REASON_REQUIRED for whitespace-only", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: true, reason: "   " } })
    const res = makeRes()

    await POST(req as never, res as never)

    // [AI-Review][HIGH fix] AC4 strict: blank-after-trim on override path
    // returns OVERRIDE_REASON_REQUIRED, not REASON_REQUIRED.
    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("OVERRIDE_REASON_REQUIRED")
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  it("AC4 missing override reason (override=true, no reason): returns 400 OVERRIDE_REASON_REQUIRED", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: true } })
    const res = makeRes()

    await POST(req as never, res as never)

    // [AI-Review][HIGH fix] AC4 strict: missing reason on override path
    // returns OVERRIDE_REASON_REQUIRED.
    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("OVERRIDE_REASON_REQUIRED")
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // [AI-Review][MEDIUM fix] INVALID_OVERRIDE_TYPE — reject non-boolean override
  // -------------------------------------------------------------------------
  it("rejects override='true' (string) with 400 INVALID_OVERRIDE_TYPE; no capability check", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: "true", reason: "long enough reason here" } })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("INVALID_OVERRIDE_TYPE")
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  it("rejects override=1 (number) with 400 INVALID_OVERRIDE_TYPE; no capability check", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: 1, reason: "long enough reason here" } })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("INVALID_OVERRIDE_TYPE")
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  it("AC4 exactly 9-char override reason: returns 400 OVERRIDE_REASON_REQUIRED", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: true, reason: "123456789" } }) // 9 chars
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(400)
    expect((res.body as Record<string, unknown>).code).toBe("OVERRIDE_REASON_REQUIRED")
  })

  // -------------------------------------------------------------------------
  // AC2 — 403 when caller lacks capability (no audit row, no DB write)
  // -------------------------------------------------------------------------
  it("AC2 capability denied: returns 403 CAPABILITY_REQUIRED; no audit row written", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      status: 403,
      body: {
        code: "CAPABILITY_REQUIRED",
        capability: "vendor.lifecycle.override_training_cert",
        message: "Caller does not hold the required capability: vendor.lifecycle.override_training_cert",
      },
    })

    const { POST } = await import("../route")
    const req = makeReq({ body: { override: true, reason: "needs override justification" } })
    const res = makeRes()
    const client = (req as Record<string, unknown>)._testClient as ReturnType<typeof makeClient>
    const logger = (req as Record<string, unknown>)._testLogger as { warn: jest.Mock }

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(403)
    const body = res.body as Record<string, unknown>
    expect(body.code).toBe("CAPABILITY_REQUIRED")
    expect(body.capability).toBe("vendor.lifecycle.override_training_cert")

    // Must not write any audit row.
    expect(client.capturedInserts).toHaveLength(0)
    // Must not emit T1/T2 propagation.
    expect(mockEmitT1).not.toHaveBeenCalled()
    expect(mockEmitT2).not.toHaveBeenCalled()

    // [AI-Review][MEDIUM fix] Capability denial must emit a structured warn
    // log so SecOps can detect repeated failed override attempts.
    expect(logger.warn).toHaveBeenCalledWith(
      "seller.pause override capability denied",
      expect.objectContaining({
        sellerId: "seller-1",
        actorId: "admin-user-1",
        capability: "vendor.lifecycle.override_training_cert",
      })
    )
  })

  it("AC2 capability check is called with correct capability key when override=true", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { override: true, reason: "a valid long reason here" } })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(mockRequireCapability).toHaveBeenCalledWith(
      expect.anything(),
      "vendor.lifecycle.override_training_cert"
    )
  })

  // -------------------------------------------------------------------------
  // AC1 + AC3 — capability granted; audit row includes override context
  // -------------------------------------------------------------------------
  it("AC1+AC3 override granted: 200 with audit_id; runtime_context includes override flags", async () => {
    const { POST } = await import("../route")
    const overrideReason = "explicit operator override due to compliance deadline"
    const req = makeReq({ body: { override: true, reason: overrideReason } })
    const res = makeRes()
    const client = (req as Record<string, unknown>)._testClient as ReturnType<typeof makeClient>

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(typeof body.audit_id).toBe("string")

    // AC3 — verify runtime_context JSONB injected with override=true + override_reason.
    expect(client.capturedInserts).toHaveLength(1)
    const insertValues = client.capturedInserts[0].values as unknown[]
    // The 5th param (index 4) is the runtime_context JSON string.
    const runtimeContext = JSON.parse(insertValues[4] as string) as Record<string, unknown>
    expect(runtimeContext.override).toBe(true)
    expect(runtimeContext.override_reason).toBe(overrideReason)
    expect(runtimeContext.vendor_mor_enabled).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC5 — regression guard: default (non-override) path unchanged
  // -------------------------------------------------------------------------
  it("AC5 regression: override=false with valid reason succeeds; no capability check", async () => {
    const { POST } = await import("../route")
    const req = makeReq({ body: { reason: "routine suspension for policy breach" } })
    const res = makeRes()
    const client = (req as Record<string, unknown>)._testClient as ReturnType<typeof makeClient>

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    // No capability check for the non-override path.
    expect(mockRequireCapability).not.toHaveBeenCalled()

    // runtime_context should NOT include override fields.
    expect(client.capturedInserts).toHaveLength(1)
    const insertValues = client.capturedInserts[0].values as unknown[]
    const runtimeContext = JSON.parse(insertValues[4] as string) as Record<string, unknown>
    expect(runtimeContext.override).toBeUndefined()
    expect(runtimeContext.override_reason).toBeUndefined()
  })

  it("AC5 regression: override=true with exactly 10-char reason passes validation gate", async () => {
    const { POST } = await import("../route")
    // Exactly 10 chars (boundary — must pass).
    const req = makeReq({ body: { override: true, reason: "1234567890" } })
    const res = makeRes()

    await POST(req as never, res as never)

    // Capability check should have been called (validation passed).
    expect(mockRequireCapability).toHaveBeenCalled()
  })

  it("AC5 regression: idempotent re-pause on already-suspended seller returns 200 without capability check", async () => {
    const { POST } = await import("../route")
    const req = makeReq({
      body: { reason: "routine suspension" },
    })
    // Override the client to return status=suspended.
    const customClient = makeClient({
      rows: [{ id: "seller-1", status: "suspended", version: 2, market_id: "mkt-1" }],
    })
    ;(req as Record<string, unknown>).scope = {
      resolve: (key: string) => {
        if (key === "logger") return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        if (key === "__pg_pool__") return { connect: async () => customClient }
        throw new Error(`no redis`)
      },
    }
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    expect((res.body as Record<string, unknown>).idempotent).toBe(true)
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })
})
