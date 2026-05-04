/**
 * Story v160-8-2: T-30 kickoff trigger workflow.
 * Story v160-cleanup-5: Real dispatcher call replacing GP_KICKOFF_VENDOR_COUNT phantom.
 *
 * Sets system.t30_window_started_at + dispatches T-30 notifications via the
 * REAL Story 7.1 in-process dispatcher + writes audit log entry.
 *
 * CRIT-7.4 fix: `vendors_notified` now reflects ACTUAL audit-log rows written
 * by the dispatcher (not a phantom env-var count).
 *
 * @see Story 7.1 T-30 dispatch mechanism (src/lib/t30-dispatch-service.ts)
 * @see FR39
 */

import {
  dispatchT30Notifications,
  isFixtureMode,
  resolveFlagFlipDate,
  T30DispatcherFixtureModeError,
  type T30Logger,
} from "../../lib/t30-dispatch-service"

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
  logger?: T30Logger
}

/**
 * Trigger the T-30 kickoff window.
 *
 * AC1: Calls the real `dispatchT30Notifications()` in-process (Story 7.1).
 *      `vendors_notified` = count of audit entries actually written.
 *      GP_KICKOFF_VENDOR_COUNT env var removed.
 *
 * AC2: Auth context propagated — `triggered_by` from caller flows into every
 *      audit log entry written by the dispatcher.
 *
 * AC3: Production hard-block — throws HTTP 503 diagnostic when dispatcher
 *      is in fixture mode on NODE_ENV=production.
 */
export async function triggerT30Kickoff(
  ctx: KickoffContext,
): Promise<KickoffResult> {
  if (_kickoffState && !ctx.override) {
    const err = new Error("AlreadyTriggered")
    ;(err as Error & { code?: number }).code = 409
    throw err
  }

  // AC3: Hard-block in production when dispatcher is in fixture/stub mode.
  if (process.env.NODE_ENV === "production" && isFixtureMode()) {
    const err = new T30DispatcherFixtureModeError()
    ;(err as unknown as { httpCode?: number }).httpCode = 503
    throw err
  }

  const now = new Date()
  const t0 = new Date(now.getTime() + T30_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Resolve flag flip ISO for the dispatcher.
  const { iso: flagFlipIso } = resolveFlagFlipDate()

  // AC1 + AC2: Real dispatcher call — vendors_notified from actual audit rows.
  let vendorCount = 0
  try {
    const dispatchResult = await dispatchT30Notifications({
      triggered_by: ctx.triggered_by,
      flag_flip_iso: flagFlipIso,
      logger: ctx.logger,
    })
    vendorCount = dispatchResult.triggered
  } catch (err) {
    if (err instanceof T30DispatcherFixtureModeError) {
      // Re-throw so the route layer can translate to HTTP 503.
      throw err
    }
    // Non-fixture errors: rethrow as 500-class.
    throw err
  }

  _kickoffState = {
    started_at: now.toISOString(),
    t0_target: t0.toISOString(),
    triggered_by: ctx.triggered_by,
    vendor_count: vendorCount,
    admin_note: ctx.admin_note,
  }

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

/** Reset internal state (test utility only). */
export function _resetKickoffStateForTests(): void {
  _kickoffState = null
}
