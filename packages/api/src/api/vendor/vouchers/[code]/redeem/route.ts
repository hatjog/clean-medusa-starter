/**
 * POST /vendor/vouchers/:code/redeem — Story 8.4 cross-actor handoff.
 *
 * cc-4 finding F-05: Story 8.4 AC4-AC6 require a real vendor-side redeem
 * route. Previously no such endpoint existed — the harness ran against a
 * mocked Playwright route, the live verdict was BLOCKED_BY_RUNTIME.
 *
 * Behaviour:
 *   - withVendorAuth (HMAC) → vendorAuth.seller_id is the authenticated seller.
 *   - voucher.seller_id MUST match the authenticated seller (cross-vendor
 *     redeem returns 404 to avoid existence leak).
 *   - VoucherService.claim performs the atomic ACTIVE → claimed transition
 *     plus appends a `claimed` voucher_event row in one tx (idempotent).
 *   - The route returns an audit envelope containing the 8 keys Story 8.4
 *     AC5 mandates (audit_log_id, vendor_id, seller_id, market_id, code,
 *     prior_status, new_status, claimed_at) so the cross-actor handoff
 *     assertion can run against real handlers, not mocks.
 *
 * Idempotency: re-submitting the same code returns 200 with
 * { idempotent: true, status: "already_claimed" } and the original
 * audit envelope. The vendor-panel UI surfaces this as "already redeemed
 * at <claimed_at>" rather than an error.
 *
 * Validation:
 *   - 400 INVALID_INPUT — missing/short code
 *   - 401 UNAUTHORIZED — withVendorAuth fails (handled by HOF)
 *   - 404 VOUCHER_NOT_FOUND — code unknown OR cross-vendor lookup attempt
 *   - 410 VOUCHER_EXPIRED — voucher has expires_at < now
 *
 * No body fields are required for v1.9.0 baseline; future versions may
 * accept { booking_ref } to bind redemption to a specific appointment.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { randomUUID } from "node:crypto"
import { withVendorAuth } from "../../../../../lib/vendor-auth"
import type { VendorAuthContext } from "../../../../../lib/vendor-auth"
import { appendNotificationLog } from "../../../../../lib/vendor-notification-log"
import {
  VOUCHER_MODULE,
  type VoucherService,
} from "../../../../../modules/voucher"

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

type VendorRedeemAuditEnvelope = {
  audit_log_id: string
  vendor_id: string
  seller_id: string
  market_id: string | null
  code: string
  prior_status: "idle" | "consent_pending" | "claimed" | "withdrawn"
  new_status: "claimed" | "already_claimed"
  claimed_at: string
}

type VendorRedeemResponse = {
  ok: true
  idempotent: boolean
  status: "claimed" | "already_claimed"
  envelope: VendorRedeemAuditEnvelope
}

export const POST = withVendorAuth(async (
  req: RequestWithVendorAuth,
  res: MedusaResponse,
): Promise<void> => {
  const code = (req.params as { code?: string })?.code
  if (!code || code.length < 3) {
    res.status(400).json({
      code: "INVALID_INPUT",
      message: "code parameter is required (min 3 chars)",
    })
    return
  }

  const { vendor_id: vendorId, seller_id: authenticatedSellerId } = req.vendorAuth!
  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService

  // Pre-check: cross-vendor lookup attempts return 404 BEFORE claim() runs
  // so a malicious vendor cannot flip another vendor's voucher to "claimed".
  // VoucherService.claim does not enforce vendor scoping on its own.
  const existing = await voucherService.getByCode(code)
  if (!existing) {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }
  if (existing.seller_id !== authenticatedSellerId) {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }

  // Capture prior status BEFORE claim() mutates state so the audit envelope
  // reflects the actual pre-transition value, not the post-transition one.
  const priorStatus = existing.status

  const result = await voucherService.claim(code)
  if (result.status === "not_found") {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }
  if (result.status === "expired") {
    res.status(410).json({
      code: "VOUCHER_EXPIRED",
      message: "Voucher has expired and cannot be redeemed",
    })
    return
  }

  // Find the canonical claimed-at timestamp from the voucher_event row the
  // claim tx inserted. If multiple `claimed` events exist (shouldn't, but
  // defence in depth), pick the earliest.
  const voucher = result.voucher
  const claimedEvent = voucher.events
    ?.filter((e) => e.event_type === "claimed")
    .sort(
      (a, b) =>
        new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
    )[0]
  const claimedAt =
    claimedEvent?.occurred_at instanceof Date
      ? claimedEvent.occurred_at.toISOString()
      : claimedEvent?.occurred_at
      ? new Date(claimedEvent.occurred_at).toISOString()
      : new Date().toISOString()

  const auditLogId = `vva_${randomUUID()}`

  // Best-effort audit-log row in vendor_notification_log so SecOps can
  // correlate the redeem event with the vendor session. Failure does not
  // block the 200 response (audit row is observability, not business
  // invariant — the canonical record lives in the voucher_event row).
  await appendNotificationLog(req.scope, {
    vendor_id: vendorId,
    notification_type: "voucher_redeem",
    locale: "pl",
    recipient_email: "system",
    status: "sent",
    triggered_by: vendorId,
    metadata: {
      audit_log_id: auditLogId,
      code,
      seller_id: authenticatedSellerId,
      market_id: voucher.market_id ?? null,
      prior_status: priorStatus,
      new_status: result.status,
      claimed_at: claimedAt,
    },
  }).catch(() => {
    // observability-only
  })

  const envelope: VendorRedeemAuditEnvelope = {
    audit_log_id: auditLogId,
    vendor_id: vendorId,
    seller_id: authenticatedSellerId,
    market_id: voucher.market_id ?? null,
    code,
    prior_status: priorStatus,
    new_status: result.status,
    claimed_at: claimedAt,
  }

  const response: VendorRedeemResponse = {
    ok: true,
    idempotent: result.status === "already_claimed",
    status: result.status,
    envelope,
  }
  res.status(200).json(response)
})
