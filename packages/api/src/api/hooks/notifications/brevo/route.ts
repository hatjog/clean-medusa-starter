import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import {
  BREVO_WEBHOOK_EVENT_BUS_UNAVAILABLE_CODE,
  BREVO_WEBHOOK_EVENT_ID_MISSING_CODE,
  BREVO_WEBHOOK_INGRESS_METRIC,
  BREVO_WEBHOOK_UNRECOGNIZED_EVENT_CODE,
  normalizeBrevoWebhookEventName,
  recordBrevoWebhookRejection,
} from "./helpers"

type BrevoPayload = Record<string, unknown>
type EventBusLike = {
  emit: (
    event: { name: string; data: BrevoPayload },
    options?: Record<string, unknown>,
  ) => Promise<unknown>
}

/**
 * R-4 (checkpoint 6.6): trasa odpowiada 202 PRZED subskrybentem, a
 * `@medusajs/event-bus-redis` ma domyslnie `attempts: 1` — odmowa weryfikacji C
 * (np. opozniony wpis w statystykach Brevo, 429/5xx) gubilaby zdarzenie
 * trwale. Opcje zadania na poziomie emisji daja ponowienie z backoffem tylko
 * dla zdarzen Brevo; szyna ponawia wylacznie subskrybentow, ktorzy rzucili.
 */
export const BREVO_DELIVERY_EVENT_JOB_OPTIONS = Object.freeze({
  attempts: 6,
  backoff: Object.freeze({ type: "exponential", delay: 30_000 }),
  removeOnComplete: true,
  removeOnFail: false,
})
type LoggerLike = {
  error?: (message: string) => void
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope?.resolve?.("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

function readPayload(req: MedusaRequest): BrevoPayload {
  const body = req.body
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("BREVO_WEBHOOK_BODY_INVALID")
  }
  return body as BrevoPayload
}

function readString(payload: BrevoPayload, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function reject(
  res: MedusaResponse,
  logger: LoggerLike,
  errorCode: string,
  message: string,
): void {
  recordBrevoWebhookRejection()
  logger.error?.(
    `[brevo-webhook] error_code=${errorCode} metric=${BREVO_WEBHOOK_INGRESS_METRIC} ${message}`,
  )
  res.status(422).json({
    error_code: errorCode,
    metric: BREVO_WEBHOOK_INGRESS_METRIC,
    message,
  })
}

export const AUTHENTICATE = false

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = resolveLogger(req)
  let payload: BrevoPayload
  try {
    payload = readPayload(req)
  } catch {
    reject(res, logger, "BREVO_WEBHOOK_BODY_INVALID", "body musi być obiektem JSON")
    return
  }

  let eventName: string
  try {
    eventName = normalizeBrevoWebhookEventName(
      readString(payload, "event_type", "event"),
    )
  } catch (error) {
    reject(
      res,
      logger,
      BREVO_WEBHOOK_UNRECOGNIZED_EVENT_CODE,
      error instanceof Error ? error.message : "typ zdarzenia spoza dziedziny Brevo",
    )
    return
  }

  const providerEventId = readString(
    payload,
    "provider_event_id",
    "message-id",
    "message_id",
    "messageId",
    "event_uuid",
  )
  if (!providerEventId) {
    reject(res, logger, BREVO_WEBHOOK_EVENT_ID_MISSING_CODE, "brak provider_event_id")
    return
  }

  let eventBus: EventBusLike | undefined
  try {
    eventBus = req.scope?.resolve?.(Modules.EVENT_BUS) as EventBusLike | undefined
  } catch {
    eventBus = undefined
  }
  if (!eventBus || typeof eventBus.emit !== "function") {
    reject(
      res,
      logger,
      BREVO_WEBHOOK_EVENT_BUS_UNAVAILABLE_CODE,
      "szyna zdarzeń jest niedostępna",
    )
    return
  }

  const eventData: BrevoPayload = {
    ...payload,
    provider_id: "brevo",
    provider_event_id: providerEventId,
    event_type: eventName.replace(/^notification\./, ""),
  }
  await eventBus.emit({ name: eventName, data: eventData }, {
    ...BREVO_DELIVERY_EVENT_JOB_OPTIONS,
  })

  res.status(202).json({
    type: "emitted",
    provider_id: "brevo",
    provider_event_id: providerEventId,
    event_name: eventName,
  })
}
