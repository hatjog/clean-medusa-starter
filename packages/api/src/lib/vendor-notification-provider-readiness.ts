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

  // R-2.2-I1: RESEND/SENDGRID/SMTP to SHIM MIGRACYJNY, nie realna gotowość.
  // Po AD-5 („jedna ścieżka wysyłki") żaden z nich nie ma odpowiadającego
  // providera w `medusa-config.ts` — gate przepuszcza dispatch, który i tak
  // padnie na `BREVO_API_KEY_NOT_CONFIGURED`. Zostawiamy je świadomie (usunięcie
  // = zmiana zachowania zastanych środowisk, poza AC3 tej story), ale NIE po
  // cichu: każde takie przepuszczenie zostawia ślad w logu.
  // WŁAŚCICIEL usunięcia: Story 2.3 (sunset legacy providerów e-mail).
  if (hasLegacyEmailProviderEnv()) {
    warnLegacyProviderShim()
    return true
  }

  return false
}

/**
 * v1.14.0 Story 2.5 (R-2.5-M5) — gotowość dla AUTOMATÓW dosyłających
 * (reconciliation sweep). WĘŻSZA niż `isNotificationProviderReady`, bo shim
 * RESEND/SENDGRID/SMTP przepuszcza dispatch, który i tak padnie na
 * `BREVO_API_KEY_NOT_CONFIGURED` — dla ścieżki interaktywnej to jeden wiersz
 * `failed` na zakup, a dla sweepa maszynowa produkcja wierszy `failed`/DLQ co
 * 15 minut na środowisku dev/staging z zastanym SMTP.
 *
 * To NIE jest druga definicja gotowości: warunek jest PODZBIOREM tego samego
 * helpera (jawny opt-in operatora albo realny klucz brevo), a nie równoległym
 * słownikiem zmiennych.
 */
export function isNotificationProviderReadyForSweep(): boolean {
  if (!isNotificationProviderReady()) {
    return false
  }
  return (
    isTruthy(process.env.GP_VENDOR_NOTIFICATIONS_PROVIDER_READY) ||
    hasValue(process.env.BREVO_API_KEY)
  )
}

/** Zastane zmienne providerów e-mail bez zarejestrowanego providera (shim). */
export function hasLegacyEmailProviderEnv(): boolean {
  return (
    hasValue(process.env.RESEND_API_KEY) ||
    hasValue(process.env.SENDGRID_API_KEY) ||
    hasValue(process.env.SMTP_URL) ||
    (hasValue(process.env.SMTP_HOST) &&
      hasValue(process.env.SMTP_USER) &&
      hasValue(process.env.SMTP_PASS))
  )
}

function warnLegacyProviderShim(): void {
  if (process.env.NODE_ENV === "test") {
    return
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[vendor-notification-readiness] gotowość providera uznana na podstawie " +
      "zastanej zmiennej (RESEND/SENDGRID/SMTP), a jedynym zarejestrowanym " +
      "providerem e-mail jest brevo (AD-5) — dispatch padnie na " +
      "BREVO_API_KEY_NOT_CONFIGURED. Ustaw BREVO_API_KEY.",
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