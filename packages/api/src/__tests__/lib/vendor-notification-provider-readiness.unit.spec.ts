import {
  assertNotificationProviderReady,
  isNotificationProviderReady,
  NotificationProviderNotReadyError,
  shouldEnforceNotificationProviderReady,
} from "../../lib/vendor-notification-provider-readiness"

describe("vendor-notification-provider-readiness", () => {
  beforeEach(() => {
    delete process.env.NODE_ENV
    delete process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY
    delete process.env.GP_VENDOR_NOTIFICATIONS_PROVIDER_READY
    delete process.env.RESEND_API_KEY
    delete process.env.SENDGRID_API_KEY
    delete process.env.SMTP_URL
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
  })

  it("does not enforce readiness by default outside production", () => {
    expect(shouldEnforceNotificationProviderReady()).toBe(false)
  })

  it("enforces readiness in production", () => {
    process.env.NODE_ENV = "production"
    expect(shouldEnforceNotificationProviderReady()).toBe(true)
  })

  it("enforces readiness when explicitly requested", () => {
    process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY = "true"
    expect(shouldEnforceNotificationProviderReady()).toBe(true)
  })

  it("detects readiness from RESEND_API_KEY", () => {
    process.env.RESEND_API_KEY = "re_test_123"
    expect(isNotificationProviderReady()).toBe(true)
  })

  it("detects readiness from SMTP host/user/pass tuple", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_USER = "mailer"
    process.env.SMTP_PASS = "secret"
    expect(isNotificationProviderReady()).toBe(true)
  })

  it("allows explicit operator override after validation", () => {
    process.env.GP_VENDOR_NOTIFICATIONS_PROVIDER_READY = "true"
    expect(isNotificationProviderReady()).toBe(true)
  })

  it("throws when enforcement is on but no provider is configured", () => {
    process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY = "true"
    expect(() => assertNotificationProviderReady()).toThrow(
      NotificationProviderNotReadyError,
    )
  })
})