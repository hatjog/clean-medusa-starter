import {
  MissingNativeStripePayloadFieldError,
  reconcileManualRefund,
  StripePaymentAuditWorkflow,
  buildPaymentAuditEnvelope,
} from "../../../workflows/payment/stripe-payment-audit"

function refundPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_ref_1",
    request_id: "req_ref_1",
    payment_intent_id: "pi_1",
    payment_id: "pay_1",
    order_id: "ord_1",
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    refund_id: "re_abc123",
    refund_amount: 9900,
    refund_reason: "customer_request",
    ...overrides,
  }
}

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

describe("payment.refunded branch (AC1, AC2, AC3)", () => {
  it("builds audit envelope with refund fields — outcome=refunded, lifecycle_status=refunded (AC2)", () => {
    const envelope = buildPaymentAuditEnvelope("payment.refunded", {
      event_id: "evt_ref_1",
      request_id: "req_ref_1",
      payment_intent_id: "pi_1",
      payment_method_type: "card",
      processing_country: "PL",
      currency: "pln",
      refund_id: "re_abc123",
      refund_amount: 9900,
      refund_reason: "customer_request",
    })
    expect(envelope).toMatchObject({
      level: "info",
      actor: "system",
      scope: "payment_intent:pi_1",
      request_id: "req_ref_1",
      outcome: "refunded",
      lifecycle_status: "refunded",
      event_type: "payment.refunded",
      // C6: real currency code (uppercased), NOT a market id
      currency: "PLN",
      refund_id: "re_abc123",
      refund_amount: 9900,
      refund_reason: "customer_request",
    })
  })

  it("defaults refund_reason to 'unspecified' when absent — no silent omission (AC2)", () => {
    const envelope = buildPaymentAuditEnvelope("payment.refunded", {
      event_id: "evt_ref_2",
      request_id: "req_ref_2",
      payment_intent_id: "pi_2",
      payment_method_type: "card",
      processing_country: "PL",
    })
    expect(envelope.refund_reason).toBe("unspecified")
  })

  it("persists refund dedup row and emits audit_refunded event — replay returns deduplicated=true (AC3)", async () => {
    const client = new FakeClient()
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow({ connect: async () => client }, eventBus)

    const first = await workflow.process("payment.refunded", refundPayload())
    expect(first.deduplicated).toBe(false)
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "payment_audit.refunded" })
    )

    const replay = await workflow.process("payment.refunded", refundPayload())
    expect(replay.deduplicated).toBe(true)
  })

  it("two distinct partial refunds create two separate dedup rows (AC3)", async () => {
    const client = new FakeClient()
    const workflow = new StripePaymentAuditWorkflow({ connect: async () => client })

    const first = await workflow.process(
      "payment.refunded",
      refundPayload({ event_id: "evt_partial_1", refund_amount: 5000 })
    )
    const second = await workflow.process(
      "payment.refunded",
      refundPayload({ event_id: "evt_partial_2", refund_amount: 4900 })
    )

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(false)
    expect(client.rows.size).toBe(2)
  })

  it("does NOT default refund currency — only present when supplied (C6)", () => {
    const noCurrency = buildPaymentAuditEnvelope("payment.refunded", {
      event_id: "evt_ref_nc",
      request_id: "req_ref_nc",
      payment_intent_id: "pi_nc",
      payment_method_type: "card",
      processing_country: "PL",
      refund_amount: 9900,
    })
    // Better an absent currency (admin renders fallback) than a wrong one
    // (e.g. market_id rendered as currency → RangeError).
    expect(noCurrency.currency).toBeUndefined()
  })

  it("envelope shape is HG-4 backwards compatible — same field names as captured/failed (AC2)", () => {
    const refundEnv = buildPaymentAuditEnvelope("payment.refunded", {
      event_id: "evt_ref_3",
      request_id: "req_ref_3",
      payment_intent_id: "pi_3",
      payment_method_type: "card",
      processing_country: "PL",
      refund_amount: 19900,
      refund_reason: null,
    })
    const capturedEnv = buildPaymentAuditEnvelope("payment.captured", {
      event_id: "evt_cap_1",
      request_id: "req_cap_1",
      payment_intent_id: "pi_3",
      payment_method_type: "card",
      processing_country: "PL",
    })
    const hg4Fields = ["level", "actor", "scope", "request_id", "outcome", "lifecycle_status", "event_type", "timestamp"]
    for (const field of hg4Fields) {
      expect(refundEnv).toHaveProperty(field)
      expect(capturedEnv).toHaveProperty(field)
    }
  })
})

describe("reconcileManualRefund — reconcile-only (AC1/AC3, C1/C2/C3/C5)", () => {
  const base = {
    eventType: "payment.refunded" as const,
    deduplicated: false,
    payment_id: "pay_1",
    payment_intent_id: "pi_1",
    refund_id: "re_abc123",
    refund_amount: 9900,
    refund_reason: "customer_request",
  }

  function fakeLogger() {
    return {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
  }

  it("AC1/C1: reconcile-only — never creates a provider-side refund (no refundPaymentWorkflow)", () => {
    // The function has no container/provider dependency at all: a manual Stripe
    // refund is the source of truth. Reconcile just records the audit decision.
    const logger = fakeLogger()
    const out = reconcileManualRefund(base, logger)
    expect(out).toMatchObject({
      payment_id: "pay_1",
      refund_id: "re_abc123",
      refund_amount: 9900,
      reconciled: true,
      skipped: false,
      degraded: false,
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("reconcile-only")
    )
  })

  it("skips non-refund events explicitly (no silent no-op)", () => {
    const out = reconcileManualRefund({ ...base, eventType: "payment.captured" })
    expect(out).toMatchObject({
      reconciled: false,
      skipped: true,
      skipReason: "not-a-refund-event",
    })
  })

  it("C2/AC3: replay (deduplicated) does NOT reconcile a second time", () => {
    const logger = fakeLogger()
    const out = reconcileManualRefund({ ...base, deduplicated: true }, logger)
    expect(out).toMatchObject({
      reconciled: false,
      skipped: true,
      skipReason: "replay-deduplicated",
    })
    // explicit skip log, not a silent pass
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped (replay)")
    )
  })

  it("C3/AC2: missing refund_id/amount is surfaced as a loud warn — never silent", () => {
    const logger = fakeLogger()
    const out = reconcileManualRefund(
      { ...base, refund_id: null, refund_amount: null },
      logger
    )
    expect(out.reconciled).toBe(true)
    expect(out.degraded).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reconcile degraded")
    )
    expect(logger.info).not.toHaveBeenCalled()
  })
})
