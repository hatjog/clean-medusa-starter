/**
 * gp-config-sync-market-runtime — normalizacja bloku `money_path_brakes`
 * (v1.15.0 Story 2.1, AC4).
 *
 * Etap sync jest miejscem, w którym konfiguracja rynku przestaje być tekstem,
 * a zaczyna być zachowaniem. Dlatego tutaj rozstrzyga się, co jest brakiem
 * deklaracji (legalnym, z wartością bezpieczną), a co jest BŁĘDEM
 * konfiguracji (literówka w stanie hamulca) — cicha podmiana literówki na
 * `engaged` ukryłaby nieudaną próbę zwolnienia hamulca przed operatorem,
 * który byłby przekonany, że mu się udało.
 */

import {
  MONEY_PATH_BRAKE_SAFE_STATE,
  MONEY_PATH_BRAKE_SWITCHES,
  normalizeMoneyPathBrakes,
} from "../../scripts/gp-config-sync-market-runtime"

describe("normalizeMoneyPathBrakes", () => {
  it("brak bloku => wszystkie pięć hamulców zaciągniętych", () => {
    expect(normalizeMoneyPathBrakes(undefined)).toEqual({
      fr_6_7_multi_seller_purchase_return: "engaged",
      fr_9_delivery_idempotency: "engaged",
      fr_10_panel_redemption: "engaged",
      fr_12_redemption_ledger: "engaged",
      fr_14_market_isolation: "engaged",
    })
  })

  it("blok częściowy => brakujące przełączniki dostają wartość bezpieczną", () => {
    const result = normalizeMoneyPathBrakes({ fr_10_panel_redemption: "released" })
    expect(result.fr_10_panel_redemption).toBe("released")
    for (const brake of MONEY_PATH_BRAKE_SWITCHES) {
      if (brake === "fr_10_panel_redemption") continue
      expect(result[brake]).toBe(MONEY_PATH_BRAKE_SAFE_STATE)
    }
  })

  it("literówka w stanie zatrzymuje sync PRZED zapisem", () => {
    expect(() =>
      normalizeMoneyPathBrakes({ fr_9_delivery_idempotency: "relesed" }),
    ).toThrow(/money_path_brakes\.fr_9_delivery_idempotency/)
  })

  it("przełącznik spoza piątki jest błędem, nie polem ignorowanym", () => {
    expect(() => normalizeMoneyPathBrakes({ fr_99_wlasna_flaga: "released" })).toThrow(
      /ADR-177/,
    )
  })

  it("pusty blok jest błędem — „nic” nie jest deklaracją", () => {
    expect(() => normalizeMoneyPathBrakes({})).toThrow(/pusty/)
  })
})
