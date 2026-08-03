/**
 * notification-formatting.test.ts — Story 5.7 (AC3/AC4, „format jawnie
 * testowany dla locale").
 */

import {
  formatDateForLocale,
  formatMinorAmountForLocale,
  formatSalonAddress,
} from "../notification-formatting"

describe("formatDateForLocale", () => {
  it.each([
    ["pl", "30.07.2027"],
    ["de", "30.07.2027"],
    ["ua", "30.07.2027"],
    ["en", "2027-07-30"],
  ])("locale %s → %s", (locale, expected) => {
    expect(formatDateForLocale("2027-07-30T00:00:00.000Z", locale)).toBe(expected)
  })

  it("przyjmuje obiekt Date tak samo jak ISO string", () => {
    expect(formatDateForLocale(new Date("2027-07-30T23:59:59.000Z"), "pl")).toBe(
      "30.07.2027",
    )
  })

  it("liczy w UTC — ta sama data niezależnie od hosta wysyłki", () => {
    expect(formatDateForLocale("2027-01-01T00:30:00.000Z", "pl")).toBe("01.01.2027")
  })

  it("wariant regionalny locale (`pl-PL`) jest rozpoznawany", () => {
    expect(formatDateForLocale("2027-07-30T00:00:00.000Z", "pl-PL")).toBe(
      "30.07.2027",
    )
  })

  it.each([null, undefined, "", "nie-data"])(
    "wartość nieparsowalna (%p) → null, nigdy `Invalid Date`",
    (value) => {
      expect(formatDateForLocale(value as string | null, "pl")).toBeNull()
    },
  )
})

describe("formatMinorAmountForLocale", () => {
  it.each([
    [20000, "pl", "200,00"],
    [20000, "en", "200.00"],
    [1, "pl", "0,01"],
    [0, "pl", "0,00"],
    [-2550, "pl", "-25,50"],
  ])("%p minor w locale %s → %s", (minor, locale, expected) => {
    expect(formatMinorAmountForLocale(minor, locale)).toBe(expected)
  })

  it("akceptuje STRING z kolumny `numeric` (klasa defektu ADR-166 R-1)", () => {
    expect(formatMinorAmountForLocale("20000", "pl")).toBe("200,00")
  })

  it.each([null, undefined, "", "  ", "abc", {}])(
    "wartość nieliczbowa (%p) → null",
    (value) => {
      expect(formatMinorAmountForLocale(value, "pl")).toBeNull()
    },
  )
})

describe("formatSalonAddress", () => {
  it("składa ulicę, kod i miasto w adres, do którego można pójść", () => {
    expect(
      formatSalonAddress({
        address_1: "ul. Handlowa 10",
        address_2: "lok. 3",
        postal_code: "00-001",
        city: "Warszawa",
      }),
    ).toBe("ul. Handlowa 10 lok. 3, 00-001 Warszawa")
  })

  it("radzi sobie z brakiem drugiej linii i brakiem kodu", () => {
    expect(
      formatSalonAddress({ address_1: "ul. Handlowa 10", city: "Warszawa" }),
    ).toBe("ul. Handlowa 10, Warszawa")
  })

  it.each([
    [null],
    [{}],
    [{ postal_code: "00-001" }],
    [{ address_1: "   ", city: "  " }],
  ])("bez ulicy i bez miasta (%p) → null, nie kikut adresu", (parts) => {
    expect(formatSalonAddress(parts)).toBeNull()
  })
})
