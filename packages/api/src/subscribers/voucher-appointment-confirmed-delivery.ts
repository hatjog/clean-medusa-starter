import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import {
  buildVoucherAppointmentDeliveryEmail,
  type VoucherAppointmentDeliveryEmail,
} from "../modules/voucher-delivery"
import {
  getHmacSecret,
} from "../modules/voucher-delivery/storage/hmac"
import type { IVoucherPdfStorage } from "../modules/voucher-delivery/storage/ports"
import type {
  VoucherAppointmentIcsInput,
  VoucherAppointmentLifecycleStatus,
} from "../modules/voucher-delivery/ics-generator"
import { VOUCHER_MODULE } from "../modules/voucher"
// Story 2.2 (AC5 poz.5): klucz szablonu WYŁĄCZNIE ze stałej rejestru (AD-6).
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"
import { resolveMarketScopedNotificationMarketId } from "../lib/notification-market-context"
// RLC005/M3 (code-review 2.4): locale odbiorcy NIE może być zaszyte —
// ten sam resolver + fail-loud co ścieżka 2.3 (voucher-purchase-delivery.ts).
import { resolveMarketLocale } from "../lib/get-market-locales"
import {
  createMarketLocalesReader,
  type MarketLocalesReader,
} from "../lib/read-market-locales"

export const APPOINTMENT_MARKET_LOCALES_UNAVAILABLE_ERROR_CODE =
  "VOUCHER_DELIVERY_MARKET_LOCALES_UNAVAILABLE"

export const VOUCHER_APPOINTMENT_CONFIRMED_EVENT =
  "gp.voucher.appointment_confirmed.v1" as const

const STORAGE_CONTAINER_KEY = "voucher_pdf_storage"
const DEFAULT_BACKEND_URL = "http://localhost:9002"

type LoggerLike = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
  error?: (message: string, error?: unknown) => void
}

type AppointmentConfirmedPayload = {
  entitlement_instance_id: string
  vendor_id: string
  location_id: string
  service_name: string
  starts_at: string
  ends_at: string
  timezone: string
  confirmation_source: string
  appointment_id?: string | null
  sequence?: number | null
  lifecycle_status?: VoucherAppointmentLifecycleStatus | null
}

/**
 * Story 2.3 (AC6b) — rynek przychodzi w `scope` KOPERTY, nie w payloadzie.
 *
 * Domknięcie R-2.2-M4: 2.2 dodało opcjonalne `payload.market_id`, ale schema
 * `gp.voucher.appointment_confirmed.v1` ma `additionalProperties: false` i NIE
 * deklaruje tego pola — czyli emiter nie mógłby go legalnie wysłać, a odczyt
 * z payloadu był martwy. Normatywnym nośnikiem rynku jest `envelope.v1`
 * `scope.market_id` (pole WYMAGANE w kopercie), uzupełniony przez projekcję
 * `findAppointmentConfirmationDeliverySource` (od 2.3 zwraca `market_id`).
 */
type AppointmentConfirmedScope = {
  instance_id?: string
  market_id?: string | null
  vendor_id?: string | null
  location_id?: string | null
}

type AppointmentConfirmedEnvelope = {
  event_type?: string
  occurred_at?: string
  causation_id?: string
  scope?: AppointmentConfirmedScope
  payload?: Partial<AppointmentConfirmedPayload>
}

type AppointmentConfirmationDeliverySource = {
  buyer_email: string | null
  buyer_locale?: string | null
  salon_name?: string | null
  location_address?: string | null
  seller_handle?: string | null
  /** R-2.2-M4 domknięte w Story 2.3: projekcja zwraca rynek z danych domenowych. */
  market_id?: string | null
}

type AppointmentSourceReader = {
  findAppointmentConfirmationDeliverySource(
    entitlement_instance_id: string,
  ): Promise<AppointmentConfirmationDeliverySource | null>
}

type NotificationModuleLike = {
  createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
  send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
}

type AppointmentNotificationDispatcher = {
  dispatch(payload: Record<string, unknown>): Promise<unknown>
}

export type AppointmentConfirmationDeliveryResult = {
  entitlement_instance_id: string | null
  status: "sent" | "failed"
  notification_id: string | null
  error_message: string | null
}

export async function handleVoucherAppointmentConfirmedDelivery(
  data: AppointmentConfirmedEnvelope | Record<string, unknown>,
  deps: {
    sourceReader: AppointmentSourceReader
    dispatcher: AppointmentNotificationDispatcher
    artifactStorage: Pick<IVoucherPdfStorage, "store">
    downloadBaseUrl: string
    hmacSecret: string
    marketLocales: MarketLocalesReader
    logger?: LoggerLike
    now?: Date
  },
): Promise<AppointmentConfirmationDeliveryResult> {
  const payload = extractAppointmentPayload(data)
  const scopeMarketId = extractAppointmentScopeMarketId(data)
  const entitlementId = payload.entitlement_instance_id ?? null

  if (!entitlementId) {
    return {
      entitlement_instance_id: null,
      status: "failed",
      notification_id: null,
      error_message: "appointment payload missing entitlement_instance_id",
    }
  }

  const source =
    await deps.sourceReader.findAppointmentConfirmationDeliverySource(entitlementId)
  if (!source || !source.buyer_email) {
    return {
      entitlement_instance_id: entitlementId,
      status: "failed",
      notification_id: null,
      error_message: "appointment delivery source not found",
    }
  }

  // RLC005/M3: locale odbiorcy pochodzi WYŁĄCZNIE z `resolveMarketLocale`
  // (ten sam resolver co 2.3) — nigdy z literału ani z `?? "pl"` w kodzie.
  // marketId liczymy raz, przed rozstrzygnięciem locale, żeby oba call-site'y
  // (locale + `market_id` notyfikacji) dzieliły ten sam rynek.
  const marketId = resolveMarketScopedNotificationMarketId({
    market_id: scopeMarketId ?? source.market_id ?? null,
    call_site: "voucher-appointment-confirmed-delivery",
    logger: deps.logger,
  })
  const marketLocaleRead = await deps.marketLocales.read(marketId)
  const localeResolution = resolveMarketLocale({
    requested: source.buyer_locale ?? null,
    marketId,
    locales: marketLocaleRead.config,
    callSite: "voucher-appointment-confirmed-delivery",
    logger: deps.logger,
  })

  // Wzorzec 2.3 (AC4 „FAIL-LOUD, bez downgrade'u"): konfiguracja locale rynku
  // NIEZNANA + dane domenowe niosą locale, którego ten shim nie zna → to
  // niewiedza o rynku, nie „locale niewspierane" — cichy downgrade do `pl`
  // dałby maila w złym języku wyglądającego jak sukces.
  if (
    marketLocaleRead.degraded &&
    localeResolution.reason === "not_supported_by_market"
  ) {
    deps.logger?.error?.(
      "[voucher-appointment-confirmed] konfiguracja locale rynku niedostępna, a dane " +
        "domenowe niosą inne locale — wysyłka wstrzymana zamiast downgrade'u do locale domyślnego",
      {
        entitlement_instance_id: entitlementId,
        market_id: marketId,
        requested_locale: source.buyer_locale ?? null,
        error_code: APPOINTMENT_MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
      },
    )
    return {
      entitlement_instance_id: entitlementId,
      status: "failed",
      notification_id: null,
      error_message: APPOINTMENT_MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
    }
  }

  const locale = localeResolution.locale

  const now = deps.now ?? new Date()
  const appointment = buildAppointmentInput(payload, source, now)
  const email = buildVoucherAppointmentDeliveryEmail({
    recipient_email: source.buyer_email,
    salon_name: source.salon_name ?? appointment.salon_name ?? null,
    location_address: source.location_address ?? appointment.location_address ?? null,
    appointment,
    download_base_url: deps.downloadBaseUrl,
    hmac_secret: deps.hmacSecret,
    now,
  })

  if (!email.calendar) {
    return {
      entitlement_instance_id: entitlementId,
      status: "failed",
      notification_id: null,
      error_message: "appointment calendar payload was not generated",
    }
  }

  await deps.artifactStorage.store({
    storage_key: email.calendar.storage_key,
    pdf_buffer: Buffer.from(email.calendar.ics, "utf8"),
    metadata: {
      delivery_id: `appointment:${entitlementId}`,
      recipient_token: `appointment:${entitlementId}`,
      generated_at: now.toISOString(),
      vendor_handles: [
        source.seller_handle ?? payload.vendor_id ?? "bonbeauty",
      ].filter((value): value is string => Boolean(value)),
    },
  })

  const notificationPayload = buildNotificationPayload({
    to: source.buyer_email,
    entitlementId,
    locale,
    email,
    marketId,
  })
  const result = await deps.dispatcher.dispatch(notificationPayload)
  const notificationId = extractNotificationId(result)

  if (notificationId === null) {
    // L-2: notification_id === null means the notification module returned no ID —
    // the module may lack createNotifications/send or returned an empty response.
    // Warn instead of silently reporting "sent" without evidence of delivery.
    deps.logger?.warn?.("[voucher-appointment-confirmed] notification dispatched but no notification_id returned — possible silent failure (misconfigured notification module?)", {
      entitlement_instance_id: entitlementId,
    })
  } else {
    deps.logger?.info?.("[voucher-appointment-confirmed] notification sent", {
      entitlement_instance_id: entitlementId,
      notification_id: notificationId,
    })
  }

  return {
    entitlement_instance_id: entitlementId,
    status: "sent",
    notification_id: notificationId,
    error_message: null,
  }
}

function buildAppointmentInput(
  payload: Partial<AppointmentConfirmedPayload>,
  source: AppointmentConfirmationDeliverySource,
  now: Date,
): VoucherAppointmentIcsInput {
  const missing = [
    "vendor_id",
    "location_id",
    "service_name",
    "starts_at",
    "ends_at",
    "timezone",
    "confirmation_source",
  ].filter((key) => !payload[key as keyof AppointmentConfirmedPayload])

  if (missing.length > 0 || !payload.entitlement_instance_id) {
    throw new Error(
      `[voucher-appointment-confirmed] payload niekompletny: brak ${missing.join(", ")}`,
    )
  }

  return {
    entitlement_instance_id: payload.entitlement_instance_id,
    appointment_id: payload.appointment_id ?? null,
    vendor_id: payload.vendor_id!,
    location_id: payload.location_id!,
    salon_name: source.salon_name ?? null,
    location_address: source.location_address ?? null,
    service_name: payload.service_name!,
    starts_at: payload.starts_at!,
    ends_at: payload.ends_at!,
    timezone: payload.timezone!,
    confirmation_source: payload.confirmation_source!,
    sequence: payload.sequence ?? 0,
    lifecycle_status: payload.lifecycle_status ?? "confirmed",
    now,
  }
}

function extractAppointmentPayload(
  data: AppointmentConfirmedEnvelope | Record<string, unknown>,
): Partial<AppointmentConfirmedPayload> {
  const maybeEnvelope = data as AppointmentConfirmedEnvelope
  if (maybeEnvelope.payload && typeof maybeEnvelope.payload === "object") {
    return maybeEnvelope.payload
  }

  return data as Partial<AppointmentConfirmedPayload>
}

/** Story 2.3 (AC6b) — rynek z `scope` koperty envelope.v1 (pole wymagane). */
function extractAppointmentScopeMarketId(
  data: AppointmentConfirmedEnvelope | Record<string, unknown>,
): string | null {
  const scope = (data as AppointmentConfirmedEnvelope).scope
  if (!scope || typeof scope !== "object") return null
  const marketId = scope.market_id
  if (typeof marketId !== "string") return null
  const trimmed = marketId.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildNotificationPayload(input: {
  to: string
  entitlementId: string
  locale: string
  email: VoucherAppointmentDeliveryEmail
  marketId: string
}): Record<string, unknown> {
  const marketId = input.marketId

  return {
    to: input.to,
    channel: "email",
    // `template` = pole kontraktu Medusy; `data.template_key` = kanoniczne GP
    // (ADR-158). Obie wartości z tej samej stałej rejestru.
    template: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_APPOINTMENT_CONFIRMATION,
    data: {
      template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_APPOINTMENT_CONFIRMATION,
      market_id: marketId,
      flow_id: "voucher_appointment",
      entitlement_instance_id: input.entitlementId,
      locale: input.locale,
      subject: input.email.subject,
      text: input.email.text,
      html: input.email.html,
      calendar_download_url: input.email.calendar?.download_url ?? null,
      attachments: input.email.attachments,
    },
    content: {
      subject: input.email.subject,
      text: input.email.text,
      html: input.email.html,
    },
    attachments: input.email.attachments,
    metadata: {
      notification_type: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_APPOINTMENT_CONFIRMATION,
      triggered_by: "system",
      event_type: VOUCHER_APPOINTMENT_CONFIRMED_EVENT,
      entitlement_instance_id: input.entitlementId,
      has_calendar_attachment: input.email.attachments.length > 0,
    },
  }
}

function createAppointmentNotificationDispatcher(
  notificationModule: NotificationModuleLike,
): AppointmentNotificationDispatcher {
  return {
    async dispatch(payload) {
      return typeof notificationModule.createNotifications === "function"
        ? notificationModule.createNotifications(payload)
        : notificationModule.send?.(payload)
    },
  }
}

function extractNotificationId(value: unknown): string | null {
  if (!value) return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractNotificationId(item)
      if (nested) return nested
    }
    return null
  }

  if (typeof value !== "object") return null

  const record = value as Record<string, unknown>
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id
  }

  for (const key of ["data", "notification", "notifications", "result", "results"] as const) {
    const nested = extractNotificationId(record[key])
    if (nested) return nested
  }

  return null
}

function resolveLogger(container: SubscriberArgs<Record<string, unknown>>["container"]): LoggerLike {
  try {
    return (container.resolve as unknown as (key: string) => LoggerLike)(
      "logger",
    )
  } catch {
    return console
  }
}

function resolveDownloadBaseUrl(): string {
  // Download link appoints a backend route (/api/v1/voucher-appointment-ics/:token)
  // served exclusively by Medusa — never the storefront origin. STOREFRONT_URL is
  // intentionally excluded from the fallback chain (M-1 finding).
  return (
    process.env.MEDUSA_BACKEND_URL ??
    process.env.BACKEND_URL ??
    DEFAULT_BACKEND_URL
  )
}

export default async function voucherAppointmentConfirmedDeliverySubscriber({
  event,
  container,
}: SubscriberArgs<AppointmentConfirmedEnvelope | Record<string, unknown>>) {
  const logger = resolveLogger(container)
  const sourceReader = container.resolve(VOUCHER_MODULE) as AppointmentSourceReader
  const notificationModule = container.resolve(Modules.NOTIFICATION) as NotificationModuleLike
  const artifactStorage = container.resolve(STORAGE_CONTAINER_KEY) as IVoucherPdfStorage
  const sql = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  try {
    const result = await handleVoucherAppointmentConfirmedDelivery(event.data, {
      sourceReader,
      dispatcher: createAppointmentNotificationDispatcher(notificationModule),
      artifactStorage,
      downloadBaseUrl: resolveDownloadBaseUrl(),
      hmacSecret: getHmacSecret(),
      marketLocales: createMarketLocalesReader(sql, logger),
      logger,
    })

    if (result.status === "failed") {
      logger.warn?.("[voucher-appointment-confirmed] delivery skipped", {
        entitlement_instance_id: result.entitlement_instance_id,
        error_message: result.error_message,
      })
    }
  } catch (error) {
    logger.error?.("[voucher-appointment-confirmed] delivery failed", error)
    throw error
  }
}

// L-1 finding: the Outlook rescue-path (lifecycle_status: rescheduled|cancelled)
// is implemented in the email composer (buildLifecycleStatusText) and covered by
// unit tests, but this subscriber only listens to `appointment_confirmed`. If
// reschedule/cancel are emitted as separate event types, the Outlook fallback will
// not trigger from those events. Wiring to reschedule/cancel events is deferred
// to a future story (Story 5.4 or Epic 6) once those event contracts are defined.
// The current contract (gp.voucher.appointment_confirmed.v1) does not define
// reschedule/cancel events — see specs/contracts/events/schemas/payloads/.
export const config: SubscriberConfig = {
  event: VOUCHER_APPOINTMENT_CONFIRMED_EVENT,
}
