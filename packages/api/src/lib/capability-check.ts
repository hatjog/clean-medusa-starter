/**
 * capability-check.ts — Admin capability resolution helper (cleanup-15a re-land).
 *
 * v1.6.0 policy: any authenticated admin user (actor_type="user") has all
 * lifecycle capabilities. Full per-capability RBAC table deferred to v1.7.0.
 *
 * Security contract:
 *   - Returns true ONLY if auth_context is present + actor_type === "user"
 *   - No fallback to true on missing/invalid auth — fail-closed
 *   - Callers MUST have already run authenticate() + operatorAuthMiddleware
 *     (those middleware return 401/403 before handler is invoked; capability
 *     check is a second gate for explicit override paths)
 *
 * @module lib/capability-check
 */
import type { MedusaRequest } from "@medusajs/framework/http"

export type Capability = "lifecycle.override" | "alerts.read" | "policy.bypass"

type AuthContext = {
  actor_id?: string
  actor_type?: string
}

function getAuthContext(req: MedusaRequest): AuthContext | undefined {
  return (req as MedusaRequest & { auth_context?: AuthContext }).auth_context
}

/**
 * checkLifecycleOverrideCapability — returns true if the authenticated actor
 * has the `lifecycle.override` capability (v1.6.0: any admin user → true).
 *
 * @param req MedusaRequest (must have auth_context populated by middleware)
 * @returns Promise<boolean> — true = capability granted; false = denied
 */
export async function checkLifecycleOverrideCapability(
  req: MedusaRequest
): Promise<boolean> {
  const ctx = getAuthContext(req)
  if (!ctx?.actor_id || !ctx?.actor_type) {
    return false
  }
  // v1.6.0: admin user role → granted. v1.7.0 will query capability_grants table.
  return ctx.actor_type === "user"
}

/**
 * checkCapability — generic capability check (convenience for future extension).
 *
 * @param req MedusaRequest
 * @param _capability Capability key (v1.6.0: ignored — all admin users granted)
 */
export async function checkCapability(
  req: MedusaRequest,
  _capability: Capability
): Promise<boolean> {
  return checkLifecycleOverrideCapability(req)
}

/**
 * extractActorIdOrThrow — fail-closed actor extraction.
 *
 * Replaces the legacy phantom-admin fallback pattern. Throws if auth_context is missing
 * or actor_id is absent — callers receive a 401 response from error boundary.
 * Must only be called after authenticate() + operatorAuthMiddleware have run.
 *
 * @throws Error if actor_id is not present in auth_context
 */
export function extractActorIdOrThrow(req: MedusaRequest): string {
  const ctx = getAuthContext(req)
  if (!ctx?.actor_id) {
    throw new Error("actor_id missing from auth_context — unauthenticated request reached handler")
  }
  return ctx.actor_id
}
