export class NotificationProviderNotReadyError extends Error {
  readonly code = "VENDOR_NOTIFICATION_PROVIDER_NOT_READY"

  constructor() {
    super(
      "Vendor notification provider is not configured for live dispatch. " +
        // v1.14.0 Story 2.2 (AC3): brevo jest kanałem produkcyjnym (AD-5), więc
        // BREVO_API_KEY stoi na pierwszym miejscu — bez tego operator dostawał
        // instrukcję ustawienia nieaktualnego providera.
        "Set BREVO_API_KEY, RESEND_API_KEY, SENDGRID_API_KEY, SMTP_URL, or SMTP_HOST/SMTP_USER/SMTP_PASS, " +
        "or explicitly mark GP_VENDOR_NOTIFICATIONS_PROVIDER_READY=true after validating the provider.",
    )
    this.name = "NotificationProviderNotReadyError"
  }
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim())
}

export function shouldEnforceNotificationProviderReady(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    isTruthy(process.env.GP_VENDOR_NOTIFICATIONS_ENFORCE_PROVIDER_READY)
  )
}

export function isNotificationProviderReady(): boolean {
  if (isTruthy(process.env.GP_VENDOR_NOTIFICATIONS_PROVIDER_READY)) {
    return true
  }

  // v1.14.0 Story 2.2 (AC3, AD-5): provider brevo zarejestrowany w
  // medusa-config.ts jest kanałem produkcyjnym platformy.
  if (hasValue(process.env.BREVO_API_KEY)) {
    return true
  }

  if (hasValue(process.env.RESEND_API_KEY)) {
    return true
  }

  if (hasValue(process.env.SENDGRID_API_KEY)) {
    return true
  }

  if (hasValue(process.env.SMTP_URL)) {
    return true
  }

  return (
    hasValue(process.env.SMTP_HOST) &&
    hasValue(process.env.SMTP_USER) &&
    hasValue(process.env.SMTP_PASS)
  )
}

export function assertNotificationProviderReady(): void {
  if (
    shouldEnforceNotificationProviderReady() &&
    !isNotificationProviderReady()
  ) {
    throw new NotificationProviderNotReadyError()
  }
}