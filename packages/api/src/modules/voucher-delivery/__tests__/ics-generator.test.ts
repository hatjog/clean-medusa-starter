/**
 * ics-generator.test.ts — Story 5.2: neutral appointment .ics generator.
 *
 * Covers stable UID, Europe/Warsaw VTIMEZONE/DST, PHI/PII anti-leak guard,
 * scoped HMAC token, reschedule SEQUENCE and cancel METHOD/STATUS.
 */

import { describe, expect, jest, test } from "@jest/globals";

import {
  buildAppointmentCalendarUid,
  generateVoucherAppointmentIcs,
  type VoucherAppointmentIcsInput,
} from "../ics-generator";
import { verifySignedToken } from "../storage/hmac";

const FIXED_NOW = new Date("2026-06-02T08:00:00Z");

const BASE_INPUT: VoucherAppointmentIcsInput = {
  entitlement_instance_id: "entinst_apt_001",
  appointment_id: "appt_001",
  vendor_id: "vendor_bonbeauty_001",
  location_id: "loc_bonbeauty_krakow_001",
  salon_name: "Salon Alfa",
  location_address: "ul. Karmelicka 10, Krakow",
  service_name: "Konsultacja dermatologiczna VOUCHER-SECRET-123",
  starts_at: "2026-06-18T10:00:00+02:00",
  ends_at: "2026-06-18T11:00:00+02:00",
  timezone: "Europe/Warsaw",
  confirmation_source: "vendor_panel",
  sequence: 0,
  lifecycle_status: "confirmed",
};

function render(input: Partial<VoucherAppointmentIcsInput> = {}): string {
  return generateVoucherAppointmentIcs({
    ...BASE_INPUT,
    ...input,
    now: input.now ?? FIXED_NOW,
  });
}

function lineFor(ics: string, prefix: string): string {
  const line = unfoldIcs(ics)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(`missing iCal line: ${prefix}`);
  }
  return line;
}

function lineMatching(ics: string, pattern: RegExp): string {
  const line = unfoldIcs(ics)
    .split(/\r?\n/)
    .find((candidate) => pattern.test(candidate));
  if (!line) {
    throw new Error(`missing iCal line matching: ${pattern}`);
  }
  return line;
}

function unfoldIcs(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "");
}

describe("generateVoucherAppointmentIcs — AC1 neutral payload", () => {
  test("uses deterministic UID per entitlement + appointment", () => {
    const uid = buildAppointmentCalendarUid(BASE_INPUT);
    expect(uid).toBe("entinst_apt_001.appt_001@bonbeauty");

    const first = render({ now: new Date("2026-06-02T08:00:00Z") });
    const second = render({ now: new Date("2026-06-03T08:00:00Z") });

    expect(lineFor(first, "UID:")).toBe(`UID:${uid}`);
    expect(lineFor(second, "UID:")).toBe(`UID:${uid}`);
  });

  test("emits neutral summary, fallback summary and deterministic DTSTAMP", () => {
    const withSalon = render();
    expect(lineFor(withSalon, "SUMMARY:")).toBe("SUMMARY:Wizyta w Salon Alfa");
    expect(lineFor(withSalon, "DTSTAMP:")).toBe("DTSTAMP:20260602T080000Z");

    const fallback = render({ salon_name: "" });
    expect(lineFor(fallback, "SUMMARY:")).toBe("SUMMARY:Wizyta BonBeauty");
  });

  test("does not leak service name, voucher code or health markers", () => {
    const serviceNameValue = "Zabieg medyczny dermatologia VOUCHER-SECRET-123";
    const ics = render({
      service_name: serviceNameValue,
      // Extra raw code must be ignored even if a future caller passes it.
      voucher_code: "VOUCHER-SECRET-123",
    } as Partial<VoucherAppointmentIcsInput>);

    expect(ics).not.toContain("Zabieg medyczny");
    expect(ics).not.toContain("dermatologia");
    expect(ics).not.toContain("Konsultacja dermatologiczna");
    expect(ics).not.toContain("VOUCHER-SECRET-123");
    expect(ics).not.toContain("service_name");
    // Property-based: literal value of service_name must never appear in output
    // regardless of content (L-3 fix — structural invariant, not denylist).
    expect(ics).not.toContain(serviceNameValue);
  });

  test("service_name with arbitrary value never appears in ics output (property-based L-3)", () => {
    const uniqueMarker = "UNIQUE-SERVICE-MARKER-XYZ-987654";
    const ics = render({ service_name: uniqueMarker });
    expect(ics).not.toContain(uniqueMarker);
  });

  test("optional manage link uses scoped HMAC token, never a raw voucher code", () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const secret = "ics-test-secret";
    try {
      const ics = render({
        manage_link: {
          base_url: "https://bonbeauty.example/appointments/manage",
          secret,
          ttl_seconds: 3600,
          scope: "voucher_appointment_ics",
        },
        voucher_code: "RAW-CODE-DO-NOT-LEAK",
      } as Partial<VoucherAppointmentIcsInput>);

      const urlLine = lineMatching(ics, /^URL(?:;VALUE=URI)?:/);
      expect(urlLine).toMatch(
        /^URL(?:;VALUE=URI)?:https:\/\/bonbeauty\.example\/appointments\/manage\?token=/,
      );
      expect(ics).not.toContain("RAW-CODE-DO-NOT-LEAK");

      const token = decodeURIComponent(urlLine.split("token=")[1]!);
      const verified = verifySignedToken(token, secret);
      expect(verified).not.toBeNull();
      expect(verified!.storage_key).toBe(
        "voucher_appointment_ics|entinst_apt_001|appt_001|loc_bonbeauty_krakow_001",
      );
      expect(verified!.expires_at).toBe(FIXED_NOW.getTime() + 3600 * 1000);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("generateVoucherAppointmentIcs — AC2 Europe/Warsaw DST", () => {
  test("includes VTIMEZONE rules and DTSTART/DTEND in Europe/Warsaw for spring DST", () => {
    const ics = render({
      starts_at: "2026-03-29T10:00:00+02:00",
      ends_at: "2026-03-29T11:00:00+02:00",
    });

    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Europe/Warsaw");
    expect(ics).toContain("BEGIN:DAYLIGHT");
    expect(ics).toContain("TZOFFSETTO:+0200");
    expect(ics).toContain("BEGIN:STANDARD");
    expect(ics).toContain("TZOFFSETTO:+0100");
    expect(lineFor(ics, "DTSTART;TZID=Europe/Warsaw:")).toBe(
      "DTSTART;TZID=Europe/Warsaw:20260329T100000",
    );
    expect(lineFor(ics, "DTEND;TZID=Europe/Warsaw:")).toBe(
      "DTEND;TZID=Europe/Warsaw:20260329T110000",
    );
  });

  test("keeps local appointment time stable for autumn DST and a non-DST control date", () => {
    const autumn = render({
      starts_at: "2026-10-25T10:00:00+01:00",
      ends_at: "2026-10-25T11:00:00+01:00",
    });
    expect(lineFor(autumn, "DTSTART;TZID=Europe/Warsaw:")).toBe(
      "DTSTART;TZID=Europe/Warsaw:20261025T100000",
    );

    const winter = render({
      starts_at: "2026-01-15T09:30:00+01:00",
      ends_at: "2026-01-15T10:30:00+01:00",
    });
    expect(lineFor(winter, "DTSTART;TZID=Europe/Warsaw:")).toBe(
      "DTSTART;TZID=Europe/Warsaw:20260115T093000",
    );
  });
});

describe("generateVoucherAppointmentIcs — AC3 reschedule and cancel", () => {
  test("reschedule preserves UID, increments SEQUENCE and communicates status in text", () => {
    const original = render({ sequence: 0 });
    const rescheduled = render({
      starts_at: "2026-06-19T12:00:00+02:00",
      ends_at: "2026-06-19T13:00:00+02:00",
      sequence: 1,
      lifecycle_status: "rescheduled",
    });

    expect(lineFor(rescheduled, "UID:")).toBe(lineFor(original, "UID:"));
    expect(lineFor(rescheduled, "SEQUENCE:")).toBe("SEQUENCE:1");
    expect(lineFor(rescheduled, "SUMMARY:")).toBe(
      "SUMMARY:Wizyta w Salon Alfa (zmiana terminu)",
    );
    expect(lineFor(rescheduled, "DESCRIPTION:")).toContain("zmiana terminu");
  });

  test("UID is stable when only time and sequence change (L-1 invariant)", () => {
    // Simulates the reschedule scenario from Story 5.3 perspective:
    // same appointment_id + entitlement_instance_id, different time slot.
    const uid1 = lineFor(
      render({ sequence: 0, starts_at: "2026-06-18T10:00:00+02:00", ends_at: "2026-06-18T11:00:00+02:00" }),
      "UID:",
    );
    const uid2 = lineFor(
      render({ sequence: 1, starts_at: "2026-06-25T14:00:00+02:00", ends_at: "2026-06-25T15:00:00+02:00", lifecycle_status: "rescheduled" }),
      "UID:",
    );
    const uid3 = lineFor(
      render({ sequence: 2, lifecycle_status: "cancelled" }),
      "UID:",
    );
    expect(uid1).toBe(uid2);
    expect(uid2).toBe(uid3);
  });

  test("cancel emits METHOD:CANCEL, STATUS:CANCELLED, stable UID and neutral status text", () => {
    const original = render({ sequence: 1 });
    const cancelled = render({
      sequence: 2,
      lifecycle_status: "cancelled",
    });

    expect(lineFor(cancelled, "METHOD:")).toBe("METHOD:CANCEL");
    expect(lineFor(cancelled, "STATUS:")).toBe("STATUS:CANCELLED");
    expect(lineFor(cancelled, "UID:")).toBe(lineFor(original, "UID:"));
    expect(lineFor(cancelled, "SEQUENCE:")).toBe("SEQUENCE:2");
    expect(lineFor(cancelled, "SUMMARY:")).toBe("SUMMARY:Wizyta w Salon Alfa (odwołano)");
    expect(lineFor(cancelled, "DESCRIPTION:")).toContain("odwołano");
    expect(cancelled).not.toContain("Konsultacja dermatologiczna");
  });

  test("rejects invalid appointment windows and unsupported timezone", () => {
    expect(() =>
      render({
        starts_at: "2026-06-18T11:00:00+02:00",
        ends_at: "2026-06-18T10:00:00+02:00",
      }),
    ).toThrow(/ends_at must be after starts_at/);

    expect(() => render({ timezone: "UTC" })).toThrow(/Europe\/Warsaw/);
  });
});
