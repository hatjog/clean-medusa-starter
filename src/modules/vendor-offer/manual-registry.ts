/**
 * vendor-offer/manual-registry.ts — READ-only settings-table backed callsite
 * registry per STORY-4-2 §AC-PVR-4.2-04 + §E2 (Pre-mortem R2 mitigation).
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-4-2-PRIMARY-VENDOR-RESOLVER.md
 *
 * Boundary (Pre-mortem §E2 R2):
 *  - This module is **READ-only**. Querying it never mutates state.
 *  - WRITE callsites for `incumbent_marker` mutations live in
 *    `vendor-offer.service.ts` (admin write paths) per STORY-4-1.
 *  - The settings-table backing is the canonical source-of-truth so registry
 *    drift between admin UI mutation paths and DB rows is detected by the
 *    grep CI lint (`validate_primary_vendor_callsites.py` lands separately
 *    in story Files / Artifacts §Super-repo).
 *
 * v1.5.0 starting set (4 callsites per AC-PVR-4.2-04):
 *  1. PDP product page
 *  2. Cart line item resolution
 *  3. Category/listing card
 *  4. Order detail
 *
 * v1.6.0 may add UI callsites for the multi-vendor secondary surface
 * (additive-MINOR; new rows are appended to the settings table).
 */

/**
 * RegisteredCallsite — one row per primary-vendor READ callsite.
 *
 * Net-new optional fields = additive-MINOR (safe). Renaming or removing
 * fields = MAJOR (forces consumer migration).
 */
export interface RegisteredCallsite {
  /** Stable callsite key (kebab-case). MUST be unique across the registry. */
  callsite: string
  /** Repository-relative path to the file that performs the lookup. */
  file: string
  /** Function or component name within the file. */
  function: string
  /** Public façade module the callsite imports through. */
  reads_via: "data/vendor-offer/primary-resolver" | "lib/data/primary-vendor"
  /** Date the callsite was registered (ISO yyyy-mm-dd). */
  added_at: string
  /** Reviewer GitHub handle that approved the registry row. */
  reviewer: string
}

/**
 * Default v1.5.0 starting set. The settings table seeds from this list at
 * boot; consumers should call {@link loadRegistry} (which reads the live
 * table) rather than depending on this constant directly.
 */
export const V150_DEFAULT_CALLSITES: ReadonlyArray<RegisteredCallsite> = [
  {
    callsite: "pdp-product-page",
    file: "GP/storefront/src/app/[locale]/(main)/products/[handle]/page.tsx",
    function: "ProductPage",
    reads_via: "data/vendor-offer/primary-resolver",
    added_at: "2026-04-30",
    reviewer: "@hatjog",
  },
  {
    callsite: "cart-line-item",
    file: "GP/storefront/src/components/cart/cart-line.tsx",
    function: "CartLine",
    reads_via: "data/vendor-offer/primary-resolver",
    added_at: "2026-04-30",
    reviewer: "@hatjog",
  },
  {
    callsite: "listing-card",
    file: "GP/storefront/src/components/sections/listing-card.tsx",
    function: "ListingCard",
    reads_via: "data/vendor-offer/primary-resolver",
    added_at: "2026-04-30",
    reviewer: "@hatjog",
  },
  {
    callsite: "order-detail",
    file: "GP/storefront/src/app/[locale]/(main)/order/[id]/page.tsx",
    function: "OrderDetailPage",
    reads_via: "data/vendor-offer/primary-resolver",
    added_at: "2026-04-30",
    reviewer: "@hatjog",
  },
]

/**
 * SettingsTableReader — minimal port for the settings-table backing.
 * STORY-1-3 lands the full settings module; the registry depends on this
 * **interface** so it can be unit-tested without a DB harness.
 */
export interface SettingsTableReader {
  /**
   * Returns the JSON-serialised registry rows for the given key, or `null`
   * if the table has no entry. The caller is responsible for parsing.
   */
  getJson(key: string): Promise<unknown | null>
}

const SETTINGS_KEY = "vendor_offer.primary_vendor_callsites" as const

/**
 * RegistryLookupError — discriminated error class. Consumers may match on
 * `code`; treat code values as part of the public contract.
 */
export type RegistryLookupErrorCode =
  | "REGISTRY_NOT_FOUND"
  | "REGISTRY_MALFORMED"
  | "DUPLICATE_CALLSITE"

export class RegistryLookupError extends Error {
  public readonly code: RegistryLookupErrorCode
  constructor(args: { code: RegistryLookupErrorCode; message: string }) {
    super(args.message)
    this.name = "RegistryLookupError"
    this.code = args.code
    Object.setPrototypeOf(this, RegistryLookupError.prototype)
  }
}

/**
 * loadRegistry — READ helper. Returns the persisted callsite registry.
 *
 * - Returns the {@link V150_DEFAULT_CALLSITES} when the settings table has
 *   no row (boot path / cold start).
 * - Throws `RegistryLookupError(REGISTRY_MALFORMED)` if the persisted JSON
 *   does not match the expected shape.
 * - Throws `RegistryLookupError(DUPLICATE_CALLSITE)` if any `callsite` key
 *   collides — uniqueness is the registry's primary integrity invariant.
 */
export async function loadRegistry(
  reader: SettingsTableReader
): Promise<ReadonlyArray<RegisteredCallsite>> {
  const raw = await reader.getJson(SETTINGS_KEY)
  if (raw === null || raw === undefined) {
    return V150_DEFAULT_CALLSITES
  }
  if (!Array.isArray(raw)) {
    throw new RegistryLookupError({
      code: "REGISTRY_MALFORMED",
      message: `expected array at settings key '${SETTINGS_KEY}', got ${typeof raw}`,
    })
  }

  const rows = raw.map((row, idx) => {
    if (!isValidCallsite(row)) {
      throw new RegistryLookupError({
        code: "REGISTRY_MALFORMED",
        message: `row ${idx} at '${SETTINGS_KEY}' is not a valid RegisteredCallsite`,
      })
    }
    return row
  })

  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.callsite)) {
      throw new RegistryLookupError({
        code: "DUPLICATE_CALLSITE",
        message: `duplicate callsite key '${row.callsite}' in '${SETTINGS_KEY}'`,
      })
    }
    seen.add(row.callsite)
  }

  return rows
}

/**
 * Lookup a single registered callsite by key. Returns `null` when not found
 * (intentional — callers may compose a custom error per UX).
 */
export async function findCallsite(
  reader: SettingsTableReader,
  callsite: string
): Promise<RegisteredCallsite | null> {
  const rows = await loadRegistry(reader)
  return rows.find((r) => r.callsite === callsite) ?? null
}

/**
 * isCallsiteRegistered — convenience predicate. Returns `true` when the
 * callsite key is present in the registry.
 */
export async function isCallsiteRegistered(
  reader: SettingsTableReader,
  callsite: string
): Promise<boolean> {
  return (await findCallsite(reader, callsite)) !== null
}

function isValidCallsite(value: unknown): value is RegisteredCallsite {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    typeof v.callsite === "string" &&
    v.callsite.length > 0 &&
    typeof v.file === "string" &&
    typeof v.function === "string" &&
    (v.reads_via === "data/vendor-offer/primary-resolver" ||
      v.reads_via === "lib/data/primary-vendor") &&
    typeof v.added_at === "string" &&
    typeof v.reviewer === "string"
  )
}

/** Settings key — exported so admin-side WRITE paths can target the same row. */
export const PRIMARY_VENDOR_CALLSITES_SETTINGS_KEY = SETTINGS_KEY
