/**
 * Currency formatting helpers (IP-4, Story 1.9)
 *
 * Amounts are stored in grosze (integer cents).
 * Default currency: PLN → "10,00 zł", "1 000,00 zł"
 */

const PLN_FORMATTER = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an amount in grosze (integer cents) to a human-readable currency string.
 *
 * @param amountInGrosze - integer amount in the smallest currency unit
 * @param currency - ISO 4217 code, defaults to "PLN"
 * @returns formatted string, e.g. "10,00 zł" or "1 000,00 zł"
 */
export function formatCurrency(
  amountInGrosze: number,
  currency: string = "PLN",
): string {
  const value = amountInGrosze / 100;

  if (currency === "PLN") {
    return PLN_FORMATTER.format(value);
  }

  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
