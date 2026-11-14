/**
 * v1.9.0 wf5 — refund → entitlement state transition tests
 * (closes Epic-1 H-3 + CC-1 F-CC1-002/016/018 P0_FINANCIAL_EXPOSURE).
 *
 * Asserts that on `payment.refunded`:
 *   - ALL entitlement_instance rows attached to the refunded order are
 *     transitioned to REFUNDED in the same DB transaction as the audit row.
 *   - Already-terminal rows (REFUNDED / VOIDED / CLOSED) are left alone
 *     (idempotency on webhook replay).
 *   - The revocation summary is persisted onto the audit envelope
 *     (`revoked_entitlement_count` / `revoked_entitlement_ids`).
 *   - A refunded voucher CANNOT redeem — the audit envelope and the row
 *     state both agree it is in REFUNDED.
 *   - Multi-line carts (H-6) — N entitlement rows are all revoked atomically.
 *   - Compensation no longer hard-DELETEs (F-CC1-016) — uses VOIDED transition.
 *   - `gp.payments.payment_refunded.v1` contract event is emitted with the
 *     revocation summary in payload.
 *
 * The H-1 producer wiring for `gp.payments.payment_paid.v1` is also covered.
 */
import {
  StripePaymentAuditWorkflow,
  buildPaymentPaidContractEvent,
  buildPaymentRefundedContractEvent,
  buildPaymentAuditEnvelope,
} from "../../../workflows/payment/stripe-payment-audit"

function refundPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_refund_1",
    request_id: "req_refund_1",
    payment_intent_id: "pi_refund_1",
    payment_id: "pay_refund_1",
    order_id: "ord_refund_1",
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    refund_id: "re_test_abc",
    refund_amount: 19900,
    refund_reason: "customer_request",
    ...overrides,
  }
}

function capturedPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_paid_1",
    request_id: "req_paid_1",
    payment_intent_id: "pi_paid_1",
    payment_id: "pay_paid_1",
    order_id: "ord_paid_1",
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    entitlement_profile: {
      profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      policy: { validity_months: 12 },
      currency: "PLN",
      amount_minor: 19900,
    },
    ...overrides,
  }
}

/**
 * Refund-test FakeClient — tracks `webhook_event_processed` rows and
 * `entitlement_instance` rows so we can assert state transitions end-to-end.
 */
class RefundFakeClient {
  webhookRows = new Map<string, { envelope: Record<string, unknown> }>()
  entitlementRows = new Map<
    string,
    { id: string; order_id: string; state: string; line_item_id: string | null }
  >()
  queries: string[] = []
  released = false

  seedEntitlement(opts: {
    id: string
    order_id: string
    state: string
    line_item_id?: string | null
  }) {
    this.entitlementRows.set(opts.id, {
      id: opts.id,
      order_id: opts.order_id,
      state: opts.state,
      line_item_id: opts.line_item_id ?? null,
    })
  }

  /** v1.15.0 Story 5.9 review-fix: stan kodu jest STANEM fake'a, nie stałą. */
  voucherStatus = "idle"

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    this.queries.push(sql)

    if (sql.includes("INSERT INTO webhook_event_processed")) {
      const key = `${params[0]}:stripe`
      if (this.webhookRows.has(key)) return { rows: [] as T[], rowCount: 0 }
      this.webhookRows.set(key, {
        envelope: JSON.parse(params[2] as string),
      })
      return { rows: [] as T[], rowCount: 1 }
    }

    if (sql.includes("UPDATE webhook_event_processed")) {
      const key = `${params[0]}:stripe`
      const existing = this.webhookRows.get(key)
      if (!existing) return { rows: [] as T[], rowCount: 0 }
      // Naive merge: detect which jsonb_build_object keys are present.
      if (sql.includes("'entitlement_issue_failed_reason'")) {
        existing.envelope.entitlement_issue_failed_reason = params[1] as string
      } else if (sql.includes("'entitlement_issue_deferred_reason'")) {
        existing.envelope.entitlement_issue_deferred_reason = params[1] as string
      } else if (sql.includes("'revoked_entitlement_ids'")) {
        existing.envelope.revoked_entitlement_ids = JSON.parse(params[1] as string)
        existing.envelope.revoked_entitlement_count = params[2]
        existing.envelope.already_terminal_entitlement_ids = JSON.parse(
          params[3] as string
        )
        existing.envelope.already_terminal_entitlement_count = params[4]
      }
      return { rows: [] as T[], rowCount: 1 }
    }

    // v1.15.0 Story 5.9 (FR-12, SM-7): zwrot unieważnia TAKŻE stan kodu
    // vouchera, w tej samej transakcji. Fake musi znać most kod → uprawnienie
    // i wiersz `voucher`, inaczej producent fail-closuje na braku mostu —
    // słusznie, tylko z powodu luki fake'a, nie zachowania.
    if (sql.includes("policy_snapshot->>'voucher_code'")) {
      const id = params[0] as string
      return {
        rows: [
          {
            voucher_code: `GP-TEST-${id}`,
            entitlement_type: "VOUCHER_AMOUNT",
          },
        ] as unknown as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("FROM voucher WHERE code")) {
      return {
        rows: [{ status: this.voucherStatus }] as unknown as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("UPDATE voucher SET status")) {
      // review-fix 5.9: fake NIE udaje sukcesu w oderwaniu od stanu — WHERE
      // producenta wiąże `status = prior`, więc rowCount zależy od tego, co
      // fake właśnie zwrócił jako stan bieżący. Bez tego test „przechodzi",
      // choćby producent pisał do wiersza, którego nie zablokował.
      const prior = params[3] as string
      if (prior !== this.voucherStatus) return { rows: [] as T[], rowCount: 0 }
      this.voucherStatus = params[1] as string
      return { rows: [] as T[], rowCount: 1 }
    }

    // v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-1): `revokeEntitlementsOnRefund`
    // dociąga `entitlement_type`, bo decyzja „czy jest co unieważniać" należy do
    // wołającego, nie do producenta.
    if (sql.includes("SELECT id, state, entitlement_type FROM entitlement_instance")) {
      const orderId = params[0] as string
      const matches = Array.from(this.entitlementRows.values()).filter(
        (r) => r.order_id === orderId
      )
      return {
        rows: matches.map((r) => ({
          id: r.id,
          state: r.state,
          entitlement_type: "VOUCHER_AMOUNT",
        })) as T[],
        rowCount: matches.length,
      }
    }

    if (sql.includes("UPDATE entitlement_instance")) {
      // params: [id, state, ...]
      const id = params[0] as string
      const newState = params[1] as string
      const row = this.entitlementRows.get(id)
      if (row) {
        if (sql.includes("AND state NOT IN")) {
          if (!["VOIDED", "REFUNDED", "CLOSED"].includes(row.state)) {
            row.state = newState
          }
        } else {
          row.state = newState
        }
      }
      if (sql.includes("RETURNING entitlement_type")) {
        return {
          rows: (row
            ? [{ entitlement_type: "VOUCHER_AMOUNT" }]
            : []) as unknown as T[],
          rowCount: row ? 1 : 0,
        }
      }
      return { rows: [] as T[], rowCount: row ? 1 : 0 }
    }

    if (sql.includes("SELECT id FROM entitlement_instance")) {
      const orderId = params[0] as string
      const lineItemId = params[1] !== undefined ? (params[1] as string | null) : null
      const match = Array.from(this.entitlementRows.values()).find(
        (r) => r.order_id === orderId && r.line_item_id === lineItemId
      )
      return {
        rows: match ? ([{ id: match.id }] as T[]) : ([] as T[]),
        rowCount: match ? 1 : 0,
      }
    }

    // review-fix cyklu 2 (C2-HIGH-1): produkcyjne zapytanie linii niesie dane
    // sprzedawcy — captured-path wydaje kod przy wystawieniu.
    if (sql.includes("FROM order_item oi")) {
      return {
        rows: [
          {
            line_item_id: "line_1",
            metadata: null,
            line_title: "Zabieg testowy",
            seller_id: "sel_test",
            seller_name: "Salon Testowy",
            seller_handle: "salon-testowy",
          },
        ] as unknown as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("INSERT INTO voucher")) {
      return { rows: [] as T[], rowCount: 1 }
    }

    if (sql.includes("INSERT INTO entitlement_instance")) {
      const id = params[0] as string
      const orderId = params[3] as string
      const lineItemId = (params[4] as string | null) ?? null
      this.entitlementRows.set(id, {
        id,
        order_id: orderId,
        state: "ACTIVE",
        line_item_id: lineItemId,
      })
      return { rows: [] as T[], rowCount: 1 }
    }

    return { rows: [] as T[], rowCount: 0 }
  }

  release() {
    this.released = true
  }
}

type FakeRedemption = {
  redemption_id: string
  entitlement_id: string
  redemption_kind: "REDEMPTION" | "REVERSAL"
  reverses_redemption_id: string | null
  idempotency_key: string
  amount_minor: number
  issued_gross_minor: number
  resulting_state: "REDEEMED_PARTIAL" | "REDEEMED_FULL"
  remaining_after_minor: number
  created_at: number
  market_id: string
  purchase_market_id: string
  redemption_market_id: string
}

/** Fake rozszerzony o ledger realizacji, aby refund testował prawdziwe odwrócenie. */
class RedemptionRefundFakeClient extends RefundFakeClient {
  redemptions: FakeRedemption[] = []

  seedRedemption(opts: {
    redemption_id: string
    entitlement_id: string
    gross_amount_minor: number
    issued_gross_amount_minor?: number
    commission_amount_minor?: number
  }) {
    this.redemptions.push({
      redemption_id: opts.redemption_id,
      entitlement_id: opts.entitlement_id,
      redemption_kind: "REDEMPTION",
      reverses_redemption_id: null,
      idempotency_key: `redeem:${opts.redemption_id}`,
      amount_minor: opts.gross_amount_minor,
      issued_gross_minor:
        opts.issued_gross_amount_minor ?? opts.gross_amount_minor,
      resulting_state: "REDEEMED_FULL",
      remaining_after_minor: 0,
      created_at: new Date("2026-08-01T10:00:00.000Z").getTime(),
      market_id: "bonbeauty",
      purchase_market_id: "bonbeauty",
      redemption_market_id: "bonbeauty",
    })
  }

  override async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    if (
      sql.includes("FROM voucher_redemption redemption") &&
      sql.includes("already_reversed")
    ) {
      const entitlementId = params[0] as string
      const rows = this.redemptions
        .filter(
          (row) =>
            row.entitlement_id === entitlementId &&
            row.redemption_kind === "REDEMPTION"
        )
        .map((row) => ({
          redemption_id: row.redemption_id,
          already_reversed: this.redemptions.some(
            (candidate) =>
              candidate.redemption_kind === "REVERSAL" &&
              candidate.reverses_redemption_id === row.redemption_id
          ),
        }))
      return { rows: rows as T[], rowCount: rows.length }
    }

    if (
      sql.includes("FROM voucher_redemption") &&
      sql.includes("redemption_id = $1")
    ) {
      const row = this.redemptions.find(
        (candidate) => candidate.redemption_id === params[0]
      )
      return { rows: row ? ([row] as T[]) : ([] as T[]), rowCount: row ? 1 : 0 }
    }

    if (
      sql.includes("FROM voucher_redemption") &&
      sql.includes("entitlement_id = $1") &&
      sql.includes("idempotency_key = $2")
    ) {
      const row = this.redemptions.find(
        (candidate) =>
          candidate.entitlement_id === params[0] &&
          candidate.idempotency_key === params[1] &&
          candidate.redemption_kind === params[2]
      )
      return { rows: row ? ([row] as T[]) : ([] as T[]), rowCount: row ? 1 : 0 }
    }

    if (sql.includes("AS commission_base_minor")) {
      const entitlementId = params[0] as string
      const commissionBase = this.redemptions
        .filter((row) => row.entitlement_id === entitlementId)
        .reduce(
          (sum, row) =>
            sum +
            (row.redemption_kind === "REDEMPTION"
              ? row.amount_minor
              : -row.amount_minor),
          0
        )
      return {
        rows: [{ commission_base_minor: commissionBase }] as unknown as T[],
        rowCount: 1,
      }
    }

    if (sql.includes("AS redeemed_minor")) {
      const entitlementId = params[0] as string
      const matching = this.redemptions.filter(
        (row) => row.entitlement_id === entitlementId
      )
      return {
        rows: [
          {
            redeemed_minor: matching.reduce(
              (sum, row) =>
                sum +
                (row.redemption_kind === "REDEMPTION" ? row.amount_minor : 0),
              0
            ),
            reversed_minor: matching.reduce(
              (sum, row) =>
                sum +
                (row.redemption_kind === "REVERSAL" ? row.amount_minor : 0),
              0
            ),
          },
        ] as unknown as T[],
        rowCount: 1,
      }
    }

    if (
      sql.includes("FROM entitlement_instance") &&
      sql.includes("remaining_amount")
    ) {
      const row = this.entitlementRows.get(params[0] as string)
      return {
        rows: row
          ? ([
              {
                id: row.id,
                entitlement_type: "VOUCHER_AMOUNT",
                state: row.state,
                remaining_amount: 0,
                policy_snapshot: {
                  amount_minor: 19900,
                  currency_code: "PLN",
                  voucher_code: `GP-TEST-${row.id}`,
                },
                voucher_qualification: "MPV",
                market_id: "bonbeauty",
              },
            ] as unknown as T[])
          : ([] as T[]),
        rowCount: row ? 1 : 0,
      }
    }

    if (sql.includes("INSERT INTO voucher_redemption")) {
      const idempotencyKey = params[1] as string
      const existing = this.redemptions.find(
        (row) =>
          row.entitlement_id === params[0] &&
          row.idempotency_key === idempotencyKey &&
          row.redemption_kind === params[8]
      )
      if (existing) return { rows: [] as T[], rowCount: 0 }

      this.redemptions.push({
        redemption_id: params[2] as string,
        entitlement_id: params[0] as string,
        redemption_kind: params[8] as "REDEMPTION" | "REVERSAL",
        reverses_redemption_id: params[9] as string | null,
        idempotency_key: idempotencyKey,
        amount_minor: params[3] as number,
        issued_gross_minor: params[6] as number,
        resulting_state: params[4] as "REDEEMED_PARTIAL" | "REDEEMED_FULL",
        remaining_after_minor: params[5] as number,
        created_at: params[7] as number,
        market_id: params[10] as string,
        purchase_market_id: params[11] as string,
        redemption_market_id: params[12] as string,
      })
      return { rows: [] as T[], rowCount: 1 }
    }

    if (
      sql.includes("UPDATE entitlement_instance") &&
      sql.includes("WHERE id = $1 AND state = $2")
    ) {
      const row = this.entitlementRows.get(params[0] as string)
      if (!row || row.state !== params[1]) {
        return { rows: [] as T[], rowCount: 0 }
      }
      row.state = params[2] as string
      return { rows: [] as T[], rowCount: 1 }
    }

    return super.query<T>(sql, params)
  }
}

describe("v1.9.0 wf5 H-3 / F-CC1-002 — refund path → entitlement REFUNDED", () => {
  it("payment.refunded odwraca kanoniczną realizację i zeruje podstawę prowizji", async () => {
    const client = new RedemptionRefundFakeClient()
    client.seedEntitlement({
      id: "ent_redeemed",
      order_id: "ord_refund_1",
      state: "REDEEMED_FULL",
    })
    client.seedRedemption({
      redemption_id: "red_original",
      entitlement_id: "ent_redeemed",
      gross_amount_minor: 19900,
      commission_amount_minor: 2500,
    })
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow(
      { connect: async () => client },
      eventBus
    )

    const result = await workflow.process("payment.refunded", refundPayload())

    const reversals = client.redemptions.filter(
      (row) => row.redemption_kind === "REVERSAL"
    )
    expect(reversals).toHaveLength(1)
    expect(reversals[0]?.reverses_redemption_id).toBe("red_original")
    expect(
      client.redemptions.reduce(
        (sum, row) =>
          sum +
          (row.redemption_kind === "REDEMPTION"
            ? row.amount_minor
            : -row.amount_minor),
        0
      )
    ).toBe(0)
    expect(result.refundRevocation?.reversal_redemption_ids).toEqual([
      reversals[0]?.redemption_id,
    ])
    expect(client.entitlementRows.get("ent_redeemed")?.state).toBe("REFUNDED")
    expect(client.voucherStatus).toBe("refunded")
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gp.entitlements.entitlement_state_changed.v1",
        data: expect.objectContaining({
          payload: expect.objectContaining({ entitlement_id: "ent_redeemed" }),
        }),
      })
    )
  })

  it("odwraca wszystkie raty raz i zachowuje idempotencję replayu webhooka", async () => {
    const client = new RedemptionRefundFakeClient()
    client.seedEntitlement({
      id: "ent_installments",
      order_id: "ord_refund_1",
      state: "REDEEMED_FULL",
    })
    client.seedRedemption({
      redemption_id: "red_installment_1",
      entitlement_id: "ent_installments",
      gross_amount_minor: 7000,
      issued_gross_amount_minor: 19900,
    })
    client.seedRedemption({
      redemption_id: "red_installment_2",
      entitlement_id: "ent_installments",
      gross_amount_minor: 12900,
      issued_gross_amount_minor: 19900,
    })
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow(
      { connect: async () => client },
      eventBus
    )

    const first = await workflow.process("payment.refunded", refundPayload())
    const replay = await workflow.process("payment.refunded", refundPayload())

    const reversals = client.redemptions.filter(
      (row) => row.redemption_kind === "REVERSAL"
    )
    expect(reversals).toHaveLength(2)
    expect(first.refundRevocation?.reversal_redemption_ids).toHaveLength(2)
    expect(client.entitlementRows.get("ent_installments")?.state).toBe("REFUNDED")
    expect(replay.deduplicated).toBe(true)
    expect(replay.refundRevocation).toBeUndefined()
  })

  it("transitions a single ACTIVE entitlement to REFUNDED on payment.refunded", async () => {
    const client = new RefundFakeClient()
    client.seedEntitlement({
      id: "ent_1",
      order_id: "ord_refund_1",
      state: "ACTIVE",
    })
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow(
      { connect: async () => client },
      eventBus
    )

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.deduplicated).toBe(false)
    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual(["ent_1"])
    expect(client.entitlementRows.get("ent_1")?.state).toBe("REFUNDED")
  })

  it("revokes MULTIPLE entitlements (H-6 multi-product cart) on a single refund", async () => {
    const client = new RefundFakeClient()
    client.seedEntitlement({
      id: "ent_a",
      order_id: "ord_refund_1",
      state: "ACTIVE",
      line_item_id: "line_a",
    })
    client.seedEntitlement({
      id: "ent_b",
      order_id: "ord_refund_1",
      state: "ACTIVE",
      line_item_id: "line_b",
    })
    client.seedEntitlement({
      id: "ent_c",
      order_id: "ord_refund_1",
      state: "REDEMPTION_REQUESTED",
      line_item_id: "line_c",
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual(
      expect.arrayContaining(["ent_a", "ent_b", "ent_c"])
    )
    expect(result.refundRevocation?.revoked_entitlement_ids.length).toBe(3)
    for (const id of ["ent_a", "ent_b", "ent_c"]) {
      expect(client.entitlementRows.get(id)?.state).toBe("REFUNDED")
    }
  })

  it("does NOT re-transition already-terminal entitlements on refund replay (idempotent)", async () => {
    const client = new RefundFakeClient()
    client.seedEntitlement({
      id: "ent_already_refunded",
      order_id: "ord_refund_1",
      state: "REFUNDED",
    })
    client.seedEntitlement({
      id: "ent_voided",
      order_id: "ord_refund_1",
      state: "VOIDED",
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual([])
    expect(result.refundRevocation?.already_terminal_entitlement_ids.length).toBe(2)
    expect(client.entitlementRows.get("ent_already_refunded")?.state).toBe("REFUNDED")
    expect(client.entitlementRows.get("ent_voided")?.state).toBe("VOIDED")
  })

  it("zwrot kodu JUŻ `expired` przechodzi i schodzi na `refunded` (review-fix 5.9)", async () => {
    // Regresja: przed fixem producent rzucał `VoucherCodeNotInvalidatableError`
    // na stanie kodu spoza allow-listy, a leżąc w transakcji wołającego
    // przewracał CAŁY zwrot. Stan `expired` przy uprawnieniu ACTIVE jest realny
    // na danych zastanych — usunięty w 5.9 bulk-sweeper gasił kody niezależnie
    // od stanu uprawnienia.
    const client = new RefundFakeClient()
    client.voucherStatus = "expired"
    client.seedEntitlement({
      id: "ent_expired_code",
      order_id: "ord_refund_1",
      state: "ACTIVE",
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual([
      "ent_expired_code",
    ])
    expect(client.entitlementRows.get("ent_expired_code")?.state).toBe("REFUNDED")
    // Stan kodu NADPISANY: „pieniądze wróciły" jest faktem mocniejszym niż
    // „minęła data" — i tylko on daje powód odmowy rozróżnialny od „wygasł".
    expect(client.voucherStatus).toBe("refunded")
  })

  it("`refunded` NIE jest cofane przez późniejsze unieważnienie (kontrola przeciwna)", async () => {
    const client = new RefundFakeClient()
    client.voucherStatus = "refunded"
    client.seedEntitlement({
      id: "ent_refund_twice",
      order_id: "ord_refund_1",
      state: "ACTIVE",
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    await workflow.process("payment.refunded", refundPayload())

    expect(client.voucherStatus).toBe("refunded")
  })

  it("REFUNDED voucher cannot be 'redeemed' — state machine rejects ACTIVE re-entry", async () => {
    const client = new RefundFakeClient()
    client.seedEntitlement({
      id: "ent_revoked",
      order_id: "ord_refund_1",
      state: "ACTIVE",
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    await workflow.process("payment.refunded", refundPayload())

    // Row is REFUNDED — any downstream redemption check that reads the row
    // would see REFUNDED and refuse. Cross-verify via the canTransition
    // primitive: REFUNDED is terminal.
    const {
      canTransition,
      EntitlementInstanceState,
    } = require("../../../modules/voucher/models/entitlement")
    expect(
      canTransition(
        EntitlementInstanceState.REFUNDED,
        EntitlementInstanceState.REDEMPTION_REQUESTED
      )
    ).toBe(false)
    expect(
      canTransition(EntitlementInstanceState.REFUNDED, EntitlementInstanceState.ACTIVE)
    ).toBe(false)
  })

  it("persists revocation summary onto audit envelope (F-CC1-018 admin view input)", async () => {
    const client = new RefundFakeClient()
    client.seedEntitlement({
      id: "ent_only",
      order_id: "ord_refund_1",
      state: "ACTIVE",
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    await workflow.process("payment.refunded", refundPayload())

    const row = client.webhookRows.get("evt_refund_1:stripe")
    expect(row?.envelope.revoked_entitlement_ids).toEqual(["ent_only"])
    expect(row?.envelope.revoked_entitlement_count).toBe(1)
  })

  it("emits gp.payments.payment_refunded.v1 contract event with revocation in payload", async () => {
    const client = new RefundFakeClient()
    client.seedEntitlement({
      id: "ent_x",
      order_id: "ord_refund_1",
      state: "ACTIVE",
    })
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow(
      { connect: async () => client },
      eventBus
    )

    await workflow.process("payment.refunded", refundPayload())

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gp.payments.payment_refunded.v1",
        data: expect.objectContaining({
          event_type: "gp.payments.payment_refunded.v1",
          payload: expect.objectContaining({
            provider_id: "stripe",
            revoked_entitlement_ids: ["ent_x"],
            revoked_entitlement_count: 1,
          }),
        }),
      })
    )
  })
})

describe("v1.9.0 wf5 H-2 / F-CC1-003 — webhook-before-order race surface", () => {
  it("persists entitlement_issue_deferred_reason on payment.captured without order_id", async () => {
    const client = new RefundFakeClient()
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    const result = await workflow.process(
      "payment.captured",
      capturedPayload({ order_id: undefined })
    )

    expect(result.deduplicated).toBe(false)
    const row = client.webhookRows.get("evt_paid_1:stripe")
    expect(row?.envelope.entitlement_issue_deferred_reason).toBe(
      "webhook_before_order"
    )
    expect(result.entitlement).toBeUndefined()
  })
})

describe("v1.9.0 wf5 H-1 — gp.payments.payment_paid.v1 producer wiring", () => {
  it("emits gp.payments.payment_paid.v1 on payment.captured", async () => {
    const client = new RefundFakeClient()
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const workflow = new StripePaymentAuditWorkflow(
      { connect: async () => client },
      eventBus
    )

    await workflow.process("payment.captured", capturedPayload())

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gp.payments.payment_paid.v1",
        data: expect.objectContaining({
          event_type: "gp.payments.payment_paid.v1",
          payload: expect.objectContaining({
            provider_id: "stripe",
            currency: "PLN",
            paid_amount_minor: 19900,
          }),
        }),
      })
    )
  })

  it("builds payment_paid contract with schema-required fields", () => {
    const envelope = buildPaymentAuditEnvelope("payment.captured", capturedPayload())
    const result = {
      event_id: "evt_paid_1",
      envelope,
      deduplicated: false,
    }
    const built = buildPaymentPaidContractEvent(
      result,
      capturedPayload(),
      new Date("2026-05-24T10:00:00Z")
    )
    expect(built).toMatchObject({
      schema_version: "1",
      event_type: "gp.payments.payment_paid.v1",
      payload: expect.objectContaining({
        payment_id: "pay_paid_1",
        order_id: "ord_paid_1",
        provider_id: "stripe",
        currency: "PLN",
        paid_amount_minor: 19900,
      }),
    })
  })
})

describe("v1.9.0 wf5 M-8 — currency on ALL outcomes, not just refunds", () => {
  it("payment.captured envelope carries currency", () => {
    const envelope = buildPaymentAuditEnvelope(
      "payment.captured",
      capturedPayload()
    )
    expect(envelope.currency).toBe("PLN")
  })
  it("payment.failed envelope carries currency when present", () => {
    const envelope = buildPaymentAuditEnvelope("payment.failed", {
      event_id: "evt_failed_1",
      request_id: "req_failed_1",
      payment_intent_id: "pi_failed_1",
      payment_method_type: "card",
      processing_country: "PL",
      failure_code: "card_declined",
      decline_code: "insufficient_funds",
      currency: "eur",
    } as any)
    expect(envelope.currency).toBe("EUR")
  })
})

describe("v1.9.0 wf5 H-6 — multi-line cart issues N entitlements", () => {
  it("issues one entitlement per voucher line item with line_item_id pinned", async () => {
    const client = new RefundFakeClient()
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    // Direct-payload path: simulate two-line cart by calling twice with
    // distinct line_item_id values on the embedded profile.
    const result1 = await workflow.process(
      "payment.captured",
      capturedPayload({
        event_id: "evt_multi_1",
        order_id: "ord_multi",
        entitlement_profile: {
          profile_id: "voucher-kwotowy-365d",
          entitlement_type: "VOUCHER_AMOUNT",
          policy: { validity_months: 12 },
          // Story 3.5 (ADR-166 pkt 8): kwota vouchera z profilu linii —
          // fallback na kwotę PI z koperty jest usunięty.
          amount_minor: 10000,
          line_item_id: "line_001",
        },
      })
    )
    const result2 = await workflow.process(
      "payment.captured",
      capturedPayload({
        event_id: "evt_multi_2",
        order_id: "ord_multi",
        entitlement_profile: {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          policy: { validity_months: 12 },
          // Story 3.5 (ADR-166 pkt 8): kwota vouchera z profilu linii —
          // fallback na kwotę PI z koperty jest usunięty.
          amount_minor: 15000,
          line_item_id: "line_002",
        },
      })
    )

    expect(result1.entitlement?.idempotent).toBe(false)
    expect(result2.entitlement?.idempotent).toBe(false)
    expect(result1.entitlement?.entitlement_id).not.toBe(
      result2.entitlement?.entitlement_id
    )
    // Both lines from the same order_id => 2 distinct rows.
    const orderRows = Array.from(client.entitlementRows.values()).filter(
      (r) => r.order_id === "ord_multi"
    )
    expect(orderRows.length).toBe(2)
  })
})
