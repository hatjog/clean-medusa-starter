/**
 * market-scope-guard.unit.spec.ts
 *
 * Guard rynku miał kształt FAIL-OPEN: działał wyłącznie wtedy, gdy OBIE strony
 * były ustawione, więc zasób bez `sales_channel_id` był czytelny z dowolnego
 * rynku, a brak kontekstu rynku wyłączał guard w całości.
 *
 * Testy są tabelaryczne, bo to reguła binarna z czterema wariantami braku —
 * a każdy z nich był wcześniej cichą zgodą.
 */
import { isWithinMarketScope } from "../../lib/market-scope-guard"

describe("isWithinMarketScope — fail-closed", () => {
  it("zgadza sie tylko, gdy OBA kanaly sa obecne i identyczne", () => {
    expect(isWithinMarketScope("sc_bonbeauty", "sc_bonbeauty")).toBe(true)
  })

  it("rozne kanaly to odmowa", () => {
    expect(isWithinMarketScope("sc_bonbeauty", "sc_bongarden")).toBe(false)
  })

  it.each([
    ["brak kontekstu rynku", null, "sc_bonbeauty"],
    ["undefined kontekstu rynku", undefined, "sc_bonbeauty"],
    ["zasob bez kanalu", "sc_bonbeauty", null],
    ["zasob z undefined", "sc_bonbeauty", undefined],
    ["obie strony puste", null, null],
  ])("%s => ODMOWA (wczesniej byla cicha zgoda)", (_label, context, resource) => {
    expect(
      isWithinMarketScope(context as string | null, resource as string | null),
    ).toBe(false)
  })

  it.each([
    ["pusty string kontekstu", "", "sc_bonbeauty"],
    ["same spacje w kontekscie", "   ", "sc_bonbeauty"],
    ["pusty string zasobu", "sc_bonbeauty", ""],
    ["same spacje w zasobie", "sc_bonbeauty", "\t "],
  ])("%s traktujemy jak BRAK, nie jak identyfikator", (_label, context, resource) => {
    expect(isWithinMarketScope(context, resource)).toBe(false)
  })

  it("dwa puste stringi NIE sa 'takie same' — to nie jest dopasowanie", () => {
    // Naiwne `a === b` przepuscilo by ten przypadek jako zgodnosc.
    expect(isWithinMarketScope("", "")).toBe(false)
  })

  it("otaczajace spacje nie rozbijaja realnego dopasowania", () => {
    expect(isWithinMarketScope(" sc_bonbeauty ", "sc_bonbeauty")).toBe(true)
  })
})
