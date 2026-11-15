/**
 * v1.15.0 Story 5.9 review-fix cyklu 3 — KONTROLE dla REG-HIGH-2, REG-MEDIUM-1,
 * REG-LOW-1 i COR-LOW-1.
 *
 * ## Co ten plik mierzy, czego nie mierzył żaden istniejący
 *
 * Cykl 2 dołożył na ścieżce `payment.captured` fail-loud na braku danych salonu
 * (`issueVoucherCodeWithinTx`). Fake w
 * `stripe-payment-audit-refund-live-bridge.unit.spec.ts` podaje dla każdej linii
 * KOMPLET pól `seller_*`, więc jest strukturalnie niezdolny zobaczyć, co się
 * dzieje, gdy ich NIE MA — a to jest realny stan katalogu (produkt bez aktywnego
 * `product_product_seller_seller`, sprzedawca bez `handle`). Ten plik podaje
 * linie z brakami i pyta, co robi wołający.
 *
 * KAŻDA kontrola tutaj PĘKA po cofnięciu odpowiadającej jej poprawki:
 *   - bez rodziny `VoucherIssuanceBlockedError` i jej obsługi u wołającego
 *     `workflow.process` RZUCA zamiast utrwalić powód (kontrole 1, 2, 4),
 *   - bez kontroli wyprzedzającej INSERT powstaje wiersz uprawnienia BEZ kodu
 *     (kontrola 3 — to jest ta, na której SM-7 by urósł),
 *   - bez `LIMIT 2` w `resolveVoucherLineContext` kod dostaje sprzedawcę
 *     PIERWSZEJ chronologicznie linii zamiast odmowy (kontrola 5),
 *   - bez przepisania liczników do koperty pozostają one wyłącznie w wartości
 *     zwracanej (kontrole 6, 7).
 */
import { StripePaymentAuditWorkflow } from "../../../workflows/payment/stripe-payment-audit"
import { handleOwedUnitBarrierSql } from "./owed-unit-barrier-fake"

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

const ORDER = "ord_blocked_1"

function capturedPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_captured_blocked",
    request_id: "req_captured_blocked",
    payment_intent_id: "pi_blocked",
    payment_id: "pay_blocked",
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
    ...capturedPayload(),
    event_id: "evt_refund_blocked",
    request_id: "req_refund_blocked",
    refund_id: "re_blocked",
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

function voucherLine(id: string, seller: Partial<OrderLine> = {}): OrderLine {
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
    ...seller,
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

/** Fake bez fabrykacji — każdy odczyt idzie z tego, co kod produkcyjny zapisał. */
class BlockedIssuanceFakeClient {
  webhookRows = new Map<string, { envelope: Record<string, unknown> }>()
  entitlementRows = new Map<string, EntitlementRow>()
  voucherRows = new Map<string, VoucherRow>()
  lines: OrderLine[] = []

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

    // Story 3.4 (DW-15-318): wspólna bariera skutku na trasie natywnej.
    const owedUnitBarrier = handleOwedUnitBarrierSql(this, sql, params)
    if (owedUnitBarrier) return owedUnitBarrier as unknown as { rows: T[]; rowCount: number }
    if (sql.includes("INSERT INTO webhook_event_processed")) {
      const key = `${params[0]}:stripe`
      if (this.webhookRows.has(key)) return rows([])
      this.webhookRows.set(key, { envelope: JSON.parse(params[2] as string) })
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes("UPDATE webhook_event_processed")) {
      // Utrwalenie kluczy koperty na wierszu dedupe — sklejamy JSON tak, jak
      // robi to `jsonb ||`, żeby asercje mogły czytać stan TRWAŁY, a nie tylko
      // kopertę w pamięci.
      const key = `${params[0]}:stripe`
      const row = this.webhookRows.get(key)
      if (row) {
        if (sql.includes("entitlement_issue_failed_reason")) {
          if (!("entitlement_issue_failed_reason" in row.envelope)) {
            row.envelope.entitlement_issue_failed_reason = params[1]
            if (params[2] != null) {
              row.envelope.entitlement_issue_blocked_reason = params[2]
            }
          }
        }
        if (sql.includes("code_invalidation_skipped_count")) {
          row.envelope.revoked_entitlement_count = params[2]
          row.envelope.already_terminal_entitlement_count = params[4]
          row.envelope.code_invalidation_skipped_count = params[6]
        }
      }
      return { rows: [] as T[], rowCount: 1 }
    }

    if (sql.includes("FROM order_item oi") && sql.includes("oli.metadata")) {
      return rows(this.lines)
    }
    if (sql.includes("FROM order_item oi")) {
      // `resolveVoucherLineContext`. LIMIT 2 jest CZĘŚCIĄ MIERZONEGO
      // ZACHOWANIA: bez drugiego wiersza wołający nie ma dowodu
      // niejednoznaczności i wybrałby pierwszą linię po cichu.
      const lineItemId = params[1] as string | undefined
      const match = lineItemId
        ? this.lines.filter((l) => l.line_item_id === lineItemId)
        : this.lines
      const limit = /LIMIT\s+(\d+)/.exec(sql)
      return rows(match.slice(0, limit ? Number(limit[1]) : 1))
    }

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

  release() {}

  envelopeOf(eventId: string): Record<string, unknown> {
    return this.webhookRows.get(`${eventId}:stripe`)?.envelope ?? {}
  }
}

function workflowFor(client: BlockedIssuanceFakeClient) {
  return new StripePaymentAuditWorkflow({ connect: async () => client })
}

describe("REG-HIGH-2 — brak danych salonu NIE wywraca transakcji webhooka", () => {
  it("(1) linia bez dowiązania sprzedawcy: webhook przechodzi, powód jest NAZWANY", async () => {
    // Przed fixem: `issueVoucherCodeWithinTx` rzucał anonimowym `Error`, oba
    // `catch`-e przepuszczały go dalej, transakcja audytu padała razem z wierszem
    // dedupe — więc Stripe ponawiał webhook w kółko, a każde ponowienie
    // wywracało się identycznie.
    const client = new BlockedIssuanceFakeClient([
      voucherLine("line_v", {
        seller_id: null,
        seller_name: null,
        seller_handle: null,
      }),
    ])

    const result = await workflowFor(client).process(
      "payment.captured",
      capturedPayload()
    )

    expect(result.deduplicated).toBe(false)
    expect(result.envelope.entitlement_issue_blocked_reason).toBe(
      "missing_line_context"
    )
    expect(result.envelope.entitlement_issue_failed_reason).toMatch(
      /seller_id/
    )
    // Powód jest TRWAŁY, nie tylko w kopercie w pamięci: replay webhooka gubi
    // obiekt, wiersz zostaje.
    expect(
      client.envelopeOf("evt_captured_blocked")
        .entitlement_issue_blocked_reason
    ).toBe("missing_line_context")
  })

  it("(2) sam `seller_handle` pusty wystarczy — LEFT JOIN daje null, nie brak wiersza", async () => {
    const client = new BlockedIssuanceFakeClient([
      voucherLine("line_v", { seller_handle: "   " }),
    ])

    const result = await workflowFor(client).process(
      "payment.captured",
      capturedPayload()
    )

    expect(result.envelope.entitlement_issue_blocked_reason).toBe(
      "missing_line_context"
    )
    expect(result.envelope.entitlement_issue_failed_reason).toMatch(
      /seller_handle/
    )
  })

  it("(3) SM-7: odmowa NIE zostawia uprawnienia bez kodu ani wiersza `voucher`", async () => {
    // To jest kontrola, dla której kontrola danych musiała WYPRZEDZIĆ INSERT.
    // Gdyby rzut padał dopiero u producenta kodu (jak przed fixem), w tej samej
    // transakcji leżałby już wiersz uprawnienia bez mostu — czyli uprawnienie,
    // którego zwrot NIE unieważni.
    const client = new BlockedIssuanceFakeClient([
      voucherLine("line_v", { seller_id: null }),
    ])

    await workflowFor(client).process("payment.captured", capturedPayload())

    expect(client.entitlementRows.size).toBe(0)
    expect(client.voucherRows.size).toBe(0)
  })

  it("(4) brak `market_id` idzie tą samą drogą (REG-LOW-2), nie jako nieobsłużony wyjątek", async () => {
    const client = new BlockedIssuanceFakeClient([voucherLine("line_v")])

    const result = await workflowFor(client).process(
      "payment.captured",
      capturedPayload({ market_id: null })
    )

    expect(result.envelope.entitlement_issue_blocked_reason).toBe(
      "missing_market"
    )
    expect(client.entitlementRows.size).toBe(0)
  })

  it("kontrola PRZECIWNA: komplet danych nadal wystawia kod (fix nie bramkuje wołania)", async () => {
    const client = new BlockedIssuanceFakeClient([voucherLine("line_v")])

    const result = await workflowFor(client).process(
      "payment.captured",
      capturedPayload()
    )

    expect(result.envelope.entitlement_issue_blocked_reason).toBeUndefined()
    expect(result.envelope.entitlement_issue_failed_reason).toBeUndefined()
    const issued = [...client.entitlementRows.values()][0]
    const code = issued.policy_snapshot.voucher_code as string
    expect(code).toMatch(/^BO-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(client.voucherRows.get(code)?.status).toBe("idle")
  })
})

describe("REG-MEDIUM-1 — linia niewskazana na zamówieniu wielopozycyjnym", () => {
  it("(5) odmawia zamiast przypisać kod PIERWSZEJ chronologicznie linii", async () => {
    // Przed fixem: predykat linii był pomijany, a `LIMIT 1` zwracał dowolną
    // linię — jej `seller_id` szedł prosto do `INSERT INTO voucher`. Trasa
    // realizacji zawęża po `seller_id`, więc właściwy salon kodu BY NIE
    // ZREALIZOWAŁ, a obcy zobaczyłby go u siebie.
    const client = new BlockedIssuanceFakeClient([
      voucherLine("line_a", {
        seller_id: "sel_obcy",
        seller_name: "Salon Obcy",
        seller_handle: "salon-obcy",
      }),
      voucherLine("line_b"),
    ])

    const result = await workflowFor(client).process(
      "payment.captured",
      capturedPayload({
        entitlement_profile: {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          policy: { validity_months: 12 },
          amount_minor: 19900,
          currency: "PLN",
          line_item_id: null,
        },
      })
    )

    expect(result.envelope.entitlement_issue_blocked_reason).toBe(
      "ambiguous_line"
    )
    expect(client.voucherRows.size).toBe(0)
  })

  it("kontrola PRZECIWNA: zamówienie JEDNOPOZYCYJNE bez `line_item_id` przechodzi", async () => {
    // Zawężenie nie może zabrać zachowania, które było poprawne: przy jednej
    // linii nie ma czego mylić.
    const client = new BlockedIssuanceFakeClient([voucherLine("line_a")])

    const result = await workflowFor(client).process(
      "payment.captured",
      capturedPayload({
        entitlement_profile: {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          policy: { validity_months: 12 },
          amount_minor: 19900,
          currency: "PLN",
          line_item_id: null,
        },
      })
    )

    expect(result.envelope.entitlement_issue_blocked_reason).toBeUndefined()
    expect(client.voucherRows.size).toBe(1)
  })
})

describe("COR-LOW-1 / REG-LOW-1 — pominięcia i wyniki producenta są WIDOCZNE", () => {
  it("(6) licznik pominiętych unieważnień trafia do koperty audytu", async () => {
    // Cykl 2 zwracał `code_invalidation_skipped_entitlement_ids` z komentarzem
    // „fakt pominięcia jest zwracany i asertowany, nie przemilczany". Był
    // przemilczany: jedyny produkcyjny wołający przepisywał do koperty wyłącznie
    // dwa pozostałe liczniki, a asercja żyła w teście jednostkowym.
    const client = new BlockedIssuanceFakeClient([
      voucherLine("line_v"),
      creditPackLine("line_c"),
    ])
    const workflow = workflowFor(client)

    await workflow.process("payment.captured", capturedPayload())
    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.envelope.code_invalidation_skipped_count).toBe(1)
    expect(
      client.envelopeOf("evt_refund_blocked").code_invalidation_skipped_count
    ).toBe(1)
  })

  it("(7) wynik producenta INNY niż `invalidated` jest nazwany w kopercie", async () => {
    // Rozjazd mierzony tutaj: kod jest JUŻ `refunded`, a uprawnienie nadal
    // ACTIVE — czyli stan kodu i stan uprawnienia rozeszły się poza tranzycją.
    // Producent zwraca `already_invalidated` (poprawnie: nie ma czego
    // przestawiać), SM-7 nie rośnie — ale bez przepisania wyniku do koperty
    // fakt rozjazdu nie zostawiał ŻADNEGO śladu produkcyjnego.
    //
    // Uwaga na kontrolę przeciwną do intuicji, zmierzoną przy pisaniu tego
    // testu: `claimed → refunded` NIE jest anomalią. `claimed` jest na
    // allow-liście źródłowej celu `refunded` (zwrot pieniędzy unieważnia także
    // kod zrealizowany), więc producent zwraca tam `invalidated`. Pierwotna
    // wersja tej kontroli zakładała inaczej i została poprawiona pomiarem.
    const client = new BlockedIssuanceFakeClient()
    client.seedEntitlement({
      id: "ent_desynced_code",
      entitlement_type: "VOUCHER_SERVICE",
      state: "ACTIVE",
      policy_snapshot: { voucher_code: "BO-DSNC-01" },
    })
    client.voucherRows.set("BO-DSNC-01", {
      code: "BO-DSNC-01",
      status: "refunded",
      value_minor: 19900,
    })

    const result = await workflowFor(client).process(
      "payment.refunded",
      refundPayload()
    )

    expect(result.refundRevocation?.code_invalidation_outcomes).toEqual([
      { entitlement_id: "ent_desynced_code", outcome: "already_invalidated" },
    ])
    expect(result.envelope.code_invalidation_anomalies).toEqual([
      "ent_desynced_code:already_invalidated",
    ])
  })

  it("kontrola PRZECIWNA: czysty zwrot NIE zostawia klucza anomalii", async () => {
    const client = new BlockedIssuanceFakeClient([voucherLine("line_v")])
    const workflow = workflowFor(client)

    await workflow.process("payment.captured", capturedPayload())
    const result = await workflow.process("payment.refunded", refundPayload())

    expect(result.envelope.code_invalidation_anomalies).toBeUndefined()
    expect(result.refundRevocation?.code_invalidation_outcomes).toEqual([
      expect.objectContaining({ outcome: "invalidated" }),
    ])
  })
})
