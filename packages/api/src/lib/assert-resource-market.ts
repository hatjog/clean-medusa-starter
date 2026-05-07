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
  /**
   * `false` = mutation may proceed (either same market, no ALS context with
   * `allowMissingAls: true`, or resource has no market scope).
   */
  blocked: false
}

export interface ResourceMarketBlocked {
  /**
   * `true` = mutation BLOCKED. Caller MUST return 404 with `body`
   * (NOT 403 — existence must not leak across markets per cleanup-27 AC6).
   */
  blocked: true
  body: { type: "not_found"; message: string }
}

export type MarketGuardResult = ResourceMarketGuard | ResourceMarketBlocked

/**
 * Options for {@link assertResourceMarket}.
 *
 * Defaults are FAIL-CLOSED to match AR45 write-path security posture. Callers
 * that intentionally serve cross-market admin / system-level traffic (AR44
 * §admin-exclusion) opt into permissive behaviour explicitly.
 */
export interface AssertResourceMarketOptions {
  /**
   * If `true`, return `{ blocked: false }` when `alsMarketId` is null/empty
   * (admin / system-level caller without ALS market context — AR44 §admin-exclusion).
   *
   * If `false` (default — fail-closed), missing ALS market context BLOCKS the
   * mutation. This is the secure default for write paths: a middleware bug that
   * drops `market_id` must NOT silently re-grant cross-market write access.
   *
   * Story v160-cleanup-61 review fix M2 — was previously fail-OPEN by default.
   */
  allowMissingAls?: boolean
  /**
   * If `true`, treat a null/empty resource as a probe-failure (block 404).
   * If `false` (default), let the caller handle null-resource separately
   * (e.g. constant-time anti-enumeration paths that pad latency before returning 404).
   *
   * Story v160-cleanup-61 review fix H1 — claim/route.ts adoption requires this
   * mode so the helper does not break the constant-time invariant.
   */
  blockOnMissingResource?: boolean
}

/**
 * assertResourceMarket — AR45 pre-mutation market-scope assertion.
 *
 * @param resource - Fetched resource object (or null if not found).
 * @param alsMarketId - ALS market_id from `marketContextStorage.getStore()?.market_id` (may be null).
 * @param resourceLabel - Human-readable label for 404 message (no id echoed — existence must not leak).
 * @param options - See {@link AssertResourceMarketOptions}. Defaults are FAIL-CLOSED.
 * @returns `{ blocked: false }` when mutation may proceed; `{ blocked: true, body }` when 404 should be returned.
 *   The `body.type` is always `"not_found"`; caller is expected to set HTTP status 404 (NEVER 403).
 *
 * AR45 rules (defaults — fail-closed):
 *   1. If resource is null:
 *        - default → not blocked (caller handles null-resource itself, e.g. constant-time path)
 *        - with `blockOnMissingResource: true` → 404 fail-closed
 *   2. If alsMarketId is null/empty:
 *        - default → 404 fail-closed (a middleware bug must NOT grant cross-market write)
 *        - with `allowMissingAls: true` → not blocked (admin / system-level opt-in)
 *   3. If resource.market_id is null/undefined → unscoped/global resource → not blocked.
 *      Empty-string `market_id` is NOT treated as unscoped (it is a data-integrity bug;
 *      surface as 404 — review fix L1).
 *   4. If resource.market_id !== alsMarketId → cross-market probe → 404 fail-closed.
 *   5. Otherwise → same-market → not blocked.
 */
export function assertResourceMarket(
  resource: { market_id?: string | null } | null,
  alsMarketId: string | null,
  resourceLabel = "resource",
  options: AssertResourceMarketOptions = {}
): MarketGuardResult {
  const { allowMissingAls = false, blockOnMissingResource = false } = options

  // Rule 1 — not found
  if (resource === null || resource === undefined) {
    if (blockOnMissingResource) {
      return {
        blocked: true,
        body: { type: "not_found", message: `${resourceLabel} not found` },
      }
    }
    return { blocked: false }
  }

  // Rule 2 — missing ALS context
  if (alsMarketId === null || alsMarketId === "") {
    if (allowMissingAls) {
      return { blocked: false }
    }
    return {
      blocked: true,
      body: { type: "not_found", message: `${resourceLabel} not found` },
    }
  }

  // Rule 3 — resource has no market scope (null/undefined only); allow.
  if (resource.market_id === null || resource.market_id === undefined) {
    return { blocked: false }
  }

  // Empty-string market_id is a data-integrity bug, not "unscoped"; treat as 404.
  // Review fix L1 — was previously silently allowed.
  if (resource.market_id === "") {
    return {
      blocked: true,
      body: { type: "not_found", message: `${resourceLabel} not found` },
    }
  }

  // Rule 4 — cross-market mismatch → 404 (existence must not leak).
  if (resource.market_id !== alsMarketId) {
    return {
      blocked: true,
      body: { type: "not_found", message: `${resourceLabel} not found` },
    }
  }

  // Rule 5 — same market → allow.
  return { blocked: false }
}
