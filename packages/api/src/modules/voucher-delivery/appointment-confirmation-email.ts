import {
  generateVoucherAppointmentIcs,
  buildAppointmentCalendarUid,
  type VoucherAppointmentIcsInput,
} from "./ics-generator";
import {
  normalizeVoucherAppointmentLocale,
  renderAppointmentCopy,
  voucherAppointmentHtmlLang,
  type VoucherAppointmentLocale,
} from "./appointment-i18n";
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
export const VOUCHER_APPOINTMENT_EMAIL_A11Y_TOKENS = Object.freeze({
  background: "#ffffff",
  bodyText: "#1f2933",
  ctaBackground: "#1f2937",
  ctaText: "#ffffff",
  focusOutline: "#0b5fff",
  accentBorder: "#b0892f",
  minTargetPx: 44,
});

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
  locale?: VoucherAppointmentLocale;
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
  const locale = normalizeVoucherAppointmentLocale(input.locale);
  const withdrawalCopy = buildWithdrawalCopy(locale);

  if (!input.appointment) {
    const subject = renderAppointmentCopy(locale, "email_subject_open");
    const statusText = renderAppointmentCopy(locale, "email_status_open");
    const followupText = renderAppointmentCopy(locale, "email_open_followup");
    const text = [
      statusText,
      followupText,
      withdrawalCopy,
    ].join("\n\n");
    const html = renderEmailHtml({
      locale,
      subject,
      bodyLines: [statusText, followupText, withdrawalCopy],
    });

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
    locale,
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
  const statusText = buildLifecycleStatusText(lifecycleStatus, locale);
  const appointmentWindow = formatAppointmentWindow(appointment, locale);
  const salonName = normalizeDisplayName(input.salon_name ?? appointment.salon_name);
  const location = normalizeDisplayName(
    input.location_address ?? appointment.location_address,
  );
  const subject = buildSubject(lifecycleStatus, locale);
  const text = [
    statusText,
    salonName
      ? renderAppointmentCopy(locale, "email_place_known", { salon: salonName })
      : renderAppointmentCopy(locale, "email_place_default"),
    location ? renderAppointmentCopy(locale, "email_address", { address: location }) : null,
    appointmentWindow
      ? renderAppointmentCopy(locale, "email_term", { window: appointmentWindow })
      : null,
    renderAppointmentCopy(locale, "email_attachment_copy"),
    renderAppointmentCopy(locale, "email_calendar_text", { url: downloadUrl }),
    withdrawalCopy,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
  const bodyLines = [
    statusText,
    salonName
      ? renderAppointmentCopy(locale, "email_place_known", { salon: salonName })
      : renderAppointmentCopy(locale, "email_place_default"),
    location ? renderAppointmentCopy(locale, "email_address", { address: location }) : null,
    appointmentWindow
      ? renderAppointmentCopy(locale, "email_term", { window: appointmentWindow })
      : null,
    renderAppointmentCopy(locale, "email_attachment_copy"),
    withdrawalCopy,
  ].filter((line): line is string => Boolean(line));
  const html = renderEmailHtml({
    locale,
    subject,
    bodyLines,
    cta: {
      url: downloadUrl,
      label: renderAppointmentCopy(locale, "email_calendar_cta"),
    },
  });
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
  locale: VoucherAppointmentLocale,
): string {
  if (lifecycleStatus === "rescheduled") {
    return renderAppointmentCopy(locale, "email_status_rescheduled");
  }

  if (lifecycleStatus === "cancelled") {
    return renderAppointmentCopy(locale, "email_status_cancelled");
  }

  return renderAppointmentCopy(locale, "email_status_confirmed");
}

function buildSubject(
  lifecycleStatus: VoucherAppointmentIcsInput["lifecycle_status"],
  locale: VoucherAppointmentLocale,
): string {
  if (lifecycleStatus === "rescheduled") {
    return renderAppointmentCopy(locale, "email_subject_rescheduled");
  }

  if (lifecycleStatus === "cancelled") {
    return renderAppointmentCopy(locale, "email_subject_cancelled");
  }

  return renderAppointmentCopy(locale, "email_subject_confirmed");
}

function buildWithdrawalCopy(locale: VoucherAppointmentLocale): string {
  return renderAppointmentCopy(locale, "email_withdrawal_copy");
}

function formatAppointmentWindow(
  appointment: Pick<VoucherAppointmentIcsInput, "starts_at" | "ends_at">,
  locale: VoucherAppointmentLocale,
): string {
  const startsAt = normalizeDate(appointment.starts_at, "starts_at");
  const endsAt = normalizeDate(appointment.ends_at, "ends_at");
  const date = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(startsAt);
  const time = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${date}, ${time.format(startsAt)}-${time.format(endsAt)}`;
}

function resolveIntlLocale(locale: VoucherAppointmentLocale): string {
  if (locale === "en") {
    return "en-GB";
  }

  if (locale === "ua") {
    return "uk-UA";
  }

  if (locale === "de") {
    return "de-DE";
  }

  return "pl-PL";
}

function renderEmailHtml(input: {
  locale: VoucherAppointmentLocale;
  subject: string;
  bodyLines: string[];
  cta?: {
    url: string;
    label: string;
  };
}): string {
  const lang = voucherAppointmentHtmlLang(input.locale);
  const tokens = VOUCHER_APPOINTMENT_EMAIL_A11Y_TOKENS;
  const paragraphs = input.bodyLines
    .map(
      (line) =>
        `<p style="margin:0 0 16px;color:${tokens.bodyText};overflow-wrap:anywhere;word-break:normal;">${escapeHtml(line)}</p>`,
    )
    .join("");
  const cta = input.cta
    ? [
        '<p style="margin:24px 0 16px;">',
        `<a class="voucher-email__cta" href="${escapeHtml(input.cta.url)}" style="display:inline-block;box-sizing:border-box;min-width:${tokens.minTargetPx}px;min-height:${tokens.minTargetPx}px;padding:12px 18px;line-height:20px;background-color:${tokens.ctaBackground};color:${tokens.ctaText};border:2px solid ${tokens.accentBorder};border-radius:4px;text-decoration:underline;font-weight:700;overflow-wrap:anywhere;word-break:normal;">${escapeHtml(input.cta.label)}</a>`,
        "</p>",
      ].join("")
    : "";

  return [
    "<!doctype html>",
    `<html lang="${lang}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.subject)}</title>`,
    "<style>",
    `.voucher-email{margin:0;padding:24px;background-color:${tokens.background};color:${tokens.bodyText};font-family:Arial,Helvetica,sans-serif;line-height:1.5;}`,
    `.voucher-email__content{width:100%;max-width:640px;margin:0 auto;}`,
    `.voucher-email p{overflow-wrap:anywhere;word-break:normal;}`,
    `.voucher-email a:focus{outline:3px solid ${tokens.focusOutline};outline-offset:3px;}`,
    `.voucher-email__cta:focus{outline:3px solid ${tokens.focusOutline};outline-offset:3px;}`,
    "</style>",
    "</head>",
    `<body class="voucher-email" style="margin:0;padding:24px;background-color:${tokens.background};color:${tokens.bodyText};font-family:Arial,Helvetica,sans-serif;line-height:1.5;">`,
    '<main class="voucher-email__content" role="main" style="width:100%;max-width:640px;margin:0 auto;">',
    paragraphs,
    cta,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
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
