/**
 * Story 3.3 AC2 — runda fix 2 (ADR-242 §Decyzja p.5, AR-03 „egzekwowane quantity=1").
 *
 * JEDNO kryterium „linia voucherowa" i JEDNA reguła krotności dla wszystkich
 * punktów egzekwowania:
 *   1. trasy koszyka sklepu (`POST /store/carts/:id/line-items[/:line_id]`) —
 *      PRZED powstaniem płatności, odmowa 400 z `reason`
 *      {@link VOUCHER_LINE_QUANTITY_CART_REASON};
 *   2. wystawca Path Y (`liveIssueEntitlementsWithinTx`) i wystawca captured
 *      (`issueEntitlementsForAllLineItems`) — fail-loud z `reason`
 *      {@link VOUCHER_LINE_QUANTITY_ISSUE_REASON}, nigdy ciche 1-za-N.
 *
 * Kryterium identyfikacji jest to samo, którego używa wystawca Path Y do
 * odróżnienia „non-voucher (legalne pominięcie)" od „linia voucherowa":
 * KTÓRYKOLWIEK marker entitlement w metadanych linii ALBO
 * `product.metadata.gp.entitlement_profile`.
 */

/** Nazwany powód odmowy na trasie koszyka (4xx, maszynowy). */
export const VOUCHER_LINE_QUANTITY_CART_REASON = "voucher_line_quantity_unsupported" as const

/** Nazwany powód porażki wystawienia (kontrakt `gift-line-issue-outcome.v1`). */
export const VOUCHER_LINE_QUANTITY_ISSUE_REASON = "quantity_per_line_unsupported" as const

/** Jedyna dopuszczalna krotność linii voucherowej (ADR-242 p.5). */
export const VOUCHER_LINE_REQUIRED_QUANTITY = 1

/**
 * Markery "voucher-intent" w metadanych linii. Obecność KTÓREGOKOLWIEK oznacza,
 * że linia MIAŁA być voucherem.
 */
export const VOUCHER_INTENT_KEYS = [
  "entitlement_profile",
  "entitlement_profile_id",
  "profile_id",
  "entitlement_type",
  "entitlement_policy",
  "recipients",
] as const

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function hasVoucherIntent(metadata: Record<string, unknown> | null | undefined): boolean {
  const obj = readObject(metadata)
  if (!obj) return false
  return VOUCHER_INTENT_KEYS.some((k) => obj[k] != null)
}

export function hasProductVoucherIntent(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  const gp = readObject(readObject(metadata)?.gp)
  return gp?.entitlement_profile != null
}

/** Linia voucherowa = marker w linii ALBO profil w produkcie (kryterium wystawcy). */
export function isVoucherLine(
  lineMetadata: Record<string, unknown> | null | undefined,
  productMetadata: Record<string, unknown> | null | undefined
): boolean {
  return hasVoucherIntent(lineMetadata) || hasProductVoucherIntent(productMetadata)
}

/**
 * Krotność z bazy (NUMERIC z node-pg bywa stringiem). Wartość nieczytelna
 * NIE jest traktowana jako 1 — zwraca `false` (fail-loud u wołającego).
 */
export function isSupportedVoucherLineQuantity(quantity: unknown): boolean {
  const n =
    typeof quantity === "number"
      ? quantity
      : typeof quantity === "string" && quantity.trim() !== ""
        ? Number(quantity)
        : Number.NaN
  return n === VOUCHER_LINE_REQUIRED_QUANTITY
}
