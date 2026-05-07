/**
 * assertResourceMarket — AR45 write-path helper.
 *
 * Story v160-cleanup-61: write-path AR45 enforcement parity.
 *
 * Asserts that a resource fetched by path-segment id belongs to the current
 * ALS market context before any mutation is attempted. Returns a 404 signal
 * (NOT 403 — existence must not leak across markets per cleanup-27 AC6 protocol).
 *
 * Usage pattern:
 *
 *   const als = marketContextStorage.getStore()
 *   const resource = await service.getById(id)
 *   const guard = assertResourceMarket(resource, als?.market_id ?? null, "resource_type")
 *   if (guard.blocked) {
 *     res.status(404).json(guard.body)
 *     return
 *   }
 *   // proceed with mutation — AR45 assertion PASSED
 *
 * @see specs/architecture/multi-market-isolation-matrix.md AR45
 * @see cleanup-27 AC6 (404 not 403 protocol — existence must not leak)
 */

export interface ResourceMarketGuard {
  /** true = cross-market probe blocked — return 404 immediately */
  blocked: false
}

export interface ResourceMarketBlocked {
  blocked: true
  body: { type: "not_found"; message: string }
}

export type MarketGuardResult = ResourceMarketGuard | ResourceMarketBlocked

/**
 * assertResourceMarket — AR45 pre-mutation market-scope assertion.
 *
 * @param resource - Fetched resource object (or null if not found).
 * @param alsMarketId - ALS market_id from `marketContextStorage.getStore()?.market_id` (may be null).
 * @param resourceLabel - Human-readable label for 404 message (no id echoed — existence must not leak).
 * @returns { blocked: false } when mutation may proceed; { blocked: true, body } when 404 should be returned.
 *
 * AR45 rules:
 *   1. If resource is null → not found (404). Fail-closed.
 *   2. If alsMarketId is null → no ALS context set (open access; backward compat for admin or
 *      system-level callers that do not inject market context). Mutation may proceed.
 *   3. If resource.market_id is null → resource has no market scope (unscoped/global). Mutation may proceed.
 *   4. If resource.market_id !== alsMarketId → cross-market probe. Fail-closed 404.
 *   5. Otherwise → same-market, mutation may proceed.
 */
export function assertResourceMarket(
  resource: { market_id?: string | null } | null,
  alsMarketId: string | null,
  resourceLabel = "resource"
): MarketGuardResult {
  // Rule 1 — not found
  if (resource === null || resource === undefined) {
    return {
      blocked: true,
      body: { type: "not_found", message: `${resourceLabel} not found` },
    }
  }

  // Rule 2 — no ALS context; allow (admin / system-level caller)
  if (alsMarketId === null || alsMarketId === "") {
    return { blocked: false }
  }

  // Rule 3 — resource has no market scope; allow
  if (resource.market_id === null || resource.market_id === undefined || resource.market_id === "") {
    return { blocked: false }
  }

  // Rule 4 — cross-market mismatch → 404 (existence must not leak)
  if (resource.market_id !== alsMarketId) {
    return {
      blocked: true,
      body: { type: "not_found", message: `${resourceLabel} not found` },
    }
  }

  // Rule 5 — same market → allow
  return { blocked: false }
}
