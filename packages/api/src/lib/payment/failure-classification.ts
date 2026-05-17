export type StripeFailureClassification =
  | "retryable"
  | "non_retryable"
  | "support_required"

export type PaymentAttemptClassification = StripeFailureClassification | "pending"

export type StripeFailureDetails = {
  failure_code?: string | null
  decline_code?: string | null
}

export type StripeFailureClassificationResult = StripeFailureDetails & {
  classification: StripeFailureClassification
}

export type PaymentAttemptClassificationInput = {
  status?: string | null
  data?: Record<string, unknown> | null
  context?: Record<string, unknown> | null
}

export type PaymentAttemptClassificationResult = StripeFailureClassificationResult | {
  classification: "pending"
  failure_code?: undefined
  decline_code?: undefined
}

const RETRYABLE_FAILURE_CODES = new Set([
  "authentication_required",
  "insufficient_funds",
  "payment_intent_authentication_failure",
  "processing_error",
  "try_again_later",
])

const RETRYABLE_DECLINE_CODES = new Set([
  "authentication_required",
  "approve_with_id",
  "insufficient_funds",
  "issuer_not_available",
  "processing_error",
  "reenter_transaction",
  "try_again_later",
])

const NON_RETRYABLE_FAILURE_CODES = new Set([
  "fraudulent",
  "generic_decline",
  "lost_card",
  "merchant_blacklist",
  "pickup_card",
  "restricted_card",
  "revocation_of_all_authorizations",
  "revocation_of_authorization",
  "security_violation",
  "stolen_card",
])

const NON_RETRYABLE_DECLINE_CODES = new Set([
  "do_not_honor",
  "fraudulent",
  "generic_decline",
  "lost_card",
  "merchant_blacklist",
  "pickup_card",
  "restricted_card",
  "revocation_of_all_authorizations",
  "revocation_of_authorization",
  "security_violation",
  "stolen_card",
])

const PENDING_SESSION_STATUSES = new Set([
  "authorized",
  "pending",
  "requires_action",
  "requires_more",
])

const PENDING_INTENT_STATUSES = new Set([
  "processing",
  "requires_action",
  "requires_capture",
  "requires_confirmation",
])

export function redactFailureCode(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return value.split(":")[0]?.trim() || undefined
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
  path: readonly string[]
): string | undefined {
  let cursor: unknown = source
  for (const segment of path) {
    const object = objectValue(cursor)
    cursor = object[segment]
  }
  return readString(cursor)
}

function normalizeCode(value: string | null | undefined): string | undefined {
  return redactFailureCode(value)?.toLowerCase()
}

export function extractStripeFailureDetails(
  data: Record<string, unknown> | null | undefined,
  context: Record<string, unknown> | null | undefined = {}
): StripeFailureDetails {
  const paymentData = objectValue(data)
  const paymentContext = objectValue(context)

  return {
    failure_code:
      redactFailureCode(
        readString(paymentData.failure_code) ??
          readString(paymentData.code) ??
          readNestedString(paymentData, ["last_payment_error", "code"]) ??
          readNestedString(paymentData, ["payment_intent", "last_payment_error", "code"]) ??
          readNestedString(paymentData, ["error", "code"]) ??
          readString(paymentContext.gp_failure_code) ??
          readString(paymentContext.failure_code)
      ) ?? null,
    decline_code:
      readString(paymentData.decline_code) ??
      readNestedString(paymentData, ["last_payment_error", "decline_code"]) ??
      readNestedString(paymentData, ["payment_intent", "last_payment_error", "decline_code"]) ??
      readNestedString(paymentData, ["error", "decline_code"]) ??
      readString(paymentContext.gp_decline_code) ??
      readString(paymentContext.decline_code) ??
      null,
  }
}

export function classifyStripeFailure(
  details: StripeFailureDetails
): StripeFailureClassificationResult {
  const failureCode = normalizeCode(details.failure_code)
  const declineCode = normalizeCode(details.decline_code)

  if (!failureCode && !declineCode) {
    return {
      classification: "support_required",
      failure_code: details.failure_code ?? null,
      decline_code: details.decline_code ?? null,
    }
  }

  if (
    (failureCode && NON_RETRYABLE_FAILURE_CODES.has(failureCode)) ||
    (declineCode && NON_RETRYABLE_DECLINE_CODES.has(declineCode))
  ) {
    return {
      classification: "non_retryable",
      failure_code: details.failure_code ?? null,
      decline_code: details.decline_code ?? null,
    }
  }

  if (
    (failureCode && RETRYABLE_FAILURE_CODES.has(failureCode)) ||
    (declineCode && RETRYABLE_DECLINE_CODES.has(declineCode))
  ) {
    return {
      classification: "retryable",
      failure_code: details.failure_code ?? null,
      decline_code: details.decline_code ?? null,
    }
  }

  return {
    classification: "support_required",
    failure_code: details.failure_code ?? null,
    decline_code: details.decline_code ?? null,
  }
}

export function classifyPaymentAttempt(
  input: PaymentAttemptClassificationInput
): PaymentAttemptClassificationResult {
  const sessionStatus = input.status?.toLowerCase()
  const data = objectValue(input.data)
  const intentStatus =
    readString(data.status)?.toLowerCase() ??
    readNestedString(data, ["payment_intent", "status"])?.toLowerCase()

  if (
    (sessionStatus && PENDING_SESSION_STATUSES.has(sessionStatus)) ||
    (intentStatus && PENDING_INTENT_STATUSES.has(intentStatus))
  ) {
    return { classification: "pending" }
  }

  const failure = extractStripeFailureDetails(input.data, input.context)
  if (failure.failure_code || failure.decline_code) {
    return classifyStripeFailure(failure)
  }

  return classifyStripeFailure(failure)
}
