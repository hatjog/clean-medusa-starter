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
 *
 * Logs a structured warning if the container resolve throws so silent
 * misconfiguration cannot mask itself behind the fail-closed RBAC path
 * (see capability-grants review F6).
 */
function getKnex(req: MedusaRequest): Knex | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const container = (req as any).scope ?? (req as any).__container__
    if (container?.resolve) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
    }
  } catch (err) {
    // Container present but PG_CONNECTION resolve failed — log so operators
    // can detect the misconfiguration. Capability check will fail-closed below.
    // eslint-disable-next-line no-console
    console.warn(
      "[capability-check] PG_CONNECTION resolve failed; capability checks will deny.",
      { error: err instanceof Error ? err.message : String(err) },
    )
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
 * Resolution order (fail-closed at every step):
 *  1. Short-circuit false if `actor_id` is missing (unauthenticated path).
 *  2. Short-circuit false if `actor_type !== "user"` — the grants table is
 *     admin-only by design (defence in depth even if a non-admin actor_id
 *     ever collides with an admin id; cleanup-42 review F2).
 *  3. Resolve Knex from container (or test seam). If unavailable, fail-closed
 *     and return `false`. There is intentionally NO fallback to the legacy
 *     "any admin user -> granted" behaviour: that stub is the bypass TF-102
 *     was opened to remove (cleanup-42 review F1).
 *  4. Query `admin_capability_grants` for the exact capability OR
 *     `__super_admin__` (single OR-clause). Result cached for CACHE_TTL_MS.
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
  // Defence in depth: grants table is admin-only. Reject any non-"user" actor
  // up-front so a future actor namespace cannot accidentally inherit grants.
  if (ctx.actor_type !== "user") {
    return false
  }
  const db = resolveKnex(req)
  if (!db) {
    // Fail-closed: no DB -> no grants. Operators see the warning emitted by
    // getKnex(); capability checks deny until PG_CONNECTION is restored.
    return false
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
 *
 * NOTE: Calling `requireCapability(req, "__super_admin__")` is technically
 * supported (the literal is part of the `Capability` union for manifest
 * symmetry) but is unusual — handlers should request the smallest capability
 * they actually need. The bypass key is meant to be granted, not required.
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
