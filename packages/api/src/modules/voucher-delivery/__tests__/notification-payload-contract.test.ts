/**
 * notification-payload-contract.test.ts — Story 5.7 (AC3/AC4/AC5).
 *
 * Ten test jest TypeScriptową połową bramki pokrycia: porównuje kontrakt
 * `notification-body-vars.ts` z RZECZYWISTYM `Object.keys(notification.data)`
 * obu builderów oraz z `placeholders.body_vars` manifestów w gp-ops. Druga
 * połowa (walidator repo) robi to samo z poziomu super-repo — obie muszą
 * czytać ten sam kontrakt, nie dwie ręcznie dublowane listy.
 *
 * Bez tego testu payload mógł nieść `claim_url`, którego nie czytał ŻADEN
 * szablon, a mail i tak kończył się `ledger=sent` (incydent 2026-07-30).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

import { buildHandoffLinkNotification } from "../handoff-link-intent"
import {
  NOTIFICATION_BODY_VAR_CONTRACT,
  NotificationBodyVarsIncompleteError,
  VOUCHER_HANDOFF_LINK_BODY_VARS,
  VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS,
} from "../notification-body-vars"
import {
  buildPurchaseConfirmationNotification,
  type PurchaseConfirmationIntentInput,
} from "../purchase-confirmation-intent"
import { hashRecipientEmail } from "../recipient-hash"

const MANIFEST_ROOT = resolve(
  __dirname,
  "../../../../../../../../gp-ops/templates/communications/brevo/email",
)

const VOUCHER_CODE = "BB-ABCD-1234"

function fullInput(
  overrides: Partial<PurchaseConfirmationIntentInput> = {},
): PurchaseConfirmationIntentInput {
  return {
    recipient_email: "kupujaca@example.test",
    recipient_hash: hashRecipientEmail("kupujaca@example.test"),
    entitlement_id: "entinst_5_7_001",
    voucher_code: VOUCHER_CODE,
    market_id: "bonbeauty",
    locale: "pl",
    dispatch_id: "dispatch-1",
    voucher_page_url: `https://dev.bonbeauty.pl/pl/voucher/${VOUCHER_CODE}`,
    customer_first_name: "Magda",
    salon_name: "Salon Bonbeauty",
    salon_address: "ul. Handlowa 10, 00-001 Warszawa",
    support_email: "kontakt@bonbeauty.pl",
    market_url: "https://dev.bonbeauty.pl",
    voucher_expires_at: "2027-07-30T00:00:00.000Z",
    order_id: "1042",
    purchase_date: "2026-07-30T09:15:00.000Z",
    voucher_value_minor: 20000,
    voucher_currency: "PLN",
    salon_url: "https://dev.bonbeauty.pl/pl/sellers/salon-bonbeauty",
    ...overrides,
  }
}

function manifestBodyVars(templateKey: string): Record<string, string[]> {
  const templateDir = resolve(MANIFEST_ROOT, templateKey)
  const perLocale: Record<string, string[]> = {}

  for (const locale of readdirSync(templateDir)) {
    const manifestPath = resolve(templateDir, locale, "manifest.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    perLocale[locale] = manifest.placeholders.body_vars
  }

  return perLocale
}

describe("Story 5.7 — kontrakt body vars pokrywa manifesty (AC3/AC4/AC5)", () => {
  it.each([
    ["voucher_handoff_link", VOUCHER_HANDOFF_LINK_BODY_VARS],
    ["voucher_purchase_confirmation", VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS],
  ])("kontrakt '%s' == body_vars manifestu w KAŻDYM locale", (key, contract) => {
    const perLocale = manifestBodyVars(key)
    expect(Object.keys(perLocale).length).toBeGreaterThan(0)

    for (const [locale, bodyVars] of Object.entries(perLocale)) {
      expect({ locale, vars: [...bodyVars].sort() }).toEqual({
        locale,
        vars: [...contract].sort(),
      })
    }
  })

  it("mapa NOTIFICATION_BODY_VAR_CONTRACT pokrywa oba klucze voucherowe", () => {
    expect(Object.keys(NOTIFICATION_BODY_VAR_CONTRACT).sort()).toEqual([
      "voucher_handoff_link",
      "voucher_purchase_confirmation",
    ])
  })
})

describe("Story 5.7 — payload builderów pokrywa kontrakt (AC3/AC4)", () => {
  it("handoff: Object.keys(data) zawiera KOMPLET body vars i nie ma `claim_url`", () => {
    const notification = buildHandoffLinkNotification(fullInput())
    const data = notification.data as Record<string, unknown>
    const keys = Object.keys(data)

    for (const name of VOUCHER_HANDOFF_LINK_BODY_VARS) {
      expect(keys).toContain(name)
      expect(String(data[name]).trim().length).toBeGreaterThan(0)
    }

    // Sedno defektu 5.3: nazwa, której nie czytał żaden szablon.
    expect(keys).not.toContain("claim_url")
    expect(data.handoff_url).toBe(
      `https://dev.bonbeauty.pl/pl/voucher/${VOUCHER_CODE}`,
    )
  })

  it("potwierdzenie: KOMPLET body vars, a `voucher_pdf_url` to strona vouchera", () => {
    const notification = buildPurchaseConfirmationNotification(fullInput())
    const data = notification.data as Record<string, unknown>
    const keys = Object.keys(data)

    for (const name of VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS) {
      expect(keys).toContain(name)
      expect(String(data[name]).trim().length).toBeGreaterThan(0)
    }

    expect(data.voucher_pdf_url).toBe(
      `https://dev.bonbeauty.pl/pl/voucher/${VOUCHER_CODE}`,
    )
    expect(String(data.voucher_pdf_url)).not.toMatch(/\.pdf$/i)
    expect(keys).not.toContain("claim_url")
  })

  it("zachowuje pola governance obok body vars (nie zastępuje ich)", () => {
    const data = buildPurchaseConfirmationNotification(fullInput())
      .data as Record<string, unknown>

    for (const name of [
      "template_key",
      "market_id",
      "flow_id",
      "locale",
      "idempotency_key",
      "entitlement_id",
      "dispatch_id",
      "recipient_hash",
    ]) {
      expect(Object.keys(data)).toContain(name)
    }
  })

  it("formatuje wartości dla locale — surowe minor units ani Date nie przechodzą", () => {
    const pl = buildPurchaseConfirmationNotification(fullInput()).data as Record<
      string,
      unknown
    >
    expect(pl.voucher_value).toBe("200,00")
    expect(pl.voucher_currency).toBe("PLN")
    expect(pl.voucher_expires_at).toBe("30.07.2027")
    expect(pl.purchase_date).toBe("30.07.2026")

    const en = buildPurchaseConfirmationNotification(
      fullInput({ locale: "en" }),
    ).data as Record<string, unknown>
    expect(en.voucher_value).toBe("200.00")
    expect(en.voucher_expires_at).toBe("2027-07-30")
  })

  it("kwota `numeric` zwrócona przez pg jako STRING nie degraduje (klasa ADR-166 R-1)", () => {
    const data = buildPurchaseConfirmationNotification(
      fullInput({ voucher_value_minor: "20000" }),
    ).data as Record<string, unknown>

    expect(data.voucher_value).toBe("200,00")
  })
})

describe("Story 5.7 — fail-loud na braku pokrycia (AC3.koniec / AC4.8)", () => {
  it.each([
    ["customer_first_name", { customer_first_name: null }],
    ["salon_name", { salon_name: null }],
    ["salon_address", { salon_address: "   " }],
    ["support_email", { support_email: null }],
    ["market_url", { market_url: null }],
    ["voucher_expires_at", { voucher_expires_at: null }],
  ])("handoff bez '%s' rzuca kontrolowany błąd", (missing, override) => {
    expect(() =>
      buildHandoffLinkNotification(
        fullInput(override as Partial<PurchaseConfirmationIntentInput>),
      ),
    ).toThrow(NotificationBodyVarsIncompleteError)

    try {
      buildHandoffLinkNotification(
        fullInput(override as Partial<PurchaseConfirmationIntentInput>),
      )
    } catch (error) {
      const typed = error as NotificationBodyVarsIncompleteError
      expect(typed.error_code).toBe("VOUCHER_DELIVERY_PAYLOAD_INCOMPLETE")
      expect(typed.missing_vars).toContain(missing)
      // Komunikat niesie NAZWY, nigdy wartości (bywają PII).
      expect(typed.message).not.toContain("kupujaca@example.test")
    }
  })

  it.each([
    ["order_id", { order_id: null }],
    ["purchase_date", { purchase_date: null }],
    ["voucher_value", { voucher_value_minor: null }],
    ["voucher_currency", { voucher_currency: null }],
    ["salon_url", { salon_url: null }],
  ])("potwierdzenie bez '%s' rzuca kontrolowany błąd", (missing, override) => {
    try {
      buildPurchaseConfirmationNotification(
        fullInput(override as Partial<PurchaseConfirmationIntentInput>),
      )
      throw new Error("oczekiwano NotificationBodyVarsIncompleteError")
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationBodyVarsIncompleteError)
      expect(
        (error as NotificationBodyVarsIncompleteError).missing_vars,
      ).toContain(missing)
    }
  })

  it("data wygaśnięcia nie do sparsowania nie trafia do maila jako `Invalid Date`", () => {
    expect(() =>
      buildHandoffLinkNotification(fullInput({ voucher_expires_at: "nie-data" })),
    ).toThrow(NotificationBodyVarsIncompleteError)
  })
})
