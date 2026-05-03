/**
 * Story v160-7-2: Nudge cadence email render unit tests.
 *
 * Locks down 4-step × 2-locale matrix + placeholder hydration + escalation
 * tone (T-3 ALL CAPS subject) + locale parity (PL/EN identical key sets).
 */

import {
  NUDGE_CADENCE_DAYS,
  NUDGE_CADENCE_EMAIL_COPY,
  hydrateNudgeCadenceTemplate,
  renderNudgeCadenceHtml,
  renderNudgeCadenceSubject,
  renderNudgeCadenceText,
  type NudgeCadenceLocale,
  type NudgeCadenceStep,
  type NudgeCadenceTemplateContext,
} from "../../modules/vendor-notifications/email-templates/nudge-cadence/i18n"

const STEPS: ReadonlyArray<NudgeCadenceStep> = ["t21", "t14", "t7", "t3"]
const LOCALES: ReadonlyArray<NudgeCadenceLocale> = ["pl", "en"]

const ctx: NudgeCadenceTemplateContext = {
  vendor_name: "Salon Anna Beauty",
  flag_flip_date: "2026-06-30",
  days_remaining: "21",
  opt_in_url: "https://admin.bonbeauty.example/vendors/opt-in",
}

describe("vendor-notifications/nudge-cadence — Story v160-7-2", () => {
  describe("locale + step parity", () => {
    it.each(STEPS)("step %s has identical key sets across pl/en", (step) => {
      const plKeys = Object.keys(NUDGE_CADENCE_EMAIL_COPY[step].pl).sort()
      const enKeys = Object.keys(NUDGE_CADENCE_EMAIL_COPY[step].en).sort()
      expect(plKeys).toEqual(enKeys)
    })

    it("days mapping matches step labels", () => {
      expect(NUDGE_CADENCE_DAYS).toEqual({ t21: 21, t14: 14, t7: 7, t3: 3 })
    })
  })

  describe("hydrateNudgeCadenceTemplate", () => {
    it("substitutes vendor_name + flag_flip_date + days_remaining + opt_in_url", () => {
      const out = hydrateNudgeCadenceTemplate(
        "{{ vendor_name }} | {{ flag_flip_date }} | T-{{ days_remaining }} | {{ opt_in_url }}",
        ctx,
      )
      expect(out).toBe(
        "Salon Anna Beauty | 2026-06-30 | T-21 | https://admin.bonbeauty.example/vendors/opt-in",
      )
    })

    it("default contact_email when omitted", () => {
      const out = hydrateNudgeCadenceTemplate("{{ contact_email }}", ctx)
      expect(out).toBe("admin@bonbeauty.example")
    })
  })

  describe("renderNudgeCadenceSubject — escalation matrix", () => {
    it("T-21 PL is informational tone", () => {
      const s = renderNudgeCadenceSubject("t21", "pl", ctx)
      expect(s).toMatch(/Przypomnienie/)
      expect(s).toMatch(/21 dni/)
    })

    it("T-3 PL is ALL CAPS final notice", () => {
      const s = renderNudgeCadenceSubject("t3", "pl", ctx)
      expect(s).toMatch(/OSTATNIE 3 DNI/)
    })

    it("T-3 EN is FINAL ALL CAPS", () => {
      const s = renderNudgeCadenceSubject("t3", "en", ctx)
      expect(s).toMatch(/FINAL 3 DAYS/)
    })
  })

  describe("renderNudgeCadenceText — full hydration", () => {
    it.each(STEPS)("step %s body hydrates vendor_name + flag_flip_date", (step) => {
      const text = renderNudgeCadenceText(step, "pl", ctx)
      expect(text).toContain("Salon Anna Beauty")
      expect(text).toContain("2026-06-30")
      expect(text).toContain(ctx.opt_in_url)
      expect(text).not.toMatch(/\{\{|\}\}/) // no unhydrated placeholders
    })
  })

  describe("renderNudgeCadenceHtml — preheader + cta link", () => {
    it("includes preheader hidden block + CTA anchor", () => {
      const html = renderNudgeCadenceHtml("t14", "en", ctx)
      expect(html).toMatch(/<title>14 days to migration/)
      expect(html).toMatch(/<a href="https:\/\/admin\.bonbeauty\.example\/vendors\/opt-in"/)
      expect(html).toMatch(/display:none/) // preheader
      expect(html).not.toMatch(/\{\{|\}\}/)
    })
  })
})
