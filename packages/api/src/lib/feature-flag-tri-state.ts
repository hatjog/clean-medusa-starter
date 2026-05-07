/**
 * Story v160-8-3: Multi-vendor feature flag tri-state OFF/SHADOW/ON.
 * Story v160-cleanup-15e: Single flag oracle — ALL backend flag readers
 *   route through this module. No env-literal reads outside this file.
 * Story v160-cleanup-50: DB-backed persistence + TTL cache + history audit.
 *
 * ## Storage (v160-cleanup-50)
 *
 * Current state is stored in the `feature_flag_state` table
 * (PK = flag_id, e.g. "multi_vendor_pdp"). Reads are served from an
 * in-memory cache with a configurable TTL (default 30 s, env
 * `GP_FLAG_STATE_TTL_MS`). Cache miss → `SELECT value FROM feature_flag_state`.
 *
 * If the DB is unavailable, `getCurrentState` falls back to the `GP_MV_FLAG_STATE`
 * env-var (downgraded: "emergency fallback only" — NOT default behaviour), then
 * to "off" (fail-closed). A single `logger.warn` is emitted per process
 * lifetime when the fallback activates.
 *
 * Writes (`setState`) are transactional: UPSERT `feature_flag_state` +
 * INSERT `feature_flag_history` + INSERT `operator_multi_vendor_flag_audit`
 * in one transaction, followed by local cache invalidation and the existing
 * `invalidateOnFlip` cache fan-out.
 *
 * Cross-instance propagation: each instance re-reads from DB after TTL
 * expiry (≤30 s). Redis pub-sub instant invalidation is deferred to v1.7.0+.
 *
 * @see specs/adr/ADR-070-feature-flag-tri-state.md
 * @see specs/operator/flag-flip-runbook.md
 * @see FR41 / FR42 / NFR-REL-2 / NFR-REL-10
 */

import * as cacheInvalidateModule from "./cache-invalidate-on-flag-flip"
import * as phaseBAggregator from "./phase-b-smoke-gate-aggregator"
import { logger } from "./logger"
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

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const FLAG_AUDIT_TABLE = "operator_multi_vendor_flag_audit"
const FLAG_STATE_TABLE = "feature_flag_state"
const FLAG_HISTORY_TABLE = "feature_flag_history"
const FLAG_ID_MULTI_VENDOR_PDP = "multi_vendor_pdp"

export const FLAG_STATE_TTL_MS: number = (() => {
  const v = Number(process.env.GP_FLAG_STATE_TTL_MS)
  return Number.isFinite(v) && v > 0 ? v : 30_000
})()

// ---------------------------------------------------------------------------
// In-memory cache (Map keyed by flag_id — forward-compatible with v1.7.0 multi-flag)
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: MultiVendorFlagState
  expiresAt: number
}

const _cache = new Map<string, CacheEntry>()

export function getCachedState(flagId: string): MultiVendorFlagState | null {
  const entry = _cache.get(flagId)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    _cache.delete(flagId)
    return null
  }
  return entry.value
}

export function setCachedState(
  flagId: string,
  value: MultiVendorFlagState,
): void {
  _cache.set(flagId, { value, expiresAt: Date.now() + FLAG_STATE_TTL_MS })
}

export function invalidateCachedState(flagId: string): void {
  _cache.delete(flagId)
}

// ---------------------------------------------------------------------------
// DB-unavailable fallback: emit warn at most once per process lifetime
// ---------------------------------------------------------------------------

let _dbUnavailableWarnEmitted = false

function emitDbUnavailableWarnOnce(error: unknown): void {
  if (_dbUnavailableWarnEmitted) return
  _dbUnavailableWarnEmitted = true
  const message = error instanceof Error ? error.message : String(error)
  logger.warn("flag.state.db_unavailable_fallback_env", { error: message })
}

/** Reset DB-unavailable warn state — for testing only. */
export function _resetDbWarnState(): void {
  // M4 fix: hard-gate to test environments.
  if (process.env.NODE_ENV !== "test") return
  _dbUnavailableWarnEmitted = false
}

// ---------------------------------------------------------------------------
// Back-compat write-side hint (preserved per story spec; NOT used in read path)
// ---------------------------------------------------------------------------

/** @deprecated read path uses DB cache; this is a write-side hint only */
let _currentState: MultiVendorFlagState | null = null
let _lastTransitionAt: string | null = null
let _lastAdmin: string | null = null

/**
 * One-shot warn for setState calls that omit `ctx.db` (M5 fix).
 * Production callers MUST pass `db`; without it, the no-DB branch only updates
 * an in-memory hint and is NOT durable nor multi-instance safe.
 */
let _setStateNoDbWarnEmitted = false

function emitSetStateNoDbWarnOnce(): void {
  if (_setStateNoDbWarnEmitted) return
  _setStateNoDbWarnEmitted = true
  logger.warn("flag.state.set_state_called_without_db", { note: "setState invoked without ctx.db; durability/multi-instance safety LOST. Production callers must pass req.scope.resolve('manager').getKnex() or equivalent." })
}

/** Reset setState-no-db warn state — for testing only. */
export function _resetSetStateNoDbWarnState(): void {
  if (process.env.NODE_ENV !== "test") return
  _setStateNoDbWarnEmitted = false
}

// ---------------------------------------------------------------------------
// Helper: relation-missing error detection
// ---------------------------------------------------------------------------

function isMissingRelationError(err: unknown, tableName: string): boolean {
  // L2 fix: prefer SQLSTATE 42P01 (undefined_table) when available — works
  // across locales. Fall back to substring match for non-pg drivers / wrapped
  // errors.
  const code = (err as { code?: string } | null | undefined)?.code
  if (code === "42P01") return true
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`relation '${tableName}' does not exist`) ||
    message.includes(`relation ${tableName} does not exist`)
  )
}

// ---------------------------------------------------------------------------
// Audit trail types (unchanged from v160-8-3 / cleanup-15e)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Read current-state row from feature_flag_state. Returns null on missing/error. */
export async function readFlagStateRow(
  db: Knex,
  flagId: string,
): Promise<MultiVendorFlagState | null> {
  const row = await db<{ value: string }>(FLAG_STATE_TABLE)
    .select("value")
    .where("flag_id", flagId)
    .first()

  const v = row?.value
  if (v && (["off", "shadow", "on"] as string[]).includes(v)) {
    return v as MultiVendorFlagState
  }
  if (v) {
    // L3 fix: row exists but value is not in allow-list → warn for operator visibility.
    logger.warn("flag.state.invalid_db_value", { flag_id: flagId, value: v })
  }
  return null
}

/** UPSERT into feature_flag_state. Must be called inside a transaction. */
export async function upsertFlagState(
  trx: Knex.Transaction,
  flagId: string,
  value: MultiVendorFlagState,
  updatedBy: string,
): Promise<void> {
  await trx.raw(
    `INSERT INTO ${FLAG_STATE_TABLE} (flag_id, value, updated_by, updated_at)
     VALUES (?, ?, ?, now())
     ON CONFLICT (flag_id) DO UPDATE
       SET value = EXCLUDED.value,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [flagId, value, updatedBy],
  )
}

/** INSERT into feature_flag_history. Must be called inside a transaction. */
export async function insertFlagHistory(
  trx: Knex.Transaction,
  flagId: string,
  from: MultiVendorFlagState | null,
  to: MultiVendorFlagState,
  updatedBy: string,
  reason: string | null,
): Promise<void> {
  await trx(FLAG_HISTORY_TABLE).insert({
    flag_id: flagId,
    from_value: from,
    to_value: to,
    updated_by: updatedBy,
    reason: reason ?? null,
  })
}

// ---------------------------------------------------------------------------
// Existing audit table accessor (preserved — used by getAuditTrail / getPersistedLastTransitionInfo)
// ---------------------------------------------------------------------------

async function getLatestPersistedAuditRow(
  db: Knex,
): Promise<PersistedAuditRow | null> {
  try {
    const row = await db<PersistedAuditRow>(FLAG_AUDIT_TABLE)
      .select("*")
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .first()

    return row ?? null
  } catch (err) {
    if (isMissingRelationError(err, FLAG_AUDIT_TABLE)) {
      return null
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getCurrentState — rewritten read-priority order (AC2, AC5)
//
// 1. Cache hit (non-expired) → return.
// 2. Cache miss → SELECT feature_flag_state → populate cache → return.
// 3. DB error (incl. relation-missing) → env-var fallback (log warn, once).
// 4. Final fallback → "off".
// ---------------------------------------------------------------------------

export async function getCurrentState(
  db?: Knex | null,
): Promise<MultiVendorFlagState> {
  // 1. Cache hit
  const cached = getCachedState(FLAG_ID_MULTI_VENDOR_PDP)
  if (cached !== null) return cached

  // 2. DB read
  if (db) {
    try {
      const value = await readFlagStateRow(db, FLAG_ID_MULTI_VENDOR_PDP)
      if (value !== null) {
        setCachedState(FLAG_ID_MULTI_VENDOR_PDP, value)
        return value
      }
      // feature_flag_state row missing (pre-migration) — fall through to env/off
    } catch (err) {
      // 3. DB unavailable — env-var fallback
      emitDbUnavailableWarnOnce(err)
      const envOverride = process.env
        .GP_MV_FLAG_STATE as MultiVendorFlagState | undefined
      if (
        envOverride &&
        (["off", "shadow", "on"] as string[]).includes(envOverride)
      ) {
        return envOverride
      }
      return "off"
    }
  }

  // In-memory write-side hint (back-compat, no DB available)
  if (_currentState) return _currentState

  // Env-var override (env-only mode: no DB, no cache)
  const envOverride = process.env
    .GP_MV_FLAG_STATE as MultiVendorFlagState | undefined
  if (
    envOverride &&
    (["off", "shadow", "on"] as string[]).includes(envOverride)
  ) {
    return envOverride
  }

  // 4. Fail-closed
  return "off"
}

// ---------------------------------------------------------------------------
// getFlagState — single flag oracle (cleanup-15e contract; unchanged signature)
// ---------------------------------------------------------------------------

/**
 * Single flag oracle — Story v160-cleanup-15e (CRIT-1 fix).
 *
 * Returns "on" | "off" | "unknown" mapped from the tri-state singleton.
 * Replaces all env-literal `process.env.MULTI_VENDOR_PRICING_ENABLED` reads
 * in backend production code. Callers treat "shadow" as "on" for gating.
 *
 * "unknown" is returned only when getCurrentState() throws unexpectedly;
 * callers MUST treat "unknown" as "off" (fail-closed).
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

// ---------------------------------------------------------------------------
// validateTransition (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SetStateContext / SetStateResult types (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// setState — rewritten: transactional UPSERT + history + operator audit (AC3)
// ---------------------------------------------------------------------------

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

  const { invalidateOnFlip } = cacheInvalidateModule

  let auditLogId: string
  let entryAt: string
  // H1 fix: defer cache invalidation until AFTER successful DB commit so a
  // rolled-back transaction does not bust downstream caches for a non-event.
  let cache_invalidate_outcome: SetStateResult["cache_invalidate_outcome"] = {
    isr_tags_revalidated: 0,
    redis_keys_busted: 0,
    sdk_cache_pings: 0,
    errors: [],
    duration_ms: 0,
  }
  let lockedFrom: MultiVendorFlagState = from

  if (ctx.db) {
    // Transactional write: UPSERT state + INSERT history + INSERT operator audit
    await ctx.db.transaction(async (trx) => {
      // M3 fix: lock current row FOR UPDATE and re-validate against the locked
      // value. Prevents lost-update / phantom-history under concurrent writers.
      const lockedRow = await trx<{ value: string }>(FLAG_STATE_TABLE)
        .select("value")
        .where("flag_id", FLAG_ID_MULTI_VENDOR_PDP)
        .forUpdate()
        .first()
      if (lockedRow?.value && (["off", "shadow", "on"] as string[]).includes(lockedRow.value)) {
        lockedFrom = lockedRow.value as MultiVendorFlagState
      }
      // Re-validate against the locked row — if another writer already moved
      // the state away from `from`, fail fast rather than write a phantom row.
      if (lockedFrom !== from) {
        const reValidate = validateTransition(lockedFrom, to)
        if (!reValidate.valid) {
          throw new Error(
            `InvalidTransition (post-lock): ${reValidate.reason}; observed=${lockedFrom}, requested=${from}->${to}`,
          )
        }
      }

      // (a) UPSERT feature_flag_state
      await upsertFlagState(trx, FLAG_ID_MULTI_VENDOR_PDP, to, ctx.triggered_by)

      // (b) INSERT feature_flag_history (uses observed lockedFrom, not the
      //     pre-transaction `from`, so history reflects the actual transition).
      await insertFlagHistory(
        trx,
        FLAG_ID_MULTI_VENDOR_PDP,
        lockedFrom,
        to,
        ctx.triggered_by,
        ctx.reason ?? null,
      )

      // (c) INSERT operator_multi_vendor_flag_audit (cleanup-15f preserved)
      const [auditRow] = await trx<PersistedAuditRow>(FLAG_AUDIT_TABLE)
        .insert({
          from_state: lockedFrom,
          to_state: to,
          triggered_by: ctx.triggered_by,
          reason: ctx.reason ?? null,
          alert_id: ctx.alert_id ?? null,
          smoke_gate_ref: ctx.smoke_gate_ref ?? null,
          admin_note: ctx.admin_note ?? null,
          cache_invalidate_outcome,
        })
        .returning("*")

      if (!auditRow) {
        throw new Error("flag_audit_insert_returned_no_row")
      }

      auditLogId = auditRow.id
      entryAt = auditRow.at
    })

    // H1 fix: invalidateOnFlip runs AFTER successful commit. Use the observed
    // `lockedFrom` so downstream cache fan-out reflects reality.
    cache_invalidate_outcome = await invalidateOnFlip(lockedFrom, to)

    // L4 fix: write-through cache update so the next read on this instance
    // observes the new value immediately (and no longer a stale entry from
    // pre-write `getCurrentState`).
    setCachedState(FLAG_ID_MULTI_VENDOR_PDP, to)
  } else {
    // No DB — in-memory only path (backwards compat for tests without DB).
    // M5 fix: emit a one-shot warn so production code paths that forget to
    // pass ctx.db are visible in logs.
    emitSetStateNoDbWarnOnce()
    cache_invalidate_outcome = await invalidateOnFlip(from, to)
    auditLogId = `mv_flag_${Date.now()}`
    entryAt = new Date().toISOString()
    // L4 fix: keep cache consistent with the in-memory hint.
    setCachedState(FLAG_ID_MULTI_VENDOR_PDP, to)
  }

  // Update write-side hint (back-compat; not used in read path)
  _currentState = to
  _lastTransitionAt = entryAt!
  _lastAdmin = ctx.triggered_by

  const entry: AuditTrailEntry = {
    audit_log_id: auditLogId!,
    from: lockedFrom,
    to,
    triggered_by: ctx.triggered_by,
    reason: ctx.reason,
    alert_id: ctx.alert_id,
    smoke_gate_ref: ctx.smoke_gate_ref,
    admin_note: ctx.admin_note,
    cache_invalidate_outcome,
    at: entryAt!,
  }

  _auditTrail.push(entry)

  return {
    from: lockedFrom,
    to,
    audit_log_id: entry.audit_log_id,
    cache_invalidate_outcome,
  }
}

// ---------------------------------------------------------------------------
// getAuditTrail / getPersistedAuditTrail (unchanged)
// ---------------------------------------------------------------------------

export function getAuditTrail(limit = 50): Array<(typeof _auditTrail)[number]> {
  return _auditTrail.slice(-limit).reverse()
}

export async function getPersistedAuditTrail(
  db: Knex,
  limit = 50,
): Promise<AuditTrailEntry[]> {
  try {
    const rows = await db<PersistedAuditRow>(FLAG_AUDIT_TABLE)
      .select("*")
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .limit(limit)

    return rows.map(mapPersistedAuditRow)
  } catch (err) {
    if (isMissingRelationError(err, FLAG_AUDIT_TABLE)) {
      return []
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getLastTransitionInfo / getPersistedLastTransitionInfo (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// readSmokeGateRatifiedVerdict (unchanged — cleanup-15f)
// ---------------------------------------------------------------------------

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
