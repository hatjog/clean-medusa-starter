import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
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
import { VOUCHER_MODULE } from "../modules/voucher"

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
  voucher_code?: string
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

interface BuyerClaimNotificationDispatcher {
  dispatch(input: {
    to: string
    subject: string
    text: string
    html: string
    locale: "pl" | "en"
    voucher_id: string
  }): Promise<{ notificationId: string | null }>
}

type NotificationModuleLike = {
  createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
  send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
}

/**
 * Voucher module service surface required by the buyer-notification
 * subscriber. Only `findBuyerClaimSource` is consumed here; broader
 * `IVoucherModuleService` is intentionally not referenced to keep the
 * coupling narrow and to make unit-test mocking trivial.
 */
type VoucherModuleSourceReader = {
  findBuyerClaimSource(
    voucher_id: string,
    voucher_code: string | null,
  ): Promise<VoucherClaimSourceRecord | null>
}

function extractNotificationId(value: unknown): string | null {
  if (!value) return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractNotificationId(item)
      if (nested) return nested
    }
    return null
  }

  if (typeof value !== "object") return null

  const record = value as Record<string, unknown>
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id
  }

  for (const key of ["data", "notification", "notifications", "result", "results"] as const) {
    const nested = extractNotificationId(record[key])
    if (nested) return nested
  }

  return null
}

function createVoucherClaimAuditFetcher(
  container: SubscriberArgs<VoucherClaimedEventPayload>["container"],
  eventPayload: VoucherClaimedEventPayload,
): VoucherClaimAuditFetcher {
  return {
    async fetchVoucherClaimSource(voucher_id: string) {
      // Story 9.3 — ADR-052 cutover, Layer 4 read path (per AC1(b)
      // preferred ścieżka). Source = `VoucherService.findBuyerClaimSource`
      // (SQL JOIN entitlement_instance × voucher × public.order × voucher_event).
      // Module link query.graph traversals were rejected (review F-01/F-02):
      // entitlement_instance has no buyer_email / claimed_at / seller_id /
      // product_id columns, so `query.graph({ fields: ["seller.name", ...] })`
      // would always project nulls. SQL path is the functionally-correct
      // mitigation logged in story Dev Notes §R3.
      const voucherService = container.resolve(VOUCHER_MODULE) as VoucherModuleSourceReader
      const lookupVoucherCode = eventPayload.voucher_code ?? null
      const source = await voucherService.findBuyerClaimSource(
        voucher_id,
        lookupVoucherCode,
      )

      if (!source) return null

      return {
        buyer_email: source.buyer_email,
        buyer_locale: source.buyer_locale,
        seller_name: source.seller_name,
        seller_handle: source.seller_handle,
        service_title: source.service_title,
        // F-2-03 phase-3 fix: prefer eventPayload.claimed_at (on-the-wire
        // truth of the event that triggered this subscriber) per AR45
        // "audit reflects the actual event". voucher_event scan in
        // VoucherService.findBuyerClaimSource returns the latest claimed
        // event globally — which may diverge on replay/withdraw→reclaim.
        claimed_at: eventPayload.claimed_at ?? source.claimed_at ?? null,
        voucher_code:
          source.voucher_code ?? eventPayload.voucher_code ?? voucher_id,
      }
    },
  }
}

function createBuyerClaimNotificationDispatcher(
  notificationModule: NotificationModuleLike,
): BuyerClaimNotificationDispatcher {
  return {
    async dispatch(input) {
      const payload = {
        to: input.to,
        channel: "email",
        template: "buyer_claim_notification",
        data: {
          voucher_id: input.voucher_id,
          locale: input.locale,
          subject: input.subject,
          text: input.text,
          html: input.html,
        },
        content: {
          subject: input.subject,
          text: input.text,
          html: input.html,
        },
        metadata: {
          notification_type: "buyer_claim_notification",
          triggered_by: "system",
          voucher_id: input.voucher_id,
          locale: input.locale,
        },
      }

      const result =
        typeof notificationModule.createNotifications === "function"
          ? await notificationModule.createNotifications(payload)
          : await notificationModule.send?.(payload)

      return { notificationId: extractNotificationId(result) }
    },
  }
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
  deps: {
    fetcher: VoucherClaimAuditFetcher
    logger?: LoggerLike
    dispatcher?: BuyerClaimNotificationDispatcher
  },
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

  const subject = renderBuyerClaimSubject(projected.locale, projected)
  const text = renderBuyerClaimText(projected.locale, projected)
  const html = renderBuyerClaimHtml(projected.locale, projected)

  try {
    if (deps.dispatcher) {
      const dispatchResult = await deps.dispatcher.dispatch({
        to: projected.buyer_email,
        subject,
        text,
        html,
        locale: projected.locale,
        voucher_id,
      })

      deps.logger?.info?.("[buyer-claim] notification sent", {
        voucher_id,
        locale: projected.locale,
        notification_id: dispatchResult.notificationId,
      })
    } else {
      deps.logger?.info?.("[buyer-claim] would send notification", {
        voucher_id,
        locale: projected.locale,
        subject,
        text_length: text.length,
        html_length: html.length,
      })
    }
  } catch (error) {
    deps.logger?.error?.("[buyer-claim] notification dispatch failed", error)

    return {
      id: auditId,
      voucher_id,
      notification_type: "buyer_claim_notification",
      sent_at,
      locale: projected.locale,
      email_to: projected.buyer_email,
      status: "failed",
      error_message: `dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      triggered_by: "system",
    }
  }

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

  const fetcher = createVoucherClaimAuditFetcher(
    container,
    event.data as VoucherClaimedEventPayload,
  )
  const notificationModule = container.resolve(Modules.NOTIFICATION) as NotificationModuleLike
  const dispatcher = createBuyerClaimNotificationDispatcher(notificationModule)

  await handleVoucherClaimedForBuyerNotification(
    event.data as VoucherClaimedEventPayload,
    { fetcher, logger, dispatcher },
  )
}

export const config: SubscriberConfig = {
  event: "voucher.claimed",
}
