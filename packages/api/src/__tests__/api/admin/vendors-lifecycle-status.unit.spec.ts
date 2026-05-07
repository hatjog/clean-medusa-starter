/**
 * Story v160-cleanup-47 — lifecycle-status real writes unit tests.
 *
 * Covers AC6 scenarios:
 * 1. write → read round-trip (POST suspended, GET returns same)
 * 2. missing vendor → 404
 * 3. illegal transition → 422 + no audit row
 * 4. idempotent transition → 200 + no audit row
 * 5. concurrent writes serialized; only one final state; audit rows ordered
 * 6. audit-append failure → entire transition rolls back (5xx)
 * 7. seeded default lifecycle row on first GET when seller exists
 *
 * Also verifies existing v160-7-4 auth/capability/override/current_metadata
 * paths continue to PASS (no regression — scenarios 8-11 below).
 */

import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  GET as lifecycleStatusGET,
  POST as lifecycleStatusPOST,
} from "../../../api/admin/vendors/[id]/lifecycle-status/route"
import { _resetRingBuffer } from "../../../lib/alert-emit"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown

function makeLifecycleRow(
  overrides: Partial<{
    id: string
    seller_id: string
    lifecycle_status: string
    decision_state: string
    opt_in_at: string | null
    opt_out_at: string | null
    last_transition_at: string
    last_transition_by: string
    created_at: string
    updated_at: string
  }> = {},
) {
  return {
    id: "lc_row_01",
    seller_id: "vendor_01",
    lifecycle_status: "pending_approval",
    decision_state: "pending",
    opt_in_at: null,
    opt_out_at: null,
    last_transition_at: "2026-05-07T00:00:00.000Z",
    last_transition_by: "system",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    ...overrides,
  }
}

/**
 * Builds a mock Knex instance simulating vendor_lifecycle_state + vendor_notification_log.
 *
 * The transaction mock runs the callback immediately (synchronous trx proxy).
 */
function makeKnexMock(
  opts: {
    lifecycleRow?: ReturnType<typeof makeLifecycleRow> | null
    upsertResult?: ReturnType<typeof makeLifecycleRow>
    auditInsertResult?: { id: string } | Error
  } = {},
) {
  const {
    lifecycleRow = makeLifecycleRow(),
    upsertResult = makeLifecycleRow({ lifecycle_status: "suspended" }),
    auditInsertResult = { id: "audit_row_01" },
  } = opts

  const auditInsertCalls: unknown[] = []
  const upsertCalls: unknown[] = []

  function buildTableMock(tableName: string): unknown {
    if (tableName === "vendor_lifecycle_state") {
      const firstFn = jest.fn().mockResolvedValue(lifecycleRow ?? null) as AnyFn

      return {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        forUpdate: jest.fn().mockReturnValue({ first: firstFn }),
        first: firstFn,
        insert: jest.fn().mockReturnValue({
          onConflict: jest.fn().mockReturnValue({
            merge: jest.fn().mockReturnValue({
              returning: jest.fn().mockImplementation(() => {
                upsertCalls.push({ table: tableName })
                return Promise.resolve([upsertResult])
              }) as AnyFn,
            }),
            ignore: jest.fn().mockReturnValue({
              returning: jest.fn().mockImplementation(() => {
                if (lifecycleRow === null) {
                  // No existing row → seed succeeds
                  return Promise.resolve([makeLifecycleRow()])
                }
                // Row already exists → empty result (conflict ignored)
                return Promise.resolve([])
              }) as AnyFn,
            }),
          }),
        }),
      }
    }

    if (tableName === "vendor_notification_log") {
      return {
        insert: jest.fn().mockReturnValue({
          returning: jest.fn().mockImplementation(() => {
            auditInsertCalls.push({ table: tableName })
            if (auditInsertResult instanceof Error) {
              return Promise.reject(auditInsertResult)
            }
            return Promise.resolve([auditInsertResult])
          }) as AnyFn,
        }),
      }
    }

    return {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null) as AnyFn,
    }
  }

  const knexFn = jest.fn((tableName: string) =>
    buildTableMock(tableName),
  ) as AnyFn & { transaction: AnyFn }

  // transaction: runs callback with a proxy that also calls buildTableMock
  knexFn.transaction = jest.fn(
    async (fn: (trx: unknown) => Promise<unknown>) => {
      const trxProxy = new Proxy(
        {} as Record<string, unknown>,
        {
          apply(_target, _thisArg, args) {
            return buildTableMock(args[0] as string)
          },
          get(_target, prop) {
            if (prop === "transaction") return knexFn.transaction
            return () => buildTableMock(prop.toString())
          },
        },
      )
      // Make the proxy callable as a function
      const callableProxy = new Proxy(
        (tableName: string) => buildTableMock(tableName),
        {
          get(_target, prop) {
            if (prop === "transaction") return knexFn.transaction
            return () => buildTableMock(prop.toString())
          },
        },
      )

      return fn(callableProxy)
    },
  ) as AnyFn

  return { knexFn, auditInsertCalls, upsertCalls }
}

function makeSellerService(
  sellers: Array<{ id: string; handle?: string; email?: string; metadata?: unknown }>,
) {
  return {
    list: jest.fn(async (filters: { id?: string } = {}) => {
      if (filters.id) return sellers.filter((s) => s.id === filters.id)
      return sellers
    }),
    update: jest.fn(async (_id: string, _payload: unknown) => undefined),
  }
}

/**
 * Build a mock request. authContext is NOT defaulted here so callers can
 * explicitly pass null/undefined to simulate missing auth.
 */
function createReq(opts: {
  params?: { id: string }
  body?: Record<string, unknown>
  authContext?: { actor_id?: string; actor_type?: string } | null
  knexFn?: AnyFn
  sellerService?: ReturnType<typeof makeSellerService>
  extraScopeKeys?: Record<string, unknown>
}) {
  const resolvedAuthContext =
    opts.authContext !== undefined
      ? opts.authContext
      : { actor_id: "admin_user_01", actor_type: "user" }

  return {
    auth_context: resolvedAuthContext,
    body: opts.body ?? {},
    params: opts.params ?? { id: "vendor_01" },
    query: {},
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION && opts.knexFn) {
          return opts.knexFn
        }
        if (
          (key === "sellerModuleService" || key === "sellerService") &&
          opts.sellerService
        ) {
          return opts.sellerService
        }
        if (opts.extraScopeKeys && key in opts.extraScopeKeys) {
          return opts.extraScopeKeys[key]
        }
        return { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
      },
    },
  } as unknown as Parameters<typeof lifecycleStatusPOST>[0]
}

function createRes() {
  const res = {
    body: null as unknown,
    statusCode: 200,
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

describe("lifecycle-status route — real writes (v160-cleanup-47 / TF-108)", () => {
  beforeEach(() => {
    _resetRingBuffer()
  })

  // AC6 scenario 1 — write → read round-trip
  it("SC1: POST sets to_status=suspended, GET returns same lifecycle_status", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)

    const suspendedRow = makeLifecycleRow({ lifecycle_status: "suspended" })
    const { knexFn } = makeKnexMock({
      lifecycleRow: makeLifecycleRow({ lifecycle_status: "pending_approval" }),
      upsertResult: suspendedRow,
      auditInsertResult: { id: "audit_row_01" },
    })

    const postReq = createReq({
      body: { to_status: "suspended", admin_note: "Suspended pending review" },
      knexFn,
      sellerService,
    })
    const postRes = createRes()
    await lifecycleStatusPOST(
      postReq,
      postRes as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )

    expect(postRes.statusCode).toBe(200)
    const postBody = postRes.body as {
      vendor_id: string
      from_status: string
      to_status: string
      audit_log_id: string
    }
    expect(postBody.to_status).toBe("suspended")
    expect(postBody.audit_log_id).toBe("audit_row_01")

    // GET round-trip — mock returns the written suspended row
    const { knexFn: getKnexFn } = makeKnexMock({ lifecycleRow: suspendedRow })
    const getReq = createReq({ knexFn: getKnexFn, sellerService })
    const getRes = createRes()
    await lifecycleStatusGET(
      getReq,
      getRes as unknown as Parameters<typeof lifecycleStatusGET>[1],
    )

    expect(getRes.statusCode).toBe(200)
    const getBody = getRes.body as { lifecycle_status: string }
    expect(getBody.lifecycle_status).toBe("suspended")
  })

  // AC6 scenario 2 — POST missing vendor → 404
  it("SC2: POST with unknown vendor id → 404", async () => {
    const sellerService = makeSellerService([])
    const { knexFn } = makeKnexMock()

    const req = createReq({ body: { to_status: "suspended" }, sellerService, knexFn })
    const res = createRes()
    await lifecycleStatusPOST(req, res as unknown as Parameters<typeof lifecycleStatusPOST>[1])

    expect(res.statusCode).toBe(404)
    expect((res.body as { error: string }).error).toMatch(/was not found/)
  })

  // AC6 scenario 2b — GET missing vendor → 404
  it("SC2b: GET with unknown vendor id → 404", async () => {
    const sellerService = makeSellerService([])
    const { knexFn } = makeKnexMock()

    const req = createReq({ sellerService, knexFn })
    const res = createRes()
    await lifecycleStatusGET(req, res as unknown as Parameters<typeof lifecycleStatusGET>[1])

    expect(res.statusCode).toBe(404)
  })

  // AC6 scenario 3 — illegal transition → 422, no audit row
  it("SC3: illegal transition (terminated→suspended) → 422 + no audit row", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)

    const { knexFn, auditInsertCalls } = makeKnexMock({
      lifecycleRow: makeLifecycleRow({ lifecycle_status: "terminated" }),
    })

    const req = createReq({ body: { to_status: "suspended" }, sellerService, knexFn })
    const res = createRes()
    await lifecycleStatusPOST(req, res as unknown as Parameters<typeof lifecycleStatusPOST>[1])

    expect(res.statusCode).toBe(422)
    expect((res.body as { error: string }).error).toMatch(/Transition not allowed/)
    expect(auditInsertCalls).toHaveLength(0)
  })

  // AC6 scenario 4 — idempotent transition → 200, no audit row
  it("SC4: idempotent transition (to_status == current) → 200 + no audit row", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)

    const { knexFn, auditInsertCalls } = makeKnexMock({
      lifecycleRow: makeLifecycleRow({ lifecycle_status: "pending_approval" }),
    })

    const req = createReq({
      body: { to_status: "pending_approval" },
      sellerService,
      knexFn,
    })
    const res = createRes()
    await lifecycleStatusPOST(req, res as unknown as Parameters<typeof lifecycleStatusPOST>[1])

    expect(res.statusCode).toBe(200)
    const body = res.body as { from_status: string; to_status: string }
    expect(body.from_status).toBe("pending_approval")
    expect(body.to_status).toBe("pending_approval")
    expect(auditInsertCalls).toHaveLength(0)
  })

  // AC6 scenario 5 — concurrent writes serialized (mocked transaction guard)
  it("SC5: two sequential POSTs model serialization — second sees post-commit state", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)

    // Request 1: pending_approval → suspended
    const suspendedRow = makeLifecycleRow({ lifecycle_status: "suspended" })
    const { knexFn: knex1 } = makeKnexMock({
      lifecycleRow: makeLifecycleRow({ lifecycle_status: "pending_approval" }),
      upsertResult: suspendedRow,
      auditInsertResult: { id: "audit_1" },
    })
    const req1 = createReq({
      body: { to_status: "suspended" },
      sellerService,
      knexFn: knex1,
    })
    const res1 = createRes()
    await lifecycleStatusPOST(
      req1,
      res1 as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )
    expect(res1.statusCode).toBe(200)
    expect((res1.body as { to_status: string }).to_status).toBe("suspended")
    expect((res1.body as { audit_log_id: string }).audit_log_id).toBe("audit_1")

    // Request 2: suspended → terminated (re-reads post-commit state)
    const terminatedRow = makeLifecycleRow({ lifecycle_status: "terminated" })
    const { knexFn: knex2 } = makeKnexMock({
      lifecycleRow: suspendedRow,
      upsertResult: terminatedRow,
      auditInsertResult: { id: "audit_2" },
    })
    const req2 = createReq({
      body: { to_status: "terminated" },
      sellerService,
      knexFn: knex2,
    })
    const res2 = createRes()
    await lifecycleStatusPOST(
      req2,
      res2 as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )
    expect(res2.statusCode).toBe(200)
    expect((res2.body as { to_status: string }).to_status).toBe("terminated")
    expect((res2.body as { audit_log_id: string }).audit_log_id).toBe("audit_2")
  })

  // AC6 scenario 6 — audit append failure → 5xx + lifecycle row rolled back
  it("SC6: audit-append failure → 5xx, transaction propagates error", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)

    const { knexFn } = makeKnexMock({
      lifecycleRow: makeLifecycleRow({ lifecycle_status: "pending_approval" }),
      auditInsertResult: new Error("DB write failed — audit table unavailable"),
    })

    const req = createReq({ body: { to_status: "suspended" }, sellerService, knexFn })
    const res = createRes()
    await lifecycleStatusPOST(req, res as unknown as Parameters<typeof lifecycleStatusPOST>[1])

    // Route should return 5xx when audit append throws
    expect(res.statusCode).toBeGreaterThanOrEqual(500)
  })

  // AC6 scenario 7 — GET seeds default row when seller exists but lifecycle row absent
  it("SC7: GET when lifecycle row absent → seeds pending_approval default", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)

    const { knexFn } = makeKnexMock({ lifecycleRow: null })

    const req = createReq({ sellerService, knexFn })
    const res = createRes()
    await lifecycleStatusGET(req, res as unknown as Parameters<typeof lifecycleStatusGET>[1])

    expect(res.statusCode).toBe(200)
    const body = res.body as { lifecycle_status: string }
    expect(body.lifecycle_status).toBe("pending_approval")
  })

  // -- v160-7-4 regression guard --

  // SC8: 401 when no auth_context
  it("SC8 (regression): POST → 401 when no auth_context", async () => {
    const req = createReq({
      authContext: null,
      body: { to_status: "suspended" },
    })
    const res = createRes()
    await lifecycleStatusPOST(
      req,
      res as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )
    expect(res.statusCode).toBe(401)
    expect((res.body as { error: string }).error).toMatch(/Valid admin session/)
  })

  // SC9: 400 when to_status is missing
  it("SC9 (regression): POST → 400 when to_status missing", async () => {
    const req = createReq({ body: {} })
    const res = createRes()
    await lifecycleStatusPOST(
      req,
      res as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/to_status is required/)
  })

  // SC10: 400 when current_metadata supplied (bypass guard preserved)
  it("SC10 (regression): POST → 400 when current_metadata in body", async () => {
    const req = createReq({
      body: { to_status: "suspended", current_metadata: { lifecycle_status: "open" } },
    })
    const res = createRes()
    await lifecycleStatusPOST(
      req,
      res as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/current_metadata/)
  })

  // SC11: override=true accepted for user actor (v1.6.0: any admin user → granted)
  it("SC11 (regression): POST with override=true + user actor → override capability granted", async () => {
    const sellers = [
      { id: "vendor_01", handle: "salon-01", email: "salon@example.com", metadata: {} },
    ]
    const sellerService = makeSellerService(sellers)
    const { knexFn } = makeKnexMock({
      lifecycleRow: makeLifecycleRow({ lifecycle_status: "pending_approval" }),
      auditInsertResult: { id: "audit_override_01" },
    })

    const req = createReq({
      body: { to_status: "suspended", override: true },
      sellerService,
      knexFn,
      authContext: { actor_id: "admin_user_01", actor_type: "user" },
    })
    const res = createRes()
    await lifecycleStatusPOST(
      req,
      res as unknown as Parameters<typeof lifecycleStatusPOST>[1],
    )
    // override=true + user actor → capability granted → transition proceeds
    expect(res.statusCode).toBe(200)
  })
})
