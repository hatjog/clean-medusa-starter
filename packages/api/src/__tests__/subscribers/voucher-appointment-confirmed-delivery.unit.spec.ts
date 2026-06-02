import { describe, expect, it, jest } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"

import voucherAppointmentConfirmedDeliverySubscriber, {
  VOUCHER_APPOINTMENT_CONFIRMED_EVENT,
  handleVoucherAppointmentConfirmedDelivery,
} from "../../subscribers/voucher-appointment-confirmed-delivery"
import { VOUCHER_MODULE } from "../../modules/voucher"

const EVENT_ENVELOPE = {
  schema_version: "1",
  event_type: VOUCHER_APPOINTMENT_CONFIRMED_EVENT,
  occurred_at: "2026-06-02T08:30:00Z",
  scope: {
    instance_id: "gp-dev",
    market_id: "bonbeauty",
    vendor_id: "vendor_bonbeauty_001",
    location_id: "loc_bonbeauty_krakow_001",
  },
  idempotency_key: "bonbeauty:entinst_apt_001:appointment_confirmed",
  correlation_id: "entinst_apt_001",
  causation_id: "booking_confirmation:appt_001",
  payload: {
    entitlement_instance_id: "entinst_apt_001",
    vendor_id: "vendor_bonbeauty_001",
    location_id: "loc_bonbeauty_krakow_001",
    service_name: "Konsultacja dermatologiczna RAW-CODE-123",
    starts_at: "2026-06-18T10:00:00+02:00",
    ends_at: "2026-06-18T11:00:00+02:00",
    timezone: "Europe/Warsaw",
    confirmation_source: "vendor_panel",
  },
}

function buildEvent(data: Record<string, unknown>) {
  return {
    name: VOUCHER_APPOINTMENT_CONFIRMED_EVENT,
    data,
    metadata: {},
  }
}

function buildContainer(
  voucherService: Record<string, unknown>,
  notificationModule: Record<string, unknown>,
  storage: Record<string, unknown>,
) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }

  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === VOUCHER_MODULE) return voucherService
      if (key === Modules.NOTIFICATION) return notificationModule
      if (key === "voucher_pdf_storage") return storage
      throw new Error(`Unexpected container key: ${key}`)
    }),
    logger,
  }
}

describe("voucher appointment confirmed delivery subscriber", () => {
  it("resolves buyer source, stores .ics artifact and dispatches email notification", async () => {
    const findAppointmentConfirmationDeliverySource = jest.fn(async () => ({
      buyer_email: "buyer@example.test",
      buyer_locale: "pl",
      salon_name: "Salon Alfa",
      location_address: "ul. Karmelicka 10, Krakow",
      seller_handle: "salon-alfa",
    }))
    const createNotifications = jest.fn(async () => ({ id: "noti_appointment_1" }))
    const store = jest.fn(async () => ({ stored_at: "2026-06-02T08:31:00Z", version: 1 }))

    const result = await handleVoucherAppointmentConfirmedDelivery(
      EVENT_ENVELOPE,
      {
        sourceReader: { findAppointmentConfirmationDeliverySource },
        dispatcher: { dispatch: createNotifications },
        artifactStorage: { store },
        downloadBaseUrl: "https://api.bonbeauty.example",
        hmacSecret: "appointment-subscriber-secret",
        now: new Date("2026-06-02T08:00:00Z"),
      },
    )

    expect(result.status).toBe("sent")
    expect(findAppointmentConfirmationDeliverySource).toHaveBeenCalledWith(
      "entinst_apt_001",
    )
    expect(store).toHaveBeenCalledTimes(1)
    const storeCalls = store.mock.calls as unknown as Array<[Record<string, any>]>
    const stored = storeCalls[0][0]
    // I-2 fix: when appointment_id is absent the stable UID-based segment is used
    // (entitlement@bonbeauty → sanitized "entinst_apt_001-bonbeauty") instead of the
    // literal "appointment" fallback, preventing key collisions across multiple
    // confirmations for the same entitlement without a stable appointment_id.
    expect(stored.storage_key).toBe(
      "voucher-appointment-ics/entinst_apt_001/entinst_apt_001-bonbeauty.ics",
    )
    expect(stored.pdf_buffer.toString("utf8")).toContain("BEGIN:VCALENDAR")
    expect(stored.pdf_buffer.toString("utf8")).not.toContain("RAW-CODE-123")

    expect(createNotifications).toHaveBeenCalledTimes(1)
    const notificationCalls = createNotifications.mock.calls as unknown as Array<
      [Record<string, any>]
    >
    const notification = notificationCalls[0][0]
    expect(notification.to).toBe("buyer@example.test")
    expect(notification.template).toBe("voucher_appointment_confirmation")
    expect(notification.attachments).toHaveLength(1)
    expect(notification.attachments[0].content_type).toBe("text/calendar")
    expect(notification.data.calendar_download_url).toMatch(
      /^https:\/\/api\.bonbeauty\.example\/api\/v1\/voucher-appointment-ics\//,
    )
    expect(notification.data.text).toContain("Dodaj do kalendarza")
    expect(notification.data.text).toContain("art. 38 pkt 1")
    expect(JSON.stringify(notification)).not.toContain("Konsultacja dermatologiczna")
    expect(JSON.stringify(notification)).not.toContain("RAW-CODE-123")
  })

  it("fail-closed: brak buyer source nie wysyła maila ani nie zapisuje artefaktu", async () => {
    const result = await handleVoucherAppointmentConfirmedDelivery(
      EVENT_ENVELOPE,
      {
        sourceReader: {
          findAppointmentConfirmationDeliverySource: jest.fn(async () => null),
        },
        dispatcher: { dispatch: jest.fn(async () => undefined) },
        artifactStorage: {
          store: jest.fn(async () => ({
            stored_at: "2026-06-02T08:31:00Z",
            version: 1,
          })),
        },
        downloadBaseUrl: "https://api.bonbeauty.example",
        hmacSecret: "appointment-subscriber-secret",
        now: new Date("2026-06-02T08:00:00Z"),
      },
    )

    expect(result.status).toBe("failed")
    expect(result.error_message).toBe("appointment delivery source not found")
  })

  it("default subscriber resolves Medusa modules and delegates to the pure handler", async () => {
    const findAppointmentConfirmationDeliverySource = jest.fn(async () => ({
      buyer_email: "buyer@example.test",
      buyer_locale: "pl",
      salon_name: "Salon Alfa",
      location_address: "ul. Karmelicka 10, Krakow",
      seller_handle: "salon-alfa",
    }))
    const createNotifications = jest.fn(async () => ({ id: "noti_appointment_2" }))
    const store = jest.fn(async () => ({ stored_at: "2026-06-02T08:31:00Z", version: 1 }))
    const container = buildContainer(
      { findAppointmentConfirmationDeliverySource },
      { createNotifications },
      { store },
    )

    await voucherAppointmentConfirmedDeliverySubscriber({
      event: buildEvent(EVENT_ENVELOPE),
      container,
    } as any)

    expect(container.resolve).toHaveBeenCalledWith(VOUCHER_MODULE)
    expect(container.resolve).toHaveBeenCalledWith(Modules.NOTIFICATION)
    expect(container.resolve).toHaveBeenCalledWith("voucher_pdf_storage")
    expect(createNotifications).toHaveBeenCalledTimes(1)
    expect(store).toHaveBeenCalledTimes(1)
  })
})
