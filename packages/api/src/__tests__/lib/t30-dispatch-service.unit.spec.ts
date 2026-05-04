/**
 * Story v160-cleanup-5: Unit tests for t30-dispatch-service.ts
 *
 * Covers:
 *   - dispatchT30Notifications() returns correct counts + audit entries
 *   - AC3: T30DispatcherFixtureModeError thrown in production+fixture mode
 *   - isFixtureMode() flag checks
 *   - resolveFlagFlipDate() / isWindowOpen() helpers
 */

import {
  dispatchT30Notifications,
  fetchEligibleVendors,
  isFixtureMode,
  isWindowOpen,
  NotificationProviderNotReadyError,
  resolveFlagFlipDate,
  T30DispatcherFixtureModeError,
} from "../../lib/t30-dispatch-service"

describe("t30-dispatch-service", () => {
  beforeEach(() => {
    delete process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON
    delete process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED
    delete process.env.GP_FLAG_FLIP_DATE
    delete process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY
    delete process.env.GP_VENDOR_NOTIFICATIONS_PROVIDER_READY
    delete process.env.RESEND_API_KEY
    delete process.env.SENDGRID_API_KEY
    delete process.env.SMTP_URL
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    delete process.env.NODE_ENV
  })

  // -------------------------------------------------------------------------
  // resolveFlagFlipDate
  // -------------------------------------------------------------------------
  describe("resolveFlagFlipDate()", () => {
    it("returns null when env not set", () => {
      expect(resolveFlagFlipDate().flagFlipDate).toBeNull()
    })

    it("parses valid YYYY-MM-DD", () => {
      process.env.GP_FLAG_FLIP_DATE = "2026-06-01"
      const { flagFlipDate } = resolveFlagFlipDate()
      expect(flagFlipDate).not.toBeNull()
      expect(flagFlipDate?.toISOString().startsWith("2026-06-01")).toBe(true)
    })

    it("returns null for invalid date string", () => {
      process.env.GP_FLAG_FLIP_DATE = "not-a-date"
      expect(resolveFlagFlipDate().flagFlipDate).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // isWindowOpen
  // -------------------------------------------------------------------------
  describe("isWindowOpen()", () => {
    it("returns false for null", () => {
      expect(isWindowOpen(null)).toBe(false)
    })

    it("returns true when flipDate is within 30 days from now", () => {
      // date 15 days in future — window opened
      const future15 = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
      expect(isWindowOpen(future15)).toBe(true)
    })

    it("returns false when flipDate is > 30 days out", () => {
      const future60 = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
      expect(isWindowOpen(future60)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // isFixtureMode
  // -------------------------------------------------------------------------
  describe("isFixtureMode()", () => {
    it("returns true when GP_T30_REAL_VENDOR_SOURCE_ENABLED not set", () => {
      expect(isFixtureMode()).toBe(true)
    })

    it("returns false when GP_T30_REAL_VENDOR_SOURCE_ENABLED=true", () => {
      process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED = "true"
      expect(isFixtureMode()).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // fetchEligibleVendors
  // -------------------------------------------------------------------------
  describe("fetchEligibleVendors()", () => {
    it("returns empty array when no fixture set", async () => {
      expect(await fetchEligibleVendors()).toEqual([])
    })

    it("returns parsed vendors from GP_T30_DEV_FIXTURE_VENDORS_JSON", async () => {
      process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([
        { id: "v1", handle: "salon-a", email: "a@example.com", preferred_locale: "pl" },
      ])
      const vendors = await fetchEligibleVendors()
      expect(vendors).toHaveLength(1)
      expect(vendors[0].id).toBe("v1")
    })

    it("returns empty array on invalid JSON", async () => {
      process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = "not-json"
      expect(await fetchEligibleVendors()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // dispatchT30Notifications
  // -------------------------------------------------------------------------
  describe("dispatchT30Notifications()", () => {
    const silentLogger = {}

    it("returns triggered=0 + empty audit entries when no vendors", async () => {
      const result = await dispatchT30Notifications({
        triggered_by: "admin_test",
        flag_flip_iso: "2026-06-01",
        logger: silentLogger,
      })
      expect(result.triggered).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.audit_entries).toHaveLength(0)
      expect(result.audit_log_ids).toHaveLength(0)
    })

    it("returns triggered=N + N audit entries for N vendors", async () => {
      process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([
        { id: "v1", handle: "salon-a", email: "a@example.com", preferred_locale: "pl" },
        { id: "v2", handle: "salon-b", email: "b@example.com", preferred_locale: "en" },
        { id: "v3", handle: "salon-c", email: "c@example.com", preferred_locale: null },
      ])
      const result = await dispatchT30Notifications({
        triggered_by: "admin_alice",
        flag_flip_iso: "2026-06-01",
        logger: silentLogger,
      })
      expect(result.triggered).toBe(3)
      expect(result.audit_entries).toHaveLength(3)
      expect(result.audit_log_ids).toHaveLength(3)
    })

    it("AC2: propagates triggered_by to every audit entry", async () => {
      process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([
        { id: "v1", handle: "salon-x", email: "x@example.com", preferred_locale: "pl" },
      ])
      const result = await dispatchT30Notifications({
        triggered_by: "admin_bob",
        flag_flip_iso: "2026-06-01",
        logger: silentLogger,
      })
      expect(result.audit_entries[0].triggered_by).toBe("admin_bob")
    })

    it("audit entries have notification_type=t30_migration", async () => {
      process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON = JSON.stringify([
        { id: "v1", handle: "salon-y", email: "y@example.com", preferred_locale: "en" },
      ])
      const result = await dispatchT30Notifications({
        triggered_by: "admin_carol",
        flag_flip_iso: "2026-06-01",
        logger: silentLogger,
      })
      expect(result.audit_entries[0].notification_type).toBe("t30_migration")
    })

    it("AC3: throws T30DispatcherFixtureModeError in production+fixture mode", async () => {
      process.env.NODE_ENV = "production"
      delete process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED

      await expect(
        dispatchT30Notifications({
          triggered_by: "admin_prod",
          flag_flip_iso: "2026-06-01",
          logger: silentLogger,
        }),
      ).rejects.toThrow(T30DispatcherFixtureModeError)
    })

    it("AC3: does NOT throw in production when real source enabled", async () => {
      process.env.NODE_ENV = "production"
      process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED = "true"
      process.env.RESEND_API_KEY = "re_live_123"

      const result = await dispatchT30Notifications({
        triggered_by: "admin_prod_real",
        flag_flip_iso: "2026-06-01",
        logger: silentLogger,
      })
      expect(result.triggered).toBe(0)
    })

    it("throws NotificationProviderNotReadyError when enforcement is enabled without provider", async () => {
      process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY = "true"

      await expect(
        dispatchT30Notifications({
          triggered_by: "admin_stage",
          flag_flip_iso: "2026-06-01",
          logger: silentLogger,
        }),
      ).rejects.toThrow(NotificationProviderNotReadyError)
    })

    it("does not throw when enforcement is enabled and provider is configured", async () => {
      process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY = "true"
      process.env.RESEND_API_KEY = "re_stage_123"

      const result = await dispatchT30Notifications({
        triggered_by: "admin_stage_ready",
        flag_flip_iso: "2026-06-01",
        logger: silentLogger,
      })
      expect(result.triggered).toBe(0)
    })
  })
})
