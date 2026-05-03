/**
 * Story v160-6-6: Buyer claim notification email copy (PL + EN).
 *
 * Sent to buyer (Marta-gift persona) AFTER recipient claims voucher. Conveys
 * salon name + service + claim timestamp, WITHOUT recipient identity. Privacy
 * boundary AR45: zero recipient-side PII (no recipient_email, recipient_name,
 * recipient_ip, recipient_user_agent, claim_session_id) in the payload OR
 * the rendered output.
 *
 * Tone: soft + transactional (legitimate interest basis per DPIA §3 — no
 * marketing consent required; transactional confirmation of buyer's purchase
 * outcome).
 *
 * Template hydration: Approach A — simple {{ var }} regex replacement (per
 * Story 7.1 pattern). Allowlisted placeholders: seller_name, seller_handle,
 * service_title, claimed_at, voucher_code.
 */

export type BuyerClaimEmailLocale = "pl" | "en"

export interface BuyerClaimEmailCopy {
  subject: string
  preheader: string
  greeting: string
  body: string
  cta_label: string
  footer: string
}

export const BUYER_CLAIM_EMAIL_COPY: Record<
  BuyerClaimEmailLocale,
  BuyerClaimEmailCopy
> = {
  pl: {
    subject: "Twój voucher BonBeauty został zrealizowany",
    preheader:
      "Voucher dla {{ seller_name }} został właśnie zrealizowany. Dziękujemy za zakup.",
    greeting: "Dzień dobry,",
    body: [
      "Mamy dobre wieści — voucher BonBeauty, który ufundowaliście, został właśnie zrealizowany.",
      "",
      "Salon: {{ seller_name }}",
      "Usługa: {{ service_title }}",
      "Data realizacji: {{ claimed_at }}",
      "Kod vouchera: {{ voucher_code }}",
      "",
      "Z poszanowaniem prywatności odbiorcy nie ujawniamy jego danych osobowych — to zwykła praktyka BonBeauty (RODO art. 5 ust. 1 lit. c — minimalizacja danych).",
    ].join("\n"),
    cta_label: "Zobacz salon",
    footer:
      "Pytania? Napisz na admin@bonbeauty.example. Ten email jest powiadomieniem transakcyjnym (podstawa prawna: prawnie uzasadniony interes, RODO art. 6 ust. 1 lit. f).",
  },
  en: {
    subject: "Your BonBeauty voucher has been claimed",
    preheader:
      "The voucher for {{ seller_name }} was just claimed. Thank you for your purchase.",
    greeting: "Hello,",
    body: [
      "Good news — the BonBeauty voucher you purchased has just been claimed.",
      "",
      "Salon: {{ seller_name }}",
      "Service: {{ service_title }}",
      "Claim date: {{ claimed_at }}",
      "Voucher code: {{ voucher_code }}",
      "",
      "Out of respect for the recipient's privacy we do not disclose their personal data — this is standard BonBeauty practice (GDPR art. 5(1)(c) — data minimisation).",
    ].join("\n"),
    cta_label: "View salon",
    footer:
      "Questions? Email admin@bonbeauty.example. This email is a transactional notification (legal basis: legitimate interest, GDPR art. 6(1)(f)).",
  },
}

export interface BuyerClaimTemplateContext {
  seller_name: string
  seller_handle: string
  service_title: string
  claimed_at: string // ISO 8601 OR locale-formatted string
  voucher_code: string
  /** Optional CTA URL (re-discovery path) — defaults to seller permalink. */
  seller_url?: string
}

export function hydrateBuyerClaimTemplate(
  text: string,
  ctx: BuyerClaimTemplateContext,
): string {
  return text
    .replace(/\{\{\s*seller_name\s*\}\}/g, ctx.seller_name)
    .replace(/\{\{\s*seller_handle\s*\}\}/g, ctx.seller_handle)
    .replace(/\{\{\s*service_title\s*\}\}/g, ctx.service_title)
    .replace(/\{\{\s*claimed_at\s*\}\}/g, ctx.claimed_at)
    .replace(/\{\{\s*voucher_code\s*\}\}/g, ctx.voucher_code)
}

export function renderBuyerClaimSubject(
  locale: BuyerClaimEmailLocale,
  _ctx: BuyerClaimTemplateContext,
): string {
  return BUYER_CLAIM_EMAIL_COPY[locale].subject
}

export function renderBuyerClaimText(
  locale: BuyerClaimEmailLocale,
  ctx: BuyerClaimTemplateContext,
): string {
  const copy = BUYER_CLAIM_EMAIL_COPY[locale]
  const body = hydrateBuyerClaimTemplate(copy.body, ctx)
  const url = ctx.seller_url ?? `https://bonbeauty.example/sellers/${ctx.seller_handle}`
  return [
    copy.greeting,
    "",
    body,
    "",
    `${copy.cta_label}: ${url}`,
    "",
    "---",
    copy.footer,
  ].join("\n")
}

export function renderBuyerClaimHtml(
  locale: BuyerClaimEmailLocale,
  ctx: BuyerClaimTemplateContext,
): string {
  const copy = BUYER_CLAIM_EMAIL_COPY[locale]
  const body = hydrateBuyerClaimTemplate(copy.body, ctx).replace(/\n/g, "<br />")
  const preheader = hydrateBuyerClaimTemplate(copy.preheader, ctx)
  const url = ctx.seller_url ?? `https://bonbeauty.example/sellers/${ctx.seller_handle}`
  return [
    "<!DOCTYPE html>",
    `<html lang="${locale}">`,
    "<head>",
    `<meta charset="utf-8" />`,
    `<title>${copy.subject}</title>`,
    "</head>",
    `<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">`,
    `<div style="display:none; font-size: 0; line-height: 0; color: transparent;">${preheader}</div>`,
    `<p>${copy.greeting}</p>`,
    `<p>${body}</p>`,
    `<p style="margin-top: 24px;">`,
    `<a href="${url}" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: #fff; text-decoration: none; border-radius: 4px;">${copy.cta_label}</a>`,
    `</p>`,
    `<hr style="margin-top: 32px; border: none; border-top: 1px solid #e5e5e5;" />`,
    `<p style="font-size: 12px; color: #666;">${copy.footer}</p>`,
    "</body>",
    "</html>",
  ].join("\n")
}
