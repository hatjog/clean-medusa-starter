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

/**
 * BCP47 alias bridge: the platform propagates locale as BCP47 (`uk`, `en-US`, …).
 * Internally we use the GP-conventional token `"ua"` for Ukrainian and strip region
 * suffixes so that incoming `"uk"` or `"en-US"` don't throw at the boundary.
 * This keeps the internal token set (`pl|en|ua|de`) stable while allowing safe
 * integration with the Medusa x-medusa-locale middleware.
 */
const BCP47_ALIAS: Readonly<Record<string, VoucherAppointmentLocale>> = {
  uk: "ua",   // BCP47 Ukrainian → internal UA token
  "uk-UA": "ua",
  "en-US": "en",
  "en-GB": "en",
  "de-DE": "de",
  "de-AT": "de",
  "de-CH": "de",
  "pl-PL": "pl",
};

export function normalizeVoucherAppointmentLocale(
  locale: VoucherAppointmentLocale | string | null | undefined,
): VoucherAppointmentLocale {
  const candidate = locale ?? "pl";
  // Exact match (primary path)
  if ((VOUCHER_APPOINTMENT_LOCALES as readonly string[]).includes(candidate)) {
    return candidate as VoucherAppointmentLocale;
  }
  // BCP47 alias (e.g. "uk" → "ua", "en-US" → "en")
  if (BCP47_ALIAS[candidate]) {
    return BCP47_ALIAS[candidate];
  }
  // Strip region tag and retry (e.g. "uk-UA" already in alias, but handles new variants)
  const base = candidate.split("-")[0]!;
  if ((VOUCHER_APPOINTMENT_LOCALES as readonly string[]).includes(base)) {
    return base as VoucherAppointmentLocale;
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
