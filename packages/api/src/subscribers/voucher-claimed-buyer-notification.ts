import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
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

type QueryGraphLike = {
  graph(input: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
    pagination?: Record<string, unknown>
  }): Promise<{ data?: Array<Record<string, unknown>> }>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, unknown>
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return asRecord(value[0])
  }
  return asRecord(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
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
      const query = container.resolve(ContainerRegistrationKeys.QUERY) as QueryGraphLike
      const lookupVoucherCode = eventPayload.voucher_code ?? voucher_id
      const result = await query.graph({
        entity: "entitlement_instance",
        fields: [
          "id",
          "buyer_email",
          "claimed_at",
          "policy_snapshot",
          "seller.name",
          "seller.handle",
          "product.title",
          "voucher.code",
        ],
        filters: {
          $or: [
            { id: voucher_id },
            { voucher: { code: lookupVoucherCode } },
            { policy_snapshot: { voucher_code: lookupVoucherCode } },
          ],
        },
        pagination: { take: 1, skip: 0 },
      })

      const row = result.data?.[0]
      if (!row) {
        return null
      }

      const seller = firstRecord(row.seller)
      const product = firstRecord(row.product)
      const voucher = firstRecord(row.voucher)
      const snapshot = asRecord(row.policy_snapshot)
      const claimedAt =
        stringOrNull(row.claimed_at) ??
        (row.claimed_at instanceof Date ? row.claimed_at.toISOString() : null) ??
        eventPayload.claimed_at ??
        null

      return {
        buyer_email: stringOrNull(row.buyer_email),
        buyer_locale: null,
        seller_name: stringOrNull(seller?.name),
        seller_handle: stringOrNull(seller?.handle),
        service_title: stringOrNull(product?.title),
        claimed_at: claimedAt,
        voucher_code:
          stringOrNull(voucher?.code) ??
          stringOrNull(snapshot?.voucher_code) ??
          lookupVoucherCode,
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
