/**
 * GP ↔ upstream Stripe amount-unit boundary normalization.
 *
 * GP stores ALL monetary amounts in MINOR units (e.g. grosze: 26000 = 260.00
 * PLN) — this is the documented commerce-domain convention
 * (`specs/domains/commerce/README.md`: "Kwoty pieniężne ... jako minor units").
 *
 * The upstream `@medusajs/payment-stripe` provider assumes Medusa-native MAJOR
 * units: it runs `getSmallestUnit(amount, currency)` (×100 for 2-decimal
 * currencies) on amounts it SENDS to Stripe, and `getAmountFromSmallestUnit`
 * (÷100) on amounts it RETURNS. Left unbridged, a 26000-grosze (260 PLN) cart
 * was charged 2 600 000 grosze (26 000 PLN) — a ×100 overcharge.
 *
 * These helpers translate at the GP↔upstream boundary so the upstream math
 * lands on the correct Stripe smallest-unit value. They reuse the upstream's
 * OWN `getSmallestUnit` / `getAmountFromSmallestUnit` so the currency-decimals
 * table (0-decimal JPY/KRW, 3-decimal KWD/BHD, default 2) stays in lock-step
 * with whatever the provider actually applies — no parallel multiplier table.
 *
 * Round-trip is exact for integer minor amounts:
 *   providerMajorToGpMinor(gpMinorToProviderMajor(26000, "pln"), "pln") === 26000
 *
 * [Path B fix for the minor-vs-major ×100 defect — see audit. Alternative
 *  Path A (re-seed data to major units) was rejected: it would violate the
 *  minor-units SSOT and touch storefront/admin/vendor/seed/config.]
 */
import type { BigNumberInput } from "@medusajs/framework/types"
import {
  getSmallestUnit,
  getAmountFromSmallestUnit,
} from "@medusajs/payment-stripe/dist/utils/get-smallest-unit"

/**
 * Convert a GP-stored MINOR amount (grosze) into the MAJOR-unit value the
 * upstream provider expects on its INPUT path (before it re-applies
 * getSmallestUnit). `null`/`undefined` pass through untouched — several
 * provider methods (e.g. updatePayment) legitimately omit `amount`.
 */
export function gpMinorToProviderMajor<T extends BigNumberInput | null | undefined>(
  amount: T,
  currency: string | null | undefined
): T | number {
  if (amount == null || !currency) return amount
  return getAmountFromSmallestUnit(amount, currency)
}

/**
 * Convert a MAJOR-unit amount the upstream provider RETURNS (already passed
 * through getAmountFromSmallestUnit) back into GP MINOR units (grosze).
 * `null`/`undefined` pass through untouched.
 */
export function providerMajorToGpMinor<T extends BigNumberInput | null | undefined>(
  amount: T,
  currency: string | null | undefined
): T | number {
  if (amount == null || !currency) return amount
  return getSmallestUnit(amount, currency)
}
