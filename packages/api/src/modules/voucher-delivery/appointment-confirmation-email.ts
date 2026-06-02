import {
  generateVoucherAppointmentIcs,
  buildAppointmentCalendarUid,
  type VoucherAppointmentIcsInput,
} from "./ics-generator";
import { buildSignedToken } from "./storage/hmac";

export const VOUCHER_APPOINTMENT_ICS_STORAGE_SCOPE =
  "voucher-appointment-ics";
export const VOUCHER_APPOINTMENT_ICS_DOWNLOAD_ROUTE =
  "/api/v1/voucher-appointment-ics";

const DEFAULT_DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export type VoucherAppointmentDeliveryAttachment = {
  filename: string;
  content: string;
  content_type: "text/calendar";
  contentType: "text/calendar";
  mime_type: "text/calendar";
  disposition: "attachment";
};

export type VoucherAppointmentDeliveryCalendar = {
  ics: string;
  storage_key: string;
  download_url: string;
  filename: string;
};

export type VoucherAppointmentDeliveryEmail = {
  subject: string;
  text: string;
  html: string;
  attachments: VoucherAppointmentDeliveryAttachment[];
  calendar: VoucherAppointmentDeliveryCalendar | null;
};

export type VoucherAppointmentDeliveryEmailInput = {
  recipient_email: string;
  salon_name?: string | null;
  location_address?: string | null;
  appointment: VoucherAppointmentIcsInput | null;
  download_base_url: string;
  hmac_secret: string;
  ttl_seconds?: number;
  now?: Date | string;
};

export function buildVoucherAppointmentIcsStorageKey(
  appointment: Pick<
    VoucherAppointmentIcsInput,
    "appointment_id" | "entitlement_instance_id"
  >,
): string {
  const entitlement = sanitizeStorageSegment(appointment.entitlement_instance_id);

  if (!entitlement) {
    throw new Error("entitlement_instance_id is required for .ics storage key");
  }

  const sanitizedAppointmentId = sanitizeStorageSegment(
    appointment.appointment_id ?? "",
  );

  // I-2: When appointment_id is absent, fall back to the stable calendar UID
  // (derived from entitlement_instance_id by the ICS generator) so that multiple
  // confirmations for the same entitlement without an appointment_id map to the
  // same storage key rather than all collapsing to the literal "appointment" segment.
  const keySegment =
    sanitizedAppointmentId ||
    sanitizeStorageSegment(buildAppointmentCalendarUid(appointment));

  return `${VOUCHER_APPOINTMENT_ICS_STORAGE_SCOPE}/${entitlement}/${keySegment}.ics`;
}

export function isVoucherAppointmentIcsStorageKey(
  storageKey: string,
): boolean {
  return (
    storageKey.startsWith(`${VOUCHER_APPOINTMENT_ICS_STORAGE_SCOPE}/`) &&
    storageKey.endsWith(".ics") &&
    !storageKey.includes("..") &&
    !storageKey.includes("\0")
  );
}

export function buildVoucherAppointmentDeliveryEmail(
  input: VoucherAppointmentDeliveryEmailInput,
): VoucherAppointmentDeliveryEmail {
  const now = normalizeDate(input.now ?? new Date(), "now");
  const withdrawalCopy = buildWithdrawalCopy();

  if (!input.appointment) {
    const subject = "Voucher BonBeauty - termin pozostaje otwarty";
    const text = [
      "Voucher został dostarczony.",
      "Termin pozostaje otwarty. Po potwierdzeniu wizyty wyślemy osobne potwierdzenie kalendarzowe.",
      withdrawalCopy,
    ].join("\n\n");
    const html = [
      "<p>Voucher został dostarczony.</p>",
      "<p>Termin pozostaje otwarty. Po potwierdzeniu wizyty wyślemy osobne potwierdzenie kalendarzowe.</p>",
      `<p>${escapeHtml(withdrawalCopy)}</p>`,
    ].join("");

    return {
      subject,
      text,
      html,
      attachments: [],
      calendar: null,
    };
  }

  const appointment = input.appointment;
  const lifecycleStatus = appointment.lifecycle_status ?? "confirmed";
  const ics = generateVoucherAppointmentIcs({
    ...appointment,
    salon_name: input.salon_name ?? appointment.salon_name ?? null,
    location_address:
      input.location_address ?? appointment.location_address ?? null,
    now,
  });
  const storageKey = buildVoucherAppointmentIcsStorageKey(appointment);
  const filename = `bonbeauty-appointment-${sanitizeStorageSegment(
    appointment.entitlement_instance_id,
  )}.ics`;
  const downloadUrl = buildDownloadUrl({
    baseUrl: input.download_base_url,
    storageKey,
    secret: input.hmac_secret,
    ttlSeconds: input.ttl_seconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS,
    now,
  });
  const calendar: VoucherAppointmentDeliveryCalendar = {
    ics,
    storage_key: storageKey,
    download_url: downloadUrl,
    filename,
  };
  const statusText = buildLifecycleStatusText(lifecycleStatus);
  const appointmentWindow = formatAppointmentWindow(appointment);
  const salonName = normalizeDisplayName(input.salon_name ?? appointment.salon_name);
  const location = normalizeDisplayName(
    input.location_address ?? appointment.location_address,
  );
  const subject = buildSubject(lifecycleStatus);
  const text = [
    statusText,
    salonName ? `Miejsce: ${salonName}.` : "Miejsce: BonBeauty.",
    location ? `Adres: ${location}.` : null,
    appointmentWindow ? `Termin: ${appointmentWindow}.` : null,
    "W załączniku znajdziesz plik .ics.",
    `Dodaj do kalendarza: ${downloadUrl}`,
    withdrawalCopy,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
  const html = [
    `<p>${escapeHtml(statusText)}</p>`,
    `<p>${escapeHtml(salonName ? `Miejsce: ${salonName}.` : "Miejsce: BonBeauty.")}</p>`,
    location ? `<p>${escapeHtml(`Adres: ${location}.`)}</p>` : "",
    appointmentWindow ? `<p>${escapeHtml(`Termin: ${appointmentWindow}.`)}</p>` : "",
    "<p>W załączniku znajdziesz plik .ics.</p>",
    `<p><a href="${escapeHtml(downloadUrl)}">Dodaj do kalendarza</a></p>`,
    `<p>${escapeHtml(withdrawalCopy)}</p>`,
  ].join("");
  const attachment: VoucherAppointmentDeliveryAttachment = {
    filename,
    content: ics,
    content_type: "text/calendar",
    contentType: "text/calendar",
    mime_type: "text/calendar",
    disposition: "attachment",
  };

  assertNeutralDeliverySurface(input, {
    text,
    html,
    ics,
    downloadUrl,
  });

  return {
    subject,
    text,
    html,
    attachments: [attachment],
    calendar,
  };
}

function buildDownloadUrl(input: {
  baseUrl: string;
  storageKey: string;
  secret: string;
  ttlSeconds: number;
  now: Date;
}): string {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new Error("download ttl_seconds must be a positive integer");
  }

  const expiresAt = input.now.getTime() + input.ttlSeconds * 1000;
  const token = buildSignedToken(input.storageKey, expiresAt, input.secret);
  return new URL(
    `${VOUCHER_APPOINTMENT_ICS_DOWNLOAD_ROUTE}/${token}`,
    input.baseUrl,
  ).toString();
}

function buildLifecycleStatusText(
  lifecycleStatus: VoucherAppointmentIcsInput["lifecycle_status"],
): string {
  if (lifecycleStatus === "rescheduled") {
    return "Termin został zmieniony.";
  }

  if (lifecycleStatus === "cancelled") {
    return "Termin został odwołany.";
  }

  return "Termin został potwierdzony.";
}

function buildSubject(
  lifecycleStatus: VoucherAppointmentIcsInput["lifecycle_status"],
): string {
  if (lifecycleStatus === "rescheduled") {
    return "Zmiana terminu wizyty BonBeauty";
  }

  if (lifecycleStatus === "cancelled") {
    return "Odwołanie terminu wizyty BonBeauty";
  }

  return "Potwierdzenie terminu wizyty BonBeauty";
}

function buildWithdrawalCopy(): string {
  return [
    "prawo do odstąpienia przysługuje do pełnego wykonania usługi",
    "zgodnie z art. 38 pkt 1 ustawy o prawach konsumenta.",
    "Przy zakupie zebraliśmy kumulatywną zgodę na rozpoczęcie świadczenia przed upływem terminu odstąpienia oraz oświadczenie dotyczące utraty prawa po pełnym wykonaniu usługi.",
  ].join(" ");
}

function formatAppointmentWindow(
  appointment: Pick<VoucherAppointmentIcsInput, "starts_at" | "ends_at">,
): string {
  const startsAt = normalizeDate(appointment.starts_at, "starts_at");
  const endsAt = normalizeDate(appointment.ends_at, "ends_at");
  const date = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(startsAt);
  const time = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${date}, ${time.format(startsAt)}-${time.format(endsAt)}`;
}

function normalizeDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be a valid ISO date-time`);
  }
  return date;
}

function normalizeDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function sanitizeStorageSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

function assertNeutralDeliverySurface(
  input: VoucherAppointmentDeliveryEmailInput,
  surface: {
    text: string;
    html: string;
    ics: string;
    downloadUrl: string;
  },
): void {
  const appointmentRecord = (input.appointment ?? {}) as Record<string, unknown>;
  const sensitiveValues = [
    input.recipient_email,
    appointmentRecord.service_name,
    appointmentRecord.voucher_code,
    appointmentRecord.buyer_email,
    appointmentRecord.buyer_first_name,
    appointmentRecord.buyer_last_name,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    // I-1: threshold lowered to >= 2 to catch 2-char sensitive values (e.g. short last names).
    .filter((value) => value.length >= 2);
  const combined = [
    surface.text,
    surface.html,
    surface.ics,
    surface.downloadUrl,
  ].join("\n");

  for (const sensitiveValue of sensitiveValues) {
    if (combined.includes(sensitiveValue)) {
      throw new Error(
        "voucher appointment delivery neutral-payload guard rejected sensitive content",
      );
    }
  }
}
