/**
 * capability-grants-repo.ts — DB-backed admin capability grants resolver.
 *
 * Resolves active grants from `admin_capability_grants` table with an
 * in-process TTL cache (default 30 s) to avoid per-request DB hits.
 *
 * Super-admin shortcut: if the actor has a `__super_admin__` row with
 * `revoked_at IS NULL`, all capabilities are implicitly granted without
 * enumerating individual rows. The seed migration (cleanup-42) inserts this
 * row for every existing admin — v1.7.0 admin UI can granularise by
 * revoking it and inserting per-capability rows instead.
 *
 * OQ #2 resolved: super-admin bypass retained in v1.6.0 per default decision.
 * OQ #3 resolved: 30 s TTL across requests (CACHE_TTL_MS).
 * OQ #4 resolved: `__resetCapabilityCache()` exported for test seams only.
 *
 * @module lib/capability-grants-repo
 */
import type { Knex } from "knex"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for the in-process capability grant cache (milliseconds). */
export const CACHE_TTL_MS = 30_000

/** Distinguished capability that grants all capabilities implicitly. */
export const SUPER_ADMIN_CAPABILITY = "__super_admin__"

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = { value: boolean; expiresAt: number }
const _cache = new Map<string, CacheEntry>()

function _cacheKey(actor_id: string, capability: string): string {
  return `${actor_id}:${capability}`
}

/**
 * Reset all cached entries. Intended for use in tests only — exported with
 * a leading `__` to signal its private nature.
 *
 * In production the cache expires naturally via TTL; no runtime mutation API
 * is exposed in v1.6.0 (no admin UI for grant management).
 */
export function __resetCapabilityCache(): void {
  _cache.clear()
}

/**
 * Manually invalidate the cached entry for `(actor_id, capability)`.
 * Called internally after a revoke so the worst-case stale grant window
 * is bounded (not unbounded by TTL).
 */
export function invalidateCacheEntry(actor_id: string, capability: string): void {
  _cache.delete(_cacheKey(actor_id, capability))
  // Also invalidate __super_admin__ key so a revoked super-admin is seen
  // immediately on next lookup.
  _cache.delete(_cacheKey(actor_id, SUPER_ADMIN_CAPABILITY))
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * findActiveGrant — returns true if the actor holds an active grant for
 * `capability` (not revoked) OR holds an active `__super_admin__` grant.
 *
 * Uses a single DB query with an OR clause to satisfy both conditions in
 * one round-trip. Caches the result for CACHE_TTL_MS.
 *
 * @param db         Knex instance (or transaction)
 * @param actor_id   Admin actor identifier from auth_context
 * @param capability Capability string to check
 */
export async function findActiveGrant(
  db: Knex,
  actor_id: string,
  capability: string
): Promise<boolean> {
  const key = _cacheKey(actor_id, capability)
  const now = Date.now()
  const hit = _cache.get(key)
  if (hit && hit.expiresAt > now) {
    return hit.value
  }

  const rows = await db("admin_capability_grants")
    .select("capability")
    .where("actor_id", actor_id)
    .whereIn("capability", [capability, SUPER_ADMIN_CAPABILITY])
    .whereNull("revoked_at")
    .limit(1)

  const granted = rows.length > 0
  _cache.set(key, { value: granted, expiresAt: now + CACHE_TTL_MS })
  return granted
}

/**
 * listActiveGrantsForActor — returns all active capability strings for the actor.
 * Utility for audit / test assertions; not called in hot paths.
 */
export async function listActiveGrantsForActor(
  db: Knex,
  actor_id: string
): Promise<string[]> {
  const rows = await db("admin_capability_grants")
    .select<{ capability: string }[]>("capability")
    .where("actor_id", actor_id)
    .whereNull("revoked_at")
  return rows.map((r) => r.capability)
}
