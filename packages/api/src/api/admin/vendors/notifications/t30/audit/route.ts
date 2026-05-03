/**
 * Story v160-7-1: T-30 audit log admin route.
 *
 * GET /admin/vendors/notifications/t30/audit
 *   Response: { entries: VendorNotificationLogEntry[] }
 *
 * Persistence target — Path B GP-owned `vendor_notification_log` table
 * (Story 7.1 Dev Note T3.4 decision; Path A Mercur audit log surface
 * deferred to follow-up if Mercur 2 admin extension exposes it). Stub
 * implementation returns empty array until table migration lands.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import type { VendorNotificationLogEntry } from "../../../../../../modules/vendor-notifications"

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // Stub: real impl reads from `vendor_notification_log` table.
  const entries: VendorNotificationLogEntry[] = []
  res.status(200).json({ entries })
}
