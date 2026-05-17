import {
  PAYMENT_RETRY_PENDING_MESSAGE,
  PaymentRetryConflictError,
  deriveRetryIdempotencyKey,
  refreshPaymentSessionForRetry,
} from "../../../lib/payment/retry-refresh"

type QueryCall = { sql: string; params: ReadonlyArray<unknown> }

class FakeRetryClient {
  calls: QueryCall[] = []

  constructor(private readonly latestRow: Record<string, unknown> | null) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })

    if (sql.includes("FROM payment_session ps")) {
      return {
        rows: (this.latestRow ? [this.latestRow] : []) as T[],
        rowCount: this.latestRow ? 1 : 0,
      }
    }

    return { rows: [] as T[], rowCount: 1 }
  }
}

function failedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "ps_failed_1",
    provider_id: "pp_stripe_stripe",
    status: "error",
    data: {
      last_payment_error: {
        code: "card_declined",
        decline_code: "insufficient_funds",
      },
    },
    context: {},
    retry_count: 0,
    payment_collection_id: "paycol_1",
    order_id: "order_123",
    customer_id: "cus_1",
    sales_channel_id: "sc_1",
    ...overrides,
  }
}

describe("payment retry refresh", () => {
  it("derives the documented order_id + retry_count idempotency key", () => {
    expect(deriveRetryIdempotencyKey("order_123", 2)).toBe("order_123_2")
  })

  it("increments retry_count and creates one retry session with the derived idempotency key", async () => {
    const client = new FakeRetryClient(failedSession())
    const createSession = jest.fn(async () => ({ id: "ps_retry_1" }))

    const result = await refreshPaymentSessionForRetry(client, {
      paymentCollectionId: "paycol_1",
      customerId: "cus_1",
      salesChannelId: "sc_1",
      createSession,
    })

    expect(result.retry_count).toBe(1)
    expect(result.idempotency_key).toBe("order_123_1")
    expect(result.payment_session_id).toBe("ps_retry_1")
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "order_123_1",
        retryCount: 1,
      })
    )
    expect(
      client.calls.some(
        (call) =>
          call.sql.includes("UPDATE payment_session") &&
          call.sql.includes("retry_idempotency_key")
      )
    ).toBe(true)
  })

  it("rejects a still-pending previous attempt with 409 and no new session", async () => {
    const client = new FakeRetryClient(
      failedSession({
        status: "pending",
        data: { status: "processing" },
      })
    )
    const createSession = jest.fn()

    await expect(
      refreshPaymentSessionForRetry(client, {
        paymentCollectionId: "paycol_1",
        customerId: "cus_1",
        salesChannelId: "sc_1",
        createSession,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "payment_retry_pending",
      publicMessage: PAYMENT_RETRY_PENDING_MESSAGE,
    })
    expect(createSession).not.toHaveBeenCalled()
  })

  it("does not retry non-retryable hard declines", async () => {
    const client = new FakeRetryClient(
      failedSession({
        data: {
          last_payment_error: {
            code: "card_declined",
            decline_code: "fraudulent",
          },
        },
      })
    )
    const createSession = jest.fn()

    await expect(
      refreshPaymentSessionForRetry(client, {
        paymentCollectionId: "paycol_1",
        customerId: "cus_1",
        salesChannelId: "sc_1",
        createSession,
      })
    ).rejects.toBeInstanceOf(PaymentRetryConflictError)
    expect(createSession).not.toHaveBeenCalled()
  })

  it("does not treat missing failure metadata as retryable", async () => {
    const client = new FakeRetryClient(
      failedSession({
        data: {},
      })
    )
    const createSession = jest.fn()

    await expect(
      refreshPaymentSessionForRetry(client, {
        paymentCollectionId: "paycol_1",
        customerId: "cus_1",
        salesChannelId: "sc_1",
        createSession,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "payment_retry_support_required",
    })
    expect(createSession).not.toHaveBeenCalled()
  })
})
