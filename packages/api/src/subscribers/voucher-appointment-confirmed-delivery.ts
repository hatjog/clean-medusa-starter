import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"

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

type AppointmentConfirmedEnvelope = {
  event_type?: string
  occurred_at?: string
  causation_id?: string
  payload?: Partial<AppointmentConfirmedPayload>
}

type AppointmentConfirmationDeliverySource = {
  buyer_email: string | null
  buyer_locale?: string | null
  salon_name?: string | null
  location_address?: string | null
  seller_handle?: string | null
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
    logger?: LoggerLike
    now?: Date
  },
): Promise<AppointmentConfirmationDeliveryResult> {
  const payload = extractAppointmentPayload(data)
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
    locale: source.buyer_locale ?? "pl",
    email,
  })
  const result = await deps.dispatcher.dispatch(notificationPayload)
  const notificationId = extractNotificationId(result)

  deps.logger?.info?.("[voucher-appointment-confirmed] notification sent", {
    entitlement_instance_id: entitlementId,
    notification_id: notificationId,
  })

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

function buildNotificationPayload(input: {
  to: string
  entitlementId: string
  locale: string
  email: VoucherAppointmentDeliveryEmail
}): Record<string, unknown> {
  return {
    to: input.to,
    channel: "email",
    template: "voucher_appointment_confirmation",
    data: {
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
      notification_type: "voucher_appointment_confirmation",
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
  return (
    process.env.MEDUSA_BACKEND_URL ??
    process.env.BACKEND_URL ??
    process.env.STOREFRONT_URL ??
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

  try {
    const result = await handleVoucherAppointmentConfirmedDelivery(event.data, {
      sourceReader,
      dispatcher: createAppointmentNotificationDispatcher(notificationModule),
      artifactStorage,
      downloadBaseUrl: resolveDownloadBaseUrl(),
      hmacSecret: getHmacSecret(),
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

export const config: SubscriberConfig = {
  event: VOUCHER_APPOINTMENT_CONFIRMED_EVENT,
}
