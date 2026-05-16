import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"

import {
  compensateIssuedEntitlement,
  issueEntitlementWithinPaymentTransaction,
  MissingEntitlementProfileError,
  type IssueEntitlementResult,
} from "../entitlements/issue-entitlement"
import type { EntitlementType } from "../../modules/voucher/models/entitlement"

export const STRIPE_PAYMENT_EVENTS = [
  "payment.captured",
  "payment.failed",
  "payment.canceled",
  "payment.refunded",
] as const

export type StripePaymentEventName = (typeof STRIPE_PAYMENT_EVENTS)[number]
export type PaymentAuditOutcome = "captured" | "failed" | "canceled" | "refunded"

export type StripePaymentAuditPayload = {
  event_id?: string
  request_id?: string
  payment_intent_id?: string
  payment_id?: string
  order_id?: string
  market_id?: string | null
  payment_method_type?: string | null
  processing_country?: string | null
  failure_code?: string | null
  decline_code?: string | null
  amount_minor?: number | null
  currency?: string | null
  entitlement_profile?: {
    profile_id?: string
    entitlement_type?: EntitlementType | string
    policy?: Record<string, unknown>
    currency?: string
    amount_minor?: number
    line_item_id?: string | null
  } | null
}

export type PaymentAuditEnvelope = {
  level: "info" | "warn" | "error"
  actor: "system"
  scope: string
  request_id: string
  outcome: PaymentAuditOutcome
  lifecycle_status: "paid" | "failed" | "refunded"
  event_type: StripePaymentEventName
  timestamp: string
  failure_code?: string
  decline_code?: string
  payment_method_type?: string
  processing_country?: string
}

export type StripePaymentAuditResult = {
  event_id: string
  envelope: PaymentAuditEnvelope
  deduplicated: boolean
  entitlement?: IssueEntitlementResult
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release: () => void
}
type PgPool = {
  connect: () => Promise<PgClient>
}
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

type EventBusLike = {
  emit?: (message: { name: string; data: unknown }) => Promise<unknown>
}

type LoggerLike = {
  info?: (message: string, meta?: unknown) => void
  warn?: (message: string, meta?: unknown) => void
  error?: (message: string, meta?: unknown) => void
}

export class MissingNativeStripePayloadFieldError extends Error {
  constructor(fields: string[]) {
    super(`missing required native Stripe payment field(s): ${fields.join(", ")}`)
    this.name = "MissingNativeStripePayloadFieldError"
  }
}

export class StripePaymentAuditWorkflow {
  constructor(
    private readonly db: PgPool | KnexLike,
    private readonly eventBus?: EventBusLike,
    private readonly logger?: LoggerLike
  ) {}

  async process(
    eventType: StripePaymentEventName,
    payload: StripePaymentAuditPayload,
    now = new Date()
  ): Promise<StripePaymentAuditResult> {
    const result = await this.processMutation(eventType, payload, now)
    await this.emit(result, payload, now)
    return result
  }

  async processMutation(
    eventType: StripePaymentEventName,
    payload: StripePaymentAuditPayload,
    now = new Date()
  ): Promise<StripePaymentAuditResult> {
    assertNativeStripePayload(eventType, payload)
    const envelope = buildPaymentAuditEnvelope(eventType, payload, now)
    const eventId = payload.event_id as string

    return this.withTransaction(async (client) => {
      let entitlement: IssueEntitlementResult | undefined
      const inserted = await insertDedupRow(client, payload, envelope)
      if (!inserted) {
        return { event_id: eventId, envelope, deduplicated: true }
      }

      if (eventType === "payment.captured" && payload.order_id) {
        try {
          entitlement = await issueEntitlementWithinPaymentTransaction(
            client,
            {
              event_id: payload.event_id as string,
              order_id: payload.order_id as string,
              payment_id: payload.payment_id,
              payment_intent_id: payload.payment_intent_id,
              market_id: payload.market_id,
              amount_minor: payload.amount_minor,
              currency: payload.currency,
              entitlement_profile: payload.entitlement_profile,
            },
            now
          )
        } catch (err) {
          if (!(err instanceof MissingEntitlementProfileError)) {
            throw err
          }
          this.logger?.warn?.(
            `[stripe-payment-audit] ${eventType} order_id=${payload.order_id} ` +
              `has no entitlement profile; audit persisted without entitlement issue`
          )
        }
      }

      return { event_id: eventId, envelope, deduplicated: false, entitlement }
    })
  }

  async emit(
    result: StripePaymentAuditResult,
    payload: StripePaymentAuditPayload,
    now = new Date()
  ): Promise<void> {
    if (result.deduplicated) return
    emitAuditLog(this.logger, result.envelope)
    await this.eventBus?.emit?.({
      name: `payment_audit.${result.envelope.outcome}`,
      data: result.envelope,
    })
    if (result.entitlement) {
      await this.eventBus?.emit?.({
        name: "gp.entitlements.entitlement_issued.v1",
        data: {
          schema_version: "1",
          event_type: "gp.entitlements.entitlement_issued.v1",
          occurred_at: now.toISOString(),
          actor: "system",
          scope: {
            instance_id: "gp-dev",
            market_id: payload.market_id ?? "unknown",
            vendor_id: null,
            location_id: null,
          },
          idempotency_key: `entitlement:${result.entitlement.entitlement_id}`,
          payload: {
            entitlement_id: result.entitlement.entitlement_id,
            order_id: payload.order_id,
            payment_id: payload.payment_id ?? payload.payment_intent_id,
            entitlement_type: payload.entitlement_profile?.entitlement_type,
            currency: payload.entitlement_profile?.currency ?? payload.currency ?? "PLN",
            amount_minor:
              payload.entitlement_profile?.amount_minor ?? payload.amount_minor ?? 0,
            items_count: 1,
          },
        },
      })
    }
  }

  async compensate(result: StripePaymentAuditResult | undefined): Promise<void> {
    if (!result || result.deduplicated) return
    await this.withTransaction(async (client) => {
      await compensateIssuedEntitlement(client, result.entitlement)
      await client.query(
        `DELETE FROM webhook_event_processed WHERE event_id = $1 AND provider = 'stripe'`,
        [result.event_id]
      )
    })
  }

  private async withTransaction<T>(handler: (client: PgClient) => Promise<T>): Promise<T> {
    if (isPgPool(this.db)) {
      const client = await this.db.connect()
      try {
        await client.query("BEGIN")
        const result = await handler(client)
        await client.query("COMMIT")
        return result
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    }

    return this.db.transaction(async (trx) => handler(createKnexPgClient(trx)))
  }
}

function emitAuditLog(logger: LoggerLike | undefined, envelope: PaymentAuditEnvelope): void {
  try {
    if (envelope.level === "error") {
      logger?.error?.("[stripe-payment-audit]", envelope)
    } else if (envelope.level === "warn") {
      logger?.warn?.("[stripe-payment-audit]", envelope)
    } else {
      logger?.info?.("[stripe-payment-audit]", envelope)
    }
  } catch {
    // Audit persistence is the source of truth; logger binding issues must not
    // trigger workflow compensation.
  }
}

function assertNativeStripePayload(
  eventType: StripePaymentEventName,
  payload: StripePaymentAuditPayload
): void {
  const required = [
    "event_id",
    "request_id",
    "payment_intent_id",
    "payment_method_type",
    "processing_country",
  ]
  if (eventType === "payment.failed") required.push("failure_code")

  const missing = required.filter((field) => {
    const value = payload[field as keyof StripePaymentAuditPayload]
    return value === undefined || value === null || value === ""
  })
  if (missing.length > 0) {
    throw new MissingNativeStripePayloadFieldError(missing)
  }
}

export function buildPaymentAuditEnvelope(
  eventType: StripePaymentEventName,
  payload: StripePaymentAuditPayload,
  now = new Date()
): PaymentAuditEnvelope {
  const outcome = eventType.slice("payment.".length) as PaymentAuditOutcome
  const lifecycle_status =
    outcome === "captured" ? "paid" : outcome === "refunded" ? "refunded" : "failed"
  const level = outcome === "captured" || outcome === "refunded" ? "info" : "warn"
  const envelope: PaymentAuditEnvelope = {
    level,
    actor: "system",
    scope: `payment_intent:${payload.payment_intent_id}`,
    request_id: payload.request_id as string,
    outcome,
    lifecycle_status,
    event_type: eventType,
    timestamp: now.toISOString(),
    payment_method_type: payload.payment_method_type ?? undefined,
    processing_country: payload.processing_country ?? undefined,
  }
  const failureCode = redactFailureCode(payload.failure_code)
  if (failureCode) envelope.failure_code = failureCode
  if (payload.decline_code) envelope.decline_code = payload.decline_code
  return envelope
}

export function redactFailureCode(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return value.split(":")[0]?.trim() || undefined
}

async function insertDedupRow(
  client: PgClient,
  payload: StripePaymentAuditPayload,
  envelope: PaymentAuditEnvelope
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO webhook_event_processed
       (event_id, provider, market_id, envelope, received_at)
     VALUES ($1, 'stripe', $2, $3::jsonb, NOW())
     ON CONFLICT (event_id, provider) DO NOTHING`,
    [payload.event_id, payload.market_id ?? null, JSON.stringify(envelope)]
  )
  return (result.rowCount ?? 0) === 1
}

export function createStripePaymentAuditWorkflowFromScope(scope: {
  resolve: (key: string) => unknown
}): StripePaymentAuditWorkflow {
  const db = resolvePgDatabase(scope)
  let eventBus: EventBusLike | undefined
  let logger: LoggerLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  try {
    logger = scope.resolve("logger") as LoggerLike
  } catch {
    logger = undefined
  }
  return new StripePaymentAuditWorkflow(db, eventBus, logger)
}

function resolvePgDatabase(scope: { resolve: (key: string) => unknown }): PgPool | KnexLike {
  try {
    return scope.resolve("__pg_pool__") as PgPool
  } catch {
    return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  }
}

function isPgPool(value: PgPool | KnexLike): value is PgPool {
  return typeof (value as PgPool).connect === "function"
}

function createKnexPgClient(db: KnexLike): PgClient {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values: ReadonlyArray<unknown> = []
    ) => {
      const query = toKnexSql(text, values)
      const result = await db.raw(query.sql, query.bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = (result.rows ?? []) as T[]
      return { rows, rowCount: result.rowCount ?? rows.length }
    },
    release: () => undefined,
  }
}

function toKnexSql(
  sql: string,
  values: ReadonlyArray<unknown>
): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    bindings.push(values[Number(index) - 1])
    return "?"
  })
  return { sql: text, bindings }
}

export type StripePaymentAuditWorkflowInput = {
  eventType: StripePaymentEventName
  payload: StripePaymentAuditPayload
}

export const persistStripePaymentAuditStep = createStep<
  StripePaymentAuditWorkflowInput,
  StripePaymentAuditResult,
  StripePaymentAuditResult
>(
  "gp-persist-stripe-payment-audit",
  async (input, { container }) => {
    const workflow = createStripePaymentAuditWorkflowFromScope(
      container as unknown as { resolve: (key: string) => unknown }
    )
    const result = await workflow.processMutation(input.eventType, input.payload)
    return new StepResponse(result, result)
  },
  async (result, { container }) => {
    if (!result) return
    const workflow = createStripePaymentAuditWorkflowFromScope(
      container as unknown as { resolve: (key: string) => unknown }
    )
    await workflow.compensate(result)
  }
)

export const emitStripePaymentAuditStep = createStep<
  { result: StripePaymentAuditResult; payload: StripePaymentAuditPayload },
  void,
  void
>("gp-emit-stripe-payment-audit", async (input, { container }) => {
  const workflow = createStripePaymentAuditWorkflowFromScope(
    container as unknown as { resolve: (key: string) => unknown }
  )
  await workflow.emit(input.result, input.payload)
  return new StepResponse(undefined, undefined)
})

export const stripePaymentAuditWorkflow = createWorkflow<
  StripePaymentAuditWorkflowInput,
  StripePaymentAuditResult,
  []
>("gp-stripe-payment-audit-workflow", function (input) {
  const result = persistStripePaymentAuditStep(input)
  emitStripePaymentAuditStep({ result, payload: input.payload })
  return new WorkflowResponse(result)
})

export { MissingEntitlementProfileError }
