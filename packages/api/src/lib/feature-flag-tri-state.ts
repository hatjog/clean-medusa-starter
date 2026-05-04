/**
 * Story v160-8-3: Multi-vendor feature flag tri-state OFF/SHADOW/ON.
 *
 * @see specs/adr/ADR-070-feature-flag-tri-state.md
 * @see specs/operator/flag-flip-runbook.md
 * @see FR41 / FR42 / NFR-REL-2 / NFR-REL-10
 */

import * as cacheInvalidateModule from "./cache-invalidate-on-flag-flip"
import * as phaseBAggregator from "./phase-b-smoke-gate-aggregator"

export type MultiVendorFlagState = "off" | "shadow" | "on"

export const ALLOWED_TRANSITIONS: Record<
  MultiVendorFlagState,
  MultiVendorFlagState[]
> = {
  off: ["shadow"],
  shadow: ["on", "off"],
  on: ["shadow", "off"],
}

// In-memory state baseline; production-ready storage = system_metadata table
// (DEFER to v1.7.0+; baseline persists via env var override on read).
let _currentState: MultiVendorFlagState | null = null
let _lastTransitionAt: string | null = null
let _lastAdmin: string | null = null

const _auditTrail: Array<{
  audit_log_id: string
  from: MultiVendorFlagState
  to: MultiVendorFlagState
  triggered_by: string
  reason?: string
  alert_id?: string
  smoke_gate_ref?: string
  admin_note?: string
  cache_invalidate_outcome?: unknown
  at: string
}> = []

export async function getCurrentState(): Promise<MultiVendorFlagState> {
  if (_currentState) return _currentState
  const envOverride = process.env.GP_MV_FLAG_STATE as MultiVendorFlagState | undefined
  if (envOverride && ["off", "shadow", "on"].includes(envOverride)) {
    return envOverride
  }
  return "off"
}

export function validateTransition(
  from: MultiVendorFlagState,
  to: MultiVendorFlagState,
): { valid: boolean; reason?: string } {
  if (from === to) return { valid: false, reason: "same_state" }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return {
      valid: false,
      reason: `transition ${from}->${to} not allowed; allowed: ${ALLOWED_TRANSITIONS[from].join(",")}`,
    }
  }
  return { valid: true }
}

export type SetStateContext = {
  triggered_by: string
  reason?: string
  alert_id?: string
  admin_note?: string
  smoke_gate_ref?: string
  bypass_smoke_gate?: boolean
}

export type SetStateResult = {
  from: MultiVendorFlagState
  to: MultiVendorFlagState
  audit_log_id: string
  cache_invalidate_outcome: {
    isr_tags_revalidated: number
    redis_keys_busted: number
    sdk_cache_pings: number
    errors: string[]
    duration_ms: number
  }
}

export async function setState(
  to: MultiVendorFlagState,
  ctx: SetStateContext,
): Promise<SetStateResult> {
  const from = await getCurrentState()
  const v = validateTransition(from, to)
  if (!v.valid) {
    throw new Error(`InvalidTransition: ${v.reason}`)
  }

  // Smoke-gate guard for OFF->SHADOW + SHADOW->ON unless bypass.
  const requiresGate =
    (from === "off" && to === "shadow") ||
    (from === "shadow" && to === "on")
  if (requiresGate && !ctx.bypass_smoke_gate) {
    const ratified = await readSmokeGateRatifiedVerdict()
    if (ratified !== "pass") {
      throw new Error(
        `SmokeGateBlocked: Phase B smoke gate verdict=${ratified ?? "unratified"}; transition ${from}->${to} blocked`,
      )
    }
  }

  // Cache invalidate (static import — type-only cycle, safe).
  const { invalidateOnFlip } = cacheInvalidateModule
  const cache_invalidate_outcome = await invalidateOnFlip(from, to)

  _currentState = to
  _lastTransitionAt = new Date().toISOString()
  _lastAdmin = ctx.triggered_by
  const audit_log_id = `mv_flag_${Date.now()}`
  _auditTrail.push({
    audit_log_id,
    from,
    to,
    triggered_by: ctx.triggered_by,
    reason: ctx.reason,
    alert_id: ctx.alert_id,
    smoke_gate_ref: ctx.smoke_gate_ref,
    admin_note: ctx.admin_note,
    cache_invalidate_outcome,
    at: _lastTransitionAt,
  })

  return { from, to, audit_log_id, cache_invalidate_outcome }
}

export function getAuditTrail(limit = 50): Array<(typeof _auditTrail)[number]> {
  return _auditTrail.slice(-limit).reverse()
}

export function getLastTransitionInfo(): {
  last_transitioned_at: string | null
  last_admin: string | null
} {
  return { last_transitioned_at: _lastTransitionAt, last_admin: _lastAdmin }
}

async function readSmokeGateRatifiedVerdict(): Promise<
  "pass" | "fail" | null
> {
  // Read from in-memory ratification store (Story 8.7).
  try {
    const r = phaseBAggregator.getLastRatification()
    return r ? r.verdict : null
  } catch {
    return null
  }
}
