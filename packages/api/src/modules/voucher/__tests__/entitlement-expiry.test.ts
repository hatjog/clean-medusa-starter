/**
 * entitlement-expiry.test.ts — Story 4.2 (v1.11.0 Epic 4 / Wave 4).
 *
 * Pokrywa warstwę czystą salda + defensywnego expiry (AC1) oraz gate aktywacji
 * profilu forfeiture (AC3):
 *   AC1 — saldo na TYM SAMYM entitlement_id; deterministyczny `expires_at`
 *         (12 mies. domyślnie, boundary [1,24]); pre-expiry powiadomienie oferuje
 *         extend ORAZ bezpłatny zwrot salda (równorzędne); copy NIGDY „przepadnie"
 *         (test odrzuca zakazane frazy); odpłatny extend nigdy bez bezpłatnej opcji.
 *   AC3 — profil z forfeiture ⇒ aktywacja zablokowana (art. 385¹ KC, reuse boundary
 *         1.2); profil z extend/refund ⇒ GREEN.
 */

import { describe, it, expect } from "@jest/globals"
import {
  DEFAULT_VALIDITY_MONTHS,
  EXPIRED_CUSTOMER_STATUS,
  FORBIDDEN_FORFEITURE_TOKENS,
  ForfeitureCopyError,
  ExpiryProfileForfeitureError,
  entitlementRemainingBalance,
  resolveValidityMonths,
  addMonthsUtc,
  computeExpiresAt,
  assertNoForfeitureCopy,
  defaultPreExpiryMessage,
  buildPreExpiryNotification,
  buildPreExpiryIdempotencyKey,
  assertExpiryProfileActivatable,
} from "../entitlement-expiry"
import { ENTITLEMENT_BOUNDARY } from "../entitlement-boundary"

// ===========================================================================
// AC1 — saldo na tym samym entitlement_id (query, NIGDY reissue)
// ===========================================================================

describe("Story 4.2 AC1 — saldo (remaining) na tym samym entitlement_id", () => {
  it("czyta remaining_amount jako saldo niewykorzystane (has_unused_balance)", () => {
    const b = entitlementRemainingBalance({ id: "ent_1", remaining_amount: 12000 })
    expect(b.entitlement_id).toBe("ent_1")
    expect(b.remaining_minor).toBe(12000)
    expect(b.has_unused_balance).toBe(true)
  })

  it("remaining 0 ⇒ brak salda (has_unused_balance=false)", () => {
    const b = entitlementRemainingBalance({ id: "ent_1", remaining_amount: 0 })
    expect(b.remaining_minor).toBe(0)
    expect(b.has_unused_balance).toBe(false)
  })

  it("remaining null (legacy) ⇒ clamp do 0 (NIGDY ujemne)", () => {
    const b = entitlementRemainingBalance({ id: "ent_1", remaining_amount: null })
    expect(b.remaining_minor).toBe(0)
    expect(b.has_unused_balance).toBe(false)
  })

  it("remaining ujemne (anomalia) ⇒ clamp do 0 (fail-safe)", () => {
    const b = entitlementRemainingBalance({ id: "ent_1", remaining_amount: -50 })
    expect(b.remaining_minor).toBe(0)
  })
})

// ===========================================================================
// AC1 — deterministyczny expires_at (12 mies. domyślnie, boundary [1,24])
// ===========================================================================

describe("Story 4.2 AC1 — deterministyczny expires_at (D-9/FR14)", () => {
  const issued = new Date("2026-01-15T10:00:00.000Z")

  it("brak validity_months ⇒ domyślne 12 mies.", () => {
    expect(resolveValidityMonths({})).toBe(DEFAULT_VALIDITY_MONTHS)
    expect(resolveValidityMonths({})).toBe(12)
    const exp = computeExpiresAt(issued, {})
    expect(exp.toISOString()).toBe("2027-01-15T10:00:00.000Z")
  })

  it("validity_months z profilu (np. 6) ⇒ honorowane", () => {
    expect(resolveValidityMonths({ validity_months: 6 })).toBe(6)
    const exp = computeExpiresAt(issued, { validity_months: 6 })
    expect(exp.toISOString()).toBe("2026-07-15T10:00:00.000Z")
  })

  it("boundary: validity_months > 24 ⇒ CLAMP do 24 (NIE poszerza boundary)", () => {
    expect(resolveValidityMonths({ validity_months: 36 })).toBe(
      ENTITLEMENT_BOUNDARY.validity_months_max
    )
    expect(resolveValidityMonths({ validity_months: 36 })).toBe(24)
  })

  it("boundary: validity_months < 1 ⇒ CLAMP do 1 (min ≈ 30 dni)", () => {
    expect(resolveValidityMonths({ validity_months: 0 })).toBe(
      ENTITLEMENT_BOUNDARY.validity_months_min
    )
    expect(resolveValidityMonths({ validity_months: 0 })).toBe(1)
  })

  it("deterministyczny: ten sam input ⇒ ten sam termin (audytowalność)", () => {
    const a = computeExpiresAt(issued, { validity_months: 12 })
    const b = computeExpiresAt(issued, { validity_months: 12 })
    expect(a.toISOString()).toBe(b.toISOString())
  })

  it("addMonthsUtc: clamp dnia przy przepełnieniu miesiąca (31 sty + 1 mies.)", () => {
    const jan31 = new Date("2026-01-31T00:00:00.000Z")
    // luty 2026 ma 28 dni ⇒ clamp do 28 (NIE przeskok na marzec).
    expect(addMonthsUtc(jan31, 1).toISOString()).toBe("2026-02-28T00:00:00.000Z")
  })
})

// ===========================================================================
// AC1 — anti-forfeiture invariant w copy (MECHANICZNY, NIE review)
// ===========================================================================

describe("Story 4.2 AC1 — anti-forfeiture copy invariant (odrzuca zakazane frazy)", () => {
  it("assertNoForfeitureCopy: copy z 'przepadnie' rzuca ForfeitureCopyError", () => {
    expect(() =>
      assertNoForfeitureCopy("Twoje saldo wkrótce przepadnie — zapłać aby zachować")
    ).toThrow(ForfeitureCopyError)
  })

  it("odrzuca wszystkie warianty przepadku/utraty/forfeiture", () => {
    const bad = [
      "saldo przepadnie",
      "to oznacza przepadek środków",
      "utrata wartości vouchera",
      "value will be forfeited",
      "forfeiture of the balance",
    ]
    for (const text of bad) {
      expect(() => assertNoForfeitureCopy(text)).toThrow(ForfeitureCopyError)
    }
  })

  it("case-insensitive: 'PRZEPADNIE' tez odrzucone", () => {
    expect(() => assertNoForfeitureCopy("SALDO PRZEPADNIE")).toThrow(
      ForfeitureCopyError
    )
  })

  it("copy opiekuńcze (extend/zwrot, bez przepadku) ⇒ przechodzi", () => {
    expect(() => assertNoForfeitureCopy(defaultPreExpiryMessage())).not.toThrow()
  })

  it("FORBIDDEN_FORFEITURE_TOKENS spójne z walidatorem 1.2 (forfeit/przepad/utrat)", () => {
    expect(FORBIDDEN_FORFEITURE_TOKENS).toEqual(
      expect.arrayContaining(["przepad", "utrat", "forfeit", "forfeiture"])
    )
  })

  it("default copy NIE zawiera żadnego zakazanego tokenu", () => {
    const msg = defaultPreExpiryMessage().toLowerCase()
    for (const token of FORBIDDEN_FORFEITURE_TOKENS) {
      expect(msg.includes(token)).toBe(false)
    }
  })
})

// ===========================================================================
// AC1 — pre-expiry powiadomienie: extend ‖ bezpłatny zwrot salda (równorzędne)
// ===========================================================================

describe("Story 4.2 AC1 — pre-expiry powiadomienie (extend + bezpłatny zwrot)", () => {
  const expiresAt = new Date("2027-01-15T10:00:00.000Z")

  it("oferuje extend ORAZ refund_balance jako równorzędne alternatywy", () => {
    const n = buildPreExpiryNotification({
      entitlement_id: "ent_1",
      expires_at: expiresAt,
      remaining_minor: 12000,
    })
    const kinds = n.options.map((o) => o.kind)
    expect(kinds).toContain("extend")
    expect(kinds).toContain("refund_balance")
    // refund_balance ZAWSZE bezpłatny (równorzędna alternatywa, nie pomocnicza).
    const refund = n.options.find((o) => o.kind === "refund_balance")!
    expect(refund.paid).toBe(false)
  })

  it("copy powiadomienia przechodzi anti-forfeiture invariant (NIGDY 'przepadnie')", () => {
    const n = buildPreExpiryNotification({
      entitlement_id: "ent_1",
      expires_at: expiresAt,
      remaining_minor: 12000,
    })
    expect(() => assertNoForfeitureCopy(n.message)).not.toThrow()
  })

  it("override copy z zakazaną frazą ⇒ rzuca (gate mechaniczny, NIE generuje)", () => {
    expect(() =>
      buildPreExpiryNotification({
        entitlement_id: "ent_1",
        expires_at: expiresAt,
        remaining_minor: 12000,
        message: "Saldo przepadnie jeśli nie zapłacisz",
      })
    ).toThrow(ForfeitureCopyError)
  })

  it("odpłatny extend (paid_extend=true) ⇒ NADAL ma bezpłatną opcję (refund_balance)", () => {
    const n = buildPreExpiryNotification({
      entitlement_id: "ent_1",
      expires_at: expiresAt,
      remaining_minor: 12000,
      paid_extend: true,
    })
    const ext = n.options.find((o) => o.kind === "extend")!
    expect(ext.paid).toBe(true)
    // UX-DR-08 H-2: odpłatny extend nigdy bez równoczesnej bezpłatnej opcji.
    expect(n.options.some((o) => !o.paid)).toBe(true)
  })

  it("idempotency_key deterministyczny per (entitlement_id, expires_at)", () => {
    const n = buildPreExpiryNotification({
      entitlement_id: "ent_1",
      expires_at: expiresAt,
      remaining_minor: 12000,
    })
    expect(n.idempotency_key).toBe(
      buildPreExpiryIdempotencyKey("ent_1", expiresAt.toISOString())
    )
    // Inny termin (np. po extend) ⇒ inny klucz (nowe okno przypomnienia).
    const later = buildPreExpiryNotification({
      entitlement_id: "ent_1",
      expires_at: new Date("2027-07-15T10:00:00.000Z"),
      remaining_minor: 12000,
    })
    expect(later.idempotency_key).not.toBe(n.idempotency_key)
  })

  it("EXPIRED_CUSTOMER_STATUS = recovery-as-care (UX §8), NIE 'przepadlo'", () => {
    expect(EXPIRED_CUSTOMER_STATUS).toBe("Ważność minęła — sprawdź opcje zwrotu")
    expect(() => assertNoForfeitureCopy(EXPIRED_CUSTOMER_STATUS)).not.toThrow()
  })
})

// ===========================================================================
// AC3 — blokada profilu forfeiture przy aktywacji (REUSE boundary 1.2)
// ===========================================================================

describe("Story 4.2 AC3 — profil z forfeiture zablokowany przy aktywacji", () => {
  it("on_expiry_convert_to=forfeiture ⇒ aktywacja zablokowana (art. 385¹ KC)", () => {
    expect(() =>
      assertExpiryProfileActivatable({
        validity_months: 12,
        on_expiry_convert_to: "forfeiture",
      })
    ).toThrow(ExpiryProfileForfeitureError)
  })

  it("on_expiry_convert_to=przepadek ⇒ zablokowany", () => {
    expect(() =>
      assertExpiryProfileActivatable({
        validity_months: 12,
        on_expiry_convert_to: "przepadek",
      })
    ).toThrow(ExpiryProfileForfeitureError)
  })

  it("on_expiry_convert_to=extend ⇒ GREEN (dozwolone)", () => {
    expect(() =>
      assertExpiryProfileActivatable({
        validity_months: 12,
        on_expiry_convert_to: "extend",
      })
    ).not.toThrow()
  })

  it("on_expiry_convert_to=refund ⇒ GREEN (dozwolone)", () => {
    expect(() =>
      assertExpiryProfileActivatable({
        validity_months: 12,
        on_expiry_convert_to: "refund",
      })
    ).not.toThrow()
  })

  it("brak on_expiry_convert_to ⇒ GREEN (pole opcjonalne; gate dotyczy forfeiture)", () => {
    expect(() =>
      assertExpiryProfileActivatable({ validity_months: 12 })
    ).not.toThrow()
  })

  it("błąd niesie podstawę prawną (art. 385¹ KC) i wskazanie extend/refund", () => {
    try {
      assertExpiryProfileActivatable({
        validity_months: 12,
        on_expiry_convert_to: "forfeiture",
      })
      throw new Error("oczekiwano ExpiryProfileForfeitureError")
    } catch (err) {
      expect(err).toBeInstanceOf(ExpiryProfileForfeitureError)
      expect((err as Error).message).toContain("385")
      expect((err as Error).message).toMatch(/extend/)
      expect((err as Error).message).toMatch(/refund/)
    }
  })
})
