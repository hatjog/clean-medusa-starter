/**
 * v1.15.0 Story 5.9 review-fix cyklu 2 — KONTROLA C2-HIGH-1.
 *
 * ## Dlaczego ten plik istnieje obok `stripe-payment-audit-refund.unit.spec.ts`
 *
 * Fake tamtego pliku na zapytanie mostu ZAWSZE zwraca
 * `{ voucher_code: "GP-TEST-…", entitlement_type: "VOUCHER_AMOUNT" }`. Zdanie
 * w jego komentarzu („inaczej producent fail-closuje na braku mostu — słusznie,
 * tylko z powodu luki fake'a, nie zachowania") było twierdzeniem o produkcji,
 * którego nikt nie sprawdził: na ścieżce `payment.captured` most NIE BYŁ
 * wypełniany, więc każdy zwrot takiego zamówienia wywracał całą transakcję
 * webhooka. Fake, który most fabrykuje, jest STRUKTURALNIE niezdolny to
 * zobaczyć — nie da się tego naprawić asercją w tamtym pliku.
 *
 * Ten fake NIE fabrykuje niczego. Trzyma dwie „tabele":
 *   - `entitlement_instance` z RZECZYWISTYM `policy_snapshot` zapisanym przez
 *     produkcyjny INSERT,
 *   - `voucher` z wierszami zapisanymi przez produkcyjny `INSERT INTO voucher`.
 * Most jest czytany z pierwszej, stan kodu z drugiej. Jeżeli producent
 * wystawienia mostu nie zbuduje, kontrola PĘKA — i to jest jej cała wartość.
 *
 * Kontrole:
 *   (1) linia voucherowa wystawiona ŻYWĄ ścieżką `payment.captured` da się
 *       unieważnić przy zwrocie — `voucher.status` schodzi na `refunded`;
 *   (2) kontrola przeciwna: linia NIE-voucher-backed (`CREDIT_PACK`) w TYM
 *       SAMYM zamówieniu przechodzi zwrot bez wołania producenta stanu kodu;
 *   (3) fail-closed zostaje: wiersz voucher-backed BEZ mostu (dane zastane,
 *       DW-15-114) nadal wywraca zwrot — pominięcie byłoby powrotem defektu.
 */
import {
  StripePaymentAuditWorkflow,
} from "../../../workflows/payment/stripe-payment-audit"

// Story 11.2 (ADR-240): producent `entitlement_state_changed` bierze
// `scope.instance_id` WYŁĄCZNIE z GP_INSTANCE_ID; brak = odmowa emisji.
// Fixture podaje instancję jawnie (oś scope uzupełniona, asercje bez zmian).
const PREVIOUS_GP_INSTANCE_ID = process.env.GP_INSTANCE_ID
beforeEach(() => {
  process.env.GP_INSTANCE_ID = "gp-test-instance"
})
afterAll(() => {
  if (PREVIOUS_GP_INSTANCE_ID === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = PREVIOUS_GP_INSTANCE_ID
})

const ORDER = "ord_live_bridge_1"

function capturedPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_captured_lb",
    request_id: "req_captured_lb",
    payment_intent_id: "pi_lb",
    payment_id: "pay_lb",
    order_id: ORDER,
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    ...overrides,
  }
}

function refundPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_refund_lb",
    request_id: "req_refund_lb",
    payment_intent_id: "pi_lb",
    payment_id: "pay_lb",
    order_id: ORDER,
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    refund_id: "re_lb",
    refund_amount: 19900,
    refund_reason: "customer_request",
    ...overrides,
  }
}

type OrderLine = {
  line_item_id: string
  metadata: Record<string, unknown> | null
  line_title: string | null
  seller_id: string | null
  seller_name: string | null
  seller_handle: string | null
}

type EntitlementRow = {
  id: string
  order_id: string
  line_item_id: string | null
  entitlement_type: string
  state: string
  policy_snapshot: Record<string, unknown>
  claim_token: string | null
}

type VoucherRow = { code: string; status: string; value_minor: number }

function voucherLine(id: string): OrderLine {
  return {
    line_item_id: id,
    metadata: {
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      entitlement_policy: { validity_months: 12 },
      amount_minor: 19900,
      currency: "PLN",
    },
    line_title: "Zabieg oczyszczający",
    seller_id: "sel_1",
    seller_name: "Salon Testowy",
    seller_handle: "salon-testowy",
  }
}

function creditPackLine(id: string): OrderLine {
  return {
    line_item_id: id,
    metadata: {
      entitlement_profile_id: "credit-pack-10",
      entitlement_type: "CREDIT_PACK",
      entitlement_policy: { face_value_minor: 10000 },
      amount_minor: 10000,
      currency: "PLN",
    },
    line_title: "Pakiet kredytów",
    seller_id: null,
    seller_name: null,
    seller_handle: null,
  }
}

/**
 * Fake bez ani jednej fabrykacji: każdy odczyt idzie z tego, co produkcyjny kod
 * wcześniej zapisał.
 */
class HonestBridgeFakeClient {
  webhookRows = new Map<string, { envelope: Record<string, unknown> }>()
  entitlementRows = new Map<string, EntitlementRow>()
  voucherRows = new Map<string, VoucherRow>()
  lines: OrderLine[] = []
  released = false

  constructor(lines: OrderLine[] = []) {
    this.lines = lines
  }

  seedEntitlement(row: Partial<EntitlementRow> & { id: string }) {
    this.entitlementRows.set(row.id, {
      order_id: ORDER,
      line_item_id: null,
      entitlement_type: "VOUCHER_SERVICE",
      state: "ACTIVE",
      policy_snapshot: {},
      claim_token: null,
      ...row,
    })
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    const rows = <R,>(list: R[]) => ({
      rows: list as unknown as T[],
      rowCount: list.length,
    })

    if (sql.includes("INSERT INTO webhook_event_processed")) {
      const key = `${params[0]}:stripe`
      if (this.webhookRows.has(key)) return rows([])
      this.webhookRows.set(key, { envelope: JSON.parse(params[2] as string) })
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes("UPDATE webhook_event_processed")) {
      return { rows: [] as T[], rowCount: 1 }
    }

    // ── odczyty linii zamówienia (multi-line path + kontekst sprzedawcy) ────
    if (sql.includes("FROM order_item oi") && sql.includes("line_item_id")) {
      return rows(this.lines)
    }
    if (sql.includes("FROM order_item oi")) {
      // `resolveVoucherLineContext` — bez kolumny `line_item_id`.
      const lineItemId = params[1] as string | undefined
      const match = lineItemId
        ? this.lines.filter((l) => l.line_item_id === lineItemId)
        : this.lines
      return rows(match.slice(0, 1))
    }

    // ── most kod → uprawnienie: CZYTANY Z ZAPISANEGO SNAPSHOTU ──────────────
    if (sql.includes("policy_snapshot->>'voucher_code'")) {
      const row = this.entitlementRows.get(params[0] as string)
      if (!row) return rows([])
      return rows([
        {
          voucher_code:
            (row.policy_snapshot.voucher_code as string | undefined) ?? null,
          entitlement_type: row.entitlement_type,
        },
      ])
    }

    if (sql.includes("FROM voucher WHERE code")) {
      const v = this.voucherRows.get(params[0] as string)
      return v ? rows([{ status: v.status }]) : rows([])
    }
    if (sql.includes("UPDATE voucher SET status")) {
      const v = this.voucherRows.get(params[0] as string)
      const prior = params[3] as string
      if (!v || v.status !== prior) return { rows: [] as T[], rowCount: 0 }
      v.status = params[1] as string
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes("INSERT INTO voucher")) {
      const code = params[0] as string
      if (!this.voucherRows.has(code)) {
        this.voucherRows.set(code, {
          code,
          status: "idle",
          value_minor: params[6] as number,
        })
      }
      return { rows: [] as T[], rowCount: 1 }
    }

    if (sql.includes("SELECT id, state, entitlement_type FROM entitlement_instance")) {
      return rows(
        [...this.entitlementRows.values()]
          .filter((r) => r.order_id === params[0])
          .map((r) => ({
            id: r.id,
            state: r.state,
            entitlement_type: r.entitlement_type,
          }))
      )
    }
    if (sql.includes("SELECT id, line_item_id, claim_token FROM entitlement_instance")) {
      const match = [...this.entitlementRows.values()].find(
        (r) => r.order_id === params[0] && r.line_item_id === null
      )
      return match
        ? rows([
            {
              id: match.id,
              line_item_id: match.line_item_id,
              claim_token: match.claim_token,
            },
          ])
        : rows([])
    }
    if (sql.includes("SELECT id, claim_token FROM entitlement_instance")) {
      const lineItemId = (params[1] as string | undefined) ?? null
      const match = [...this.entitlementRows.values()].find(
        (r) => r.order_id === params[0] && r.line_item_id === lineItemId
      )
      return match
        ? rows([{ id: match.id, claim_token: match.claim_token }])
        : rows([])
    }
    if (sql.includes("INSERT INTO entitlement_instance")) {
      const id = params[0] as string
      this.entitlementRows.set(id, {
        id,
        order_id: params[3] as string,
        line_item_id: (params[4] as string | null) ?? null,
        entitlement_type: params[2] as string,
        state: params[5] as string,
        policy_snapshot: JSON.parse(params[6] as string),
        claim_token: params[8] as string,
      })
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes("UPDATE entitlement_instance")) {
      const row = this.entitlementRows.get(params[0] as string)
      if (!row) return { rows: [] as T[], rowCount: 0 }
      if (sql.includes("AND state NOT IN")) {
        if (["VOIDED", "REFUNDED", "CLOSED"].includes(row.state)) {
          return { rows: [] as T[], rowCount: 0 }
        }
      }
      row.state = params[1] as string
      return sql.includes("RETURNING entitlement_type")
        ? rows([{ entitlement_type: row.entitlement_type }])
        : { rows: [] as T[], rowCount: 1 }
    }

    return rows([])
  }

  release() {
    this.released = true
  }
}

describe("C2-HIGH-1 — zwrot na wierszu wystawionym ŻYWĄ ścieżką payment.captured", () => {
  it("unieważnia kod vouchera wydany przez `payment.captured` (most powstaje przy wystawieniu)", async () => {
    const client = new HonestBridgeFakeClient([voucherLine("line_v")])
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    await workflow.process("payment.captured", capturedPayload())

    // Most REALNIE powstał — snapshot niesie kod, a wiersz `voucher` istnieje.
    const issued = [...client.entitlementRows.values()][0]
    const code = issued.policy_snapshot.voucher_code as string
    expect(code).toMatch(/^BO-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(client.voucherRows.get(code)?.status).toBe("idle")

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual([issued.id])
    expect(
      result.refundRevocation?.code_invalidation_skipped_entitlement_ids
    ).toEqual([])
    expect(client.entitlementRows.get(issued.id)?.state).toBe("REFUNDED")
    // SM-7: kod przestaje być realizowalny w TEJ SAMEJ transakcji.
    expect(client.voucherRows.get(code)?.status).toBe("refunded")
  })

  it("kontrola przeciwna: linia NIE-voucher-backed w tym samym zamówieniu przechodzi zwrot", async () => {
    const client = new HonestBridgeFakeClient([
      voucherLine("line_v"),
      creditPackLine("line_c"),
    ])
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    await workflow.process("payment.captured", capturedPayload())

    const voucherRow = [...client.entitlementRows.values()].find(
      (r) => r.entitlement_type === "VOUCHER_SERVICE"
    )!
    const creditRow = [...client.entitlementRows.values()].find(
      (r) => r.entitlement_type === "CREDIT_PACK"
    )!
    // CREDIT_PACK nie dostaje kodu — nie ma czego unieważniać, więc i nie ma
    // wiersza `voucher`.
    expect(creditRow.policy_snapshot.voucher_code).toBeUndefined()
    expect(client.voucherRows.size).toBe(1)

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual(
      expect.arrayContaining([voucherRow.id, creditRow.id])
    )
    expect(
      result.refundRevocation?.code_invalidation_skipped_entitlement_ids
    ).toEqual([creditRow.id])
    expect(client.entitlementRows.get(creditRow.id)?.state).toBe("REFUNDED")
  })

  it("fail-closed zostaje: wiersz voucher-backed BEZ mostu (dane zastane) wywraca zwrot", async () => {
    const client = new HonestBridgeFakeClient()
    client.seedEntitlement({
      id: "ent_legacy_no_bridge",
      entitlement_type: "VOUCHER_AMOUNT",
      state: "ACTIVE",
      policy_snapshot: {},
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    await expect(
      workflow.process("payment.refunded", refundPayload())
    ).rejects.toThrow(/VoucherCodeBridgeMissingError|most kod/)
    // Rollback jest własnością transakcji PG, nie fake'a — mierzymy to, co
    // fake potrafi zmierzyć: producent NIE zapisał żadnego stanu kodu.
    expect(client.voucherRows.size).toBe(0)
  })
})

describe("C2-INFO-1 — zwrot uprawnienia w PENDING_VENDOR_DECISION daje powód „zwrócony”", () => {
  it("nie jest już przepadkiem: stan REFUNDED, kod `refunded`, nie `withdrawn`", async () => {
    // Do fixa ta gałąź szła `→ VOIDED` („vendor confirms forfeiture"), więc
    // producent zapisywał kod jako `withdrawn`, a kosmetolożka widziała
    // „Wycofany" — prawdę o mechanizmie i nieprawdę o przyczynie: pieniądze
    // WRÓCIŁY do klientki. AC2 żąda powodu ROZRÓŻNIALNEGO „zwrócony".
    const client = new HonestBridgeFakeClient()
    client.seedEntitlement({
      id: "ent_pending_vendor",
      entitlement_type: "VOUCHER_SERVICE",
      state: "PENDING_VENDOR_DECISION",
      policy_snapshot: { voucher_code: "BO-PEND-0001" },
    })
    client.voucherRows.set("BO-PEND-0001", {
      code: "BO-PEND-0001",
      status: "idle",
      value_minor: 19900,
    })
    const workflow = new StripePaymentAuditWorkflow({
      connect: async () => client,
    })

    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.refundRevocation?.revoked_entitlement_ids).toEqual([
      "ent_pending_vendor",
    ])
    expect(client.entitlementRows.get("ent_pending_vendor")?.state).toBe(
      "REFUNDED"
    )
    // KONTROLA, KTÓRA PĘKA po cofnięciu fixa: przed nim było `withdrawn`.
    expect(client.voucherRows.get("BO-PEND-0001")?.status).toBe("refunded")
  })
})
