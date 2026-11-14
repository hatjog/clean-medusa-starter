/**
 * Story 5.4 fix (checkpoint PO) — admin projection of `remaining` for VOUCHER_SERVICE.
 * After 5.4 a redeemed service entitlement keeps `remaining_amount = NULL`; the
 * admin view must NOT substitute the face value for it (that showed
 * "Pozostało: 340,00 zł" at REDEEMED_FULL).
 */
import { resolveAdminRemainingMinor, SERVICE_CONSUMED_OR_TERMINAL_STATES } from "../service"
import { EntitlementType } from "../models/entitlement"

describe("Story 5.4 fix — resolveAdminRemainingMinor", () => {
  const face = 34000

  it.each([...SERVICE_CONSUMED_OR_TERMINAL_STATES])(
    "VOUCHER_SERVICE w stanie %s z remaining_amount=NULL ⇒ 0, nie wartość nominalna",
    (state) => {
      expect(
        resolveAdminRemainingMinor(
          { entitlement_type: EntitlementType.VOUCHER_SERVICE, state, remaining_amount: null },
          face
        )
      ).toBe(0)
    }
  )

  it("zbiór stanów obejmuje REDEEMED_FULL i REFUNDED", () => {
    expect(SERVICE_CONSUMED_OR_TERMINAL_STATES.has("REDEEMED_FULL")).toBe(true)
    expect(SERVICE_CONSUMED_OR_TERMINAL_STATES.has("REFUNDED")).toBe(true)
  })

  it("VOUCHER_SERVICE przed realizacją (ACTIVE, NULL) ⇒ wartość nominalna (bez zmian)", () => {
    expect(
      resolveAdminRemainingMinor(
        { entitlement_type: EntitlementType.VOUCHER_SERVICE, state: "ACTIVE", remaining_amount: null },
        face
      )
    ).toBe(face)
  })

  it("voucher kwotowy bez zmian: saldo z remaining_amount (także jako string z node-pg)", () => {
    expect(
      resolveAdminRemainingMinor(
        { entitlement_type: EntitlementType.VOUCHER_AMOUNT, state: "REDEEMED_PARTIAL", remaining_amount: "12000" },
        face
      )
    ).toBe(12000)
    expect(
      resolveAdminRemainingMinor(
        { entitlement_type: EntitlementType.VOUCHER_AMOUNT, state: "REDEEMED_FULL", remaining_amount: 0 },
        face
      )
    ).toBe(0)
  })

  it("voucher kwotowy z NULL ⇒ wartość nominalna (zachowanie sprzed 5.4)", () => {
    expect(
      resolveAdminRemainingMinor(
        { entitlement_type: EntitlementType.VOUCHER_AMOUNT, state: "REDEEMED_FULL", remaining_amount: null },
        face
      )
    ).toBe(face)
  })
})
