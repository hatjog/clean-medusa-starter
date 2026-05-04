/**
 * cleanup-3: Admin route AuthN enforcement integration spec (AC1-AC5).
 *
 * Tests that /admin/vendors/** POST routes are protected by authentication
 * and that override=true is gated behind lifecycle.override capability.
 *
 * These tests use unit-style invocations of route handlers + middleware to
 * avoid requiring a live HTTP server (consistent with existing spec patterns
 * in this codebase). They verify the contract at handler level.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { operatorAuthMiddleware } from "../../../middlewares/with-operator-auth"
import {
  checkLifecycleOverrideCapability,
  validateOverridePayload,
  buildPolicyOverrideAuditPayload,
} from "../../../lib/capability-check"
import {
  emitStructuredAlert,
  getPolicyOverrideAlerts,
  _resetPolicyOverrideAlerts,
} from "../../../lib/alert-emit"
import { POST as postLifecycleStatus } from "../../../api/admin/vendors/[id]/lifecycle-status/route"

// ---- helpers ----------------------------------------------------------------

function makeReq(authContext?: Record<string, unknown>, body?: Record<string, unknown>, params?: Record<string, unknown>) {
  return {
    auth_context: authContext,
    body: body ?? {},
    params: params ?? { id: "vendor_test_123" },
    scope: {
      resolve: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn() }),
    },
  } as any
}

function makeRes() {
  return {
    body: null as any,
    statusCode: 0,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

// ---- AC1: AuthN middleware registered on /admin/vendors/* ------------------

describe("AC1 — AuthN middleware registered on /admin/vendors/*", () => {
  const SRC_ROOT = path.resolve(__dirname, "../../..")
  const MIDDLEWARES_FILE = path.join(SRC_ROOT, "api", "middlewares.ts")

  it("middlewares.ts contains authenticate+operatorAuthMiddleware matcher for /admin/vendors/*", () => {
    expect(fs.existsSync(MIDDLEWARES_FILE)).toBe(true)
    const content = fs.readFileSync(MIDDLEWARES_FILE, "utf-8")

    // Must have the /admin/vendors/* matcher
    expect(content).toMatch(/\/admin\/vendors\/\*/)

    // Must use authenticate for that block
    expect(content).toMatch(/authenticate\("user"/)

    // Must use operatorAuthMiddleware for that block
    expect(content).toMatch(/operatorAuthMiddleware/)
  })

  it("operatorAuthMiddleware returns 401 for missing auth_context", async () => {
    const req = makeReq(undefined)
    const res = makeRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("operatorAuthMiddleware returns 401 for auth_context without actor_id", async () => {
    const req = makeReq({ actor_type: "user" }) // no actor_id
    const res = makeRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("operatorAuthMiddleware returns 403 for non-admin actor (seller token)", async () => {
    const req = makeReq({ actor_id: "seller_abc", actor_type: "seller" })
    const res = makeRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it("operatorAuthMiddleware passes for valid admin user", async () => {
    const req = makeReq({ actor_id: "user_admin_1", actor_type: "user" })
    const res = makeRes()
    const next = jest.fn()

    await operatorAuthMiddleware(req, res as any, next)

    expect(next).toHaveBeenCalled()
    expect(res.statusCode).toBe(0) // no error
  })
})

// ---- AC2: extractActorId fail-closed (no "unknown_admin") ------------------

describe("AC2 — extractActorId fail-closed: no 'unknown_admin' literal in codebase", () => {
  it("src/api/admin/vendors/notifications/nudges/route.ts has no 'unknown_admin' literal", () => {
    const file = path.resolve(
      __dirname,
      "../../..",
      "api/admin/vendors/notifications/nudges/route.ts"
    )
    const content = fs.readFileSync(file, "utf-8")
    expect(content).not.toContain("unknown_admin")
  })

  it("src/api/admin/vendors/notifications/t30/route.ts has no 'unknown_admin' literal", () => {
    const file = path.resolve(
      __dirname,
      "../../..",
      "api/admin/vendors/notifications/t30/route.ts"
    )
    const content = fs.readFileSync(file, "utf-8")
    expect(content).not.toContain("unknown_admin")
  })

  it("src/api/admin/sellers/[id]/pause/route.ts has no 'unknown_admin' literal", () => {
    const file = path.resolve(
      __dirname,
      "../../..",
      "api/admin/sellers/[id]/pause/route.ts"
    )
    const content = fs.readFileSync(file, "utf-8")
    expect(content).not.toContain("unknown_admin")
  })

  it("grep of all admin API sources finds zero 'unknown_admin' literals", () => {
    const adminDir = path.resolve(__dirname, "../../..", "api/admin")

    function scanDir(dir: string): string[] {
      const hits: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          hits.push(...scanDir(full))
        } else if (entry.name.endsWith(".ts")) {
          const content = fs.readFileSync(full, "utf-8")
          if (content.includes("unknown_admin")) {
            hits.push(full)
          }
        }
      }
      return hits
    }

    const violations = scanDir(adminDir)
    expect(violations).toHaveLength(0)
  })
})

// ---- AC3: override=true capability gate ------------------------------------

describe("AC3 — override=true requires lifecycle.override capability", () => {
  beforeEach(() => _resetPolicyOverrideAlerts())

  it("checkLifecycleOverrideCapability: granted for admin user", () => {
    const req = makeReq({ actor_id: "user_admin_1", actor_type: "user" })
    const result = checkLifecycleOverrideCapability(req)
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.actor_id).toBe("user_admin_1")
    }
  })

  it("checkLifecycleOverrideCapability: denied for missing auth_context", () => {
    const req = makeReq(undefined)
    const result = checkLifecycleOverrideCapability(req)
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toContain("Unauthorized")
    }
  })

  it("checkLifecycleOverrideCapability: denied for seller actor_type", () => {
    const req = makeReq({ actor_id: "seller_abc", actor_type: "seller" })
    const result = checkLifecycleOverrideCapability(req)
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toContain("lifecycle.override")
    }
  })

  it("lifecycle-status POST: 403 when override=true and actor_type=seller", async () => {
    const req = makeReq(
      { actor_id: "seller_abc", actor_type: "seller" },
      {
        to_status: "open",
        override: true,
        admin_note: "This is a sufficiently long admin note for testing purposes",
        reason: "test reason here",
        prior_decision: "prior approval exists",
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ error: expect.stringContaining("lifecycle.override") })
  })

  it("lifecycle-status POST: 400 when override=true but admin_note too short", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "open",
        override: true,
        admin_note: "short",
        reason: "test reason here",
        prior_decision: "prior approval",
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: expect.stringContaining("admin_note") })
  })

  it("lifecycle-status POST: 400 when override=true but no prior_decision", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "open",
        override: true,
        admin_note: "This is a sufficiently long admin note for testing purposes",
        reason: "test reason here",
        // prior_decision missing
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: expect.stringContaining("prior_decision") })
  })

  it("lifecycle-status POST: 200 for admin with full override payload", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "open",
        override: true,
        admin_note: "This is a sufficiently long admin note for testing purposes here",
        reason: "emergency override approved by CTO",
        prior_decision: "CTO approved via Slack #admin-ops 2026-05-04",
        current_metadata: {
          lifecycle_status: "pending_approval",
          lifecycle_decision: { decision: "opted_in" },
        },
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(0) // 200 implicit (no status() call = default)
    expect(res.body).toMatchObject({
      vendor_id: "vendor_test_123",
      from_status: "pending_approval",
      to_status: "open",
      audit_log_id: expect.stringContaining("lifecycle_transition"),
    })
  })
})

// ---- AC4: Integration test: lifecycle-status route scenarios ---------------

describe("AC4 — lifecycle-status route handler: auth + override scenarios", () => {
  beforeEach(() => _resetPolicyOverrideAlerts())

  it("returns 400 when to_status is missing (missing body field)", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {}
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: "to_status is required" })
  })

  it("returns 400 for invalid transition (open → pending_approval is not allowed)", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "pending_approval",
        current_metadata: { lifecycle_status: "open" },
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: expect.stringContaining("not allowed") })
  })

  it("valid transition without override succeeds: pending_approval → suspended", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "suspended",
        current_metadata: { lifecycle_status: "pending_approval" },
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(0) // 200 implicit
    expect(res.body).toMatchObject({
      from_status: "pending_approval",
      to_status: "suspended",
    })
  })
})

// ---- AC5: policy_override alert emitted ------------------------------------

describe("AC5 — policy_override alert emitted via Story 8.6 hook", () => {
  beforeEach(() => _resetPolicyOverrideAlerts())

  it("emitStructuredAlert pushes to ring buffer with correct payload shape", () => {
    const alert = emitStructuredAlert({
      category: "policy_override",
      severity: "P2",
      actor_id: "user_admin_1",
      vendor_id: "vendor_test_123",
      prior_state: "pending_approval",
      to_state: "open",
      audit_log_id: "lifecycle_transition_vendor_test_123_1234567890",
      bypassed_checks: ["completeness_gate"],
    })

    expect(alert.category).toBe("policy_override")
    expect(alert.severity).toBe("P2")
    expect(alert.actor_id).toBe("user_admin_1")
    expect(alert.vendor_id).toBe("vendor_test_123")
    expect(alert.bypassed_checks).toContain("completeness_gate")
    expect(alert.timestamp).toBeDefined()

    const buffer = getPolicyOverrideAlerts()
    expect(buffer).toHaveLength(1)
    expect(buffer[0]).toMatchObject({ category: "policy_override", actor_id: "user_admin_1" })
  })

  it("ring buffer emits alert when lifecycle-status override is used", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "open",
        override: true,
        admin_note: "Emergency override: vendor locked due to data issue, CTO approval",
        reason: "emergency override approved by CTO",
        prior_decision: "CTO approved via Slack #admin-ops 2026-05-04",
        current_metadata: {
          lifecycle_status: "pending_approval",
          lifecycle_decision: { decision: "opted_in" },
        },
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(0) // success
    const alerts = getPolicyOverrideAlerts()
    expect(alerts.length).toBeGreaterThanOrEqual(1)

    const overrideAlert = alerts.find((a) => a.category === "policy_override")
    expect(overrideAlert).toBeDefined()
    expect(overrideAlert?.actor_id).toBe("user_admin_1")
    expect(overrideAlert?.vendor_id).toBe("vendor_test_123")
    expect(overrideAlert?.bypassed_checks).toContain("completeness_gate")
  })

  it("no alert emitted for normal (non-override) transition", async () => {
    const req = makeReq(
      { actor_id: "user_admin_1", actor_type: "user" },
      {
        to_status: "suspended",
        current_metadata: { lifecycle_status: "pending_approval" },
      }
    )
    const res = makeRes()

    await postLifecycleStatus(req, res as any)

    expect(res.statusCode).toBe(0)
    const alerts = getPolicyOverrideAlerts()
    expect(alerts).toHaveLength(0)
  })
})

// ---- validateOverridePayload unit tests ------------------------------------

describe("validateOverridePayload", () => {
  it("valid payload passes", () => {
    const result = validateOverridePayload({
      prior_decision: "CTO approved",
      admin_note: "This is a sufficiently long admin note for testing purposes",
      reason: "emergency override",
    })
    expect(result.valid).toBe(true)
  })

  it("missing prior_decision fails", () => {
    const result = validateOverridePayload({
      admin_note: "This is a sufficiently long admin note for testing purposes",
      reason: "emergency override",
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("prior_decision")
    }
  })

  it("admin_note < 30 chars fails", () => {
    const result = validateOverridePayload({
      prior_decision: "CTO approved",
      admin_note: "short note",
      reason: "valid reason",
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("admin_note")
    }
  })

  it("reason < 10 chars fails", () => {
    const result = validateOverridePayload({
      prior_decision: "CTO approved",
      admin_note: "This is a sufficiently long admin note for testing",
      reason: "short",
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("reason")
    }
  })
})

// ---- buildPolicyOverrideAuditPayload unit tests ----------------------------

describe("buildPolicyOverrideAuditPayload", () => {
  it("builds correct audit payload shape", () => {
    const payload = buildPolicyOverrideAuditPayload({
      vendor_id: "vendor_001",
      actor_id: "user_admin_1",
      prior_state: "pending_approval",
      bypassed_checks: ["completeness_gate"],
      admin_note: "Emergency approval via CTO mandate",
      reason: "emergency bypass",
    })

    expect(payload.category).toBe("policy_override")
    expect(payload.actor_id).toBe("user_admin_1")
    expect(payload.vendor_id).toBe("vendor_001")
    expect(payload.prior_state).toBe("pending_approval")
    expect(payload.bypassed_checks).toContain("completeness_gate")
    expect(payload.admin_note).toBe("Emergency approval via CTO mandate")
    expect(payload.timestamp).toBeDefined()
  })
})

// ---- AC6: middlewares.ts coverage gate (static analysis) -------------------

describe("AC6 — middlewares.ts: /admin/vendors/* auth gate static check", () => {
  const SRC_ROOT = path.resolve(__dirname, "../../..")
  const MIDDLEWARES_FILE = path.join(SRC_ROOT, "api", "middlewares.ts")

  it("middleware entry for /admin/vendors/* exists in defineMiddlewares export", () => {
    const content = fs.readFileSync(MIDDLEWARES_FILE, "utf-8")

    // Verify both authenticate("user"...) and operatorAuthMiddleware exist
    // in context near /admin/vendors/* matcher
    expect(content).toMatch(/\/admin\/vendors\/\*/)
    expect(content).toMatch(/authenticate\("user",\s*\["session",\s*"bearer"\]\)/)
    expect(content).toMatch(/operatorAuthMiddleware/)
  })

  it("/admin/vendors/* matcher appears BEFORE /store/* matcher in defineMiddlewares routes array", () => {
    const content = fs.readFileSync(MIDDLEWARES_FILE, "utf-8")

    // Find the defineMiddlewares export block only — avoid false positives from JSDoc comments
    const defineStart = content.indexOf("export default defineMiddlewares(")
    expect(defineStart).toBeGreaterThan(-1)

    const routesBlock = content.slice(defineStart)
    const vendorsMatcherPos = routesBlock.indexOf('matcher: "/admin/vendors/*"')
    const storeMatcherPos = routesBlock.indexOf('matcher: "/store/*"')

    expect(vendorsMatcherPos).toBeGreaterThan(-1)
    expect(storeMatcherPos).toBeGreaterThan(-1)
    expect(vendorsMatcherPos).toBeLessThan(storeMatcherPos)
  })
})
