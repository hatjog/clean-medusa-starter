import { classifyDeliveryEventName } from "../../../../lib/delivery-event-classification"
import type { NotificationDeliveryEventType } from "@gp/messaging"

/** Nazwane wyjście obserwowalności ingressu (AD-19/NFR-2). */
export const BREVO_WEBHOOK_INGRESS_METRIC =
  "gp_brevo_webhook_ingress_total"
export const BREVO_WEBHOOK_UNRECOGNIZED_EVENT_CODE =
  "BREVO_WEBHOOK_EVENT_UNRECOGNIZED"
export const BREVO_WEBHOOK_EVENT_ID_MISSING_CODE =
  "BREVO_WEBHOOK_EVENT_ID_MISSING"
export const BREVO_WEBHOOK_EVENT_BUS_UNAVAILABLE_CODE =
  "BREVO_WEBHOOK_EVENT_BUS_UNAVAILABLE"

export type BrevoWebhookEventName =
  | "notification.delivered"
  | "notification.opened"
  | "notification.clicked"
  | "notification.hard_bounce"
  | "notification.soft_bounce"
  | "notification.blocked"
  | "notification.invalid_email"
  | "notification.deferred"
  | "notification.complaint"
  | "notification.unsubscribed"
  | "notification.failed"

const EVENT_NAME_BY_REACTION: Record<
  NotificationDeliveryEventType,
  BrevoWebhookEventName
> = {
  delivered: "notification.delivered",
  opened: "notification.opened",
  clicked: "notification.clicked",
  bounced_permanent: "notification.hard_bounce",
  bounced_transient: "notification.soft_bounce",
  blocked: "notification.blocked",
  invalid_address: "notification.invalid_email",
  deferred: "notification.deferred",
  complaint: "notification.complaint",
  unsubscribed: "notification.unsubscribed",
  failed: "notification.failed",
}

let rejectedWebhookCount = 0

export function recordBrevoWebhookRejection(): number {
  rejectedWebhookCount += 1
  return rejectedWebhookCount
}

export function getBrevoWebhookIngressMetrics(): {
  metric: string
  rejected: number
} {
  return { metric: BREVO_WEBHOOK_INGRESS_METRIC, rejected: rejectedWebhookCount }
}

export function _resetBrevoWebhookIngressMetricsForTests(): void {
  rejectedWebhookCount = 0
}

export function normalizeBrevoWebhookEventName(raw: unknown): BrevoWebhookEventName {
  const reaction = classifyDeliveryEventName(
    "event_payload",
    typeof raw === "string" ? raw : undefined,
  )
  return EVENT_NAME_BY_REACTION[reaction]
}
