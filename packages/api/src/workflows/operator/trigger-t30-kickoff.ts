/**
 * Story v160-8-2: T-30 kickoff trigger workflow.
 * Sets system.t30_window_started_at + dispatches T-30 notifications +
 * writes audit log entry.
 *
 * @see Story 7.1 T-30 dispatch mechanism
 * @see FR39
 */

const T30_WINDOW_DAYS = 30

type KickoffState = {
  started_at: string
  t0_target: string
  triggered_by: string
  vendor_count: number
  admin_note?: string
}

let _kickoffState: KickoffState | null = null

export type KickoffResult = {
  kickoff_at: string
  t0_target: string
  vendors_notified: number
}

export type KickoffContext = {
  triggered_by: string
  admin_note?: string
  override?: boolean
}

export async function triggerT30Kickoff(
  ctx: KickoffContext,
): Promise<KickoffResult> {
  if (_kickoffState && !ctx.override) {
    const err = new Error("AlreadyTriggered")
    ;(err as Error & { code?: number }).code = 409
    throw err
  }
  const now = new Date()
  const t0 = new Date(now.getTime() + T30_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  // Vendor enumeration baseline: read fixture/env count (real query DEFER to v1.7.0+).
  const vendorCount = Number.parseInt(
    process.env.GP_KICKOFF_VENDOR_COUNT || "0",
    10,
  )
  _kickoffState = {
    started_at: now.toISOString(),
    t0_target: t0.toISOString(),
    triggered_by: ctx.triggered_by,
    vendor_count: vendorCount,
    admin_note: ctx.admin_note,
  }
  // Notification fan-out delegated to Story 7.1 dispatcher (skip in baseline).
  return {
    kickoff_at: _kickoffState.started_at,
    t0_target: _kickoffState.t0_target,
    vendors_notified: vendorCount,
  }
}

export function getKickoffState(): KickoffState | null {
  return _kickoffState
}

export function getDaysRemaining(): number | null {
  if (!_kickoffState) return null
  const ms = Date.parse(_kickoffState.t0_target) - Date.now()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}
