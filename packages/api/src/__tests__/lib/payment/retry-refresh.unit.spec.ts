import {
  PAYMENT_RETRY_PENDING_MESSAGE,
  PaymentRetryConflictError,
  deriveRetryIdempotencyKey,
  refreshPaymentSessionForRetry,
} from "../../../lib/payment/retry-refresh"

type QueryCall = { sql: string; params: ReadonlyArray<unknown> }

class FakeRetryClient {
  calls: QueryCall[] = []
  rows = new Map<string, Record<string, unknown>>()
  latestId: string | null

  constructor(latestRow: Record<string, unknown> | null) {
    this.latestId = typeof latestRow?.id === "string" ? latestRow.id : null
    if (this.latestId && latestRow) {
      this.rows.set(this.latestId, structuredClone(latestRow))
    }
  }

  setLatest(row: Record<string, unknown>) {
    this.latestId = row.id as string
    this.rows.set(row.id as string, structuredClone(row))
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })

    if (sql.includes("FROM payment_session ps")) {
      const latestRow = this.latestId ? this.rows.get(this.latestId) ?? null : null
      return {
        rows: (latestRow ? [structuredClone(latestRow)] : []) as T[],
        rowCount: latestRow ? 1 : 0,
      }
    }

    if (sql.includes("SET retry_count = $2") && sql.includes("retry_idempotency_key = $3")) {
      const row = this.rows.get(params[0] as string)
      if (row) {
        row.retry_count = params[1]
        row.retry_idempotency_key = params[2]
        row.context = {
          ...(row.context as Record<string, unknown>),
          gp_retry_reservation_state: "reserved",
          gp_payment_retry_idempotency_key: params[2],
        }
      }
      return { rows: [] as T[], rowCount: row ? 1 : 0 }
    }

    if (sql.includes("gp_retry_reservation_state', 'created'")) {
      const row = this.rows.get(params[0] as string)
      if (row) {
        row.context = {
          ...(row.context as Record<string, unknown>),
          gp_retry_reservation_state: "created",
          gp_retry_created_payment_session_id: params[1],
        }
      }
      return { rows: [] as T[], rowCount: row ? 1 : 0 }
    }

    if (sql.includes("gp_payment_retry_idempotency_key")) {
      const sessionId = params[0] as string
      const row = this.rows.get(sessionId) ?? { id: sessionId }
      row.retry_count = params[1]
      row.context = {
        ...(row.context as Record<string, unknown>),
        gp_payment_retry: true,
        gp_payment_retry_count: params[1],
        gp_payment_retry_idempotency_key: params[2],
        gp_previous_payment_session_id: params[3],
      }
      this.rows.set(sessionId, row)
      this.latestId = sessionId
      return { rows: [] as T[], rowCount: 1 }
    }

    if (sql.includes("gp_retry_reservation_state', 'failed_to_create'")) {
      const row = this.rows.get(params[0] as string)
      if (row) {
        row.context = {
          ...(row.context as Record<string, unknown>),
          gp_retry_reservation_state: "failed_to_create",
          gp_retry_failure_class: params[1],
        }
      }
      return { rows: [] as T[], rowCount: row ? 1 : 0 }
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
    let callCountAtCreate = 0
    const createSession = jest.fn(async () => {
      callCountAtCreate = client.calls.length
      client.setLatest({
        id: "ps_retry_1",
        provider_id: "pp_stripe_stripe",
        status: "pending",
        data: { id: "pi_retry_1" },
        context: {},
        retry_count: 0,
        payment_collection_id: "paycol_1",
        order_id: "order_123",
        customer_id: "cus_1",
        sales_channel_id: "sc_1",
      })
      return { id: "ps_retry_1" }
    })

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
    expect(client.calls[callCountAtCreate - 1]?.sql).toBe("COMMIT")
    expect(client.calls.slice(callCountAtCreate).some((call) => call.sql === "BEGIN")).toBe(true)
    expect(client.rows.get("ps_retry_1")).toMatchObject({
      retry_count: 1,
      context: expect.objectContaining({
        gp_payment_retry_idempotency_key: "order_123_1",
      }),
    })
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

  it("prioritizes pending PSP status over stale last_payment_error metadata", async () => {
    const client = new FakeRetryClient(
      failedSession({
        status: "pending",
        data: {
          status: "processing",
          last_payment_error: {
            code: "card_declined",
            decline_code: "insufficient_funds",
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
    ).rejects.toMatchObject({
      status: 409,
      code: "payment_retry_pending",
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

  it("blocks replay when the same retry key is already reserved", async () => {
    const client = new FakeRetryClient(
      failedSession({
        retry_count: 1,
        retry_idempotency_key: "order_123_1",
        context: {
          gp_retry_reservation_state: "reserved",
          gp_payment_retry_idempotency_key: "order_123_1",
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
    ).rejects.toMatchObject({
      status: 409,
      code: "payment_retry_pending",
    })
    expect(createSession).not.toHaveBeenCalled()
  })
})
