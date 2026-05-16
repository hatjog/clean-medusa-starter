import {
  MissingNativeStripePayloadFieldError,
  StripePaymentAuditWorkflow,
  buildPaymentAuditEnvelope,
} from "../../../workflows/payment/stripe-payment-audit"

class FakeClient {
  rows = new Map<string, Record<string, unknown>>()
  queries: string[] = []
  released = false
  orderLineMetadata: Record<string, unknown> | null = null

  async query<T = Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []) {
    this.queries.push(sql)
    if (sql.includes("INSERT INTO webhook_event_processed")) {
      const key = `${params[0]}:stripe`
      if (this.rows.has(key)) return { rows: [] as T[], rowCount: 0 }
      this.rows.set(key, { event_id: params[0] })
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes("SELECT id FROM entitlement_instance")) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes("FROM order_item")) {
      return {
        rows: this.orderLineMetadata
          ? ([{ metadata: this.orderLineMetadata }] as T[])
          : ([] as T[]),
        rowCount: this.orderLineMetadata ? 1 : 0,
      }
    }
    if (sql.includes("INSERT INTO entitlement_instance")) {
      this.rows.set(params[0] as string, { id: params[0] })
      return { rows: [] as T[], rowCount: 1 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }

  release() {
    this.released = true
  }
}

function payload() {
  return {
    event_id: "evt_1",
    request_id: "req_1",
    payment_intent_id: "pi_1",
    payment_id: "pay_1",
    order_id: "ord_1",
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    entitlement_profile: {
      profile_id: "voucher-kwotowy-365d",
      entitlement_type: "VOUCHER_AMOUNT",
      policy: { validity_days: 365 },
      currency: "PLN",
      amount_minor: 19900,
    },
  }
}

describe("StripePaymentAuditWorkflow", () => {
  it("builds HG-4-compatible audit envelope", () => {
    expect(buildPaymentAuditEnvelope("payment.failed", {
      event_id: "evt_1",
      request_id: "req_1",
      payment_intent_id: "pi_1",
      payment_method_type: "card",
      processing_country: "PL",
      failure_code: "card_declined: insufficient_funds",
      decline_code: "insufficient_funds",
    })).toMatchObject({
      level: "warn",
      actor: "system",
      scope: "payment_intent:pi_1",
      request_id: "req_1",
      outcome: "failed",
      lifecycle_status: "failed",
      event_type: "payment.failed",
      failure_code: "card_declined",
      decline_code: "insufficient_funds",
    })
  })

  it("persists dedup, issues entitlement once, and emits post-commit audit event", async () => {
    const client = new FakeClient()
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow(
      { connect: async () => client },
      eventBus
    )

    const result = await workflow.process("payment.captured", payload())

    expect(result.deduplicated).toBe(false)
    expect(result.entitlement?.idempotent).toBe(false)
    expect(client.queries).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]))
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "payment_audit.captured" })
    )
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "gp.entitlements.entitlement_issued.v1" })
    )
  })

  it("deduplicates replay before mutation", async () => {
    const client = new FakeClient()
    const workflow = new StripePaymentAuditWorkflow({ connect: async () => client })

    await workflow.process("payment.captured", payload())
    const replay = await workflow.process("payment.captured", payload())

    expect(replay.deduplicated).toBe(true)
  })

  it("resolves entitlement profile from order line metadata when native event is not enriched", async () => {
    const client = new FakeClient()
    client.orderLineMetadata = {
      entitlement_profile_id: "voucher-kwotowy-365d",
      entitlement_type: "VOUCHER_AMOUNT",
      entitlement_policy: { validity_days: 365 },
      currency: "PLN",
      amount_minor: 19900,
    }
    const workflow = new StripePaymentAuditWorkflow({ connect: async () => client })
    const p = payload() as any
    p.entitlement_profile = null

    const result = await workflow.process("payment.captured", p)

    expect(result.entitlement?.idempotent).toBe(false)
    expect(client.queries.some((sql) => sql.includes("FROM order_item"))).toBe(true)
  })

  it("fails loud when native payload omits required fields", async () => {
    const workflow = new StripePaymentAuditWorkflow({ connect: async () => new FakeClient() })

    await expect(
      workflow.process("payment.failed", { event_id: "evt_1" })
    ).rejects.toBeInstanceOf(MissingNativeStripePayloadFieldError)
  })

  it("persists captured audit when entitlement profile is missing", async () => {
    const workflow = new StripePaymentAuditWorkflow({ connect: async () => new FakeClient() })
    const p = payload() as any
    p.entitlement_profile = null

    const result = await workflow.process("payment.captured", p)

    expect(result.deduplicated).toBe(false)
    expect(result.entitlement).toBeUndefined()
  })
})
