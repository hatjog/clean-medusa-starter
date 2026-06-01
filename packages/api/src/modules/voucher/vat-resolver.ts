export type VatClassification = "SPV" | "MPV"

export type ResolveVatClassificationInput = {
  /**
   * Layer 3 `policy.vat_rate_uniqueness` from ADR-136. Only literal `true`
   * confirms SPV eligibility; false, missing, or malformed evidence resolves
   * fail-closed to MPV.
   */
  vat_rate_uniqueness?: unknown
  /**
   * Optional cart/profile VAT rate evidence. When supplied, every value must be
   * known and normalize to one rate; empty, mixed, or unknown values resolve MPV.
   */
  vat_rates?: readonly unknown[] | null
}

const NO_RECLASSIFICATION_EVENTS = Object.freeze([
  "partial_redeem",
  "forfeiture",
  "expiry",
  "no_show",
] as const)

/**
 * ADR-135 snapshot contract: the resolver only produces `SPV|MPV`.
 * Production persists that value once at ISSUED and treats it as immutable.
 * Partial redeem, forfeiture, expiry, and no-show do not reclassify; void+issue
 * preserves the original classification. The physical L4 write belongs to
 * Story 3.3, when `vat_classification` exists on the runtime snapshot.
 */
export const VAT_CLASSIFICATION_SNAPSHOT_RULE = Object.freeze({
  adr: "ADR-135",
  snapshotState: "ISSUED",
  resultField: "metadata.vat_classification",
  immutableAfterSnapshot: true,
  reclassifiesAfterSnapshot: false,
  noReclassificationEvents: NO_RECLASSIFICATION_EVENTS,
  voidIssuePreservesOriginalClassification: true,
  physicalL4PersistenceStory: "3.3",
} as const)

/**
 * Pure deterministic SPV/MPV resolver for voucher VAT classification.
 *
 * Confirmed single VAT rate evidence resolves SPV. Everything else resolves
 * MPV fail-closed: mixed rates, empty evidence, unknown rates, malformed flags,
 * or contradictory input.
 */
export function resolveVatClassification(
  input: ResolveVatClassificationInput = {}
): VatClassification {
  if (
    input.vat_rate_uniqueness != null &&
    typeof input.vat_rate_uniqueness !== "boolean"
  ) {
    return "MPV"
  }

  if (input.vat_rate_uniqueness === false) {
    return "MPV"
  }

  if ("vat_rates" in input && input.vat_rates !== undefined) {
    if (!Array.isArray(input.vat_rates)) {
      return "MPV"
    }
    return hasSingleKnownVatRate(input.vat_rates) ? "SPV" : "MPV"
  }

  return input.vat_rate_uniqueness === true ? "SPV" : "MPV"
}

function hasSingleKnownVatRate(vatRates: readonly unknown[]): boolean {
  if (vatRates.length === 0) {
    return false
  }

  const normalizedRates: string[] = []
  for (const rate of vatRates) {
    const normalized = normalizeKnownVatRate(rate)
    if (normalized == null) {
      return false
    }
    normalizedRates.push(normalized)
  }

  return new Set(normalizedRates).size === 1
}

function normalizeKnownVatRate(vatRate: unknown): string | null {
  if (typeof vatRate === "number") {
    return Number.isFinite(vatRate) ? String(vatRate) : null
  }

  if (typeof vatRate === "string") {
    const normalized = vatRate.trim().toLowerCase().replace(/\s+/g, "")
    return normalized.length > 0 ? normalized : null
  }

  return null
}
