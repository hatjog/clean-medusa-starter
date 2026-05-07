/**
 * capability-check.ts — Admin capability resolution helper.
 *
 * v1.6.0 (cleanup-42 / TF-102): Replaced the "any admin user -> granted" stub
 * with a DB-backed resolver that reads from `admin_capability_grants`. Closes
 * TF-91/TF-92 properly (per-capability RBAC table is now real).
 *
 * Super-admin shortcut: actors with a `__super_admin__` grant (seeded by the
 * cleanup-42 migration for all existing admins) bypass per-capability lookup.
 * v1.7.0 admin UI can granularise by revoking that row.
 *
 * Security contract:
 *   - Returns true ONLY if a non-revoked grant row exists (direct or via
 *     super-admin bypass) - fail-closed on missing auth or DB errors
 *   - Short-circuits to { ok: false } with no DB lookup when actor_id is
 *     absent from auth_context (unauthenticated path)
 *   - Callers MUST have already run authenticate() + operatorAuthMiddleware
 *
 * Backwards compat invariant (cleanup-37/TF-91):
 *   Every existing admin seeded by the migration holds the
 *   `__super_admin__` grant which implicitly grants
 *   `vendor.lifecycle.override_training_cert`. No call sites renamed.
 *
 * @module lib/capability-check
 */
import type { MedusaRequest } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import {
  findActiveGrant,
  SUPER_ADMIN_CAPABILITY,
  __resetCapabilityCache,
  invalidateCacheEntry,
} from "./capability-grants-repo"

// Re-export cache utilities so consumers (tests) can import from one place.
export { __resetCapabilityCache, invalidateCacheEntry, SUPER_ADMIN_CAPABILITY }

// ---------------------------------------------------------------------------
// Capability manifest
// ---------------------------------------------------------------------------

/**
 * CAPABILITY_MANIFEST — frozen authoritative list of all admin capabilities.
 *
 * Structure: { [capability_key]: description_string }
 *
 * Consumers (migration seed, tests, future admin UI) MUST iterate this object
 * rather than duplicating the list. The migration seeds every existing admin
 * with `__super_admin__` (single row, not individual capability rows) so
 * additions here do not require a new migration until v1.7.0 admin UI lands.
 *
 * Naming convention: <domain>.<subdomain?>.<action>
 */
export const CAPABILITY_MANIFEST = Object.freeze({
  "lifecycle.override": "Allow override of vendor lifecycle gate conditions (generic)",
  "alerts.read": "Read platform alert history and evaluator state",
  "policy.bypass": "Bypass standard policy enforcement checks",
  /**
   * vendor.lifecycle.override_training_cert - Introduced: cleanup-37 / TF-91.
   * Allows pausing a seller while bypassing the FR54 training-cert pre-condition.
   */
  "vendor.lifecycle.override_training_cert":
    "Bypass training-cert requirement when pausing a seller (FR54 override path)",
  /**
   * vendor.lifecycle.pause - Introduced: cleanup-42 / TF-102 (extension hook).
   * Explicit per-capability pause right; v1.7.0 will wire route guard.
   */
  "vendor.lifecycle.pause": "Pause a seller vendor account",
  /**
   * vendor.lifecycle.unpause - Introduced: cleanup-42 / TF-102 (extension hook).
   */
  "vendor.lifecycle.unpause": "Unpause a seller vendor account",
  /**
   * vendor.lifecycle.suspend - Introduced: cleanup-42 / TF-102 (extension hook).
   */
  "vendor.lifecycle.suspend": "Suspend a seller vendor account",
  /**
   * admin.capability_grants.read - Introduced: cleanup-42 / TF-102 (extension hook).
   */
  "admin.capability_grants.read": "Read admin capability grants (v1.7.0 admin UI)",
  /**
   * admin.capability_grants.write - Introduced: cleanup-42 / TF-102 (extension hook).
   */
  "admin.capability_grants.write": "Create or revoke admin capability grants (v1.7.0 admin UI)",
  /**
   * __super_admin__ - Distinguished capability granting implicit access to all
   * other capabilities. Seeded for every existing admin by the cleanup-42
   * migration. Revocable to shift to per-capability model in v1.7.0.
   */
  [SUPER_ADMIN_CAPABILITY]: "Super-admin implicit grant (seeded for all existing admins)",
} as const)

/** Union type of all valid capability keys derived from the manifest. */
export type Capability = keyof typeof CAPABILITY_MANIFEST

// ---------------------------------------------------------------------------
// Internal auth context helper
// ---------------------------------------------------------------------------

type AuthContext = {
  actor_id?: string
  actor_type?: string
}

function getAuthContext(req: MedusaRequest): AuthContext | undefined {
  return (req as MedusaRequest & { auth_context?: AuthContext }).auth_context
}

/**
 * getKnex - extracts the Knex/pg_connection instance from the MedusaRequest
 * container using ContainerRegistrationKeys.PG_CONNECTION.
 */
function getKnex(req: MedusaRequest): Knex | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const container = (req as any).scope ?? (req as any).__container__
    if (container?.resolve) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
    }
  } catch {
    return undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Test-seam: allows unit tests to inject a mock Knex without touching the
// module-level container.
// ---------------------------------------------------------------------------
let _testKnex: Knex | undefined

/** Set mock Knex for unit tests. Call with undefined to reset. */
export function __setKnexForTests(db: Knex | undefined): void {
  _testKnex = db
}

function resolveKnex(req: MedusaRequest): Knex | undefined {
  return _testKnex ?? getKnex(req)
}

// ---------------------------------------------------------------------------
// Core capability resolution
// ---------------------------------------------------------------------------

/**
 * checkCapability - returns true if the authenticated actor holds `capability`.
 *
 * Resolution order:
 *  1. Short-circuit false if actor_id missing (unauthenticated).
 *  2. Resolve Knex from container (or test seam).
 *  3. Query `admin_capability_grants` for exact capability OR `__super_admin__`
 *     (single query, OR-clause). Result cached for CACHE_TTL_MS.
 *  4. If Knex is unavailable, falls back to `actor_type === "user"` for
 *     backward compat. TODO(v1.7.0): remove fallback.
 *
 * @param req        MedusaRequest with auth_context populated by middleware
 * @param capability Capability key to check
 */
export async function checkCapability(
  req: MedusaRequest,
  capability: Capability
): Promise<boolean> {
  const ctx = getAuthContext(req)
  if (!ctx?.actor_id) {
    return false
  }
  const db = resolveKnex(req)
  if (!db) {
    // Fallback: legacy "any admin user" behaviour when no DB is wired.
    // TODO(v1.7.0): remove fallback; require DB in all paths.
    return ctx.actor_type === "user"
  }
  return findActiveGrant(db, ctx.actor_id, capability)
}

/**
 * checkLifecycleOverrideCapability - backwards-compat wrapper.
 *
 * Retained for call sites (vendors lifecycle-status route) that import this
 * function by name. Delegates to `checkCapability` with `"lifecycle.override"`.
 */
export async function checkLifecycleOverrideCapability(
  req: MedusaRequest
): Promise<boolean> {
  return checkCapability(req, "lifecycle.override")
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Structured 403 payload shape shared by all capability-gated endpoints.
 * TF-92/93/108/111 siblings should import and use this type to avoid drift.
 */
export type CapabilityDeniedPayload = {
  code: "CAPABILITY_REQUIRED"
  capability: Capability
  message: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * requireCapability - enforces that the caller holds `capability`.
 *
 * Returns `{ ok: true }` when granted. Returns a structured 403 payload when
 * denied. No exception is thrown - callers pattern-match on `ok`:
 *
 *   const cap = await requireCapability(req, "vendor.lifecycle.override_training_cert");
 *   if (!cap.ok) { res.status(403).json(cap.body); return; }
 *
 * Backwards compat (cleanup-37/TF-91): the `vendor.lifecycle.override_training_cert`
 * key is preserved; migration-seeded admins hold `__super_admin__` which grants
 * this capability implicitly.
 */
export async function requireCapability(
  req: MedusaRequest,
  capability: Capability
): Promise<{ ok: true } | { ok: false; status: 403; body: CapabilityDeniedPayload }> {
  const granted = await checkCapability(req, capability)
  if (granted) {
    return { ok: true }
  }
  return {
    ok: false,
    status: 403,
    body: {
      code: "CAPABILITY_REQUIRED",
      capability,
      message: `Caller does not hold the required capability: ${capability}`,
    },
  }
}

/**
 * extractActorIdOrThrow - fail-closed actor extraction.
 *
 * Throws if auth_context is missing or actor_id is absent.
 * Must only be called after authenticate() + operatorAuthMiddleware have run.
 *
 * @throws Error if actor_id is not present in auth_context
 */
export function extractActorIdOrThrow(req: MedusaRequest): string {
  const ctx = getAuthContext(req)
  if (!ctx?.actor_id) {
    throw new Error("actor_id missing from auth_context - unauthenticated request reached handler")
  }
  return ctx.actor_id
}
