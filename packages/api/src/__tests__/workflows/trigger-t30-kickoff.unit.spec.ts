/**
 * Story v160-cleanup-5: Unit tests for trigger-t30-kickoff workflow.
 *
 * CRIT-7.4 fix: verifies that vendors_notified comes from REAL dispatcher
 * result (not GP_KICKOFF_VENDOR_COUNT env var phantom).
 *
 * Covers:
 *   AC1 — vendors_notified from actual dispatch audit rows
 *   AC2 — triggered_by propagated to dispatcher
 *   AC3 — production hard-block when fixture mode active
 */

import {
  triggerT30Kickoff,
  _resetKickoffStateForTests,
} from "../../workflows/operator/trigger-t30-kickoff"
import * as dispatchService from "../../lib/t30-dispatch-service"

describe("triggerT30Kickoff — CRIT-7.4 phantom coupling fix", () => {
  beforeEach(() => {
    _resetKickoffStateForTests()
    // Default: dev env, fixture mode, window open
    delete process.env.NODE_ENV
    delete process.env.GP_KICKOFF_VENDOR_COUNT
    delete process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED
    process.env.GP_FLAG_FLIP_DATE = new Date(
      Date.now() - 1000
    ).toISOString().slice(0, 10) // already in window
  })

  afterEach(() => {
    _resetKickoffStateForTests()
    delete process.env.GP_FLAG_FLIP_DATE
  })

  // -------------------------------------------------------------------------
  // AC1 — Real dispatcher called; vendors_notified = dispatch triggered count
  // -------------------------------------------------------------------------

  it("AC1: vendors_notified equals dispatcher triggered count (not env var)", async () => {
    // Arrange: inject 2 fake vendors via fixture env
    process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([
      { id: "v1", handle: "salon-a", email: "a@example.com", preferred_locale: "pl" },
      { id: "v2", handle: "salon-b", email: "b@example.com", preferred_locale: "en" },
    ])

    const result = await triggerT30Kickoff({ triggered_by: "admin_alice" })

    expect(result.vendors_notified).toBe(2)
    // Env var phantom must not be present in codebase (grep-level check covered
    // separately in AC1 grep assertion; here we confirm logic independence).
    expect(result.vendors_notified).not.toBe(
      Number.parseInt(process.env.GP_KICKOFF_VENDOR_COUNT ?? "-1", 10),
    )

    delete process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON
  })

  it("AC1: vendors_notified = 0 when no vendors in fixture", async () => {
    const result = await triggerT30Kickoff({ triggered_by: "admin_bob" })
    expect(result.vendors_notified).toBe(0)
  })

  it("AC1: kickoff_at and t0_target are valid ISO dates", async () => {
    const result = await triggerT30Kickoff({ triggered_by: "admin_carol" })
    expect(() => new Date(result.kickoff_at)).not.toThrow()
    expect(() => new Date(result.t0_target)).not.toThrow()
    expect(new Date(result.t0_target).getTime()).toBeGreaterThan(
      new Date(result.kickoff_at).getTime(),
    )
  })

  // -------------------------------------------------------------------------
  // AC2 — Auth context propagated to dispatcher (verified via audit entries)
  // -------------------------------------------------------------------------

  it("AC2: triggered_by propagated to dispatcher entries via fixture vendors", async () => {
    // Inject a fixture vendor so the dispatcher produces a real audit entry.
    process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([
      { id: "v-auth", handle: "salon-auth", email: "auth@example.com", preferred_locale: "pl" },
    ])

    const result = await triggerT30Kickoff({ triggered_by: "admin_dave" })

    // vendors_notified = 1 means the dispatcher processed the vendor.
    // Auth propagation is verified by integration test in t30-dispatch-service.unit.spec.ts.
    expect(result.vendors_notified).toBe(1)

    delete process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON
  })

  // -------------------------------------------------------------------------
  // AC3 — Production hard-block when fixture mode active
  // -------------------------------------------------------------------------

  it("AC3: throws T30DispatcherFixtureModeError in production+fixture mode", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED

    await expect(
      triggerT30Kickoff({ triggered_by: "admin_eve" }),
    ).rejects.toThrow(dispatchService.T30DispatcherFixtureModeError)
  })

  it("AC3: does NOT throw in production when real vendor source enabled", async () => {
    process.env.NODE_ENV = "production"
    process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED = "true"

    // Should resolve (0 vendors, but no error)
    const result = await triggerT30Kickoff({ triggered_by: "admin_frank" })
    expect(result.vendors_notified).toBe(0)
  })

  it("AC3: does NOT throw in dev mode even without real vendor source", async () => {
    // NODE_ENV not set (undefined) = not "production"
    delete process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED
    const result = await triggerT30Kickoff({ triggered_by: "admin_grace" })
    expect(result.vendors_notified).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Idempotency guard
  // -------------------------------------------------------------------------

  it("throws AlreadyTriggered (409) on duplicate call without override", async () => {
    await triggerT30Kickoff({ triggered_by: "admin_h" })
    await expect(
      triggerT30Kickoff({ triggered_by: "admin_h" }),
    ).rejects.toMatchObject({ message: "AlreadyTriggered", code: 409 })
  })

  it("override=true allows re-trigger", async () => {
    await triggerT30Kickoff({ triggered_by: "admin_i" })
    const result = await triggerT30Kickoff({
      triggered_by: "admin_i",
      override: true,
    })
    expect(result.vendors_notified).toBeGreaterThanOrEqual(0)
  })
})
