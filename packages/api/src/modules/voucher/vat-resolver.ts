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
   * a recognised Polish VAT rate (0/5/8/23%) and normalize to one rate; empty,
   * mixed, unknown, or out-of-domain values resolve MPV.
   *
   * Precedence: when both `vat_rate_uniqueness` and `vat_rates` are supplied,
   * the rate set is authoritative and overrides the flag (a `true` flag paired
   * with mixed/unknown rates still resolves MPV fail-closed).
   */
  vat_rates?: readonly unknown[] | null
}

/**
 * Allow-list of recognised Polish VAT rates expressed in percentage points
 * (0%, 5%, 8%, 23%). Any rate outside this domain is treated as unknown and
 * resolves MPV fail-closed — the resolver never presumes SPV (ADR-135 §Rollback).
 */
const KNOWN_VAT_RATES_PERCENT = Object.freeze([0, 5, 8, 23] as const)

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

/**
 * Normalizes a raw VAT rate to its canonical known-rate token, or `null` when
 * the value is not a recognised Polish VAT rate. Both percentage-point forms
 * (`8`, `8.0`, `"8%"`, `"8.00%"`) and decimal-fraction forms (`0.08`) collapse
 * to the same token when economically equal. Internal whitespace is never
 * stripped (`"1 8%"` is rejected, not collapsed to `"18%"`); only surrounding
 * whitespace and a trailing `%` are trimmed.
 */
function normalizeKnownVatRate(vatRate: unknown): string | null {
  if (typeof vatRate === "number") {
    if (!Number.isFinite(vatRate)) {
      return null
    }
    // A bare number is ambiguous: try percentage-point then decimal-fraction.
    return canonicalKnownRate(vatRate, true)
  }

  if (typeof vatRate === "string") {
    const trimmed = vatRate.trim()
    if (trimmed.length === 0) {
      return null
    }

    const hasPercent = trimmed.endsWith("%")
    const core = (hasPercent ? trimmed.slice(0, -1) : trimmed).trim()

    // Strict numeric token: rejects internal whitespace (`"1 8"`) and junk
    // (`"unknown"`, `"???"`), so they fail-close to MPV.
    if (!/^-?\d+(\.\d+)?$/.test(core)) {
      return null
    }

    const numeric = Number(core)
    if (!Number.isFinite(numeric)) {
      return null
    }

    // An explicit `%` pins the percentage-point reading; a bare numeric string
    // stays ambiguous and may also be read as a decimal fraction.
    return canonicalKnownRate(numeric, !hasPercent)
  }

  return null
}

/**
 * Maps a numeric rate to its canonical known-rate token when it matches the
 * Polish VAT allow-list, otherwise `null`. Checks the percentage-point reading
 * first; when `allowFraction` is set, also checks the decimal-fraction reading
 * (e.g. `0.08` → 8%). Float artefacts (`0.08 * 100 = 8.000000000000002`) are
 * rounded away before comparison.
 */
function canonicalKnownRate(
  numeric: number,
  allowFraction: boolean
): string | null {
  if ((KNOWN_VAT_RATES_PERCENT as readonly number[]).includes(numeric)) {
    return String(numeric)
  }

  if (allowFraction) {
    const asPercent = Number((numeric * 100).toFixed(6))
    if ((KNOWN_VAT_RATES_PERCENT as readonly number[]).includes(asPercent)) {
      return String(asPercent)
    }
  }

  return null
}
