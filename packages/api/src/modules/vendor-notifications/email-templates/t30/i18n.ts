/**
 * Story v160-7-1: T-30 migration notification email copy (PL + EN).
 *
 * Per Sprint 4 Wave 13 batch + Story 7.1 Dev Note:
 *   "Locale scope: PL + EN only per Story 2.8 narrowing."
 *
 * Copy is informed by FR32 (incumbent vendor advance notice) + FR33 (30-day
 * opt-in/opt-out window). Tone: soft + transactional (legitimate interest
 * basis per DPIA §3 — no marketing consent required).
 *
 * Template hydration: callers replace {{ vendor_name }}, {{ flag_flip_date }},
 * {{ opt_in_url }} via simple regex substitution (Approach A per Story 7.1
 * Dev Note — minimal dependency surface).
 */

export type T30EmailLocale = "pl" | "en"

export interface T30EmailCopy {
  subject: string
  preheader: string
  greeting: string
  body: string
  cta_label: string
  footer: string
}

export const T30_EMAIL_COPY: Record<T30EmailLocale, T30EmailCopy> = {
  pl: {
    subject: "BonBeauty multi-vendor migration — T-30 dni do flag flip",
    preheader:
      "Pozostało 30 dni do uruchomienia BonBeauty multi-vendor. Przygotuj decyzję migracyjną.",
    greeting: "Cześć {{ vendor_name }},",
    body: [
      "Zbliża się migracja BonBeauty z modelu mono-tenant do multi-vendor.",
      "Data flag flip: {{ flag_flip_date }} (T-30 dni od dziś).",
      "",
      "Co to oznacza:",
      "• Salon zostanie automatycznie zmigrowany jako vendor w architekturze multi-vendor.",
      "• Masz 30 dni na decyzję opt-in lub opt-out (bez kar).",
      "• Po flag flip salon będzie widoczny w nowej liście salonów BonBeauty.",
      "",
      "Przygotuj decyzję — link do formularza opt-in/opt-out znajdziesz poniżej.",
    ].join("\n"),
    cta_label: "Przejdź do formularza decyzji",
    footer:
      "Pytania? Napisz na admin@bonbeauty.example. Ten email jest częścią procesu migracji (podstawa prawna: prawnie uzasadniony interes, RODO art. 6 ust. 1 lit. f).",
  },
  en: {
    subject: "BonBeauty multi-vendor migration — T-30 days to flag flip",
    preheader:
      "30 days remain until BonBeauty multi-vendor goes live. Prepare your migration decision.",
    greeting: "Hi {{ vendor_name }},",
    body: [
      "BonBeauty is migrating from a mono-tenant model to multi-vendor.",
      "Flag flip date: {{ flag_flip_date }} (T-30 days from today).",
      "",
      "What this means:",
      "• Your salon will be automatically migrated as a vendor in the multi-vendor architecture.",
      "• You have 30 days to opt-in or opt-out (no penalty).",
      "• After flag flip, your salon will appear in the new BonBeauty salon directory.",
      "",
      "Prepare your decision — find the opt-in/opt-out form via the link below.",
    ].join("\n"),
    cta_label: "Go to decision form",
    footer:
      "Questions? Email admin@bonbeauty.example. This email is part of the migration process (legal basis: legitimate interest, GDPR art. 6(1)(f)).",
  },
}

export interface T30TemplateContext {
  vendor_name: string
  flag_flip_date: string // ISO YYYY-MM-DD
  opt_in_url: string
}

/**
 * Hydrates a copy string with template context (Approach A — simple {{ var }}
 * regex replacement). Unknown placeholders are left as-is so misuse is
 * detectable in QA review (vs silent empty substitution).
 */
export function hydrateTemplate(text: string, ctx: T30TemplateContext): string {
  return text
    .replace(/\{\{\s*vendor_name\s*\}\}/g, ctx.vendor_name)
    .replace(/\{\{\s*flag_flip_date\s*\}\}/g, ctx.flag_flip_date)
    .replace(/\{\{\s*opt_in_url\s*\}\}/g, ctx.opt_in_url)
}

/**
 * Renders the full HTML email body for a vendor + locale.
 *
 * Minimal CSS inline; single column responsive layout (deliverability
 * priority over rich design — preheader sets context for inbox preview).
 */
export function renderT30Html(
  locale: T30EmailLocale,
  ctx: T30TemplateContext,
): string {
  const copy = T30_EMAIL_COPY[locale]
  const body = hydrateTemplate(copy.body, ctx).replace(/\n/g, "<br />")
  const greeting = hydrateTemplate(copy.greeting, ctx)

  return [
    "<!DOCTYPE html>",
    `<html lang="${locale}">`,
    "<head>",
    `<meta charset="utf-8" />`,
    `<title>${copy.subject}</title>`,
    "</head>",
    `<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">`,
    `<div style="display:none; font-size: 0; line-height: 0; color: transparent;">${copy.preheader}</div>`,
    `<p>${greeting}</p>`,
    `<p>${body}</p>`,
    `<p style="margin-top: 24px;">`,
    `<a href="${ctx.opt_in_url}" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: #fff; text-decoration: none; border-radius: 4px;">${copy.cta_label}</a>`,
    `</p>`,
    `<hr style="margin-top: 32px; border: none; border-top: 1px solid #e5e5e5;" />`,
    `<p style="font-size: 12px; color: #666;">${copy.footer}</p>`,
    "</body>",
    "</html>",
  ].join("\n")
}

/**
 * Plain-text fallback (deliverability + accessibility per AC2).
 */
export function renderT30Text(
  locale: T30EmailLocale,
  ctx: T30TemplateContext,
): string {
  const copy = T30_EMAIL_COPY[locale]
  const body = hydrateTemplate(copy.body, ctx)
  const greeting = hydrateTemplate(copy.greeting, ctx)

  return [
    greeting,
    "",
    body,
    "",
    `${copy.cta_label}: ${ctx.opt_in_url}`,
    "",
    "---",
    copy.footer,
  ].join("\n")
}

export function renderT30Subject(
  locale: T30EmailLocale,
  _ctx: T30TemplateContext,
): string {
  return T30_EMAIL_COPY[locale].subject
}
