/**
 * cleanup-3: Capability check helper for elevated admin operations.
 *
 * The `lifecycle.override` capability is reserved for admins with explicit
 * permission to bypass completeness-gate checks during lifecycle transitions.
 *
 * Design decision (cleanup-3 simpler path):
 *   Rather than a full RBAC table lookup (v1.7.0+), the capability is granted
 *   to ANY authenticated admin user (actor_type="user") with a valid session.
 *   This satisfies the security requirement that override is NOT available to
 *   unauthenticated callers, vendor tokens, or non-admin actors — while keeping
 *   the v1.6.0 implementation simple.
 *
 *   Future: v1.7.0 will add a `user_capabilities` table and replace
 *   `hasLifecycleOverrideCapability` with a real DB lookup.
 *
 * @see specs/constitution/admin-rbac.md (planned for v1.7.0)
 */

import type { MedusaRequest } from "@medusajs/framework/http"

export type CapabilityCheckResult =
  | { granted: true; actor_id: string; actor_type: string }
  | { granted: false; reason: string }

/**
 * Checks whether the authenticated actor has the `lifecycle.override` capability.
 *
 * v1.6.0 rule: granted iff actor_type == "user" (Medusa admin user) AND
 * actor_id is present. Non-admin actors (vendor tokens etc.) and unauthenticated
 * callers are rejected.
 */
export function checkLifecycleOverrideCapability(
  req: MedusaRequest,
): CapabilityCheckResult {
  const authCtx = (req as MedusaRequest & {
    auth_context?: { actor_id?: string; actor_type?: string }
  }).auth_context

  if (!authCtx?.actor_id) {
    return { granted: false, reason: "Unauthorized — no actor_id in auth context" }
  }

  if (authCtx.actor_type !== "user") {
    return {
      granted: false,
      reason: `Forbidden — lifecycle.override capability requires actor_type="user"; got "${authCtx.actor_type}"`,
    }
  }

  return {
    granted: true,
    actor_id: authCtx.actor_id,
    actor_type: authCtx.actor_type,
  }
}

/**
 * Validates override-specific request fields and returns a structured error
 * if they are missing/invalid.
 *
 * Requirements (AC3):
 *   - prior_decision: non-empty string (documents why override is justified)
 *   - admin_note: ≥ 30 characters
 *   - reason: ≥ 10 characters
 */
export function validateOverridePayload(body: {
  prior_decision?: string
  admin_note?: string
  reason?: string
}): { valid: true } | { valid: false; error: string } {
  if (!body.prior_decision || body.prior_decision.trim().length === 0) {
    return {
      valid: false,
      error: "override=true requires prior_decision field explaining why override is justified",
    }
  }

  const note = body.admin_note?.trim() ?? ""
  if (note.length < 30) {
    return {
      valid: false,
      error: `override=true requires admin_note ≥ 30 chars (got ${note.length})`,
    }
  }

  const reason = body.reason?.trim() ?? ""
  if (reason.length < 10) {
    return {
      valid: false,
      error: `override=true requires reason ≥ 10 chars (got ${reason.length})`,
    }
  }

  return { valid: true }
}

/**
 * Builds a policy_override audit log payload.
 * Caller must supply bypassed_checks — the list of skipped completeness gates.
 */
export function buildPolicyOverrideAuditPayload(params: {
  vendor_id: string
  actor_id: string
  prior_state: string
  bypassed_checks: string[]
  admin_note: string
  reason?: string
}): {
  category: "policy_override"
  actor_id: string
  vendor_id: string
  prior_state: string
  bypassed_checks: string[]
  admin_note: string
  reason: string | undefined
  timestamp: string
} {
  return {
    category: "policy_override",
    actor_id: params.actor_id,
    vendor_id: params.vendor_id,
    prior_state: params.prior_state,
    bypassed_checks: params.bypassed_checks,
    admin_note: params.admin_note,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}
