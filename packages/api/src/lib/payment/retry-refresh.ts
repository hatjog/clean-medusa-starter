import {
  classifyPaymentAttempt,
  type PaymentAttemptClassificationResult,
} from "./failure-classification"

export const PAYMENT_RETRY_PENDING_MESSAGE =
  "Trwa weryfikacja poprzedniej próby - odczekaj"
export const PAYMENT_RETRY_NON_RETRYABLE_MESSAGE =
  "Płatność wymaga innej metody albo kontaktu z bankiem."
export const PAYMENT_RETRY_SUPPORT_REQUIRED_MESSAGE =
  "Nie możemy automatycznie wznowić płatności. Skontaktuj się z obsługą."

export type PaymentRetryConflictCode =
  | "payment_retry_pending"
  | "payment_retry_non_retryable"
  | "payment_retry_support_required"
  | "payment_retry_not_found"

export class PaymentRetryConflictError extends Error {
  readonly status: 404 | 409
  readonly code: PaymentRetryConflictCode
  readonly publicMessage: string

  constructor(args: {
    status?: 404 | 409
    code: PaymentRetryConflictCode
    publicMessage: string
  }) {
    super(args.publicMessage)
    this.name = "PaymentRetryConflictError"
    this.status = args.status ?? 409
    this.code = args.code
    this.publicMessage = args.publicMessage
  }
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>

export type PaymentRetryClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => QueryResult<T>
}

export type PaymentRetrySessionRow = {
  id: string
  provider_id: string | null
  status: string | null
  data: Record<string, unknown> | null
  context: Record<string, unknown> | null
  retry_count: number | string | null
  payment_collection_id: string
  order_id: string | null
  customer_id: string | null
  sales_channel_id: string | null
}

export type CreateRetrySessionInput = {
  currentSession: PaymentRetrySessionRow
  idempotencyKey: string
  retryCount: number
}

export type PaymentRetryRefreshResult<T> = {
  retry_count: number
  idempotency_key: string
  payment_session_id: string
  payment_session: T
  previous_payment_session_id: string
  failure: PaymentAttemptClassificationResult
}

export function deriveRetryIdempotencyKey(orderId: string, retryCount: number): string {
  return `${orderId}_${retryCount}`
}

function parseRetryCount(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

function extractSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const object = value as Record<string, unknown>
  if (typeof object.id === "string" && object.id.trim()) {
    return object.id
  }
  const paymentSession = object.payment_session
  if (paymentSession && typeof paymentSession === "object") {
    const nestedId = (paymentSession as Record<string, unknown>).id
    return typeof nestedId === "string" && nestedId.trim() ? nestedId : null
  }
  return null
}

function assertOwnedSession(
  row: PaymentRetrySessionRow | undefined,
  input: {
    customerId?: string | null
    salesChannelId?: string | null
  }
): PaymentRetrySessionRow {
  if (!row?.id || !row.order_id) {
    throw new PaymentRetryConflictError({
      status: 404,
      code: "payment_retry_not_found",
      publicMessage: "Payment collection not found",
    })
  }

  if (input.customerId && row.customer_id && row.customer_id !== input.customerId) {
    throw new PaymentRetryConflictError({
      status: 404,
      code: "payment_retry_not_found",
      publicMessage: "Payment collection not found",
    })
  }

  if (
    input.salesChannelId &&
    row.sales_channel_id &&
    row.sales_channel_id !== input.salesChannelId
  ) {
    throw new PaymentRetryConflictError({
      status: 404,
      code: "payment_retry_not_found",
      publicMessage: "Payment collection not found",
    })
  }

  return row
}

function assertRetryableFailure(
  classification: PaymentAttemptClassificationResult
): asserts classification is PaymentAttemptClassificationResult & { classification: "retryable" } {
  if (classification.classification === "pending") {
    throw new PaymentRetryConflictError({
      code: "payment_retry_pending",
      publicMessage: PAYMENT_RETRY_PENDING_MESSAGE,
    })
  }

  if (classification.classification === "non_retryable") {
    throw new PaymentRetryConflictError({
      code: "payment_retry_non_retryable",
      publicMessage: PAYMENT_RETRY_NON_RETRYABLE_MESSAGE,
    })
  }

  if (classification.classification === "support_required") {
    throw new PaymentRetryConflictError({
      code: "payment_retry_support_required",
      publicMessage: PAYMENT_RETRY_SUPPORT_REQUIRED_MESSAGE,
    })
  }
}

function assertStripeProvider(row: PaymentRetrySessionRow): void {
  if (!row.provider_id?.includes("stripe")) {
    throw new PaymentRetryConflictError({
      code: "payment_retry_support_required",
      publicMessage: PAYMENT_RETRY_SUPPORT_REQUIRED_MESSAGE,
    })
  }
}

export async function refreshPaymentSessionForRetry<T>(
  client: PaymentRetryClient,
  input: {
    paymentCollectionId: string
    customerId?: string | null
    salesChannelId?: string | null
    createSession: (args: CreateRetrySessionInput) => Promise<T>
  }
): Promise<PaymentRetryRefreshResult<T>> {
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `payment-retry:${input.paymentCollectionId}`,
    ])

    const latest = await client.query<PaymentRetrySessionRow>(
      `
        SELECT
          ps.id,
          ps.provider_id,
          ps.status,
          ps.data,
          ps.context,
          ps.retry_count,
          ps.payment_collection_id,
          opc.order_id,
          o.customer_id,
          o.sales_channel_id
        FROM payment_session ps
        LEFT JOIN order_payment_collection opc
          ON opc.payment_collection_id = ps.payment_collection_id
         AND opc.deleted_at IS NULL
        LEFT JOIN "order" o
          ON o.id = opc.order_id
         AND o.deleted_at IS NULL
        WHERE ps.payment_collection_id = $1
          AND ps.deleted_at IS NULL
        ORDER BY ps.created_at DESC
        LIMIT 1
        FOR UPDATE OF ps
      `,
      [input.paymentCollectionId]
    )

    const currentSession = assertOwnedSession(latest.rows[0], input)
    assertStripeProvider(currentSession)
    const failure = classifyPaymentAttempt({
      status: currentSession.status,
      data: currentSession.data,
      context: currentSession.context,
    })
    assertRetryableFailure(failure)

    const retryCount = parseRetryCount(currentSession.retry_count) + 1
    const idempotencyKey = deriveRetryIdempotencyKey(currentSession.order_id as string, retryCount)

    await client.query(
      `
        UPDATE payment_session
           SET retry_count = $2,
               context = COALESCE(context, '{}'::jsonb) ||
                 jsonb_build_object(
                   'gp_last_retry_idempotency_key', $3::text,
                   'gp_last_retry_count', $2::int,
                   'gp_last_retry_failure_code', $4::text,
                   'gp_last_retry_decline_code', $5::text
                 )
         WHERE id = $1
      `,
      [
        currentSession.id,
        retryCount,
        idempotencyKey,
        failure.failure_code ?? null,
        failure.decline_code ?? null,
      ]
    )

    const createdSession = await input.createSession({
      currentSession,
      idempotencyKey,
      retryCount,
    })
    const createdSessionId = extractSessionId(createdSession)
    if (!createdSessionId) {
      throw new Error("Retry payment session creation did not return a payment_session id")
    }

    await client.query(
      `
        UPDATE payment_session
           SET retry_count = $2,
               retry_idempotency_key = $3,
               context = COALESCE(context, '{}'::jsonb) ||
                 jsonb_build_object(
                   'gp_payment_retry', true,
                   'gp_payment_retry_count', $2::int,
                   'gp_payment_retry_idempotency_key', $3::text,
                   'gp_previous_payment_session_id', $4::text
                 )
         WHERE id = $1
      `,
      [createdSessionId, retryCount, idempotencyKey, currentSession.id]
    )

    await client.query("COMMIT")

    return {
      retry_count: retryCount,
      idempotency_key: idempotencyKey,
      payment_session_id: createdSessionId,
      payment_session: createdSession,
      previous_payment_session_id: currentSession.id,
      failure,
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw err
  }
}
