/**
 * Story v160-7-2: Nudge cadence email copy — 4 escalating steps × 2 locales.
 *
 * Cadence rationale (per Story 7.2 Dev Note):
 *   - T-21: first reminder (informational)
 *   - T-14: midpoint check (urgency rising)
 *   - T-7:  one-week-out (strong urgency)
 *   - T-3:  final notice (last-resort attention-grab; ALL CAPS subject OK)
 *
 * Privacy: legitimate interest basis per DPIA §3 — transactional vendor
 * lifecycle communication. NO marketing consent required.
 *
 * Template hydration: Approach A — `{{ var }}` regex replacement (matches
 * Story 7.1 pattern). Allowlisted placeholders: vendor_name, flag_flip_date,
 * days_remaining, opt_in_url, contact_email.
 */

export type NudgeCadenceStep = "t21" | "t14" | "t7" | "t3"
export type NudgeCadenceLocale = "pl" | "en"

export interface NudgeCadenceEmailCopy {
  subject: string
  preheader: string
  greeting: string
  body: string
  cta_label: string
  footer: string
}

export interface NudgeCadenceTemplateContext {
  vendor_name: string
  flag_flip_date: string // ISO YYYY-MM-DD
  days_remaining: string // human-readable, e.g. "21"
  opt_in_url: string
  contact_email?: string
}

const FOOTER_PL =
  "Pytania? Napisz na admin@bonbeauty.example. Email jest częścią procesu migracji (podstawa prawna: prawnie uzasadniony interes, RODO art. 6 ust. 1 lit. f)."
const FOOTER_EN =
  "Questions? Email admin@bonbeauty.example. This email is part of the migration process (legal basis: legitimate interest, GDPR art. 6(1)(f))."

export const NUDGE_CADENCE_EMAIL_COPY: Record<
  NudgeCadenceStep,
  Record<NudgeCadenceLocale, NudgeCadenceEmailCopy>
> = {
  t21: {
    pl: {
      subject: "Przypomnienie: 21 dni do migracji BonBeauty multi-vendor",
      preheader:
        "Pozostało {{ days_remaining }} dni do flag flip. Możesz spokojnie przygotować decyzję migracyjną.",
      greeting: "Cześć {{ vendor_name }},",
      body: [
        "Zbliża się migracja BonBeauty do modelu multi-vendor.",
        "Data flag flip: {{ flag_flip_date }} (T-{{ days_remaining }} dni od dziś).",
        "",
        "Jeszcze nie wybraliście opcji opt-in lub opt-out. Wciąż jest dużo czasu — to przypomnienie informacyjne.",
      ].join("\n"),
      cta_label: "Przejdź do formularza decyzji",
      footer: FOOTER_PL,
    },
    en: {
      subject: "Reminder: 21 days to BonBeauty multi-vendor migration",
      preheader:
        "{{ days_remaining }} days remain to flag flip. Plenty of time to prepare your decision.",
      greeting: "Hi {{ vendor_name }},",
      body: [
        "BonBeauty is migrating to a multi-vendor model.",
        "Flag flip date: {{ flag_flip_date }} (T-{{ days_remaining }} days from today).",
        "",
        "You haven't picked opt-in or opt-out yet. Plenty of time still — this is an informational reminder.",
      ].join("\n"),
      cta_label: "Go to decision form",
      footer: FOOTER_EN,
    },
  },
  t14: {
    pl: {
      subject: "14 dni do migracji — czas na decyzję",
      preheader:
        "Pozostało {{ days_remaining }} dni. Prosimy o decyzję opt-in / opt-out w ciągu kolejnych dwóch tygodni.",
      greeting: "Cześć {{ vendor_name }},",
      body: [
        "Pozostało {{ days_remaining }} dni do flag flip ({{ flag_flip_date }}).",
        "",
        "Czas na decyzję migracyjną. Brak decyzji w T-3 oznacza, że dokonamy konsultacji indywidualnej — prosimy zarezerwować czas wcześniej.",
      ].join("\n"),
      cta_label: "Wybierz opt-in lub opt-out",
      footer: FOOTER_PL,
    },
    en: {
      subject: "14 days to migration — time to decide",
      preheader:
        "{{ days_remaining }} days remain. Please pick opt-in / opt-out in the next two weeks.",
      greeting: "Hi {{ vendor_name }},",
      body: [
        "Only {{ days_remaining }} days remain until flag flip ({{ flag_flip_date }}).",
        "",
        "Please make your migration decision. No decision by T-3 triggers an individual consultation — book your slot early.",
      ].join("\n"),
      cta_label: "Pick opt-in or opt-out",
      footer: FOOTER_EN,
    },
  },
  t7: {
    pl: {
      subject: "Tylko 7 dni — proszę o pilną decyzję",
      preheader:
        "Tylko {{ days_remaining }} dni do flag flip. Brak decyzji = konsultacja indywidualna w T-3.",
      greeting: "Cześć {{ vendor_name }},",
      body: [
        "Pozostało tylko {{ days_remaining }} dni do flag flip ({{ flag_flip_date }}).",
        "",
        "Brak decyzji opt-in / opt-out w ciągu 7 dni oznacza, że BB-admin skontaktuje się z Wami indywidualnie. Łatwiej i szybciej będzie samodzielnie wskazać preferencję.",
      ].join("\n"),
      cta_label: "Pilnie — wybierz opcję",
      footer: FOOTER_PL,
    },
    en: {
      subject: "Only 7 days left — please decide urgently",
      preheader:
        "Only {{ days_remaining }} days to flag flip. No decision = individual consult at T-3.",
      greeting: "Hi {{ vendor_name }},",
      body: [
        "Only {{ days_remaining }} days remain to flag flip ({{ flag_flip_date }}).",
        "",
        "No opt-in / opt-out decision in 7 days triggers an individual BB-admin consultation. Picking your preference now is the simplest path.",
      ].join("\n"),
      cta_label: "Urgent — pick an option",
      footer: FOOTER_EN,
    },
  },
  t3: {
    pl: {
      subject: "OSTATNIE 3 DNI do migracji",
      preheader:
        "Ostatnia szansa na samodzielną decyzję. Po T-3 BB-admin podejmie decyzję domyślną.",
      greeting: "{{ vendor_name }},",
      body: [
        "OSTATNIE {{ days_remaining }} DNI do flag flip ({{ flag_flip_date }}).",
        "",
        "Brak Waszej decyzji w ciągu 72h oznacza, że BonBeauty przyjmie domyślny scenariusz opt-out z poszanowaniem niezbędnego okresu. Możecie nadal wybrać opt-in samodzielnie do ostatniej minuty.",
      ].join("\n"),
      cta_label: "Wybierz opt-in / opt-out TERAZ",
      footer: FOOTER_PL,
    },
    en: {
      subject: "FINAL 3 DAYS to migration",
      preheader:
        "Last chance for self-service decision. After T-3 BB-admin assigns the default.",
      greeting: "{{ vendor_name }},",
      body: [
        "FINAL {{ days_remaining }} DAYS to flag flip ({{ flag_flip_date }}).",
        "",
        "No decision within 72h means BonBeauty assigns the default opt-out scenario with the standard cool-down period. You can still pick opt-in yourself up to the very last minute.",
      ].join("\n"),
      cta_label: "Pick opt-in / opt-out NOW",
      footer: FOOTER_EN,
    },
  },
}

export function hydrateNudgeCadenceTemplate(
  text: string,
  ctx: NudgeCadenceTemplateContext,
): string {
  return text
    .replace(/\{\{\s*vendor_name\s*\}\}/g, ctx.vendor_name)
    .replace(/\{\{\s*flag_flip_date\s*\}\}/g, ctx.flag_flip_date)
    .replace(/\{\{\s*days_remaining\s*\}\}/g, ctx.days_remaining)
    .replace(/\{\{\s*opt_in_url\s*\}\}/g, ctx.opt_in_url)
    .replace(/\{\{\s*contact_email\s*\}\}/g, ctx.contact_email ?? "admin@bonbeauty.example")
}

export function renderNudgeCadenceSubject(
  step: NudgeCadenceStep,
  locale: NudgeCadenceLocale,
  _ctx: NudgeCadenceTemplateContext,
): string {
  return NUDGE_CADENCE_EMAIL_COPY[step][locale].subject
}

export function renderNudgeCadenceText(
  step: NudgeCadenceStep,
  locale: NudgeCadenceLocale,
  ctx: NudgeCadenceTemplateContext,
): string {
  const copy = NUDGE_CADENCE_EMAIL_COPY[step][locale]
  const greeting = hydrateNudgeCadenceTemplate(copy.greeting, ctx)
  const body = hydrateNudgeCadenceTemplate(copy.body, ctx)
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

export function renderNudgeCadenceHtml(
  step: NudgeCadenceStep,
  locale: NudgeCadenceLocale,
  ctx: NudgeCadenceTemplateContext,
): string {
  const copy = NUDGE_CADENCE_EMAIL_COPY[step][locale]
  const greeting = hydrateNudgeCadenceTemplate(copy.greeting, ctx)
  const body = hydrateNudgeCadenceTemplate(copy.body, ctx).replace(
    /\n/g,
    "<br />",
  )
  const preheader = hydrateNudgeCadenceTemplate(copy.preheader, ctx)
  return [
    "<!DOCTYPE html>",
    `<html lang="${locale}">`,
    "<head>",
    `<meta charset="utf-8" />`,
    `<title>${copy.subject}</title>`,
    "</head>",
    `<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">`,
    `<div style="display:none; font-size: 0; line-height: 0; color: transparent;">${preheader}</div>`,
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

/** Map cadence step → days-remaining default for context defaults. */
export const NUDGE_CADENCE_DAYS: Record<NudgeCadenceStep, number> = {
  t21: 21,
  t14: 14,
  t7: 7,
  t3: 3,
}
