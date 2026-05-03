/**
 * Story v160-7-1: T-30 email template unit tests.
 *
 * Locks down locale parity (PL + EN) + template hydration + GDPR-aware
 * footer copy (legitimate interest disclosure per DPIA §3).
 */

import {
  T30_EMAIL_COPY,
  hydrateTemplate,
  renderT30Html,
  renderT30Subject,
  renderT30Text,
} from "../../modules/vendor-notifications"

describe("vendor-notifications/t30 email template", () => {
  const ctx = {
    vendor_name: "Salon Anna Beauty",
    flag_flip_date: "2026-06-01",
    opt_in_url: "https://admin.bonbeauty.example/vendors/opt-in?vendor=ven_a",
  }

  it("locale parity: pl + en have identical key set", () => {
    expect(Object.keys(T30_EMAIL_COPY.pl).sort()).toEqual(
      Object.keys(T30_EMAIL_COPY.en).sort(),
    )
  })

  it("subject lines mention T-30 + multi-vendor migration in both locales", () => {
    expect(T30_EMAIL_COPY.pl.subject).toMatch(/T-30/i)
    expect(T30_EMAIL_COPY.pl.subject).toMatch(/multi-vendor/i)
    expect(T30_EMAIL_COPY.en.subject).toMatch(/T-30/i)
    expect(T30_EMAIL_COPY.en.subject).toMatch(/multi-vendor/i)
  })

  it("footer discloses legitimate-interest legal basis (DPIA §3)", () => {
    expect(T30_EMAIL_COPY.pl.footer).toMatch(/prawnie uzasadniony interes|RODO/i)
    expect(T30_EMAIL_COPY.en.footer).toMatch(/legitimate interest|GDPR/i)
  })

  it("hydrateTemplate substitutes vendor_name + flag_flip_date + opt_in_url", () => {
    const out = hydrateTemplate(
      "Hi {{ vendor_name }}, flip on {{ flag_flip_date }} at {{ opt_in_url }}.",
      ctx,
    )
    expect(out).toBe(
      "Hi Salon Anna Beauty, flip on 2026-06-01 at https://admin.bonbeauty.example/vendors/opt-in?vendor=ven_a.",
    )
  })

  it("renderT30Html includes hydrated context + opt-in CTA link", () => {
    const html = renderT30Html("pl", ctx)
    expect(html).toContain(ctx.vendor_name)
    expect(html).toContain(ctx.flag_flip_date)
    expect(html).toContain(ctx.opt_in_url)
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain('lang="pl"')
  })

  it("renderT30Text fallback includes hydrated context (deliverability + a11y)", () => {
    const text = renderT30Text("en", ctx)
    expect(text).toContain(ctx.vendor_name)
    expect(text).toContain(ctx.flag_flip_date)
    expect(text).toContain(ctx.opt_in_url)
    expect(text).not.toMatch(/<\/?[a-z][^>]*>/)
  })

  it("renderT30Subject returns locale-specific subject line", () => {
    expect(renderT30Subject("pl", ctx)).toBe(T30_EMAIL_COPY.pl.subject)
    expect(renderT30Subject("en", ctx)).toBe(T30_EMAIL_COPY.en.subject)
  })

  it("never leaks recipient PII into subject/preheader/CTA copy (AR45 / GDPR)", () => {
    // Static copy may include the public support contact (admin@...) but
    // MUST NOT include any per-vendor email/phone — those flow ONLY through
    // hydrated `vendor_name` placeholder (a salon display name, not personal
    // data per DPIA §3). Phone numbers MUST NOT appear anywhere in static
    // copy.
    const allCopy = JSON.stringify(T30_EMAIL_COPY)
    // Allow only the well-known support address; flag everything else.
    const emailMatches = allCopy.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []
    for (const m of emailMatches) {
      expect(m.toLowerCase()).toBe("admin@bonbeauty.example")
    }
    expect(allCopy).not.toMatch(/\+?\d{9,}/)
  })
})
