import { describe, expect, test } from "@jest/globals";

import {
  buildVoucherAppointmentDeliveryEmail,
  buildVoucherAppointmentIcsStorageKey,
  type VoucherAppointmentDeliveryEmailInput,
} from "../appointment-confirmation-email";
import { verifySignedToken } from "../storage/hmac";

const FIXED_NOW = new Date("2026-06-02T08:00:00Z");
const HMAC_SECRET = "appointment-email-secret";

const BASE_INPUT: VoucherAppointmentDeliveryEmailInput = {
  recipient_email: "buyer@example.test",
  salon_name: "Salon Alfa",
  location_address: "ul. Karmelicka 10, Krakow",
  download_base_url: "https://api.bonbeauty.example",
  hmac_secret: HMAC_SECRET,
  now: FIXED_NOW,
  appointment: {
    entitlement_instance_id: "entinst_apt_001",
    appointment_id: "appt_001",
    vendor_id: "vendor_bonbeauty_001",
    location_id: "loc_bonbeauty_krakow_001",
    salon_name: "Salon Alfa",
    location_address: "ul. Karmelicka 10, Krakow",
    service_name: "Konsultacja dermatologiczna RAW-VOUCHER-CODE-123",
    starts_at: "2026-06-18T10:00:00+02:00",
    ends_at: "2026-06-18T11:00:00+02:00",
    timezone: "Europe/Warsaw",
    confirmation_source: "vendor_panel",
    sequence: 0,
    lifecycle_status: "confirmed",
    now: FIXED_NOW,
  },
};

function render(overrides: Partial<VoucherAppointmentDeliveryEmailInput> = {}) {
  return buildVoucherAppointmentDeliveryEmail({
    ...BASE_INPUT,
    ...overrides,
    appointment:
      overrides.appointment === undefined
        ? BASE_INPUT.appointment
        : overrides.appointment,
  });
}

describe("buildVoucherAppointmentDeliveryEmail", () => {
  test("po appointment_confirmed dodaje attachment .ics, scoped download link i tekstowy CTA", () => {
    const email = render();

    expect(email.calendar).not.toBeNull();
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      filename: "bonbeauty-appointment-entinst_apt_001.ics",
      content_type: "text/calendar",
      disposition: "attachment",
    });
    expect(email.attachments[0].content).toContain("BEGIN:VCALENDAR");
    expect(email.attachments[0].content).toContain("TZID:Europe/Warsaw");
    expect(email.calendar!.download_url).toMatch(
      /^https:\/\/api\.bonbeauty\.example\/api\/v1\/voucher-appointment-ics\//,
    );
    expect(email.text).toContain("Dodaj do kalendarza");
    expect(email.html).toContain("Dodaj do kalendarza");

    const token = email.calendar!.download_url.split("/").pop()!;
    const verified = verifySignedToken(token, HMAC_SECRET);
    expect(verified).not.toBeNull();
    expect(verified!.storage_key).toBe(
      "voucher-appointment-ics/entinst_apt_001/appt_001.ics",
    );
    expect(verified!.expires_at).toBe(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000);
  });

  test("bramka open-term nie dodaje CTA, attachmentu ani download linku", () => {
    const email = render({ appointment: null });

    expect(email.calendar).toBeNull();
    expect(email.attachments).toHaveLength(0);
    expect(email.text).not.toContain("Dodaj do kalendarza");
    expect(email.html).not.toContain("Dodaj do kalendarza");
    expect(email.text).not.toContain(".ics");
    expect(email.html).not.toContain(".ics");
  });

  test("dubluje cancel/reschedule jako status tekstowy dla klientów Outlook", () => {
    const cancelled = render({
      appointment: {
        ...BASE_INPUT.appointment!,
        lifecycle_status: "cancelled",
        sequence: 2,
      },
    });

    expect(cancelled.text).toContain("Termin został odwołany");
    expect(cancelled.html).toContain("Termin został odwołany");
    expect(cancelled.attachments[0].content).toContain("METHOD:CANCEL");
    expect(cancelled.attachments[0].content).toContain("STATUS:CANCELLED");
  });

  test("copy o odstąpieniu używa art. 38 pkt 1 i nie cytuje pkt 12", () => {
    const email = render();
    const combined = `${email.text}\n${email.html}`;

    expect(combined).toContain("prawo do odstąpienia przysługuje do pełnego wykonania usługi");
    expect(combined).toContain("art. 38 pkt 1");
    expect(combined).toContain("kumulatywną zgodę");
    expect(combined).toContain("oświadczenie");
    expect(combined).not.toContain("pkt 12");
  });

  test("anti-leak guard usuwa service_name, kod vouchera i PII kupującego z treści/linku/.ics", () => {
    const email = render();
    const deliverySurface = [
      email.text,
      email.html,
      email.calendar?.download_url ?? "",
      email.attachments[0]?.content ?? "",
    ].join("\n");

    expect(deliverySurface).not.toContain("Konsultacja dermatologiczna");
    expect(deliverySurface).not.toContain("RAW-VOUCHER-CODE-123");
    expect(deliverySurface).not.toContain("buyer@example.test");
    expect(deliverySurface).not.toContain("service_name");
  });
});

describe("buildVoucherAppointmentIcsStorageKey", () => {
  test("buduje neutralny storage key bez gołego kodu vouchera", () => {
    const key = buildVoucherAppointmentIcsStorageKey(BASE_INPUT.appointment!);

    expect(key).toBe("voucher-appointment-ics/entinst_apt_001/appt_001.ics");
    expect(key).not.toContain("RAW-VOUCHER-CODE-123");
  });
});
