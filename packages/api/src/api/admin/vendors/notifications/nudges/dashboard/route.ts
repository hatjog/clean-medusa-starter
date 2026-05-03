/**
 * Story v160-7-2: Nudge cadence dashboard route.
 *
 * GET /admin/vendors/notifications/nudges/dashboard
 *   Response: {
 *     per_step_counts: { t21, t14, t7, t3 },
 *     decision_completion: { opted_in, opted_out, open, completion_rate },
 *     pending_decisions: { count, days_remaining },
 *     recent_dispatches: AuditLogEntry[]
 *   }
 *
 * Stub-tier per Sprint 4 Wave 14 batch — returns deterministic skeleton until
 * audit log table integration lands (Story 7.1 Path B follow-up). Provides
 * shape contract so admin-panel widget can render against it without backend
 * changes once persistence wires up.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

interface DashboardResponse {
  per_step_counts: {
    t21: number
    t14: number
    t7: number
    t3: number
  }
  decision_completion: {
    opted_in: number
    opted_out: number
    open: number
    completion_rate: number
  }
  pending_decisions: {
    count: number
    days_to_flag_flip: number | null
  }
  recent_dispatches: Array<{
    id: string
    vendor_id: string
    vendor_handle: string | null
    notification_type: string
    sent_at: string
    locale: "pl" | "en"
    status: "sent" | "failed"
  }>
}

function daysToFlagFlip(): number | null {
  const raw = process.env.GP_FLAG_FLIP_DATE
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const ms = d.getTime() - Date.now()
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // Stub-tier — production swap-in aggregates from `vendor_notification_log`
  // (Story 7.1 Path B table) + vendor.decision_status field per T2.1
  // (Path A: `vendor.metadata.decision_status` JSON field, additive).
  const payload: DashboardResponse = {
    per_step_counts: { t21: 0, t14: 0, t7: 0, t3: 0 },
    decision_completion: {
      opted_in: 0,
      opted_out: 0,
      open: 0,
      completion_rate: 0,
    },
    pending_decisions: {
      count: 0,
      days_to_flag_flip: daysToFlagFlip(),
    },
    recent_dispatches: [],
  }
  res.status(200).json(payload)
}
