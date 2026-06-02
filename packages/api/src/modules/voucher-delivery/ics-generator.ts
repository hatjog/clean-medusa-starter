import ical, {
  ICalCalendarMethod,
  ICalEventStatus,
} from "ical-generator";
import { getVtimezoneComponent } from "@touch4it/ical-timezones";

import { buildSignedToken } from "./storage/hmac";

export const VOUCHER_APPOINTMENT_TIMEZONE = "Europe/Warsaw";
export const VOUCHER_APPOINTMENT_SUMMARY_FALLBACK = "Wizyta BonBeauty";

const UID_DOMAIN = "bonbeauty";
const MAX_SCOPED_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export type VoucherAppointmentLifecycleStatus =
  | "confirmed"
  | "rescheduled"
  | "cancelled";

export type VoucherAppointmentManageLinkOptions = {
  base_url: string;
  secret: string;
  ttl_seconds?: number;
  scope?: string;
};

export type VoucherAppointmentIcsInput = {
  entitlement_instance_id: string;
  appointment_id?: string | null;
  vendor_id: string;
  location_id: string;
  salon_name?: string | null;
  location_address?: string | null;
  service_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  confirmation_source: string;
  sequence?: number | null;
  lifecycle_status?: VoucherAppointmentLifecycleStatus;
  manage_link?: VoucherAppointmentManageLinkOptions | null;
  now?: Date | string;
};

type RequiredAppointmentDates = Pick<
  VoucherAppointmentIcsInput,
  "starts_at" | "ends_at" | "timezone"
>;

export function buildAppointmentCalendarUid(
  input: Pick<VoucherAppointmentIcsInput, "appointment_id" | "entitlement_instance_id">,
): string {
  const entitlement = sanitizeUidPart(input.entitlement_instance_id);
  const appointment = sanitizeUidPart(input.appointment_id ?? "");

  if (!entitlement) {
    throw new Error("entitlement_instance_id is required for appointment UID");
  }

  return appointment
    ? `${entitlement}.${appointment}@${UID_DOMAIN}`
    : `${entitlement}@${UID_DOMAIN}`;
}

export function generateVoucherAppointmentIcs(input: VoucherAppointmentIcsInput): string {
  validateAppointmentWindow(input);

  const now = normalizeDate(input.now ?? new Date(), "now");
  const lifecycleStatus = input.lifecycle_status ?? "confirmed";
  const method =
    lifecycleStatus === "cancelled"
      ? ICalCalendarMethod.CANCEL
      : ICalCalendarMethod.PUBLISH;
  const eventStatus =
    lifecycleStatus === "cancelled"
      ? ICalEventStatus.CANCELLED
      : ICalEventStatus.CONFIRMED;
  const summary = buildSummary(input.salon_name, lifecycleStatus);
  const description = buildDescription(input.salon_name, lifecycleStatus);
  const url = buildManageUrl(input, now);

  const calendar = ical({
    name: "BonBeauty",
    prodId: {
      company: "Grow Platform",
      product: "BonBeauty Voucher Appointment Calendar",
      language: "PL",
    },
  });

  calendar.method(method);
  calendar.timezone({
    name: VOUCHER_APPOINTMENT_TIMEZONE,
    generator: getVtimezoneComponent as (timezone: string) => string,
  });

  calendar.createEvent({
    id: buildAppointmentCalendarUid(input),
    start: normalizeDate(input.starts_at, "starts_at"),
    end: normalizeDate(input.ends_at, "ends_at"),
    timezone: VOUCHER_APPOINTMENT_TIMEZONE,
    summary,
    description,
    location: buildLocation(input.salon_name, input.location_address),
    url,
    sequence: normalizeSequence(input.sequence),
    status: eventStatus,
    stamp: now,
  });

  return normalizeGeneratedIcs(calendar.toString(), input, now);
}

function validateAppointmentWindow(input: RequiredAppointmentDates): void {
  if (input.timezone !== VOUCHER_APPOINTMENT_TIMEZONE) {
    throw new Error(`voucher appointment .ics supports ${VOUCHER_APPOINTMENT_TIMEZONE} only`);
  }

  const startsAt = normalizeDate(input.starts_at, "starts_at");
  const endsAt = normalizeDate(input.ends_at, "ends_at");
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new Error("ends_at must be after starts_at");
  }
}

function sanitizeUidPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be a valid ISO date-time`);
  }
  return date;
}

function normalizeSequence(sequence: number | null | undefined): number {
  if (sequence === null || sequence === undefined) {
    return 0;
  }

  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error("sequence must be a non-negative integer");
  }

  return sequence;
}

function buildSummary(
  salonName: string | null | undefined,
  lifecycleStatus: VoucherAppointmentLifecycleStatus,
): string {
  const base = normalizeSalonName(salonName)
    ? `Wizyta w ${normalizeSalonName(salonName)}`
    : VOUCHER_APPOINTMENT_SUMMARY_FALLBACK;

  if (lifecycleStatus === "rescheduled") {
    return `${base} (zmiana terminu)`;
  }

  if (lifecycleStatus === "cancelled") {
    return `${base} (odwolano)`;
  }

  return base;
}

function buildDescription(
  salonName: string | null | undefined,
  lifecycleStatus: VoucherAppointmentLifecycleStatus,
): string {
  const name = normalizeSalonName(salonName) ?? "BonBeauty";

  if (lifecycleStatus === "rescheduled") {
    return `Status: zmiana terminu wizyty w ${name}.`;
  }

  if (lifecycleStatus === "cancelled") {
    return `Status: odwolano termin wizyty w ${name}.`;
  }

  return `Termin wizyty w ${name}.`;
}

function normalizeSalonName(salonName: string | null | undefined): string | null {
  const trimmed = salonName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function buildLocation(
  salonName: string | null | undefined,
  locationAddress: string | null | undefined,
): string | null {
  const parts = [normalizeSalonName(salonName), locationAddress?.trim()]
    .filter((part): part is string => Boolean(part && part.length > 0));

  return parts.length > 0 ? parts.join(", ") : null;
}

function buildManageUrl(input: VoucherAppointmentIcsInput, now: Date): string | null {
  const options = input.manage_link;
  if (!options) {
    return null;
  }

  const ttlSeconds = options.ttl_seconds ?? 24 * 60 * 60;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_SCOPED_TOKEN_TTL_SECONDS
  ) {
    throw new Error("manage_link.ttl_seconds must be between 1 and 604800");
  }

  const scope = options.scope?.trim() || "voucher_appointment_ics";
  const appointmentId = sanitizeUidPart(input.appointment_id ?? "") || "appointment";
  const storageKey = [
    scope,
    input.entitlement_instance_id,
    appointmentId,
    input.location_id,
  ].join("|");
  const expiresAt = now.getTime() + ttlSeconds * 1000;
  const token = buildSignedToken(storageKey, expiresAt, options.secret);
  const url = new URL(options.base_url);
  url.searchParams.set("token", token);
  return url.toString();
}

function normalizeGeneratedIcs(
  generated: string,
  input: Pick<VoucherAppointmentIcsInput, "starts_at" | "ends_at">,
  now: Date,
): string {
  const replacements = new Map<string, string>([
    [
      "DTSTART;TZID=Europe/Warsaw:",
      `DTSTART;TZID=Europe/Warsaw:${formatLocalDateTimeForIcs(input.starts_at)}`,
    ],
    [
      "DTEND;TZID=Europe/Warsaw:",
      `DTEND;TZID=Europe/Warsaw:${formatLocalDateTimeForIcs(input.ends_at)}`,
    ],
    ["DTSTAMP:", `DTSTAMP:${formatUtcDateTimeForIcs(now)}`],
  ]);

  return generated
    .split("\r\n")
    .map((line) => {
      for (const [prefix, replacement] of replacements) {
        if (line.startsWith(prefix)) {
          return replacement;
        }
      }
      return line;
    })
    .join("\r\n");
}

function formatLocalDateTimeForIcs(value: string): string {
  const date = normalizeDate(value, "appointment date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VOUCHER_APPOINTMENT_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return [
    byType.get("year"),
    byType.get("month"),
    byType.get("day"),
    "T",
    byType.get("hour"),
    byType.get("minute"),
    byType.get("second"),
  ].join("");
}

function formatUtcDateTimeForIcs(date: Date): string {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    "T",
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
    "Z",
  ].join("");
}
