/**
 * Integration (unit-style) tests for admin vendors AuthN enforcement (cleanup-15a).
 *
 * Tests:
 *   1. 401 — missing token (no auth_context)
 *   2. 401 — invalid token (empty actor_id)
 *   3. 403 — non-admin actor_type (seller token)
 *   4. 200 — valid admin user happy path (POST lifecycle-status)
 *   5. 400 — state machine bypass via current_metadata in body
 *   6. 403 — override=true rejected for non-admin (no capability)
 *   7. 200 — override=true accepted for admin (capability granted)
 *
 * These tests exercise route handlers directly (unit-style, no HTTP server).
 * Auth middleware (authenticate + operatorAuthMiddleware) is tested separately
 * in with-operator-auth.unit.spec.ts — here we test the fail-closed
 * extractActorIdOrThrow helper + capability checks inside route handlers.
 *
 * Notes:
 *  - Story AC5 requires ≥5 tests; this suite provides 7.
 *  - "integration" label reflects that it crosses lib + route boundaries;
 *    no real DB/network required (pure unit environment).
 */

import { POST as lifecycleStatusPOST } from "../../../api/admin/vendors/[id]/lifecycle-status/route"
import { POST as decisionPost } from "../../../api/admin/vendors/[id]/decision/route"
import { GET as pauseGateDetailGET } from "../../../api/admin/vendors/[id]/pause-gate/route"
import { GET as decisionsGet } from "../../../api/admin/vendors/decisions/route"
import { GET as pauseGateListGET } from "../../../api/admin/vendors/pause-gate/route"
import { POST as t30POST } from "../../../api/admin/vendors/notifications/t30/route"
import { POST as nudgesPost } from "../../../api/admin/vendors/notifications/nudges/route"
import { _resetRingBuffer, getRingBuffer } from "../../../lib/alert-emit"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

// ---- helpers ----------------------------------------------------------------

/**
 * Minimal Knex mock for the vendor_decision_idempotency table.
 * cleanup-36: decision route now requires a DB connection for idempotency
 * lookups. The default behaviour here:
 *   - findIdempotencyRecord → no existing row (first call path)
 *   - persistIdempotencyRecord → returns a synthetic persisted row
 */
function makeDefaultIdempotencyKnex(idempotencyKey = "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5") {
  const synthRow = {
    id: "idem-default",
    idempotency_key: idempotencyKey,
    vendor_id: "vendor_01",
    request_hash: "default-hash",
    status_code: 200,
    response_body: {},
    created_at: new Date().toISOString(),
  }
  // .where().first() — race-loss path (returns nothing on default flow).
  const firstMock = jest.fn().mockResolvedValue(undefined)
  // .where().update().returning('*') — finalize path (review fix H1).
  const updateReturningMock = jest.fn().mockResolvedValue([synthRow])
  const updateMock = jest.fn(() => ({ returning: updateReturningMock }))
  // .where().delete() — releaseReservation (review fix M1).
  const deleteMock = jest.fn().mockResolvedValue(0)
  const whereMock = jest.fn(() => ({
    first: firstMock,
    update: updateMock,
    delete: deleteMock,
  }))
  // .insert(...).onConflict('idempotency_key').ignore().returning('*') — reserve.
  const insertReturningMock = jest.fn().mockResolvedValue([synthRow])
  const ignoreMock = jest.fn(() => ({ returning: insertReturningMock }))
  const onConflictMock = jest.fn(() => ({ ignore: ignoreMock }))
  const insertMock = jest.fn(() => ({ onConflict: onConflictMock }))
  return jest.fn(() => ({ where: whereMock, insert: insertMock }))
}

function createReq(opts: {
  authContext?: { actor_id?: string; actor_type?: string }
  body?: Record<string, unknown>
  params?: Record<string, string>
  query?: Record<string, unknown>
  scopeOverrides?: Record<string, unknown>
  /**
   * Extra HTTP headers. Defaults include `idempotency-key` for decision
   * endpoints (cleanup-36: strict policy requires UUIDv4 header).
   */
  headers?: Record<string, string>
}) {
  const logger = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }

  return {
    auth_context: opts.authContext,
    body: opts.body ?? {},
    params: opts.params ?? { id: "vendor_01" },
    query: opts.query ?? {},
    // cleanup-36: decision route requires Idempotency-Key; provide a stable
    // default so existing tests don't need to change their expectations.
    headers: {
      "idempotency-key": "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
      ...opts.headers,
    },
    scope: {
      resolve: (key: string) => {
        if (opts.scopeOverrides && key in opts.scopeOverrides) {
          return opts.scopeOverrides[key]
        }

        // cleanup-36: decision route needs PG_CONNECTION for idempotency table.
        if (key === ContainerRegistrationKeys.PG_CONNECTION) {
          return makeDefaultIdempotencyKnex(
            (opts.headers?.["idempotency-key"] as string | undefined) ??
              "a1b2c3d4-e5f6-4a7b-b8c9-d0e1f2a3b4c5",
          )
        }

        return logger
      },
    },
  } as any
}

function createSellerModuleService(initialSellers: any[]) {
  const sellers = initialSellers.map((seller) => JSON.parse(JSON.stringify(seller)))

  return {
    sellers,
    list: jest.fn(async (filters: { id?: string } = {}) => {
      if (filters.id) {
        return sellers.filter((seller) => seller.id === filters.id)
      }

      return sellers
    }),
    update: jest.fn(async (id: string, payload: any) => {
      const index = sellers.findIndex((seller) => seller.id === id)
      if (index === -1) {
        throw new Error(`seller ${id} not found`)
      }

      sellers[index] = {
        ...sellers[index],
        ...payload,
      }

      return sellers[index]
    }),
  }
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

/**
 * Minimal Knex mock for lifecycle-status route tests (cleanup-47).
 *
 * Simulates vendor_lifecycle_state (SELECT + upsert) and
 * vendor_notification_log (INSERT) tables inside a fake transaction.
 */
function createLifecycleScopeKnex(lifecycleStatus: string = "pending_approval", vendorId: string = "vendor_01") {
  type AnyFn = (...args: unknown[]) => unknown

  function buildTable(tableName: string): unknown {
    if (tableName === "vendor_lifecycle_state") {
      const row = {
        id: "lc_row_test",
        seller_id: vendorId,
        lifecycle_status: lifecycleStatus,
        decision_state: "opted_in",
        opt_in_at: null,
        opt_out_at: null,
        last_transition_at: "2026-05-07T00:00:00.000Z",
        last_transition_by: "system",
        created_at: "2026-05-07T00:00:00.000Z",
        updated_at: "2026-05-07T00:00:00.000Z",
      }
      return {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        forUpdate: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(row) as AnyFn }),
        first: jest.fn().mockResolvedValue(row) as AnyFn,
        insert: jest.fn().mockReturnValue({
          onConflict: jest.fn().mockReturnValue({
            merge: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ ...row, lifecycle_status: "open" }]) as AnyFn,
            }),
            ignore: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([row]) as AnyFn,
            }),
          }),
        }),
      }
    }
    if (tableName === "vendor_notification_log") {
      return {
        insert: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: "audit_test_row" }]) as AnyFn,
        }),
      }
    }
    return { select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) as AnyFn }
  }

  const knexFn = jest.fn((tableName: string) => buildTable(tableName)) as AnyFn & { transaction: AnyFn }
  knexFn.transaction = jest.fn(async (fn: (trx: unknown) => Promise<unknown>) => {
    const trxProxy = (tableName: string) => buildTable(tableName)
    return fn(trxProxy)
  }) as AnyFn

  return knexFn
}

// Mock t30-dispatch-service to prevent real dispatching
jest.mock("../../../lib/t30-dispatch-service", () => ({
  dispatchT30Notifications: jest.fn().mockResolvedValue({ triggered: 0, skipped: 0, failed: 0, audit_log_ids: [] }),
  fetchEligibleVendors: jest.fn().mockResolvedValue([]),
  isWindowOpen: jest.fn().mockReturnValue(true),
  resolveFlagFlipDate: jest.fn().mockReturnValue({ flagFlipDate: new Date("2026-12-01"), iso: "2026-12-01" }),
  T30DispatcherFixtureModeError: class T30DispatcherFixtureModeError extends Error {
    code = "FIXTURE_MODE"
  },
}))

// ---- tests ------------------------------------------------------------------

describe("admin vendors AuthN — fail-closed extractActorIdOrThrow", () => {
  beforeEach(() => {
    _resetRingBuffer()
  })

  // AC5 test 1 — 401 missing token (no auth_context at all)
  it("POST /admin/vendors/:id/lifecycle-status → 401 when no auth_context", async () => {
    const req = createReq({
      authContext: undefined,
      body: { to_status: "open" },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ error: expect.stringContaining("Valid admin session") })
  })

  // AC5 test 2 — 401 invalid token (actor_id empty string)
  it("POST t30 notifications → 401 when actor_id is empty string", async () => {
    const req = createReq({
      authContext: { actor_id: "", actor_type: "user" },
      body: { dry_run: false },
    })
    const res = createRes()

    await t30POST(req, res as any)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("GET /admin/vendors/decisions → 401 when no auth_context", async () => {
    const req = createReq({ authContext: undefined })
    const res = createRes()

    await decisionsGet(req, res as any)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("POST /admin/vendors/:id/decision → 401 when no auth_context", async () => {
    const req = createReq({
      authContext: undefined,
      body: { decision: "opted_in", reason: "Vendor accepted migration." },
    })
    const res = createRes()

    await decisionPost(req, res as any)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("GET /admin/vendors/decisions → 200 in production from live seller metadata", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"

    try {
      const sellerModuleService = createSellerModuleService([
        {
          id: "vendor_open_01",
          handle: "salon-open",
          email: "open@example.com",
          store_status: "ACTIVE",
          metadata: {
            gp: {
              lifecycle_status: "open",
              decision_status: "forced",
              lifecycle_decision: {
                decision: "opted_in",
                captured_at: "2026-02-03T10:00:00.000Z",
              },
            },
          },
        },
        {
          id: "vendor_pending_01",
          handle: "salon-pending",
          email: "pending@example.com",
          store_status: "ACTIVE",
          metadata: { gp: { lifecycle_status: "open" } },
        },
      ])

      const req = createReq({
        authContext: { actor_id: "user_admin_01", actor_type: "user" },
        query: { status: "opted_in", search: "open" },
        scopeOverrides: { sellerModuleService },
      })
      const res = createRes()

      await decisionsGet(req, res as any)

      expect(res.statusCode).toBe(200)
      expect(res.body).toMatchObject({
        total: 1,
        vendors: [
          {
            id: "vendor_open_01",
            handle: "salon-open",
            email: "open@example.com",
            lifecycle_status: "open",
            decision_status: "opted_in",
            last_action_at: "2026-02-03T10:00:00.000Z",
          },
        ],
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it("POST /admin/vendors/:id/decision → 200 in production and persists lifecycle_decision", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousResendApiKey = process.env.RESEND_API_KEY
    process.env.NODE_ENV = "production"
    process.env.RESEND_API_KEY = "re_live_123"

    try {
      const notificationService = {
        createNotifications: jest.fn().mockResolvedValue({ id: "notif_decision_01" }),
      }
      const sellerModuleService = createSellerModuleService([
        {
          id: "vendor_01",
          handle: "salon-open",
          name: "Salon Open",
          email: "open@example.com",
          preferred_locale: "en",
          store_status: "ACTIVE",
          metadata: {
            gp: {
              lifecycle_status: "open",
            },
          },
        },
      ])

      const req = createReq({
        authContext: { actor_id: "user_admin_01", actor_type: "user" },
        body: { decision: "opted_out", reason: "Vendor declined migration." },
        scopeOverrides: {
          sellerModuleService,
          [Modules.NOTIFICATION]: notificationService,
        },
      })
      const res = createRes()

      await decisionPost(req, res as any)

      expect(res.statusCode).toBe(200)
      expect(res.body).toMatchObject({
        vendor_id: "vendor_01",
        decision: "opted_out",
        audit_log_id: "notif_decision_01",
        email_dispatched: true,
      })
      expect(notificationService.createNotifications).toHaveBeenCalledTimes(1)
      expect(notificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "open@example.com",
          channel: "email",
          template: "vendor-decision-confirmation",
          metadata: expect.objectContaining({
            vendor_id: "vendor_01",
            decision: "opted_out",
            notification_type: "decision_capture",
            triggered_by: "user_admin_01",
          }),
        }),
      )
      expect(sellerModuleService.update).toHaveBeenCalledTimes(2)
      expect(sellerModuleService.sellers[0].metadata.gp.decision_status).toBe("opted_out")
      expect(sellerModuleService.sellers[0].metadata.gp.lifecycle_decision).toMatchObject({
        decision: "opted_out",
        reason: "Vendor declined migration.",
        admin_note: null,
        captured_by: "user_admin_01",
      })
      expect(
        sellerModuleService.sellers[0].metadata.gp.lifecycle_decision_confirmation,
      ).toMatchObject({
        audit_log_id: "notif_decision_01",
        recipient_email: "open@example.com",
        template: "vendor-decision-confirmation",
        dispatched_by: "user_admin_01",
        status: "sent",
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      process.env.RESEND_API_KEY = previousResendApiKey
    }
  })

  it("POST /admin/vendors/:id/decision → 503 in production when notification module is unavailable", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousResendApiKey = process.env.RESEND_API_KEY
    process.env.NODE_ENV = "production"
    process.env.RESEND_API_KEY = "re_live_123"

    try {
      const sellerModuleService = createSellerModuleService([
        {
          id: "vendor_01",
          handle: "salon-open",
          name: "Salon Open",
          email: "open@example.com",
          preferred_locale: "en",
          store_status: "ACTIVE",
          metadata: {
            gp: {
              lifecycle_status: "open",
            },
          },
        },
      ])

      const req = createReq({
        authContext: { actor_id: "user_admin_01", actor_type: "user" },
        body: { decision: "opted_out", reason: "Vendor declined migration." },
        scopeOverrides: { sellerModuleService },
      })
      const res = createRes()

      await decisionPost(req, res as any)

      expect(res.statusCode).toBe(503)
      expect(res.body).toMatchObject({
        code: "VENDOR_NOTIFICATION_MODULE_UNAVAILABLE",
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      process.env.RESEND_API_KEY = previousResendApiKey
    }
  })

  it("POST /admin/vendors/:id/decision → 400 when vendor is not open", async () => {
    const sellerModuleService = createSellerModuleService([
      {
        id: "vendor_01",
        handle: "salon-suspended",
        email: "suspended@example.com",
        store_status: "INACTIVE",
        metadata: {
          gp: {
            lifecycle_status: "suspended",
          },
        },
      },
    ])

    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      body: { decision: "opted_in", reason: "Vendor wants to migrate now." },
      scopeOverrides: { sellerModuleService },
    })
    const res = createRes()

    await decisionPost(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({
      error: expect.stringContaining("lifecycle_status='open'"),
    })
    expect(sellerModuleService.update).not.toHaveBeenCalled()
  })

  // AC5 test 3 — 403 non-admin (lifecycle override capability denied for seller token)
  it("POST lifecycle-status with override=true → 403 for seller actor_type", async () => {
    const req = createReq({
      authContext: { actor_id: "seller_abc", actor_type: "seller" },
      body: { to_status: "open", override: true },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ error: expect.stringContaining("capability") })
  })

  // AC5 test 4 — 200 admin happy path (lifecycle-status transition by valid admin)
  // pending_approval → suspended has no completeness requirement
  it("POST lifecycle-status → 200 for valid admin user (pending_approval → suspended)", async () => {
    const sellerModuleService = createSellerModuleService([
      {
        id: "vendor_01",
        handle: "salon-pending",
        email: "pending@example.com",
        status: "pending_approval",
        metadata: {
          gp: {
            lifecycle_status: "pending_approval",
          },
        },
      },
    ])

    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      body: { to_status: "suspended" },
      params: { id: "vendor_01" },
      scopeOverrides: {
        sellerModuleService,
        [ContainerRegistrationKeys.PG_CONNECTION]: createLifecycleScopeKnex("pending_approval"),
      },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    // State machine: pending_approval → suspended is allowed, no completeness requirement
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      vendor_id: "vendor_01",
      from_status: "pending_approval",
      to_status: "suspended",
    })
    expect(sellerModuleService.update).toHaveBeenCalledWith(
      "vendor_01",
      expect.objectContaining({ status: "suspended" }),
    )
  })

  it("POST lifecycle-status → 200 for suspended → open when current seller metadata is complete", async () => {
    const sellerModuleService = createSellerModuleService([
      {
        id: "vendor_ready_01",
        handle: "salon-ready",
        email: "ready@example.com",
        status: "suspended",
        metadata: {
          gp: {
            lifecycle_status: "suspended",
            lifecycle_decision: { decision: "opted_in" },
            t30_sent_at: "2026-05-01T10:00:00.000Z",
            nudges_completed: true,
            jca_signed_at: "2026-05-02T10:00:00.000Z",
            training_verified: true,
          },
        },
      },
    ])

    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      body: { to_status: "open", admin_note: "resume after verification" },
      params: { id: "vendor_ready_01" },
      scopeOverrides: {
        sellerModuleService,
        [ContainerRegistrationKeys.PG_CONNECTION]: createLifecycleScopeKnex("suspended", "vendor_ready_01"),
      },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      vendor_id: "vendor_ready_01",
      from_status: "suspended",
      to_status: "open",
    })
    expect(sellerModuleService.update).toHaveBeenCalledWith(
      "vendor_ready_01",
      expect.objectContaining({
        status: "open",
        metadata: expect.objectContaining({
          gp: expect.objectContaining({
            lifecycle_status: "open",
          }),
        }),
      }),
    )
  })

  // AC5 test 5 — 400 state machine bypass via current_metadata in body
  it("POST lifecycle-status → 400 when current_metadata is in request body", async () => {
    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      body: {
        to_status: "open",
        current_metadata: { lifecycle_status: "suspended" },
      },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: expect.stringContaining("current_metadata") })
  })

  // AC5 test 6 — 403 override=true rejected for customer actor_type (non-admin)
  it("POST lifecycle-status override=true → 403 for customer actor_type", async () => {
    const req = createReq({
      authContext: { actor_id: "cust_xyz", actor_type: "customer" },
      body: { to_status: "terminated", override: true },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ error: expect.stringContaining("capability") })
  })

  // AC5 test 7 — 200 override=true accepted for admin + alert emitted
  it("POST lifecycle-status override=true → 200 for admin + emits policy_override alert", async () => {
    const sellerModuleService = createSellerModuleService([
      {
        id: "vendor_override_01",
        handle: "salon-override",
        email: "override@example.com",
        status: "pending_approval",
        metadata: {
          gp: {
            lifecycle_status: "pending_approval",
          },
        },
      },
    ])

    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      body: { to_status: "open", override: true, admin_note: "manual fix" },
      params: { id: "vendor_override_01" },
      scopeOverrides: {
        sellerModuleService,
        [ContainerRegistrationKeys.PG_CONNECTION]: createLifecycleScopeKnex("pending_approval", "vendor_override_01"),
      },
    })
    const res = createRes()

    await lifecycleStatusPOST(req, res as any)

    // Should succeed (admin has capability)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      vendor_id: "vendor_override_01",
      to_status: "open",
    })

    // Alert should be in the ring buffer
    const buffer = getRingBuffer(10)
    const alert = buffer.find((e) => e.code === "policy_override")
    expect(alert).toBeDefined()
    expect(alert?.severity).toBe("WARN")
    expect(alert?.context?.actor_id).toBe("user_admin_01")
  })

  it("GET /admin/vendors/pause-gate → 200 from live seller metadata with completeness", async () => {
    const sellerModuleService = createSellerModuleService([
      {
        id: "vendor_pg_01",
        handle: "salon-pg",
        email: "pg@example.com",
        status: "suspended",
        metadata: {
          gp: {
            lifecycle_status: "suspended",
            lifecycle_decision: { decision: "opted_in" },
            t30_sent_at: "2026-05-01T10:00:00.000Z",
            nudges_completed: true,
            jca_signed_at: "2026-05-02T10:00:00.000Z",
            training_verified: false,
          },
        },
      },
    ])

    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      scopeOverrides: { sellerModuleService },
    })
    const res = createRes()

    await pauseGateListGET(req, res as any)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      total: 1,
      vendors: [
        expect.objectContaining({
          id: "vendor_pg_01",
          lifecycle_status: "suspended",
          decision_status: "opted_in",
          completeness: { complete: 4, total: 5 },
        }),
      ],
    })
  })

  it("GET /admin/vendors/:id/pause-gate → 200 with allowed transitions from live status", async () => {
    const sellerModuleService = createSellerModuleService([
      {
        id: "vendor_pg_detail_01",
        handle: "salon-detail",
        email: "detail@example.com",
        status: "suspended",
        metadata: {
          gp: {
            lifecycle_status: "suspended",
            lifecycle_decision: { decision: "opted_in" },
            t30_sent_at: "2026-05-01T10:00:00.000Z",
            nudges_completed: true,
            jca_signed_at: "2026-05-02T10:00:00.000Z",
            training_verified: true,
          },
        },
      },
    ])

    const req = createReq({
      authContext: { actor_id: "user_admin_01", actor_type: "user" },
      params: { id: "vendor_pg_detail_01" },
      scopeOverrides: { sellerModuleService },
    })
    const res = createRes()

    await pauseGateDetailGET(req, res as any)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      vendor: expect.objectContaining({
        id: "vendor_pg_detail_01",
        lifecycle_status: "suspended",
      }),
      completeness: { complete: 5, total: 5 },
      allowed_transitions: ["open", "terminated"],
    })
  })
})

describe("admin vendors AuthN — nudges route fail-closed", () => {
  // AC5 additional — 401 missing auth_context in nudges route
  it("POST nudges → 401 when no auth_context", async () => {
    const req = createReq({
      authContext: undefined,
      body: { step: "t21" },
    })
    const res = createRes()

    await nudgesPost(req, res as any)

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" })
  })
})
