import {
  computeCheckoutCartHash,
  extractCheckoutIdempotencyKey,
  resolvePaymentIntentForCheckoutIdempotency,
  resolvePaymentSessionForCheckoutIdempotency,
} from "../../../lib/payment/checkout-idempotency"

describe("checkout idempotency", () => {
  it("hashes cart fingerprints deterministically", () => {
    const a = computeCheckoutCartHash({
      cart_id: "cart_1",
      currency_code: "PLN",
      total: 19900,
      item_total: 19000,
      shipping_total: 900,
      tax_total: 0,
    })
    const b = computeCheckoutCartHash({
      tax_total: 0,
      shipping_total: 900,
      item_total: 19000,
      total: 19900,
      currency_code: "PLN",
      cart_id: "cart_1",
    })
    expect(a).toBe(b)
  })

  it("reuses stored PaymentIntent for same UUID and cart hash", async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            idempotency_uuid: "uuid_1",
            idempotency_cart_hash: "hash_1",
            data: { payment_intent: { id: "pi_existing" } },
          }],
        }),
    }

    const result = await resolvePaymentIntentForCheckoutIdempotency(client, {
      payment_session_id: "ps_1",
      idempotency_uuid: "uuid_1",
      cart_hash: "hash_1",
      createIntent: jest.fn(),
      serializeIntent: (x) => x,
      deserializeIntent: (x) => x as { id: string },
    })

    expect(result).toEqual({ reused: true, payment_intent: { id: "pi_existing" } })
  })

  it("extracts Idempotency-Key case-insensitively", () => {
    expect(extractCheckoutIdempotencyKey({ "Idempotency-Key": " uuid_1 " })).toBe(
      "uuid_1"
    )
    expect(extractCheckoutIdempotencyKey({ "idempotency-key": ["uuid_2"] })).toBe(
      "uuid_2"
    )
  })

  it("serializes payment-session creation by checkout UUID and reuses existing session", async () => {
    const existing = { id: "ps_existing" }
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // advisory lock
        .mockResolvedValueOnce({ rows: [existing], rowCount: 1 }) // existing session
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // COMMIT
    }
    const createSession = jest.fn()

    const result = await resolvePaymentSessionForCheckoutIdempotency(client, {
      payment_collection_id: "paycol_1",
      idempotency_uuid: "uuid_1",
      cart_hash: "hash_1",
      createSession,
      getSessionId: (session: { id: string }) => session.id,
    })

    expect(result).toEqual({ reused: true, payment_session: existing })
    expect(createSession).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      ["checkout-payment-session:uuid_1"]
    )
  })

  it("marks a newly-created payment session with checkout idempotency metadata", async () => {
    const created = { id: "ps_new" }
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // advisory lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no existing session
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE session
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // COMMIT
    }

    const result = await resolvePaymentSessionForCheckoutIdempotency(client, {
      payment_collection_id: "paycol_1",
      idempotency_uuid: "uuid_1",
      cart_hash: "hash_1",
      createSession: jest.fn(async () => created),
      getSessionId: (session: { id: string }) => session.id,
    })

    expect(result).toEqual({ reused: false, payment_session: created })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE payment_session"),
      ["ps_new", "uuid_1", "hash_1"]
    )
  })
})
