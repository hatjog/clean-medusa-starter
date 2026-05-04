/**
 * Story v160-8-8 — AC4: Test-only flag-toggle endpoint.
 *
 * POST /admin/test/flag-toggle
 *   Body: { to_state: 'off' | 'shadow' | 'on' }
 *   Headers: X-Test-Mode: true (required)
 *
 * SECURITY CONTROLS:
 *   1. Hard-rejects unless ALLOW_TEST_ENDPOINTS=true AND NODE_ENV !== 'production'
 *   2. Requires X-Test-Mode: true header → 403 if absent
 *   3. Bypasses smoke-gate guard (purpose: 'e2e_test' — audit log marks this)
 *   4. Audit log entry written with purpose: 'e2e_test'
 *
 * ISOLATION WARNING: flag state is an in-memory singleton shared with all
 * live requests in the same process. Run E2E only against a dedicated staging
 * instance — never against a process handling real traffic.
 *
 * This endpoint exists solely for E2E test setup/teardown. It MUST NOT be
 * used in production workflows.
 *
 * @see GP/storefront/e2e/helpers/flag-helper.ts (consumer)
 * @see specs/operator/pre-promote-smoke-checklist.md
 * @see Story v160-8-3 (production flag-flip route: /admin/operator/flag-flip)
 *
 * @warning TEST ONLY — purpose: 'e2e_test' in audit trail
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  getCurrentState,
  setState,
  type MultiVendorFlagState,
} from "../../../lib/feature-flag-tri-state"

// Disable Medusa's default admin auth middleware — this route uses its own guards.
export const AUTHENTICATE = false

const ALLOWED_STATES: ReadonlySet<string> = new Set(["off", "shadow", "on"])

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // Guard 1: Hard-reject unless ALLOW_TEST_ENDPOINTS=true and not production.
  // ALLOW_TEST_ENDPOINTS must be explicitly set per environment (opt-in, not opt-out).
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_TEST_ENDPOINTS !== "true"
  ) {
    res.status(403).json({
      error: "test_endpoint_disabled",
      detail:
        "POST /admin/test/flag-toggle requires ALLOW_TEST_ENDPOINTS=true and NODE_ENV !== 'production'. " +
        "Use POST /admin/operator/flag-flip for production flag transitions.",
    })
    return
  }

  // Guard 2: Require X-Test-Mode header
  const testModeHeader = req.headers["x-test-mode"]
  if (testModeHeader !== "true") {
    res.status(403).json({
      error: "x_test_mode_header_required",
      detail: "Missing or invalid X-Test-Mode: true header.",
    })
    return
  }

  // Parse and validate body
  const body = (req.body ?? {}) as { to_state?: string }
  const toState = body.to_state

  if (!toState || !ALLOWED_STATES.has(toState)) {
    res.status(400).json({
      error: "invalid_to_state",
      detail: `to_state must be one of: ${[...ALLOWED_STATES].join(", ")}. Got: ${String(toState)}`,
    })
    return
  }

  const typedToState = toState as MultiVendorFlagState

  // Read current state
  const fromState = await getCurrentState()

  // If already in target state, return immediately (idempotent)
  if (fromState === typedToState) {
    res.status(200).json({
      from: fromState,
      to: typedToState,
      changed: false,
      purpose: "e2e_test",
    })
    return
  }

  try {
    // Transition with bypass_smoke_gate=true (e2e_test path)
    const result = await setState(typedToState, {
      triggered_by: "e2e_test_runner",
      admin_note: "Automated E2E test setup/teardown via Story v160-8-8",
      bypass_smoke_gate: true,
    })

    res.status(200).json({
      ...result,
      purpose: "e2e_test",
    })
  } catch (err) {
    const message = (err as Error).message
    // InvalidTransition (e.g. off → on directly)
    if (message.startsWith("InvalidTransition")) {
      res.status(409).json({
        error: "invalid_transition",
        detail: message,
        hint:
          "E2E flag-helper transitions via intermediate states (shadow) automatically. " +
          "Direct off→on is not an allowed transition — use ensureFlagOn() helper.",
      })
      return
    }
    res.status(500).json({ error: message })
  }
}

/**
 * GET /admin/test/flag-toggle — read current state (test convenience).
 * Same guards as POST.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_TEST_ENDPOINTS !== "true"
  ) {
    res.status(403).json({ error: "test_endpoint_disabled" })
    return
  }

  const testModeHeader = req.headers["x-test-mode"]
  if (testModeHeader !== "true") {
    res.status(403).json({ error: "x_test_mode_header_required" })
    return
  }

  const current = await getCurrentState()
  res.status(200).json({ current_state: current, purpose: "e2e_test" })
}
