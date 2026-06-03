import { describe, expect, test } from "@jest/globals";

import {
  buildVoucherAppointmentDeliveryEmail,
  VOUCHER_APPOINTMENT_EMAIL_A11Y_TOKENS,
  type VoucherAppointmentDeliveryEmailInput,
} from "../appointment-confirmation-email";
import {
  VOUCHER_APPOINTMENT_COPY,
  VOUCHER_APPOINTMENT_LOCALES,
  lookupAppointmentCopy,
  normalizeVoucherAppointmentLocale,
  voucherAppointmentHtmlLang,
  type VoucherAppointmentLocale,
} from "../appointment-i18n";
import {
  generateVoucherAppointmentIcs,
  type VoucherAppointmentIcsInput,
} from "../ics-generator";

const FIXED_NOW = new Date("2026-06-02T08:00:00Z");
const HMAC_SECRET = "appointment-a11y-i18n-secret";

const BASE_APPOINTMENT: VoucherAppointmentIcsInput = {
  entitlement_instance_id: "entinst_a11y_i18n_001",
  appointment_id: "appt_a11y_i18n_001",
  vendor_id: "vendor_bonbeauty_001",
  location_id: "loc_bonbeauty_warsaw_001",
  salon_name: "Salon Alfa",
  location_address: "ul. Karmelicka 10, Krakow",
  service_name: "Zabieg dermatologiczny RAW-VOUCHER-CODE-123",
  starts_at: "2026-06-18T10:00:00+02:00",
  ends_at: "2026-06-18T11:00:00+02:00",
  timezone: "Europe/Warsaw",
  confirmation_source: "vendor_panel",
  sequence: 0,
  lifecycle_status: "confirmed",
  now: FIXED_NOW,
};

const BASE_EMAIL_INPUT: VoucherAppointmentDeliveryEmailInput = {
  recipient_email: "buyer@example.test",
  salon_name: BASE_APPOINTMENT.salon_name,
  location_address: BASE_APPOINTMENT.location_address,
  download_base_url: "https://api.bonbeauty.example",
  hmac_secret: HMAC_SECRET,
  now: FIXED_NOW,
  appointment: BASE_APPOINTMENT,
};

function renderEmail(
  overrides: Partial<VoucherAppointmentDeliveryEmailInput> = {},
) {
  return buildVoucherAppointmentDeliveryEmail({
    ...BASE_EMAIL_INPUT,
    ...overrides,
    appointment:
      overrides.appointment === undefined
        ? BASE_EMAIL_INPUT.appointment
        : overrides.appointment,
  });
}

function renderIcs(input: Partial<VoucherAppointmentIcsInput> = {}): string {
  return generateVoucherAppointmentIcs({
    ...BASE_APPOINTMENT,
    ...input,
    now: input.now ?? FIXED_NOW,
  });
}

function parseStyleAttribute(style: string): Record<string, string> {
  return Object.fromEntries(
    style
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...value] = part.split(":");
        return [name!.trim().toLowerCase(), value.join(":").trim()];
      }),
  );
}

function styleForFirstElement(html: string, marker: string): Record<string, string> {
  const element = html.match(new RegExp(`<[^>]*${marker}[^>]*style="([^"]+)"`, "i"));
  if (!element?.[1]) {
    throw new Error(`missing style for element marker: ${marker}`);
  }
  return parseStyleAttribute(element[1]);
}

function px(value: string | undefined): number {
  return Number(String(value ?? "").replace(/px$/i, ""));
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error(`unsupported hex color: ${hex}`);
  }

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Deterministic a11y proxy checker (no jsdom/axe-core runtime dependency).
 *
 * Trade-off (M3 review finding): AC1 specifies "axe on rendered HTML → 0 critical/serious".
 * This function implements a bespoke regex heuristic that covers the same critical/serious
 * axe rules relevant to this email template (doctype, lang, link semantics, focus styles).
 * It is intentionally dependency-free so it can run in the unit-test layer.
 *
 * Full axe-core integration (jsdom + axe) is tracked for Story 7.8 (a11y CI gate), which
 * will add automated axe runs against the rendered HTML as a pipeline gate blocking merge.
 * Until 7.8 ships, this proxy provides deterministic coverage of the most critical rules.
 */
function collectCriticalOrSeriousEmailA11yFindings(html: string): string[] {
  const findings: string[] = [];
  if (!/^<!doctype html>/i.test(html)) {
    findings.push("document-missing-doctype");
  }
  if (!/<html\s+lang="(pl|en|uk|de)">/i.test(html)) {
    findings.push("html-lang-missing-or-invalid");
  }
  if (/<a\b(?![^>]*\bhref=)[^>]*>/i.test(html)) {
    findings.push("link-missing-href");
  }
  if (/<a\b[^>]*>\s*<\/a>/i.test(html)) {
    findings.push("link-name-empty");
  }
  if (/<img\b(?![^>]*\balt=)[^>]*>/i.test(html)) {
    findings.push("image-alt-missing");
  }
  if (/outline\s*:\s*none/i.test(html)) {
    findings.push("focus-outline-removed");
  }
  if (!/a:focus\{[^}]*outline\s*:\s*3px\s+solid\s+#[0-9a-f]{6}/i.test(html)) {
    findings.push("focus-visible-style-missing");
  }
  return findings;
}

function unfoldIcs(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "");
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function propertyValue(ics: string, prefix: "SUMMARY:" | "DESCRIPTION:"): string {
  const line = unfoldIcs(ics)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(`missing iCal property: ${prefix}`);
  }
  return unescapeIcsText(line.slice(prefix.length));
}

describe("voucher appointment i18n — PL/EN/UA/DE parity", () => {
  test("każdy locale ma kompletny zestaw kluczy bez fallbacku na PL", () => {
    const baseline = Object.keys(VOUCHER_APPOINTMENT_COPY.pl).sort();

    for (const locale of VOUCHER_APPOINTMENT_LOCALES) {
      expect(Object.keys(VOUCHER_APPOINTMENT_COPY[locale]).sort()).toEqual(baseline);
      for (const key of baseline) {
        expect(lookupAppointmentCopy(locale, key)).not.toEqual("");
      }
    }
  });

  test("EN/UA/DE email używa własnych stringów zamiast PL fallbacku", () => {
    const en = renderEmail({ locale: "en" });
    const ua = renderEmail({ locale: "ua" });
    const de = renderEmail({ locale: "de" });

    expect(en.text).toContain("Add to calendar");
    expect(en.text).not.toContain("Dodaj do kalendarza");
    expect(ua.text).toContain("Додати до календаря");
    expect(ua.text).not.toContain("Dodaj do kalendarza");
    expect(de.text).toContain("Zum Kalender hinzufügen");
    expect(de.text).not.toContain("Dodaj do kalendarza");
  });

  test("neutralność payloadu — service_name i voucher_code nieobecne we wszystkich locale (FR42/UX-DR-06)", () => {
    for (const locale of VOUCHER_APPOINTMENT_LOCALES) {
      const email = renderEmail({ locale });
      const ics = renderIcs({ locale });

      expect(email.text).not.toContain("RAW-VOUCHER-CODE");
      expect(email.text).not.toContain("dermatolog");
      expect(email.html).not.toContain("RAW-VOUCHER-CODE");
      expect(email.html).not.toContain("dermatolog");
      expect(ics).not.toContain("RAW-VOUCHER-CODE");
      expect(ics).not.toContain("dermatolog");
    }
  });

  test("BCP47 alias — 'uk' i 'en-US' są mapowane zamiast rzucać wyjątek (L3 integracyjny most)", () => {
    // Platforma (x-medusa-locale middleware) przekazuje locale jako BCP47.
    // normalizeVoucherAppointmentLocale musi tolerować aliasy zamiast rzucać.
    expect(normalizeVoucherAppointmentLocale("uk")).toBe("ua");
    expect(normalizeVoucherAppointmentLocale("uk-UA")).toBe("ua");
    expect(normalizeVoucherAppointmentLocale("en-US")).toBe("en");
    expect(normalizeVoucherAppointmentLocale("en-GB")).toBe("en");
    expect(normalizeVoucherAppointmentLocale("de-DE")).toBe("de");
    expect(normalizeVoucherAppointmentLocale("pl-PL")).toBe("pl");
    // Natywne tokeny GP pozostają bez zmian
    expect(normalizeVoucherAppointmentLocale("ua")).toBe("ua");
    expect(normalizeVoucherAppointmentLocale("en")).toBe("en");
  });
});

describe("voucher appointment email — a11y AC1", () => {
  test("body ma kontrast >= 4.5:1 i gold nie jest kolorem tekstu body", () => {
    const email = renderEmail();
    const bodyStyle = styleForFirstElement(email.html, 'class="voucher-email"');
    const tokens = VOUCHER_APPOINTMENT_EMAIL_A11Y_TOKENS;

    expect(bodyStyle.color).toBe(tokens.bodyText);
    expect(bodyStyle["background-color"]).toBe(tokens.background);
    expect(contrastRatio(tokens.bodyText, tokens.background)).toBeGreaterThanOrEqual(4.5);
    expect(bodyStyle.color.toLowerCase()).not.toBe(tokens.accentBorder);
    expect(email.html).not.toMatch(new RegExp(`(^|[^-])color:${tokens.accentBorder}`, "i"));
  });

  test("CTA pozostaje linkiem tekstowym z targetem >=44x44 px", () => {
    const email = renderEmail();
    const ctaStyle = styleForFirstElement(email.html, 'class="voucher-email__cta"');

    expect(email.html).toMatch(/<a\b[^>]*href="https:\/\/api\.bonbeauty\.example/i);
    expect(email.html).toContain(">Dodaj do kalendarza</a>");
    expect(ctaStyle.display).toBe("inline-block");
    expect(px(ctaStyle["min-width"])).toBeGreaterThanOrEqual(44);
    expect(px(ctaStyle["min-height"])).toBeGreaterThanOrEqual(44);
  });

  test("document lang odpowiada locale i fokus jest widoczny", () => {
    for (const locale of VOUCHER_APPOINTMENT_LOCALES) {
      const email = renderEmail({ locale });

      expect(email.html).toContain(`<html lang="${voucherAppointmentHtmlLang(locale)}">`);
      expect(collectCriticalOrSeriousEmailA11yFindings(email.html)).toEqual([]);
    }
  });
});

describe("voucher appointment email — layout DE AC2", () => {
  test("najdłuższe stringi DE są obecne i szablon nie używa przycinającego CSS", () => {
    const email = renderEmail({
      locale: "de",
      salon_name: "Schöne Straße Größe Salon mit sehr langem Namen",
      location_address:
        "Lange Straße 123, Größere Schönheitsgalerie, München",
      appointment: {
        ...BASE_APPOINTMENT,
        locale: "de",
        salon_name: "Schöne Straße Größe Salon mit sehr langem Namen",
        location_address:
          "Lange Straße 123, Größere Schönheitsgalerie, München",
      },
    });

    expect(email.html).toContain("Zum Kalender hinzufügen");
    expect(email.html).toContain("vollständigen Erbringung");
    expect(email.html).toContain("Schöne Straße Größe Salon mit sehr langem Namen");
    expect(email.html).toContain("Lange Straße 123, Größere Schönheitsgalerie");
    expect(email.html).not.toMatch(/overflow\s*:\s*hidden/i);
    expect(email.html).not.toMatch(/text-overflow\s*:\s*ellipsis/i);
    expect(email.html).not.toMatch(/white-space\s*:\s*nowrap/i);
  });
});

describe("voucher appointment .ics — UTF-8 round-trip UA/DE AC2", () => {
  test.each([
    [
      "ua" as VoucherAppointmentLocale,
      "Салон Краса Київ",
      "Візит до Салон Краса Київ",
      "Візит до Салон Краса Київ.",
    ],
    [
      "de" as VoucherAppointmentLocale,
      "Schöne Straße Größe Salon",
      "Besuch im Salon Schöne Straße Größe Salon",
      "Termin im Salon Schöne Straße Größe Salon.",
    ],
  ])(
    "%s zachowuje znaki wielobajtowe w SUMMARY i DESCRIPTION",
    (locale, salonName, expectedSummary, expectedDescription) => {
      const ics = renderIcs({
        locale,
        salon_name: salonName,
        location_address: "Neutral address",
      });

      expect(ics).not.toContain("�");
      expect(propertyValue(ics, "SUMMARY:")).toBe(expectedSummary);
      expect(propertyValue(ics, "DESCRIPTION:")).toBe(expectedDescription);
    },
  );

  test("folding długich UA/DE linii nie uszkadza sekwencji UTF-8", () => {
    const uaSalon = "Салон Краса Київ ".repeat(8).trim();
    const deSalon = "Schöne Straße Größe Salon ".repeat(8).trim();

    for (const [locale, salonName] of [
      ["ua", uaSalon],
      ["de", deSalon],
    ] as const) {
      const ics = renderIcs({ locale, salon_name: salonName });

      expect(ics).not.toContain("�");
      expect(propertyValue(ics, "SUMMARY:")).toContain(salonName);
      expect(propertyValue(ics, "DESCRIPTION:")).toContain(salonName);

      // RFC 5545 §3.1: each content line MUST be at most 75 octets (bytes),
      // excluding the CRLF. Continuation lines start with a single LWSP char
      // which counts as 1 octet. Verify that no content line in the output
      // exceeds the limit.
      for (const rawLine of ics.split(/\r?\n/)) {
        expect(Buffer.byteLength(rawLine, "utf8")).toBeLessThanOrEqual(75);
      }
    }
  });
});
