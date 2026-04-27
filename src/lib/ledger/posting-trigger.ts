/**
 * STORY-MIG-C — D-47 ledger_entry.posting_trigger domain contract.
 *
 * Application-code-side enforcement layer. v1.4.0 has no DB constraint
 * (column is nullable + sentinel-backfilled). Code paths writing to
 * `ledger_entry` MUST go through `assertPostingTrigger()` so that:
 *
 *   1. The sentinel value `'legacy-pre-v1.4.0'` is rejected at the writer
 *      (only the migration backfill ever writes it).
 *   2. Non-empty strings are accepted as forward-compatible domain values
 *      (free-text v1.4.0 per D-47; enum tightening deferred to v1.5.0).
 *   3. NULL / undefined / empty string aborts the write — caller must
 *      explicitly choose a domain value.
 *
 * v1.5.0+ tightens this to a closed enum once C3 NOT NULL constraint lands.
 *
 * Refs: D-47, STORY-MIG-C T2, AC #7
 */

/** Sentinel value written by the v1.4.0 backfill migration. NEVER write this from app code. */
export const LEGACY_POSTING_TRIGGER_SENTINEL = "legacy-pre-v1.4.0" as const;

/**
 * Canonical v1.4.0 domain values per D-47. v1.4.0 column is free-text
 * (forward-compatible); this list is the suggested baseline — additional
 * values are accepted at runtime but should be added here when adopted
 * across multiple writers.
 */
export const KNOWN_POSTING_TRIGGERS = Object.freeze([
  "order_placed",
  "refund",
  "manual_adjustment",
  "sync_repair",
] as const);

export type KnownPostingTrigger = (typeof KNOWN_POSTING_TRIGGERS)[number];

export type PostingTriggerValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "null_or_empty" | "sentinel_collision" };

/**
 * Validate a `posting_trigger` value about to be written to `ledger_entry`.
 *
 * Returns `{ ok: false }` for NULL/undefined/empty and for the sentinel —
 * in v1.4.0 the sentinel is reserved for migration backfill ONLY.
 */
export function validatePostingTrigger(
  value: string | null | undefined
): PostingTriggerValidation {
  if (value == null) {
    return { ok: false, reason: "null_or_empty" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "null_or_empty" };
  }
  if (trimmed === LEGACY_POSTING_TRIGGER_SENTINEL) {
    return { ok: false, reason: "sentinel_collision" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Throwing variant — call sites that have already type-checked their
 * domain value can use this to fail-fast on contract violations.
 */
export function assertPostingTrigger(
  value: string | null | undefined,
  context?: { writer?: string }
): string {
  const result = validatePostingTrigger(value);
  if (result.ok) {
    return result.value;
  }
  const writer = context?.writer ? ` (writer=${context.writer})` : "";
  if (result.reason === "sentinel_collision") {
    throw new Error(
      `[ledger.posting_trigger] Refusing to write sentinel value ` +
        `'${LEGACY_POSTING_TRIGGER_SENTINEL}'${writer}. ` +
        `That value is reserved for the v1.4.0 backfill migration ONLY. ` +
        `Pick a domain value: ${KNOWN_POSTING_TRIGGERS.join(", ")}.`
    );
  }
  throw new Error(
    `[ledger.posting_trigger] Refusing to write NULL/empty ` +
      `posting_trigger${writer}. ` +
      `Required by D-47; pick a domain value: ${KNOWN_POSTING_TRIGGERS.join(", ")}.`
  );
}

/**
 * Check whether a value matches the known closed-set of v1.4.0 trigger
 * values. Returns false for unknown-but-valid forward-compat strings —
 * callers that need to reject unknown values use this; callers that need
 * "non-NULL non-sentinel" use validatePostingTrigger instead.
 */
export function isKnownPostingTrigger(
  value: string
): value is KnownPostingTrigger {
  return (KNOWN_POSTING_TRIGGERS as readonly string[]).includes(value);
}
