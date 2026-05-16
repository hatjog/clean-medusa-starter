import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  STRIPE_PAYMENT_EVENTS,
  stripePaymentAuditWorkflow,
  type StripePaymentAuditPayload,
  type StripePaymentEventName,
} from "../workflows/payment/stripe-payment-audit"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}
type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

function resolveLogger(container: Record<string, unknown> | undefined): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined
  if (direct) return direct
  const resolver = container?.resolve as ((key: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console
    } catch {
      return console
    }
  }
  return console
}

export default async function stripePaymentAuditSubscriber({
  event,
  container,
}: SubscriberArgs<StripePaymentAuditPayload>): Promise<void> {
  const eventName = event.name as StripePaymentEventName | undefined
  const logger = resolveLogger(container as unknown as Record<string, unknown>)

  if (!eventName || !STRIPE_PAYMENT_EVENTS.includes(eventName)) {
    logger.warn?.(`[stripe-payment-audit] unsupported event ${eventName ?? "unknown"}`)
    return
  }

  try {
    const payload = await hydrateStripePaymentAuditPayload(
      eventName,
      event.data,
      container as unknown as { resolve: (key: string) => unknown },
      logger
    )
    const { result } = await stripePaymentAuditWorkflow(container).run({
      input: { eventType: eventName, payload },
    })
    logger.info?.(
      `[stripe-payment-audit] ${eventName} event_id=${result.event_id} ` +
        `deduplicated=${result.deduplicated}`
    )
  } catch (err) {
    const error = err as Error
    logger.error?.(
      `[stripe-payment-audit] ${eventName} failed: ${error.name}: ${error.message}; ` +
        `payload_keys=${Object.keys(event.data ?? {}).sort().join(",")}`
    )
    throw err
  }
}

export const config: SubscriberConfig = {
  event: [...STRIPE_PAYMENT_EVENTS],
}

async function hydrateStripePaymentAuditPayload(
  eventName: StripePaymentEventName,
  data: StripePaymentAuditPayload,
  container: { resolve: (key: string) => unknown },
  logger: LoggerLike
): Promise<StripePaymentAuditPayload> {
  if (data.event_id && data.payment_intent_id && data.request_id) {
    return data
  }

  const paymentId = readString((data as Record<string, unknown>).id) ?? data.payment_id
  if (!paymentId) {
    return data
  }

  let db: KnexLike
  try {
    db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  } catch {
    return data
  }

  const result = await db.raw(
    `
      SELECT
        p.id AS payment_id,
        p.amount AS amount_minor,
        p.currency_code,
        p.data AS payment_data,
        p.metadata AS payment_metadata,
        ps.data AS session_data,
        ps.metadata AS session_metadata,
        opc.order_id,
        o.metadata AS order_metadata,
        o.sales_channel_id
      FROM payment p
      LEFT JOIN payment_session ps
        ON ps.id = p.payment_session_id
       AND ps.deleted_at IS NULL
      LEFT JOIN order_payment_collection opc
        ON opc.payment_collection_id = p.payment_collection_id
       AND opc.deleted_at IS NULL
      LEFT JOIN "order" o
        ON o.id = opc.order_id
       AND o.deleted_at IS NULL
      WHERE p.id = ?
        AND p.deleted_at IS NULL
      LIMIT 1
    `,
    [paymentId]
  )
  const row = result.rows?.[0] as Record<string, unknown> | undefined
  if (!row) {
    return {
      ...data,
      event_id: data.event_id ?? `medusa:${eventName}:${paymentId}`,
      request_id: data.request_id ?? `medusa:${eventName}:${paymentId}`,
      payment_id: data.payment_id ?? paymentId,
      payment_intent_id: data.payment_intent_id ?? paymentId,
      payment_method_type: data.payment_method_type ?? "unknown",
      processing_country: data.processing_country ?? "unknown",
    }
  }

  const paymentData = objectValue(row.payment_data)
  const sessionData = objectValue(row.session_data)
  const paymentMetadata = objectValue(row.payment_metadata)
  const sessionMetadata = objectValue(row.session_metadata)
  const orderMetadata = objectValue(row.order_metadata)
  const paymentIntentId =
    data.payment_intent_id ??
    readNestedString(paymentData, ["id"]) ??
    readNestedString(paymentData, ["payment_intent"]) ??
    readNestedString(sessionData, ["id"]) ??
    readNestedString(sessionData, ["payment_intent"]) ??
    parsePaymentIntentFromClientSecret(readNestedString(paymentData, ["client_secret"])) ??
    parsePaymentIntentFromClientSecret(readNestedString(sessionData, ["client_secret"])) ??
    paymentId

  const marketId =
    data.market_id ??
    readNestedString(orderMetadata, ["gp", "market_id"]) ??
    readNestedString(orderMetadata, ["market_id"]) ??
    readNestedString(paymentMetadata, ["market_id"]) ??
    readNestedString(sessionMetadata, ["market_id"]) ??
    null

  const fallbackFields = [
    data.event_id ? null : "event_id",
    data.request_id ? null : "request_id",
    data.payment_method_type ? null : "payment_method_type",
    data.processing_country ? null : "processing_country",
  ].filter(Boolean)
  if (fallbackFields.length > 0) {
    logger.warn?.(
      `[stripe-payment-audit] ${eventName} hydrated fallback fields: ${fallbackFields.join(",")}`
    )
  }

  return {
    ...data,
    event_id:
      data.event_id ??
      readNestedString(paymentData, ["event_id"]) ??
      readNestedString(paymentMetadata, ["event_id"]) ??
      `medusa:${eventName}:${paymentId}`,
    request_id:
      data.request_id ??
      readNestedString(paymentData, ["request_id"]) ??
      readNestedString(paymentData, ["request", "id"]) ??
      readNestedString(paymentMetadata, ["request_id"]) ??
      `medusa:${eventName}:${paymentId}`,
    payment_id: data.payment_id ?? paymentId,
    payment_intent_id: paymentIntentId,
    order_id: data.order_id ?? readString(row.order_id),
    market_id: marketId,
    payment_method_type:
      data.payment_method_type ??
      readNestedString(paymentData, ["payment_method_type"]) ??
      readNestedString(paymentData, ["payment_method_details", "type"]) ??
      readFirstString(paymentData.payment_method_types) ??
      "unknown",
    processing_country:
      data.processing_country ??
      readNestedString(paymentData, ["processing_country"]) ??
      readNestedString(paymentData, ["payment_method_details", "card", "country"]) ??
      "unknown",
    amount_minor:
      data.amount_minor ??
      (typeof row.amount_minor === "number" ? row.amount_minor : Number(row.amount_minor ?? 0)),
    currency: data.currency ?? readString(row.currency_code)?.toUpperCase(),
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readNestedString(
  source: Record<string, unknown>,
  path: string[]
): string | undefined {
  let current: unknown = source
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return readString(current)
}

function readFirstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(readString).find(Boolean)
}

function parsePaymentIntentFromClientSecret(value: string | undefined): string | undefined {
  if (!value) return undefined
  const marker = "_secret_"
  const index = value.indexOf(marker)
  return index > 0 ? value.slice(0, index) : undefined
}
