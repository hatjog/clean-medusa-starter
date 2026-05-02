/**
 * Story v160-7-3: Decision confirmation email copy (PL + EN; opt-in + opt-out variants).
 *
 * Per Sprint 4 Wave 15 batch — admin captures vendor decision via /vendors/decisions
 * surface (FR34). Workflow dispatches confirmation email to vendor after capture.
 *
 * Locale scope: PL + EN only per Story 2.8 narrowing.
 */

export type DecisionConfirmationLocale = "pl" | "en"
export type DecisionType = "opted_in" | "opted_out"

export interface DecisionConfirmationCopy {
  subject_optin: string
  subject_optout: string
  preheader: string
  greeting: string
  body_optin: string
  body_optout: string
  cta_label: string
  footer: string
}

export const DECISION_CONFIRMATION_EMAIL_COPY: Record<
  DecisionConfirmationLocale,
  DecisionConfirmationCopy
> = {
  pl: {
    subject_optin:
      "Potwierdzenie decyzji: opt-in do BonBeauty multi-vendor",
    subject_optout:
      "Potwierdzenie decyzji: opt-out z BonBeauty multi-vendor",
    preheader:
      "Twoja decyzja migracyjna została zapisana. Sprawdź szczegóły poniżej.",
    greeting: "Cześć {{ vendor_name }},",
    body_optin: [
      "Potwierdzamy, że Twoja decyzja opt-in została zapisana.",
      "",
      "Data zapisu: {{ captured_at }}",
      "Twój powód: {{ reason }}",
      "",
      "Następne kroki:",
      "• Otrzymasz Joint Controller Agreement (JCA) do podpisu.",
      "• Zostanie zaplanowane szkolenie certyfikacyjne.",
      "• Po podpisaniu JCA i zatwierdzeniu certyfikatu Twój salon zostanie aktywowany jako vendor.",
    ].join("\n"),
    body_optout: [
      "Potwierdzamy, że Twoja decyzja opt-out została zapisana.",
      "",
      "Data zapisu: {{ captured_at }}",
      "Twój powód: {{ reason }}",
      "",
      "Następne kroki:",
      "• Salon zostanie zamknięty zgodnie z harmonogramem migracji.",
      "• Otrzymasz informację o terminie zamknięcia konta.",
      "• Jeśli zmienisz zdanie, skontaktuj się z nami w ciągu 30 dni.",
    ].join("\n"),
    cta_label: "Skontaktuj się z administracją",
    footer:
      "Pytania? Napisz na {{ contact_email }}. Podstawa prawna: prawnie uzasadniony interes (RODO art. 6 ust. 1 lit. f).",
  },
  en: {
    subject_optin:
      "Decision confirmed: opted-in to BonBeauty multi-vendor",
    subject_optout:
      "Decision confirmed: opted-out from BonBeauty multi-vendor",
    preheader:
      "Your migration decision has been recorded. See details below.",
    greeting: "Hi {{ vendor_name }},",
    body_optin: [
      "We confirm your opt-in decision has been recorded.",
      "",
      "Recorded at: {{ captured_at }}",
      "Your reason: {{ reason }}",
      "",
      "Next steps:",
      "• You will receive the Joint Controller Agreement (JCA) for signing.",
      "• Training certification will be scheduled.",
      "• Once JCA is signed and your certificate is verified, your salon will be activated as a vendor.",
    ].join("\n"),
    body_optout: [
      "We confirm your opt-out decision has been recorded.",
      "",
      "Recorded at: {{ captured_at }}",
      "Your reason: {{ reason }}",
      "",
      "Next steps:",
      "• Your salon will be closed per migration schedule.",
      "• You will receive account closure timeline.",
      "• If you change your mind, contact us within 30 days.",
    ].join("\n"),
    cta_label: "Contact administration",
    footer:
      "Questions? Email {{ contact_email }}. Legal basis: legitimate interest (GDPR art. 6(1)(f)).",
  },
}

export interface DecisionConfirmationContext {
  vendor_name: string
  captured_at: string
  reason: string
  contact_email: string
}

function hydrate(text: string, ctx: DecisionConfirmationContext): string {
  return text
    .replace(/\{\{\s*vendor_name\s*\}\}/g, ctx.vendor_name)
    .replace(/\{\{\s*captured_at\s*\}\}/g, ctx.captured_at)
    .replace(/\{\{\s*reason\s*\}\}/g, ctx.reason)
    .replace(/\{\{\s*contact_email\s*\}\}/g, ctx.contact_email)
}

export function renderDecisionConfirmationSubject(
  locale: DecisionConfirmationLocale,
  decision: DecisionType,
): string {
  const copy = DECISION_CONFIRMATION_EMAIL_COPY[locale]
  return decision === "opted_in" ? copy.subject_optin : copy.subject_optout
}

export function renderDecisionConfirmationHtml(
  locale: DecisionConfirmationLocale,
  decision: DecisionType,
  ctx: DecisionConfirmationContext,
): string {
  const copy = DECISION_CONFIRMATION_EMAIL_COPY[locale]
  const bodyTpl = decision === "opted_in" ? copy.body_optin : copy.body_optout
  const body = hydrate(bodyTpl, ctx).replace(/\n/g, "<br />")
  const greeting = hydrate(copy.greeting, ctx)
  const footer = hydrate(copy.footer, ctx)
  const subject = renderDecisionConfirmationSubject(locale, decision)

  return [
    "<!DOCTYPE html>",
    `<html lang="${locale}">`,
    "<head>",
    `<meta charset="utf-8" />`,
    `<title>${subject}</title>`,
    "</head>",
    `<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">`,
    `<div style="display:none; font-size: 0; line-height: 0; color: transparent;">${copy.preheader}</div>`,
    `<p>${greeting}</p>`,
    `<p>${body}</p>`,
    `<hr style="margin-top: 32px; border: none; border-top: 1px solid #e5e5e5;" />`,
    `<p style="font-size: 12px; color: #666;">${footer}</p>`,
    "</body>",
    "</html>",
  ].join("\n")
}

export function renderDecisionConfirmationText(
  locale: DecisionConfirmationLocale,
  decision: DecisionType,
  ctx: DecisionConfirmationContext,
): string {
  const copy = DECISION_CONFIRMATION_EMAIL_COPY[locale]
  const bodyTpl = decision === "opted_in" ? copy.body_optin : copy.body_optout

  return [
    hydrate(copy.greeting, ctx),
    "",
    hydrate(bodyTpl, ctx),
    "",
    "---",
    hydrate(copy.footer, ctx),
  ].join("\n")
}
