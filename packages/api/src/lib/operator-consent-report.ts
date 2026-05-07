import type { VendorNotificationLogEntry } from "../modules/vendor-notifications"
import {
  buildDecisionListEntry,
  listSellers,
  type DecisionStatus,
} from "./vendor-decision-store"
import { listNotificationLog } from "./vendor-notification-log"
import { getKickoffState } from "../workflows/operator/trigger-t30-kickoff"

type Scope = { resolve: (key: string) => unknown }

const NUDGE_TYPES = new Set<VendorNotificationLogEntry["notification_type"]>([
  "nudge_t21",
  "nudge_t14",
  "nudge_t7",
  "nudge_t3",
])

export type OperatorConsentDecisionStatus = "opted_in" | "opted_out" | "no_decision"

export type OperatorConsentVendor = {
  id: string
  handle: string
  decision_status: OperatorConsentDecisionStatus
  decision_at: string | null
  nudges_sent: number
  time_remaining_days: number | null
  last_action: string | null
}

export type OperatorConsentReport = {
  window: {
    started_at: string
    t0_target: string
    days_remaining: number | null
  } | null
  vendors: OperatorConsentVendor[]
  summary: {
    opted_in: number
    opted_out: number
    no_decision: number
    total: number
  }
  page: number
  limit: number
  total: number
}

export type OperatorConsentReportParams = {
  decision?: OperatorConsentDecisionStatus
  search?: string
  sort?: string
  page?: string
  limit?: string
}

type NotificationStats = {
  nudges_sent: number
  last_action: string | null
  last_action_at: string | null
}

function mapDecisionStatus(status: DecisionStatus): OperatorConsentDecisionStatus {
  if (status === "opted_in") {
    return "opted_in"
  }

  if (status === "opted_out") {
    return "opted_out"
  }

  return "no_decision"
}

function buildNotificationStats(
  entries: VendorNotificationLogEntry[],
): Map<string, NotificationStats> {
  const stats = new Map<string, NotificationStats>()

  for (const entry of entries) {
    const current =
      stats.get(entry.vendor_id) ?? {
        nudges_sent: 0,
        last_action: null,
        last_action_at: null,
      }

    if (NUDGE_TYPES.has(entry.notification_type)) {
      current.nudges_sent += 1
    }

    if (
      !current.last_action_at ||
      Date.parse(entry.sent_at) >= Date.parse(current.last_action_at)
    ) {
      current.last_action_at = entry.sent_at
      current.last_action = entry.notification_type
    }

    stats.set(entry.vendor_id, current)
  }

  return stats
}

function calculateDaysRemaining(t0Target: string): number {
  const ms = Date.parse(t0Target) - Date.now()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

function compareValues(
  left: string | number | null,
  right: string | number | null,
  direction: "asc" | "desc",
): number {
  const leftValue = left ?? ""
  const rightValue = right ?? ""

  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return direction === "desc" ? rightValue - leftValue : leftValue - rightValue
  }

  const result = String(leftValue).localeCompare(String(rightValue))
  return direction === "desc" ? result * -1 : result
}

export async function buildOperatorConsentReport(
  scope: Scope,
  params: OperatorConsentReportParams = {},
): Promise<OperatorConsentReport> {
  const kickoff = await getKickoffState(scope)
  const notificationLog = await listNotificationLog(scope)
  const notificationStats = buildNotificationStats(notificationLog)
  const daysRemaining = kickoff ? calculateDaysRemaining(kickoff.t0_target) : null

  let vendors = (await listSellers(scope, {})).map((seller) => {
    const decisionEntry = buildDecisionListEntry(seller)
    const decisionStatus = mapDecisionStatus(decisionEntry.decision_status)
    const stats = notificationStats.get(seller.id)
    const decisionAction =
      decisionStatus === "no_decision" ? null : `decision_${decisionStatus}`

    let last_action = stats?.last_action ?? decisionAction
    let last_action_at = stats?.last_action_at ?? null

    if (
      decisionEntry.last_action_at &&
      (!last_action_at ||
        Date.parse(decisionEntry.last_action_at) >= Date.parse(last_action_at))
    ) {
      last_action = decisionAction
      last_action_at = decisionEntry.last_action_at
    }

    return {
      id: decisionEntry.id,
      handle: decisionEntry.handle,
      decision_status: decisionStatus,
      decision_at: decisionEntry.last_action_at,
      nudges_sent: stats?.nudges_sent ?? 0,
      time_remaining_days: kickoff ? daysRemaining : null,
      last_action,
      last_action_at,
    }
  })

  if (params.decision) {
    vendors = vendors.filter((vendor) => vendor.decision_status === params.decision)
  }

  if (params.search && params.search.trim().length > 0) {
    const query = params.search.trim().toLowerCase()
    vendors = vendors.filter((vendor) => vendor.handle.toLowerCase().includes(query))
  }

  const [field, direction] = (params.sort ?? "handle:asc").split(":") as [
    keyof (OperatorConsentVendor & { last_action_at: string | null }),
    "asc" | "desc",
  ]

  const sortableFields = new Set([
    "handle",
    "decision_status",
    "decision_at",
    "nudges_sent",
    "time_remaining_days",
    "last_action",
    "last_action_at",
  ])

  if (sortableFields.has(field)) {
    vendors = [...vendors].sort((left, right) => {
      const primary = compareValues(left[field], right[field], direction === "desc" ? "desc" : "asc")
      if (primary !== 0) {
        return primary
      }

      return left.handle.localeCompare(right.handle)
    })
  }

  const summary = {
    opted_in: vendors.filter((vendor) => vendor.decision_status === "opted_in").length,
    opted_out: vendors.filter((vendor) => vendor.decision_status === "opted_out").length,
    no_decision: vendors.filter((vendor) => vendor.decision_status === "no_decision").length,
    total: vendors.length,
  }

  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1)
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.limit ?? "50", 10) || 50))
  const offset = (page - 1) * limit

  return {
    window: kickoff
      ? {
          started_at: kickoff.started_at,
          t0_target: kickoff.t0_target,
          days_remaining: daysRemaining,
        }
      : null,
    vendors: vendors.slice(offset, offset + limit).map(({ last_action_at, ...vendor }) => vendor),
    summary,
    page,
    limit,
    total: vendors.length,
  }
}

/**
 * Story v160-cleanup-45 (AC3d / TF-106): Thrown when the SellerModule + DB
 * fallback chain cannot satisfy a vendor read. The cascade route maps this
 * to HTTP 503 (Service Unavailable) regardless of whether the underlying
 * cause is a missing DI registration or a downstream DB error — both are
 * legitimate "vendor data temporarily unavailable" conditions per AR55/AR56
 * honesty (consistent with cleanup-44 unavailable-source pattern).
 */
export class SellerModuleUnavailableError extends Error {
  readonly code = "SELLER_MODULE_UNAVAILABLE"

  constructor(cause?: Error) {
    super(
      cause?.message ??
        "Seller module service is not available in the request scope",
    )
    this.name = "SellerModuleUnavailableError"
    if (cause) {
      this.cause = cause
    }
  }
}

/**
 * Story v160-cleanup-45 (AC1+AC2+TF-106): Lightweight count of vendors with
 * opted_in decision status.
 *
 * Uses the same DI fallback chain as `buildOperatorConsentReport` (via the
 * already-imported `listSellers` + `buildDecisionListEntry`) but avoids the
 * full report overhead (no pagination, sorting, or notification-log fetching).
 *
 * Throws `SellerModuleUnavailableError` when the seller module cannot be
 * resolved from scope OR the DB fallback throws — callers should map this
 * to HTTP 503 per AC3(d). The broad catch is intentional: any failure to
 * read vendor state should surface as 503 rather than 500, because the
 * cascade decision tree is undefined under partial vendor data.
 *
 * @param scope  - Medusa request scope (req.scope)
 * @param window - Reserved for future cohort-window scoping (story OQ #2).
 *   Currently the cascade operates on the full active-vendor scope (no
 *   window), matching Story 8.4 semantics. Passing a window today is a
 *   no-op and emits a warning to surface the mismatch early.
 */
export async function countOptedInVendors(
  scope: Scope,
  window?: { startMs: number; endMs: number },
): Promise<number> {
  if (window) {
    // Make the unused-window contract explicit — AC6 preserves the existing
    // (windowless) cascade contract; future window-scoped queries land in a
    // follow-up story per OQ #2 deferral.
    // eslint-disable-next-line no-console
    console.warn(
      "[countOptedInVendors] window arg ignored — full active-vendor scope used (OQ #2 deferred).",
    )
  }
  let sellers: Awaited<ReturnType<typeof listSellers>>
  try {
    sellers = await listSellers(scope)
  } catch (err) {
    throw new SellerModuleUnavailableError(
      err instanceof Error ? err : new Error(String(err)),
    )
  }
  return sellers.filter(
    (s) => buildDecisionListEntry(s).decision_status === "opted_in",
  ).length
}