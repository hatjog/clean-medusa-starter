/**
 * Story v160-8-3: Multi-vendor feature flag tri-state OFF/SHADOW/ON.
 * Story v160-cleanup-15e: Single flag oracle — ALL backend flag readers
 *   route through this module. No env-literal reads outside this file.
 *
 * @see specs/adr/ADR-070-feature-flag-tri-state.md
 * @see specs/operator/flag-flip-runbook.md
 * @see FR41 / FR42 / NFR-REL-2 / NFR-REL-10
 */

import * as cacheInvalidateModule from "./cache-invalidate-on-flag-flip"
import * as phaseBAggregator from "./phase-b-smoke-gate-aggregator"
import type { Knex } from "knex"

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

const FLAG_AUDIT_TABLE = "operator_multi_vendor_flag_audit"

type AuditTrailEntry = {
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
}

type PersistedAuditRow = {
  id: string
  from_state: MultiVendorFlagState
  to_state: MultiVendorFlagState
  triggered_by: string
  reason: string | null
  alert_id: string | null
  smoke_gate_ref: string | null
  admin_note: string | null
  cache_invalidate_outcome: unknown
  at: string
}

const _auditTrail: AuditTrailEntry[] = []

function mapPersistedAuditRow(row: PersistedAuditRow): AuditTrailEntry {
  return {
    audit_log_id: row.id,
    from: row.from_state,
    to: row.to_state,
    triggered_by: row.triggered_by,
    reason: row.reason ?? undefined,
    alert_id: row.alert_id ?? undefined,
    smoke_gate_ref: row.smoke_gate_ref ?? undefined,
    admin_note: row.admin_note ?? undefined,
    cache_invalidate_outcome: row.cache_invalidate_outcome,
    at: row.at,
  }
}

async function getLatestPersistedAuditRow(
  db: Knex,
): Promise<PersistedAuditRow | null> {
  const row = await db<PersistedAuditRow>(FLAG_AUDIT_TABLE)
    .select("*")
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .first()

  return row ?? null
}

export async function getCurrentState(
  db?: Knex | null,
): Promise<MultiVendorFlagState> {
  if (db) {
    const persisted = await getLatestPersistedAuditRow(db)
    if (persisted) {
      return persisted.to_state
    }
  }
  if (_currentState) return _currentState
  const envOverride = process.env.GP_MV_FLAG_STATE as MultiVendorFlagState | undefined
  if (envOverride && ["off", "shadow", "on"].includes(envOverride)) {
    return envOverride
  }
  return "off"
}

/**
 * Single flag oracle — Story v160-cleanup-15e (CRIT-1 fix).
 *
 * Returns "on" | "off" | "unknown" mapped from the tri-state singleton.
 * Replaces all env-literal `process.env.MULTI_VENDOR_PRICING_ENABLED` reads
 * in backend production code. Callers treat "shadow" as "on" for gating.
 *
 * "unknown" is returned only when getCurrentState() throws unexpectedly;
 * callers MUST treat "unknown" as "off" (fail-closed).
 *
 * v1.7.0 note: upgrade singleton to DB-backed pubsub for multi-instance
 * deployments; this function signature stays stable.
 */
export async function getFlagState(
  _name: "multi_vendor_pdp",
  db?: Knex | null,
): Promise<"on" | "off" | "unknown"> {
  try {
    const state = await getCurrentState(db ?? null)
    if (state === "on" || state === "shadow") return "on"
    return "off"
  } catch {
    return "unknown"
  }
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
  /**
   * Story v160-cleanup-15f — pass Knex instance from req.scope so smoke-gate
   * ratification verdict is read from DB (durable) instead of process-local
   * memory. When omitted AND bypass_smoke_gate=false AND transition requires
   * gate, setState throws SmokeGateBlocked.
   */
  db?: import("knex").Knex | null
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
  const from = await getCurrentState(ctx.db ?? null)
  const v = validateTransition(from, to)
  if (!v.valid) {
    throw new Error(`InvalidTransition: ${v.reason}`)
  }

  // Smoke-gate guard for OFF->SHADOW + SHADOW->ON unless bypass.
  const requiresGate =
    (from === "off" && to === "shadow") ||
    (from === "shadow" && to === "on")
  if (requiresGate && !ctx.bypass_smoke_gate) {
    const ratified = await readSmokeGateRatifiedVerdict(ctx.db ?? null)
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

  let entry: AuditTrailEntry
  if (ctx.db) {
    const [row] = await ctx.db<PersistedAuditRow>(FLAG_AUDIT_TABLE)
      .insert({
        from_state: from,
        to_state: to,
        triggered_by: ctx.triggered_by,
        reason: ctx.reason ?? null,
        alert_id: ctx.alert_id ?? null,
        smoke_gate_ref: ctx.smoke_gate_ref ?? null,
        admin_note: ctx.admin_note ?? null,
        cache_invalidate_outcome,
      })
      .returning("*")

    if (!row) {
      throw new Error("flag_audit_insert_returned_no_row")
    }

    entry = mapPersistedAuditRow(row)
  } else {
    entry = {
      audit_log_id: `mv_flag_${Date.now()}`,
      from,
      to,
      triggered_by: ctx.triggered_by,
      reason: ctx.reason,
      alert_id: ctx.alert_id,
      smoke_gate_ref: ctx.smoke_gate_ref,
      admin_note: ctx.admin_note,
      cache_invalidate_outcome,
      at: _lastTransitionAt,
    }
  }

  _auditTrail.push({
    audit_log_id: entry.audit_log_id,
    from,
    to,
    triggered_by: ctx.triggered_by,
    reason: ctx.reason,
    alert_id: ctx.alert_id,
    smoke_gate_ref: ctx.smoke_gate_ref,
    admin_note: ctx.admin_note,
    cache_invalidate_outcome,
    at: entry.at,
  })

  _lastTransitionAt = entry.at

  return {
    from,
    to,
    audit_log_id: entry.audit_log_id,
    cache_invalidate_outcome,
  }
}

export function getAuditTrail(limit = 50): Array<(typeof _auditTrail)[number]> {
  return _auditTrail.slice(-limit).reverse()
}

export async function getPersistedAuditTrail(
  db: Knex,
  limit = 50,
): Promise<AuditTrailEntry[]> {
  const rows = await db<PersistedAuditRow>(FLAG_AUDIT_TABLE)
    .select("*")
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(limit)

  return rows.map(mapPersistedAuditRow)
}

export function getLastTransitionInfo(): {
  last_transitioned_at: string | null
  last_admin: string | null
} {
  return { last_transitioned_at: _lastTransitionAt, last_admin: _lastAdmin }
}

export async function getPersistedLastTransitionInfo(db: Knex): Promise<{
  last_transitioned_at: string | null
  last_admin: string | null
}> {
  const row = await getLatestPersistedAuditRow(db)
  return {
    last_transitioned_at: row?.at ?? null,
    last_admin: row?.triggered_by ?? null,
  }
}

async function readSmokeGateRatifiedVerdict(
  db: import("knex").Knex | null,
): Promise<"pass" | "fail" | null> {
  // Story v160-cleanup-15f — AC2: read from DB (durable). When db is null
  // (no caller passed it), return null → transition blocks unless caller
  // sets bypass_smoke_gate=true.
  if (!db) return null
  try {
    const r = await phaseBAggregator.getLastRatification(db)
    return r ? r.verdict : null
  } catch {
    return null
  }
}
