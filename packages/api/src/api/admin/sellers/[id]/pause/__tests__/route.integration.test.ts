/**
 * Integration test — POST /admin/sellers/:id/pause with REAL capability-check.
 *
 * Story: v160-cleanup-37 — review-fix [AI-Review][LOW] integration drift guard.
 *
 * The unit suite (`route.unit.spec.ts`) mocks the entire `capability-check`
 * module. This integration suite leaves `requireCapability` unmocked so the
 * real `{ ok, status, body }` wire-format contract is exercised against the
 * route handler. If `CapabilityDeniedPayload` shape ever drifts, this test
 * catches the break before TF-92/93/108/111 siblings inherit the drift.
 */

// Mock instrumentation only — leave capability-check REAL.
const mockEmitT1 = jest.fn()
const mockEmitT2 = jest.fn()
jest.mock("../../../../../../lib/instrumentation/flag-propagation", () => ({
  emitFlagPropagationT1: (...args: unknown[]) => mockEmitT1(...args),
  emitFlagPropagationT2: (...args: unknown[]) => mockEmitT2(...args),
}))

jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    LOGGER: "logger",
  },
}))

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

function makeReq(opts: {
  body: Record<string, unknown>
  authContext?: { actor_id?: string; actor_type?: string } | undefined
}) {
  const inserts: Array<{ text: string; values: unknown[] }> = []
  const client = {
    inserts,
    async query(text: string, values?: unknown[]) {
      if (text.includes("INSERT INTO seller_status_change_audit")) {
        inserts.push({ text, values: values ?? [] })
        return { rows: [{ changed_at: new Date(), affected_orders: [] }] }
      }
      if (text.includes("SELECT id, status, version")) {
        return { rows: [{ id: "seller-1", status: "active", version: 1, market_id: "mkt-1" }] }
      }
      return { rows: [] }
    },
    release: jest.fn(),
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const req: Record<string, unknown> = {
    params: { id: "seller-1" },
    body: opts.body,
    headers: {},
    auth_context: opts.authContext,
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "__pg_pool__") return { connect: async () => client }
        if (key === "__redis_publisher__") throw new Error("no redis")
        throw new Error(`unknown key: ${key}`)
      },
    },
    _testClient: client,
    _testLogger: logger,
  }
  return req
}

describe("POST /admin/sellers/:id/pause — REAL capability-check integration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("denies override when auth_context lacks actor_type=user (returns real CapabilityDeniedPayload shape)", async () => {
    const { POST } = await import("../route.js")
    // auth_context has actor_id but actor_type !== "user" → real
    // checkLifecycleOverrideCapability returns false → 403.
    const req = makeReq({
      body: { override: true, reason: "long enough override reason" },
      authContext: { actor_id: "actor-x", actor_type: "customer" },
    })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(403)
    const body = res.body as Record<string, unknown>
    expect(body.code).toBe("CAPABILITY_REQUIRED")
    expect(body.capability).toBe("vendor.lifecycle.override_training_cert")
    expect(typeof body.message).toBe("string")
    // No DB write on denial.
    const client = (req as Record<string, unknown>)._testClient as { inserts: unknown[] }
    expect(client.inserts).toHaveLength(0)
  })

  it("grants override when auth_context.actor_type=user (real path)", async () => {
    const { POST } = await import("../route.js")
    const req = makeReq({
      body: { override: true, reason: "long enough override reason" },
      authContext: { actor_id: "admin-1", actor_type: "user" },
    })
    const res = makeRes()

    await POST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    const client = (req as Record<string, unknown>)._testClient as { inserts: Array<{ values: unknown[] }> }
    expect(client.inserts).toHaveLength(1)
    const ctx = JSON.parse(client.inserts[0].values[4] as string) as Record<string, unknown>
    expect(ctx.override).toBe(true)
    expect(ctx.override_reason).toBe("long enough override reason")
  })
})
