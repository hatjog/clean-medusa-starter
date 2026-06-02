import appointmentPl from "./i18n/voucher-appointment.pl.json";
import appointmentEn from "./i18n/voucher-appointment.en.json";
import appointmentUa from "./i18n/voucher-appointment.ua.json";
import appointmentDe from "./i18n/voucher-appointment.de.json";

export type VoucherAppointmentLocale = "pl" | "en" | "ua" | "de";
export type VoucherAppointmentCopyKey = Exclude<keyof typeof appointmentPl, "_review">;

const META_KEYS: ReadonlySet<string> = new Set(["_review"]);
export const VOUCHER_APPOINTMENT_LOCALES = ["pl", "en", "ua", "de"] as const;

function stripMeta(bundle: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle)) {
    if (META_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export const VOUCHER_APPOINTMENT_COPY: Readonly<
  Record<VoucherAppointmentLocale, Readonly<Record<string, string>>>
> = Object.freeze({
  pl: Object.freeze(stripMeta(appointmentPl as unknown as Record<string, unknown>)),
  en: Object.freeze(stripMeta(appointmentEn as unknown as Record<string, unknown>)),
  ua: Object.freeze(stripMeta(appointmentUa as unknown as Record<string, unknown>)),
  de: Object.freeze(stripMeta(appointmentDe as unknown as Record<string, unknown>)),
});

function assertAppointmentBundleParity(): void {
  const baseline = new Set(Object.keys(VOUCHER_APPOINTMENT_COPY.pl));
  for (const locale of ["en", "ua", "de"] as const) {
    const localeKeys = new Set(Object.keys(VOUCHER_APPOINTMENT_COPY[locale]));
    const missing = [...baseline].filter((key) => !localeKeys.has(key));
    const extra = [...localeKeys].filter((key) => !baseline.has(key));
    if (missing.length || extra.length) {
      throw new Error(
        `voucher appointment i18n bundle parity violation for locale ${locale}: ` +
          `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
      );
    }
  }
}
assertAppointmentBundleParity();

export function normalizeVoucherAppointmentLocale(
  locale: VoucherAppointmentLocale | null | undefined,
): VoucherAppointmentLocale {
  const candidate = locale ?? "pl";
  if ((VOUCHER_APPOINTMENT_LOCALES as readonly string[]).includes(candidate)) {
    return candidate;
  }

  throw new Error(`unsupported voucher appointment locale: ${String(locale)}`);
}

export function voucherAppointmentHtmlLang(locale: VoucherAppointmentLocale): string {
  return locale === "ua" ? "uk" : locale;
}

export function lookupAppointmentCopy(
  locale: VoucherAppointmentLocale,
  key: VoucherAppointmentCopyKey | string,
): string {
  const value = VOUCHER_APPOINTMENT_COPY[locale]?.[key as string];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing voucher appointment i18n key: ${String(key)} for locale ${locale}`);
  }
  return value;
}

export function renderAppointmentCopy(
  locale: VoucherAppointmentLocale,
  key: VoucherAppointmentCopyKey,
  variables: Record<string, string> = {},
): string {
  const template = lookupAppointmentCopy(locale, key);
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, variableName) => {
    const value = variables[variableName];
    if (value === undefined) {
      throw new Error(
        `missing variable "${variableName}" for voucher appointment i18n key: ${String(key)}`,
      );
    }
    return value;
  });
}
