import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { randomUUID } from "node:crypto"

import {
  projectBuyerClaimEmailPayload,
  type VoucherClaimSourceRecord,
} from "../modules/vendor-notifications/buyer-claim-projection"
import {
  renderBuyerClaimHtml,
  renderBuyerClaimSubject,
  renderBuyerClaimText,
} from "../modules/vendor-notifications/email-templates/buyer-claim/i18n"

/**
 * voucher-claimed-buyer-notification — Story v160-6-6 backend subscriber.
 *
 * Listens for `voucher.claimed` events emitted by the recipient claim flow
 * (Story 6.1 Server Action backend handoff) and dispatches an AR45-safe
 * email to the buyer (Marta-gift persona) with vendor name + service +
 * claim timestamp; recipient identity NEVER leaks across the boundary.
 *
 * Implementation tier (per Story 7.1 Dev-Note pattern):
 *   - Stub-tier dispatch — logs "would send" + audit entry skeleton; real
 *     Medusa notification module dispatch is Phase B activation responsibility.
 *   - Idempotency — caller pulls audit log before subscriber fires (or
 *     subscriber checks log itself). For 6.6 MVP the projector returns null
 *     on missing mandatory fields → audit entry status="failed" → admin can
 *     manually retry.
 *   - Privacy — `projectBuyerClaimEmailPayload()` enforces AR45 at the
 *     trust boundary. Source record may carry recipient fields; the email
 *     payload type literally cannot.
 */

interface VoucherClaimedEventPayload {
  voucher_id: string
  claimed_at?: string
}

type LoggerLike = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
  error?: (message: string, error?: unknown) => void
}

interface VoucherClaimAuditFetcher {
  /**
   * Resolves the AR45 source record for a voucher_id. Stub-tier callers may
   * inject a fake fetcher; production swap-in queries the voucher table +
   * joins seller + buyer + claimed_at.
   */
  fetchVoucherClaimSource(
    voucher_id: string,
  ): Promise<VoucherClaimSourceRecord | null>
}

/**
 * Exported pure handler — testable without the Medusa container.
 * Returns the audit log entry shape so the test can assert it.
 */
export interface BuyerClaimAuditEntry {
  id: string
  voucher_id: string
  notification_type: "buyer_claim_notification"
  sent_at: string
  locale: "pl" | "en" | null
  email_to: string | null
  status: "sent" | "failed" | "skipped"
  error_message: string | null
  triggered_by: "system"
}

export async function handleVoucherClaimedForBuyerNotification(
  payload: VoucherClaimedEventPayload,
  deps: { fetcher: VoucherClaimAuditFetcher; logger?: LoggerLike },
): Promise<BuyerClaimAuditEntry> {
  const { voucher_id } = payload
  const auditId = randomUUID()
  const sent_at = new Date().toISOString()

  const source = await deps.fetcher.fetchVoucherClaimSource(voucher_id)
  if (!source) {
    return {
      id: auditId,
      voucher_id,
      notification_type: "buyer_claim_notification",
      sent_at,
      locale: null,
      email_to: null,
      status: "failed",
      error_message: "voucher source not found",
      triggered_by: "system",
    }
  }

  const projected = projectBuyerClaimEmailPayload(source)
  if (!projected) {
    return {
      id: auditId,
      voucher_id,
      notification_type: "buyer_claim_notification",
      sent_at,
      locale: null,
      email_to: source.buyer_email ?? null,
      status: "failed",
      error_message: "projection failed (missing mandatory fields)",
      triggered_by: "system",
    }
  }

  // Render artifact (logged for QA breadcrumb; no real provider dispatch yet).
  const subject = renderBuyerClaimSubject(projected.locale, projected)
  const text = renderBuyerClaimText(projected.locale, projected)
  const html = renderBuyerClaimHtml(projected.locale, projected)

  deps.logger?.info?.("[buyer-claim] would send notification", {
    voucher_id,
    locale: projected.locale,
    subject,
    text_length: text.length,
    html_length: html.length,
  })

  return {
    id: auditId,
    voucher_id,
    notification_type: "buyer_claim_notification",
    sent_at,
    locale: projected.locale,
    email_to: projected.buyer_email,
    status: "sent",
    error_message: null,
    triggered_by: "system",
  }
}

export default async function voucherClaimedBuyerNotificationSubscriber({
  event,
  container,
}: SubscriberArgs<VoucherClaimedEventPayload>) {
  const logger = (container.resolve as unknown as (key: string) => LoggerLike)(
    "logger",
  )

  // Production swap-in resolves a real fetcher from the container; stub
  // returns null so the subscriber writes a `failed` audit entry until the
  // backend voucher table integration lands (Story 6.x follow-up).
  const stubFetcher: VoucherClaimAuditFetcher = {
    async fetchVoucherClaimSource() {
      return null
    },
  }

  await handleVoucherClaimedForBuyerNotification(
    event.data as VoucherClaimedEventPayload,
    { fetcher: stubFetcher, logger },
  )
}

export const config: SubscriberConfig = {
  event: "voucher.claimed",
}
