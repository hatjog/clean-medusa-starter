import ical, {
  ICalCalendarMethod,
  ICalEventStatus,
} from "ical-generator";
import { getVtimezoneComponent } from "@touch4it/ical-timezones";

import {
  normalizeVoucherAppointmentLocale,
  renderAppointmentCopy,
  VOUCHER_APPOINTMENT_COPY,
  type VoucherAppointmentLocale,
} from "./appointment-i18n";
import { buildSignedToken } from "./storage/hmac";

export const VOUCHER_APPOINTMENT_TIMEZONE = "Europe/Warsaw";
/**
 * Fallback summary for legacy consumers that have not yet migrated to the
 * locale-aware i18n path. Derived from the PL i18n bundle to avoid drift.
 */
export const VOUCHER_APPOINTMENT_SUMMARY_FALLBACK: string =
  VOUCHER_APPOINTMENT_COPY.pl.ics_summary_default ?? "Wizyta BonBeauty";

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
  vendor_id?: string | null;
  location_id: string;
  salon_name?: string | null;
  location_address?: string | null;
  /**
   * Intentionally ignored — NEVER emit.
   * Stored only for caller convenience (e.g. routing); must NOT appear in .ics
   * output (FR42, UX-DR-06, Q7 — RODO neutral payload).
   */
  service_name?: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  /**
   * Intentionally ignored — NEVER emit.
   * Stored only for caller routing; must NOT appear in .ics output.
   */
  confirmation_source?: string | null;
  sequence?: number | null;
  lifecycle_status?: VoucherAppointmentLifecycleStatus;
  locale?: VoucherAppointmentLocale;
  manage_link?: VoucherAppointmentManageLinkOptions | null;
  now?: Date | string;
};

type RequiredAppointmentDates = Pick<
  VoucherAppointmentIcsInput,
  "starts_at" | "ends_at" | "timezone"
>;

/**
 * Builds a stable, deterministic calendar UID for an appointment.
 *
 * UID = `<entitlement_instance_id>[.<appointment_id>]@bonbeauty`
 *
 * INVARIANT (AC3): for a reschedule to update the same calendar event (rather
 * than create a duplicate), the caller MUST pass the same `appointment_id`
 * across all lifecycle states (confirmed → rescheduled → cancelled).
 * If the upstream domain uses a new `appointment_id` per time-slot, callers
 * should omit `appointment_id` and rely solely on `entitlement_instance_id`
 * to guarantee UID stability.
 *
 * Story 5.3 (subscriber wiring) MUST document and enforce this invariant.
 */
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
  const locale = normalizeVoucherAppointmentLocale(input.locale);
  const method =
    lifecycleStatus === "cancelled"
      ? ICalCalendarMethod.CANCEL
      : ICalCalendarMethod.PUBLISH;
  const eventStatus =
    lifecycleStatus === "cancelled"
      ? ICalEventStatus.CANCELLED
      : ICalEventStatus.CONFIRMED;
  const summary = buildSummary(input.salon_name, lifecycleStatus, locale);
  const description = buildDescription(input.salon_name, lifecycleStatus, locale);
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
  locale: VoucherAppointmentLocale,
): string {
  const normalizedSalonName = normalizeSalonName(salonName);
  const base = normalizedSalonName
    ? renderAppointmentCopy(locale, "ics_summary_salon", { salon: normalizedSalonName })
    : renderAppointmentCopy(locale, "ics_summary_default");

  if (lifecycleStatus === "rescheduled") {
    return `${base} (${renderAppointmentCopy(locale, "ics_summary_rescheduled_suffix")})`;
  }

  if (lifecycleStatus === "cancelled") {
    return `${base} (${renderAppointmentCopy(locale, "ics_summary_cancelled_suffix")})`;
  }

  return base;
}

function buildDescription(
  salonName: string | null | undefined,
  lifecycleStatus: VoucherAppointmentLifecycleStatus,
  locale: VoucherAppointmentLocale,
): string {
  const name = normalizeSalonName(salonName) ?? "BonBeauty";

  if (lifecycleStatus === "rescheduled") {
    return renderAppointmentCopy(locale, "ics_description_rescheduled", { salon: name });
  }

  if (lifecycleStatus === "cancelled") {
    return renderAppointmentCopy(locale, "ics_description_cancelled", { salon: name });
  }

  return renderAppointmentCopy(locale, "ics_description_confirmed", { salon: name });
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
    throw new Error(
      `manage_link.ttl_seconds must be between 1 and ${MAX_SCOPED_TOKEN_TTL_SECONDS}`,
    );
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
  /**
   * Critical DST-correctness layer: ical-generator may emit DTSTART/DTEND with
   * UTC-shifted values under the TZID label. We override them with wall-clock
   * local times computed via Intl.DateTimeFormat(Europe/Warsaw).
   *
   * DTSTAMP is also overridden for deterministic test snapshots (mirrors the
   * `stamp: now` value already passed to createEvent, but serialised in our
   * canonical UTC format).
   *
   * Fail-closed guard (M-1 fix): after the pass we assert that every expected
   * line was matched exactly once. If ical-generator ever changes its output
   * format (e.g. adds VALUE= parameter, changes TZID quoting, emits folded
   * lines), the substitution will silently miss and we will throw here instead
   * of emitting a .ics with a wrong appointment time.
   */
  const DTSTART_PREFIX = "DTSTART;TZID=Europe/Warsaw:";
  const DTEND_PREFIX = "DTEND;TZID=Europe/Warsaw:";
  const DTSTAMP_PREFIX = "DTSTAMP:";

  const replacements = new Map<string, string>([
    [
      DTSTART_PREFIX,
      `${DTSTART_PREFIX}${formatLocalDateTimeForIcs(input.starts_at)}`,
    ],
    [
      DTEND_PREFIX,
      `${DTEND_PREFIX}${formatLocalDateTimeForIcs(input.ends_at)}`,
    ],
    [DTSTAMP_PREFIX, `${DTSTAMP_PREFIX}${formatUtcDateTimeForIcs(now)}`],
  ]);

  const hitCount = new Map<string, number>(
    [...replacements.keys()].map((k) => [k, 0]),
  );

  const result = generated
    .split("\r\n")
    .map((line) => {
      for (const [prefix, replacement] of replacements) {
        if (line.startsWith(prefix)) {
          hitCount.set(prefix, (hitCount.get(prefix) ?? 0) + 1);
          return replacement;
        }
      }
      return line;
    })
    .join("\r\n");

  // Fail-closed: each critical line must have been matched exactly once.
  for (const [prefix, count] of hitCount) {
    if (count !== 1) {
      throw new Error(
        `ics-generator: expected exactly 1 occurrence of "${prefix}" in ical-generator output, ` +
          `got ${count}. ical-generator output format may have changed — update normalizeGeneratedIcs accordingly.`,
      );
    }
  }

  return result;
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
