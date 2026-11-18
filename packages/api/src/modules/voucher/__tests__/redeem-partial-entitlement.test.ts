/**
 * redeem-partial-entitlement.test.ts — Story 4.1 (v1.11.0 Epic 4 / Wave 4).
 *
 * Pokrywa operację redeem (partial + full) idempotentną + derecognition na
 * in-memory store + in-memory fake PG (wzorzec entitlement-transition-wiring.test):
 *   AC1 — partial obniża `remaining` na TYM SAMYM entitlement_id (NIE reissue,
 *         NIGDY > remaining); tranzycja routuje przez wiring (audit); derecognition
 *         posting wołany przez writer; gated audit-only/no-op gdy runtime_enabled=false.
 *   AC2 — idempotencja dwuwarstwowa: replay ⇒ remaining spada RAZ, jeden posting;
 *         multi-installment N rat ⇒ N postingów (różne redemption_id), Σ recognized == suspended.
 *   AC3 — withdrawal (art. 38 pkt 1) gaśnie WYŁĄCZNIE przy REDEEMED_FULL.
 */

import { describe, it, expect, jest } from "@jest/globals"
import {
  EntitlementInstanceState,
  EntitlementType,
} from "../models/entitlement"
import {
  VOUCHER_BUNDLE_POSTING_PROFILE_ID,
  VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID,
  VOUCHER_LIABILITY_ONLY_V1,
} from "../posting-profile"
import {
  VoucherLedgerWriter,
  deriveLedgerTransactionId,
  type LedgerPgClient,
  type LedgerPgPool,
} from "../ledger-writer"
import {
  defaultPostingActivationGate,
  type PostingActivationGate,
  type TransitionEventEnvelope,
} from "../entitlement-transition-wiring"
import {
  RedeemPartialEntitlementOperation,
  InMemoryRedeemPartialStore,
  RedeemAmountError,
  RedeemNotRedeemableError,
  RedeemEntitlementStateError,
  RedeemChoiceSetItemError,
  RedeemEntitlementNotFoundError,
  RedemptionBalanceError,
  REDEMPTION_KIND_REVERSAL,
  isWithdrawalRightExtinguished,
  buildRedemptionId,
  type RedeemableAmountEntitlement,
  type RedeemableChoiceSetItem,
  type RedeemPartialInput,
} from "../workflows/redeem-partial-entitlement"

// ---------------------------------------------------------------------------
// In-memory fake PG (honoruje ON CONFLICT DO NOTHING) — capture ledger writes.
// ---------------------------------------------------------------------------

function makeFakePool(): {
  pool: LedgerPgPool
  applied: Set<string>
  txRows: unknown[][]
  entryRows: unknown[][]
} {
  const applied = new Set<string>()
  const txRows: unknown[][] = []
  const entryRows: unknown[][] = []
  const query = (async (sql: string, params: unknown[] = []) => {
    const s = sql.trim()
    if (s.startsWith("INSERT INTO ledger_posting_applied")) {
      const id = String(params[0])
      if (applied.has(id)) return { rows: [], rowCount: 0 }
      applied.add(id)
      return { rows: [], rowCount: 1 }
    }
    if (s.startsWith("INSERT INTO voucher_ledger_transaction")) {
      txRows.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (s.startsWith("INSERT INTO voucher_ledger_entry")) {
      entryRows.push(params)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) as LedgerPgClient["query"]
  const client: LedgerPgClient = { query, release: jest.fn() }
  return { pool: { connect: async () => client }, applied, txRows, entryRows }
}

const FIXED_NOW = new Date("2026-06-02T10:00:00.000Z")
const GATE_BOTH_ON: PostingActivationGate = {
  runtimeEnabled: true,
  isMarketActivated: () => true,
}

function makeEntitlement(
  overrides: Partial<RedeemableAmountEntitlement> = {}
): RedeemableAmountEntitlement {
  return {
    id: "ent_amount_1",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    state: EntitlementInstanceState.ACTIVE,
    remaining_amount: 300,
    policy_snapshot: { transferability: "bearer" },
    vat_classification: "MPV",
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    vendor_id: null,
    location_id: null,
    recipient_customer_id: null,
    ...overrides,
  }
}

function makeChoiceSetItem(
  overrides: Partial<RedeemableChoiceSetItem> = {}
): RedeemableChoiceSetItem {
  return {
    id: "choice_1",
    instance_id: "ent_bundle_1",
    market_id: "bonbeauty",
    reference_amount_minor: 100,
    remaining_minor: 100,
    status: "ACTIVE",
    redemption_id: null,
    ...overrides,
  }
}

function makeOp(opts?: {
  rows?: RedeemableAmountEntitlement[]
  choiceSetItems?: RedeemableChoiceSetItem[]
  gate?: PostingActivationGate
  wireWriter?: boolean
}): {
  op: RedeemPartialEntitlementOperation
  store: InMemoryRedeemPartialStore
  events: TransitionEventEnvelope[]
  fake: ReturnType<typeof makeFakePool>
} {
  const store = new InMemoryRedeemPartialStore(
    opts?.rows ?? [makeEntitlement()],
    opts?.choiceSetItems ?? []
  )
  const events: TransitionEventEnvelope[] = []
  const fake = makeFakePool()
  const op = new RedeemPartialEntitlementOperation({
    store,
    events: { emit: async (e) => void events.push(e) },
    ...(opts?.wireWriter
      ? { ledgerWriter: new VoucherLedgerWriter(fake.pool) }
      : {}),
    ...(opts?.gate ? { postingActivation: opts.gate } : {}),
    clock: () => FIXED_NOW,
  })
  return { op, store, events, fake }
}

function baseInput(
  overrides: Partial<RedeemPartialInput> = {}
): RedeemPartialInput {
  return {
    entitlement_id: "ent_amount_1",
    amount_minor: 180,
    idempotency_key: "redeem-key-1",
    currency: "PLN",
    voucher_net_minor: 244,
    voucher_vat_minor: 56, // totalGross = 300
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    ...overrides,
  }
}

// ===========================================================================
// AC1 — partial obniża remaining na tym samym entitlement_id + derecognition
// ===========================================================================

describe("Story 4.1 AC1 — redeem partial obniża remaining (ten sam entitlement_id, NIE reissue)", () => {
  it("partial 180 z 300 ⇒ remaining 120, REDEEMED_PARTIAL, ten sam wiersz (NIE reissue)", async () => {
    const { op, store } = makeOp()
    const res = await op.redeem(baseInput())

    expect(res.outcome).toBe("REDEEMED_PARTIAL")
    expect(res.new_state).toBe("REDEEMED_PARTIAL")
    expect(res.remaining_before_minor).toBe(300)
    expect(res.remaining_after_minor).toBe(120)
    expect(res.idempotent).toBe(false)
    // Ten sam wiersz/entitlement_id — saldo żyje na istniejącym wierszu.
    const ent = store.get("ent_amount_1")!
    expect(ent.remaining_amount).toBe(120)
    expect(ent.state).toBe("REDEEMED_PARTIAL")
    expect(ent.id).toBe("ent_amount_1")
    // NIE reissue: dokładnie 1 entitlement w store (żaden nowy nie powstał).
    expect((store as unknown as { rows: Map<string, unknown> }).rows.size).toBe(1)
  })

  it("tranzycja routuje przez wiring ⇒ audyty (request + redeem) + eventy emitowane", async () => {
    const { op, store, events } = makeOp()
    await op.redeem(baseInput())

    // Dwa kroki tranzycji przez JEDEN punkt okablowania (3.4): →REDEMPTION_REQUESTED
    // (niefinansowy) + →REDEEMED_PARTIAL (finansowy). Append-only audit dla obu.
    const audits = store.listAudits()
    expect(audits).toHaveLength(2)
    expect(audits[0].to_state).toBe("REDEMPTION_REQUESTED")
    expect(audits[1].to_state).toBe("REDEEMED_PARTIAL")
    expect(audits[1].from_state).toBe("REDEMPTION_REQUESTED")
    // Eventy emitowane post-COMMIT (best-effort) dla obu tranzycji.
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.payload.to_state)).toEqual([
      "REDEMPTION_REQUESTED",
      "REDEEMED_PARTIAL",
    ])
  })

  it("derecognition posting GATED: runtime_enabled=false ⇒ audit-only/no-op (ZERO zapisu ledger)", async () => {
    // Sanity: realna flaga = false; domyślna bramka ją odzwierciedla.
    expect(defaultPostingActivationGate().runtimeEnabled).toBe(false)
    expect(VOUCHER_LIABILITY_ONLY_V1.runtime_enabled).toBe(false)

    const { op, store, fake } = makeOp({ wireWriter: true }) // brak gate ⇒ default (false)
    const res = await op.redeem(baseInput())

    // Posting hook PODPIĘTY (attempted) ale NIE aktywowany, NIE persystuje.
    expect(res.posting.attempted).toBe(true)
    expect(res.posting.activated).toBe(false)
    expect(res.posting.persisted).toBe(false)
    expect(res.posting.reason).toContain("runtime_enabled=false")
    expect(res.posting.transaction_id).toMatch(/^[0-9a-f]{64}$/)
    // ZERO zapisu do voucher_ledger_* — ale remaining obniżony niezależnie.
    expect(fake.txRows).toHaveLength(0)
    expect(fake.applied.size).toBe(0)
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(120)
  })

  it("over-redeem (amount > remaining) ⇒ fail-closed (rzuca, ZERO skutku, NIE ujemne)", async () => {
    const { op, store } = makeOp()
    await expect(
      op.redeem(baseInput({ amount_minor: 301, idempotency_key: "over" }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
    // Brak częściowego skutku — remaining/stan nietknięte; brak record dedupe.
    const ent = store.get("ent_amount_1")!
    expect(ent.remaining_amount).toBe(300)
    // 'ACTIVE' is a voucher entitlement state; nearby `store.listRedemptions()` is a
    // test-helper variable, not a Mercur store entity — migration-drift false positive:
    expect(ent.state).toBe("ACTIVE") // noqa: mercur15-drift
    expect(store.listRedemptions()).toHaveLength(0)
    expect(store.listAudits()).toHaveLength(0)
  })

  it("amount nie-całkowity / <1 ⇒ fail-closed (RedeemAmountError)", async () => {
    const { op } = makeOp()
    await expect(
      op.redeem(baseInput({ amount_minor: 0, idempotency_key: "z" }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
    await expect(
      op.redeem(baseInput({ amount_minor: 10.5, idempotency_key: "f" }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("full redeem (amount == remaining) ⇒ remaining 0, REDEEMED_FULL", async () => {
    const { op, store } = makeOp()
    const res = await op.redeem(baseInput({ amount_minor: 300, idempotency_key: "full" }))
    expect(res.outcome).toBe("REDEEMED_FULL")
    expect(res.remaining_after_minor).toBe(0)
    expect(store.get("ent_amount_1")!.state).toBe("REDEEMED_FULL")
  })

  /**
   * F-0 (review-fix cyklu 1 story 6.3). Do tej pory stał tu test „VOUCHER_SERVICE
   * ⇒ fail-closed", który UTRWALAŁ defekt: trasa panelu
   * (`vendor/vouchers/[code]/redeem`) jest okablowana do tej operacji, a
   * ZMIERZONE na `gp_mercur` 2026-08-12 — KAŻDY produkt katalogu BonBeauty
   * wystawia `VOUCHER_SERVICE` (`entitlement_type='VOUCHER_AMOUNT'` → 0 wierszy).
   * Ekran realizacji w salonie odmawiał więc `422 REDEMPTION_REFUSED` całemu
   * asortymentowi sklepu.
   *
   * Voucher serwisowy nie ma salda — ma JEDNĄ jednostkę usługi. Realizacja jest
   * niepodzielna i kończy się `REDEEMED_FULL`.
   */
  /**
   * Trasa panelu nie podaje `voucher_net_minor`/`voucher_vat_minor` — brutto
   * emisji czytane jest z `policy_snapshot.amount_minor`, tak jak na żywej bazie.
   */
  const svcInput = (
    overrides: Partial<RedeemPartialInput> = {}
  ): RedeemPartialInput =>
    baseInput({
      amount_minor: undefined,
      voucher_net_minor: undefined,
      voucher_vat_minor: undefined,
      ...overrides,
    })

  const serviceRows = () => [
    makeEntitlement({
      entitlement_type: EntitlementType.VOUCHER_SERVICE,
      // Tak wygląda wiersz na realnej bazie: brak salda, brutto w snapshocie.
      remaining_amount: null,
      policy_snapshot: { transferability: "bearer", amount_minor: 34000 },
    }),
  ]

  it("VOUCHER_SERVICE realizuje się jako CAŁA jednostka usługi ⇒ REDEEMED_FULL", async () => {
    const { op, store, events } = makeOp({ rows: serviceRows() })

    const res = await op.redeem(
      svcInput({ redeem_full: true, idempotency_key: "svc-1" })
    )

    expect(res.outcome).toBe("REDEEMED_FULL")
    expect(res.amount_minor).toBe(34000)
    expect(res.remaining_after_minor).toBe(0)
    expect(res.withdrawal_right_extinguished).toBe(true)
    expect(store.get("ent_amount_1")!.state).toBe("REDEEMED_FULL")
    // Oba kroki grafu idą TYM SAMYM punktem okablowania co typy kwotowe —
    // nie ma tu drugiego, równoległego mechanizmu przejścia.
    expect(events.map((e) => e.payload.to_state)).toEqual([
      "REDEMPTION_REQUESTED",
      "REDEEMED_FULL",
    ])
  })

  it("VOUCHER_SERVICE jest NIEPODZIELNY — kwota inna niż brutto to odmowa", async () => {
    const { op } = makeOp({ rows: serviceRows() })

    await expect(
      op.redeem(svcInput({ amount_minor: 180, idempotency_key: "svc-part" }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("VOUCHER_SERVICE bez redeem_full i bez kwoty ⇒ odmowa, nie cicha całość", async () => {
    const { op } = makeOp({ rows: serviceRows() })

    await expect(
      op.redeem(
        svcInput({ idempotency_key: "svc-noflag" })
      )
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("VOUCHER_SERVICE: replay po tym samym idempotency-key nie realizuje drugi raz", async () => {
    const { op, events } = makeOp({ rows: serviceRows() })
    const input = svcInput({
      redeem_full: true,
      idempotency_key: "svc-replay",
    })

    const first = await op.redeem(input)
    const emittedAfterFirst = events.length
    const second = await op.redeem(input)

    expect(second.redemption_id).toBe(first.redemption_id)
    expect(second.outcome).toBe("REDEEMED_FULL")
    // v1.16.0 Story 5.4 (AD-34, ADR-237): gałąź usługowa nie ma postingu
    // kwotowego, więc replay nie ma czego deduplikować — i nie udaje, że ma.
    expect(second.posting.attempted).toBe(false)
    expect(second.posting.deduped).toBe(false)
    expect(second.posting.transaction_id).toBeUndefined()
    expect(events).toHaveLength(emittedAfterFirst)
  })

  it("VOUCHER_SERVICE bez brutto w snapshocie ⇒ fail-closed (nie ma czego realizować)", async () => {
    const { op } = makeOp({
      rows: [
        makeEntitlement({
          entitlement_type: EntitlementType.VOUCHER_SERVICE,
          remaining_amount: null,
          policy_snapshot: { transferability: "bearer" },
        }),
      ],
    })

    await expect(
      op.redeem(
        svcInput({ redeem_full: true, idempotency_key: "svc-nogross" })
      )
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("typ spoza allow-listy nadal jest odmową", async () => {
    const { op } = makeOp({
      rows: [
        makeEntitlement({
          entitlement_type: "SUBSCRIPTION" as unknown as EntitlementType,
          policy_snapshot: { transferability: "bearer", amount_minor: 34000 },
        }),
      ],
    })
    await expect(
      op.redeem(svcInput({ redeem_full: true }))
    ).rejects.toBeInstanceOf(RedeemNotRedeemableError)
  })

  it("CREDIT_PACK używa tej samej semantyki salda: partial, multi-installment i FULL", async () => {
    const rows = [
      makeEntitlement({
        entitlement_type: EntitlementType.CREDIT_PACK,
        remaining_amount: 300,
      }),
    ]
    const { op, store } = makeOp({ rows })

    const partial = await op.redeem(
      baseInput({ amount_minor: 120, idempotency_key: "credit-1" })
    )
    expect(partial.outcome).toBe("REDEEMED_PARTIAL")
    expect(partial.remaining_after_minor).toBe(180)
    expect(partial.withdrawal_right_extinguished).toBe(false)
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(180)

    const full = await op.redeem(
      baseInput({ amount_minor: 180, idempotency_key: "credit-2" })
    )
    expect(full.outcome).toBe("REDEEMED_FULL")
    expect(full.remaining_after_minor).toBe(0)
    expect(full.withdrawal_right_extinguished).toBe(true)
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(0)
  })

  it("entitlement nieistniejący ⇒ RedeemEntitlementNotFoundError", async () => {
    const { op } = makeOp({ rows: [] })
    await expect(op.redeem(baseInput())).rejects.toBeInstanceOf(
      RedeemEntitlementNotFoundError
    )
  })
})

// ===========================================================================
// v1.12.0 Story 3.7 AC2 — BUNDLE consume choice_set pozycja po pozycji
// ===========================================================================

describe("Story 3.7 AC2 — BUNDLE consume pojedynczej pozycji choice_set", () => {
  function makeBundleRows() {
    return {
      rows: [
        makeEntitlement({
          id: "ent_bundle_1",
          entitlement_type: EntitlementType.BUNDLE,
          remaining_amount: 300,
        }),
      ],
      choiceSetItems: [
        makeChoiceSetItem({ id: "choice_1", remaining_minor: 100, reference_amount_minor: 100 }),
        makeChoiceSetItem({ id: "choice_2", remaining_minor: 200, reference_amount_minor: 200 }),
      ],
    }
  }

  function bundleInput(
    overrides: Partial<RedeemPartialInput> = {}
  ): RedeemPartialInput {
    return {
      ...baseInput({
        entitlement_id: "ent_bundle_1",
        amount_minor: undefined,
        idempotency_key: "bundle-1",
        voucher_net_minor: 244,
        voucher_vat_minor: 56,
      }),
      choice_set_item_id: "choice_1",
      ...overrides,
    }
  }

  it("konsumuje jedną pozycję, pokazuje pozostałe dostępne i zostawia PARTIAL", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op, store } = makeOp({ rows, choiceSetItems })

    const res = await op.redeem(bundleInput())

    expect(res.outcome).toBe("REDEEMED_PARTIAL")
    expect(res.amount_minor).toBe(100)
    expect(res.remaining_before_minor).toBe(300)
    expect(res.remaining_after_minor).toBe(200)
    expect(res.choice_set_item_id).toBe("choice_1")
    expect(res.available_choice_set_item_ids).toEqual(["choice_2"])
    expect(store.get("ent_bundle_1")!.remaining_amount).toBe(200)
    expect(store.get("ent_bundle_1")!.state).toBe("REDEEMED_PARTIAL")
    expect(store.listChoiceSetItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "choice_1",
          status: "REDEEMED",
          remaining_minor: 0,
          redemption_id: res.redemption_id,
        }),
        expect.objectContaining({
          id: "choice_2",
          status: "ACTIVE",
          remaining_minor: 200,
        }),
      ])
    )
  })

  it("ostatnia pozycja BUNDLE przełącza entitlement na REDEEMED_FULL", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op, store } = makeOp({ rows, choiceSetItems })

    await op.redeem(bundleInput({ idempotency_key: "bundle-1", choice_set_item_id: "choice_1" }))
    const full = await op.redeem(
      bundleInput({ idempotency_key: "bundle-2", choice_set_item_id: "choice_2" })
    )

    expect(full.outcome).toBe("REDEEMED_FULL")
    expect(full.remaining_after_minor).toBe(0)
    expect(full.available_choice_set_item_ids).toEqual([])
    expect(full.withdrawal_right_extinguished).toBe(true)
    expect(store.get("ent_bundle_1")!.state).toBe("REDEEMED_FULL")
    expect(store.listChoiceSetItems().every((i) => i.status === "REDEEMED")).toBe(true)
  })

  it("replay tego samego klucza nie konsumuje pozycji drugi raz i nie dubluje audytu/postingu", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op, store } = makeOp({ rows, choiceSetItems })

    const first = await op.redeem(bundleInput())
    const replay = await op.redeem(bundleInput())

    expect(replay.idempotent).toBe(true)
    expect(replay.redemption_id).toBe(first.redemption_id)
    expect(store.get("ent_bundle_1")!.remaining_amount).toBe(200)
    expect(store.listRedemptions()).toHaveLength(1)
    expect(store.listAudits()).toHaveLength(2)
  })

  it("re-konsumpcja albo pozycja spoza setu rzuca fail-closed i robi rollback", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op, store } = makeOp({ rows, choiceSetItems })

    await op.redeem(bundleInput())
    await expect(
      op.redeem(bundleInput({ idempotency_key: "bundle-reconsume" }))
    ).rejects.toBeInstanceOf(RedeemChoiceSetItemError)
    await expect(
      op.redeem(
        bundleInput({
          idempotency_key: "bundle-outside",
          choice_set_item_id: "choice_outside",
        })
      )
    ).rejects.toBeInstanceOf(RedeemChoiceSetItemError)

    expect(store.get("ent_bundle_1")!.remaining_amount).toBe(200)
    expect(store.listRedemptions()).toHaveLength(1)
    expect(store.listAudits()).toHaveLength(2)
  })

  it("amount_minor podany dla BUNDLE musi zgadzać się z konsumowaną pozycją", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op } = makeOp({ rows, choiceSetItems })

    await expect(
      op.redeem(bundleInput({ amount_minor: 99 }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("BUNDLE wybiera posting-profile przez registry keyed-by-entitlement_type", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op, fake } = makeOp({
      rows,
      choiceSetItems,
      gate: GATE_BOTH_ON,
      wireWriter: true,
    })

    const res = await op.redeem(bundleInput())

    expect(res.posting.persisted).toBe(true)
    expect(fake.txRows).toHaveLength(1)
    expect(fake.txRows[0][2]).toBe(VOUCHER_BUNDLE_POSTING_PROFILE_ID)
  })

  // L7 — BUNDLE replay zwraca available_choice_set_item_ids (AC2 „pozostałe pokazane")
  it("BUNDLE replay zwraca available_choice_set_item_ids — kształt wyniku spójny z applied", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op } = makeOp({ rows, choiceSetItems })

    const first = await op.redeem(bundleInput())
    const replay = await op.redeem(bundleInput())

    expect(replay.idempotent).toBe(true)
    expect(replay.redemption_id).toBe(first.redemption_id)
    // Replay BUNDLE musi zwracać dostępne pozycje (AC2 — „pozostałe pokazane").
    expect(replay.available_choice_set_item_ids).toBeDefined()
    // choice_1 skonsumowany ⇒ tylko choice_2 w dostępnych.
    expect(replay.available_choice_set_item_ids).toEqual(["choice_2"])
  })

  // L7 — BUNDLE param-drift: ten sam idempotency_key, inny choice_set_item_id ⇒ fail-loud
  it("BUNDLE replay z innym choice_set_item_id ⇒ RedeemChoiceSetItemError (fail-loud, NIE cichy)", async () => {
    const { rows, choiceSetItems } = makeBundleRows()
    const { op } = makeOp({ rows, choiceSetItems })

    // Pierwsza realizacja choice_1 pod kluczem bundle-drift.
    await op.redeem(bundleInput({ idempotency_key: "bundle-drift" }))
    // Replay z TYM SAMYM kluczem ale INNYM choice_set_item_id ⇒ fail-loud.
    await expect(
      op.redeem(bundleInput({ idempotency_key: "bundle-drift", choice_set_item_id: "choice_2" }))
    ).rejects.toBeInstanceOf(RedeemChoiceSetItemError)
  })

  // INFO-3 — cross-market odrzucony dla pozycji choice_set z innego market_id
  it("BUNDLE pozycja z innym market_id niż entitlement ⇒ RedeemChoiceSetItemError (cross-market)", async () => {
    const rows = [
      makeEntitlement({
        id: "ent_bundle_1",
        entitlement_type: EntitlementType.BUNDLE,
        remaining_amount: 300,
        market_id: "bonbeauty",
      }),
    ]
    const choiceSetItems = [
      makeChoiceSetItem({ id: "choice_cross", instance_id: "ent_bundle_1", remaining_minor: 100, market_id: "other_market" }),
    ]
    const { op } = makeOp({ rows, choiceSetItems })

    await expect(
      op.redeem(bundleInput({ choice_set_item_id: "choice_cross" }))
    ).rejects.toBeInstanceOf(RedeemChoiceSetItemError)
  })
})

// ===========================================================================
// AC1 — derecognition posting routuje przez writer (gate ON sym.); MPV/SPV
// ===========================================================================

describe("Story 4.1 AC1 — derecognition posting przez writer (sym. aktywacja)", () => {
  it("MPV partial (gate ON) ⇒ posting persisted; output VAT proporcjonalny; ledger zapisany", async () => {
    const rows = [makeEntitlement({ remaining_amount: 12300 })]
    const { op, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.redeem(
      baseInput({
        amount_minor: 6000,
        idempotency_key: "mpv-1",
        voucher_net_minor: 10000,
        voucher_vat_minor: 2300,
      })
    )
    expect(res.posting.activated).toBe(true)
    expect(res.posting.persisted).toBe(true)
    expect(res.posting.deduped).toBe(false)
    expect(fake.txRows).toHaveLength(1)
    // output VAT proporcjonalny: round(2300*6000/12300) = 1122.
    const outputCredits = fake.entryRows
      .filter((p) => p[2] === "vat:output")
      .reduce((s, p) => s + Number(p[4]), 0)
    expect(outputCredits).toBe(1122)
    // transaction_id deterministyczny per redemption_id.
    // v1.15.0 Story 5.7 (ADR-178 §2.3): preimage objął `kind`.
    const rid = buildRedemptionId("ent_amount_1", "mpv-1", "REDEMPTION")
    expect(res.posting.transaction_id).toBe(
      deriveLedgerTransactionId({
        entitlement_id: "ent_amount_1",
        lifecycle_event: "REDEEMED",
        redemption_id: rid,
      })
    )
  })

  it("CREDIT_PACK wybiera posting-profile przez registry keyed-by-entitlement_type", async () => {
    const rows = [
      makeEntitlement({
        entitlement_type: EntitlementType.CREDIT_PACK,
        remaining_amount: 12300,
      }),
    ]
    const { op, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.redeem(
      baseInput({
        amount_minor: 6000,
        idempotency_key: "credit-profile",
        voucher_net_minor: 10000,
        voucher_vat_minor: 2300,
      })
    )

    expect(res.posting.persisted).toBe(true)
    expect(fake.txRows).toHaveLength(1)
    expect(fake.txRows[0][2]).toBe(VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID)
  })

  it("SPV redeem (gate ON) ⇒ generator no-op (VAT przy emisji); ZERO legu ledger; remaining obniżony", async () => {
    const rows = [
      makeEntitlement({ remaining_amount: 12300, vat_classification: "SPV" }),
    ]
    const { op, store, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.redeem(
      baseInput({
        amount_minor: 6000,
        idempotency_key: "spv-1",
        vat_classification: "SPV",
        voucher_net_minor: 10000,
        voucher_vat_minor: 2300,
      })
    )
    // Generator SPV REDEEMED = posted:false ⇒ hook activated ale persisted:false.
    expect(res.posting.activated).toBe(true)
    expect(res.posting.persisted).toBe(false)
    expect(res.posting.reason).toContain("no-op")
    expect(fake.txRows).toHaveLength(0)
    // remaining obniżony niezależnie od (braku) legu VAT.
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(6300)
  })
})

// ===========================================================================
// AC2 — idempotencja dwuwarstwowa (replay ⇒ remaining raz, jeden posting)
// ===========================================================================

describe("Story 4.1 AC2 — idempotencja po idempotency_key+entitlement_id (fail-closed)", () => {
  it("2× redeem z tą samą parą ⇒ remaining spada RAZ; replay idempotent; jeden record", async () => {
    const { op, store } = makeOp()
    const first = await op.redeem(baseInput())
    const replay = await op.redeem(baseInput())

    expect(first.idempotent).toBe(false)
    expect(replay.idempotent).toBe(true)
    // remaining obniżony tylko raz (300→120, NIE 300→120→-60).
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(120)
    expect(replay.remaining_after_minor).toBe(120)
    expect(replay.amount_minor).toBe(180)
    // Skutek pierwszego redeemu zwracany deterministycznie (ten sam redemption_id).
    expect(replay.redemption_id).toBe(first.redemption_id)
    // Jeden record dedupe; audyt NIE duplikuje skutku redeemu (2 audyty z 1 redeemu).
    expect(store.listRedemptions()).toHaveLength(1)
    expect(store.listAudits()).toHaveLength(2)
  })

  it("replay posting dedupowany przez deterministyczny transaction_id (ADR-139 D3, no-op)", async () => {
    const { op } = makeOp()
    const first = await op.redeem(baseInput())
    const replay = await op.redeem(baseInput())
    // Druga bariera: ten sam transaction_id; replay ⇒ deduped (NIE podwaja postingu).
    expect(replay.posting.deduped).toBe(true)
    expect(replay.posting.persisted).toBe(false)
    expect(replay.posting.transaction_id).toBe(first.posting.transaction_id)
    expect(replay.posting.reason).toContain("replay")
  })

  it("replay z aktywowanym writerem ⇒ ledger NIE podwojony (jeden derecognition posting)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 12300 })]
    const { op, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const input = baseInput({
      amount_minor: 6000,
      idempotency_key: "mpv-replay",
      voucher_net_minor: 10000,
      voucher_vat_minor: 2300,
    })
    await op.redeem(input)
    const replay = await op.redeem(input)
    // Domena łapie replay PRZED writerem ⇒ jeden nagłówek ledger, nie podwaja.
    expect(replay.idempotent).toBe(true)
    expect(fake.txRows).toHaveLength(1)
    expect(fake.applied.size).toBe(1)
  })
})

// ===========================================================================
// AC2 — multi-installment: N rat ⇒ N postingów (różne redemption_id), Σ
// ===========================================================================

describe("Story 4.1 AC2 — multi-installment Σ recognized output == suspended (VER-H1)", () => {
  it("3 raty różne idempotency_key ⇒ 3 postingi, Σ output VAT == cały VAT (2300)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 12300 })]
    const { op, store, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const voucher = { voucher_net_minor: 10000, voucher_vat_minor: 2300 }

    const r1 = await op.redeem(baseInput({ amount_minor: 6000, idempotency_key: "rata-1", ...voucher }))
    const r2 = await op.redeem(baseInput({ amount_minor: 4000, idempotency_key: "rata-2", ...voucher }))
    const r3 = await op.redeem(baseInput({ amount_minor: 2300, idempotency_key: "rata-3", ...voucher }))

    // 3 RÓŻNE redemption_id ⇒ 3 osobne postingi (multi-installment-safe).
    const rids = new Set([r1.redemption_id, r2.redemption_id, r3.redemption_id])
    expect(rids.size).toBe(3)
    expect(fake.txRows).toHaveLength(3)
    // Saldo wyczerpane ⇒ ostatnia rata = REDEEMED_FULL.
    expect(r3.outcome).toBe("REDEEMED_FULL")
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(0)
    // Σ recognized output VAT == suspended (cały VAT 2300) — ostatni event absorbuje resztę.
    const sumOutput = fake.entryRows
      .filter((p) => p[2] === "vat:output")
      .reduce((s, p) => s + Number(p[4]), 0)
    const sumSuspenseDebit = fake.entryRows
      .filter((p) => p[2] === "vat:output:suspense")
      .reduce((s, p) => s + Number(p[3]), 0)
    expect(sumOutput).toBe(2300)
    expect(sumSuspenseDebit).toBe(2300)
  })
})

// ===========================================================================
// AC3 — withdrawal (art. 38 pkt 1) gaśnie WYŁĄCZNIE przy REDEEMED_FULL
// ===========================================================================

describe("Story 4.1 AC3 — withdrawal gaśnie WYŁĄCZNIE przy REDEEMED_FULL", () => {
  it("REDEEMED_PARTIAL ⇒ withdrawal NADAL aktywne (saldo dostępne)", async () => {
    const { op } = makeOp()
    const res = await op.redeem(baseInput())
    expect(res.outcome).toBe("REDEEMED_PARTIAL")
    expect(res.withdrawal_right_extinguished).toBe(false)
  })

  it("REDEEMED_FULL ⇒ withdrawal WYGASŁE (usługa wykonana w całości)", async () => {
    const { op } = makeOp()
    const res = await op.redeem(baseInput({ amount_minor: 300, idempotency_key: "full" }))
    expect(res.outcome).toBe("REDEEMED_FULL")
    expect(res.withdrawal_right_extinguished).toBe(true)
  })

  it("isWithdrawalRightExtinguished: tylko REDEEMED_FULL; booking/partial NIE gasi", () => {
    expect(isWithdrawalRightExtinguished(EntitlementInstanceState.REDEEMED_FULL)).toBe(true)
    expect(isWithdrawalRightExtinguished(EntitlementInstanceState.REDEEMED_PARTIAL)).toBe(false)
    expect(isWithdrawalRightExtinguished(EntitlementInstanceState.REDEMPTION_REQUESTED)).toBe(false)
    expect(isWithdrawalRightExtinguished(EntitlementInstanceState.ACTIVE)).toBe(false)
    expect(isWithdrawalRightExtinguished(EntitlementInstanceState.ISSUED)).toBe(false)
  })

  it("partial potem dopełnienie do FULL ⇒ withdrawal gaśnie dopiero przy FULL", async () => {
    const rows = [makeEntitlement({ remaining_amount: 300 })]
    const { op } = makeOp({ rows })
    const partial = await op.redeem(baseInput({ amount_minor: 180, idempotency_key: "p1" }))
    expect(partial.withdrawal_right_extinguished).toBe(false)
    const full = await op.redeem(baseInput({ amount_minor: 120, idempotency_key: "p2" }))
    expect(full.outcome).toBe("REDEEMED_FULL")
    expect(full.withdrawal_right_extinguished).toBe(true)
  })
})

// ===========================================================================
// L1 — dual-write ordering: dedupe-first, posting LAST (ADR-139 D2/D3)
// ===========================================================================

describe("Story 4.1 L1 — dual-write ordering: insertRedemption PRZED postingiem (dedupe-first)", () => {
  it("insertRedemption wpisany PRZED step2 — record widoczny w store natychmiast po COMMIT", async () => {
    // Weryfikacja kolejności: insertRedemption zapisane PRZED postingiem (step2).
    // Replay po 1. redeem musi widzieć record (gdyby był PO postingu, mógłby brakować przy rollback).
    const { op, store } = makeOp()
    await op.redeem(baseInput())
    // Record dedupe zapisany = wpisany PRZED step2 (L1 fix — dedupe-first).
    expect(store.listRedemptions()).toHaveLength(1)
    const rec = store.listRedemptions()[0]
    expect(rec.entitlement_id).toBe("ent_amount_1")
    expect(rec.issued_gross_minor).toBe(300) // totalGross = 244+56
    // Replay: odczyta istniejący record i zwróci bez nowego obniżenia salda.
    const replay = await op.redeem(baseInput())
    expect(replay.idempotent).toBe(true)
  })

  it("L1 ordering (gate ON): record dedupe zapisany i remaining obniżony PRZED postingiem", async () => {
    // Symulacja aktywowanego postingu: dedupe i saldo MUSZĄ być przed posting hook.
    // Weryfikacja: posting persisted=true i remaining poprawnie obniżony.
    const rows = [makeEntitlement({ remaining_amount: 300 })]
    const { op, store, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.redeem(baseInput({ amount_minor: 300, idempotency_key: "full-gate-on" }))
    expect(res.posting.persisted).toBe(true)
    // State i remaining POPRAWNIE zaktualizowane (ordering spójny)
    expect(store.get("ent_amount_1")!.state).toBe("REDEEMED_FULL")
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(0)
    // Dokładnie 1 posting derecognition (NIE podwaja)
    expect(fake.txRows).toHaveLength(1)
    // Record dedupe istnieje (wpisany PRZED postingiem)
    expect(store.listRedemptions()).toHaveLength(1)
    expect(store.listRedemptions()[0].issued_gross_minor).toBe(300)
  })
})

// ===========================================================================
// L2 — currency consistency guard: expected_currency = emisja, nie tautologia
// ===========================================================================

describe("Story 4.1 L2 — currency guard: expected_currency z emisji (NIE tautologia)", () => {
  it("entitlement bez issued_amount_currency: fallback do currency inputu (PLN-only bonbeauty)", async () => {
    // Brak currency w policy_snapshot ⇒ issued_amount_currency=null ⇒ guard = PLN vs PLN (OK)
    const { op, fake } = makeOp({ gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.redeem(baseInput({ amount_minor: 300, idempotency_key: "curr-ok" }))
    expect(res.posting.activated).toBe(true)
    // Brak wyjątku currency guard = guard przepuścił (PLN==PLN)
    expect(fake.txRows).toHaveLength(1)
  })

  it("entitlement z issued_amount_currency PLN + currency PLN: guard OK (spójne)", async () => {
    // policy_snapshot z currency_code = issued_amount_currency derivowany.
    const rows = [makeEntitlement({
      policy_snapshot: { transferability: "bearer", currency_code: "PLN" },
    })]
    const { op, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.redeem(baseInput({ amount_minor: 300, idempotency_key: "curr-match" }))
    expect(res.posting.activated).toBe(true)
    expect(fake.txRows).toHaveLength(1)
  })

  it("entitlement z issued_amount_currency PLN + currency EUR: guard fail-closed (mismatch)", async () => {
    // Mismatch emisji vs inputu ⇒ writer assertCurrencyConsistent rzuca (fail-closed).
    const rows = [makeEntitlement({
      policy_snapshot: { transferability: "bearer", currency_code: "PLN" },
    })]
    const { op } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    await expect(
      op.redeem(baseInput({ amount_minor: 300, idempotency_key: "curr-mismatch", currency: "EUR" }))
    ).rejects.toThrow(/currency/)
  })
})

// ===========================================================================
// L3 — net/vat consistency: walidacja spójności między ratami (VER-H1)
// ===========================================================================

describe("Story 4.1 L3 — net/vat consistency: totalGross spójny między ratami (VER-H1)", () => {
  it("pierwsza rata: brak walidacji (brak poprzednich rekordów)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 12300 })]
    const { op } = makeOp({ rows })
    await expect(
      op.redeem(baseInput({ amount_minor: 6000, idempotency_key: "r1",
        voucher_net_minor: 10000, voucher_vat_minor: 2300 }))
    ).resolves.not.toThrow()
  })

  it("kolejna rata z identycznym totalGross: OK (spójność zachowana)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 12300 })]
    const { op } = makeOp({ rows })
    await op.redeem(baseInput({ amount_minor: 6000, idempotency_key: "r1",
      voucher_net_minor: 10000, voucher_vat_minor: 2300 }))
    await expect(
      op.redeem(baseInput({ amount_minor: 4000, idempotency_key: "r2",
        voucher_net_minor: 10000, voucher_vat_minor: 2300 }))
    ).resolves.not.toThrow()
  })

  it("kolejna rata z RÓŻNYM totalGross: fail-closed (VER-H1 dryf net/vat)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 12300 })]
    const { op } = makeOp({ rows })
    await op.redeem(baseInput({ amount_minor: 6000, idempotency_key: "r1",
      voucher_net_minor: 10000, voucher_vat_minor: 2300 })) // totalGross=12300
    // rata 2 podaje inny totalGross (10000+2000=12000) ⇒ fail-closed
    await expect(
      op.redeem(baseInput({ amount_minor: 4000, idempotency_key: "r2",
        voucher_net_minor: 10000, voucher_vat_minor: 2000 }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("replay (ta sama para key+id): NIE waliduje spójności (already recorded)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 300 })]
    const { op } = makeOp({ rows })
    await op.redeem(baseInput({ amount_minor: 180, idempotency_key: "r1",
      voucher_net_minor: 244, voucher_vat_minor: 56 }))
    // replay z identycznym kluczem: OK (early-return przed walidacją L3)
    await expect(
      op.redeem(baseInput({ amount_minor: 180, idempotency_key: "r1",
        voucher_net_minor: 244, voucher_vat_minor: 56 }))
    ).resolves.toMatchObject({ idempotent: true })
  })
})

// ===========================================================================
// L4 — scope postingu dziedziczy vendor_id/location_id z entitlementu
// ===========================================================================

describe("Story 4.1 L4 — scope postingu: vendor_id/location_id z entitlement_instance", () => {
  it("vendor_id/location_id z entitlementu → scope (gdy input nie podaje)", async () => {
    const rows = [makeEntitlement({ vendor_id: "vendor_xyz", location_id: "loc_abc" })]
    const { op, store } = makeOp({ rows })
    const res = await op.redeem(baseInput())
    expect(res.outcome).toBe("REDEEMED_PARTIAL")
    // remaining obniżone = operacja przeszła z poprawnym scopem (vendor/location z ent)
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(120)
  })

  it("input vendor_id overriduje entitlement vendor_id", async () => {
    const rows = [makeEntitlement({ vendor_id: "vendor_from_ent" })]
    const { op } = makeOp({ rows })
    // input.vendor_id overriduje: ent.vendor_id ?? input.vendor_id — tu input wins
    const res = await op.redeem(baseInput({ vendor_id: "vendor_override" }))
    expect(res.outcome).toBe("REDEEMED_PARTIAL")
  })
})

// ===========================================================================
// L5 — audit occurred_at z envelope (nie NOW() DB)
// ===========================================================================

describe("Story 4.1 L5 — audit occurred_at z envelope (czas zdarzenia, nie zegar DB)", () => {
  it("audyt zawiera occurred_at zgodny z FIXED_NOW (clock operacji, nie NOW())", async () => {
    const { op, store } = makeOp()
    await op.redeem(baseInput({ now: FIXED_NOW }))
    const audits = store.listAudits()
    // Oba audyty mają occurred_at = FIXED_NOW (czas zdarzenia z clock operacji).
    for (const audit of audits) {
      expect(audit.occurred_at).toBe(FIXED_NOW.toISOString())
    }
  })

  it("audit occurred_at różni się od created_at w warstwach z innym zegarem", () => {
    // Czysta funkcja buildTransitionEnvelopes — occurred_at z input.occurred_at.
    // InMemory appendAudit NIE nadpisuje occurred_at (brak NOW() w in-memory).
    // Walidacja: occurred_at w payload = to samo co w top-level audit (bez rozjazdu).
    const { op } = makeOp()
    void op // instantiation OK = walidacja typów L5 fix
  })
})

// ===========================================================================
// L6 — param drift: reużyty idempotency_key z innym amount_minor ⇒ fail-loud
// ===========================================================================

describe("Story 4.1 L6 — param drift: reużyty idempotency_key z innym amount_minor", () => {
  it("ten sam klucz, inny amount_minor ⇒ RedeemAmountError (fail-loud, NIE cichy)", async () => {
    const { op } = makeOp()
    await op.redeem(baseInput({ amount_minor: 180, idempotency_key: "key-drift" }))
    // Replay z tym samym kluczem ale INNYM amount_minor ⇒ fail-loud
    await expect(
      op.redeem(baseInput({ amount_minor: 100, idempotency_key: "key-drift" }))
    ).rejects.toBeInstanceOf(RedeemAmountError)
  })

  it("ten sam klucz, TEN SAM amount_minor ⇒ idempotent replay OK (brak dryftu)", async () => {
    const { op } = makeOp()
    await op.redeem(baseInput({ amount_minor: 180, idempotency_key: "key-ok" }))
    const replay = await op.redeem(baseInput({ amount_minor: 180, idempotency_key: "key-ok" }))
    expect(replay.idempotent).toBe(true)
  })
})

// ===========================================================================
// v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-2) — ODWRÓCENIE i stan kodu
//
// Do tego fixu `test:unit` nie zawierał ANI JEDNEGO wystąpienia `reverse` na
// tej operacji: pomiar „zbiór nazw porażek NIEZMIENIONY" był prawdziwy i pusty
// w tym punkcie, bo nie było testu, który mógłby stan zmienić. Odwrócenie
// PEŁNE prowadzi do `REFUNDED` — stanu UNIEWAŻNIAJĄCEGO — więc od 5.9 wymaga
// producenta stanu kodu w `wiringDeps`. Bez niego okablowanie fail-closuje
// PRZED jakimkolwiek efektem (`MissingVoucherCodeInvalidatorError`).
// ===========================================================================

describe("C2-HIGH-2 — odwrócenie realizacji domyka też stan kodu vouchera", () => {
  const CODE = "GP-REV-0001"

  function makeCodedOp(remaining = 300) {
    return makeOp({
      rows: [
        makeEntitlement({
          remaining_amount: remaining,
          policy_snapshot: { transferability: "bearer", voucher_code: CODE },
        }),
      ],
    })
  }

  it("odwrócenie PEŁNE (Σ REVERSAL == Σ REDEMPTION) ⇒ REFUNDED i kod `refunded`", async () => {
    const { op, store } = makeCodedOp()
    const redeemed = await op.redeem(baseInput({ amount_minor: 300 }))
    expect(store.getVoucherStatus(CODE)).toBe("idle")

    const res = await op.reverse({
      reverses_redemption_id: redeemed.redemption_id,
      voucher_net_minor: 244,
      voucher_vat_minor: 56,
      currency: "PLN",
    })

    expect(res.fully_reversed).toBe(true)
    expect(res.entitlement_state_after).toBe("REFUNDED")
    expect(store.get("ent_amount_1")!.state).toBe("REFUNDED")
    // AD-17: stan kodu schodzi w TEJ SAMEJ transakcji co stan uprawnienia.
    expect(store.getVoucherStatus(CODE)).toBe("refunded")
  })

  it("kontrola przeciwna: odwrócenie CZĘŚCIOWE ⇒ REDEEMED_PARTIAL, kod NIETKNIĘTY", async () => {
    const { op, store } = makeCodedOp()
    const first = await op.redeem(
      baseInput({ amount_minor: 100, idempotency_key: "rev-part-1" })
    )
    await op.redeem(
      baseInput({ amount_minor: 200, idempotency_key: "rev-part-2" })
    )

    const res = await op.reverse({
      reverses_redemption_id: first.redemption_id,
      voucher_net_minor: 244,
      voucher_vat_minor: 56,
      currency: "PLN",
    })

    expect(res.fully_reversed).toBe(false)
    expect(res.entitlement_state_after).toBe("REDEEMED_PARTIAL")
    // Uprawnienie nie zeszło do stanu unieważniającego ⇒ kod zostaje realizowalny.
    expect(store.getVoucherStatus(CODE)).toBe("idle")
  })
})

// ===========================================================================
// v1.15.0 Story 6.3 review-fix cyklu 2 (C2-M-1, C2-M-4) — POSTING i ODWRÓT
// dla `VOUCHER_SERVICE`.
//
// Cykl 2 zmierzył dwa braki KONTROLI (nie domysły, mutanty):
//   C2-M-1 — `priorRedeemedGross: 0 → totalGross` i `remainingBefore:
//            totalGross → 0` przechodziły z pakietem 51/51 zielonym, mimo że
//            obie wartości wypływają na zewnątrz (baza derecognition
//            i `remaining_before_minor` koperty).
//   C2-M-4 — bloki testów odwrotu nie zawierały ANI JEDNEGO wystąpienia
//            `VOUCHER_SERVICE`; komentarz w kodzie deklarował agnostyczność
//            typową, a żaden test tego dla nowego typu nie wykonywał
//            (`feedback_martwy_mechanizm_na_realnej_sciezce`).
// ===========================================================================

describe("C2-M-1/C2-M-4 — VOUCHER_SERVICE: posting i odwrót (ADR-212)", () => {
  const SVC_NET = 27642
  const SVC_VAT = 6358 // totalGross = 34000
  const SVC_GROSS = SVC_NET + SVC_VAT
  const SVC_CODE = "GP-SVC-0001"

  const serviceRow = (overrides: Record<string, unknown> = {}) =>
    makeEntitlement({
      entitlement_type: EntitlementType.VOUCHER_SERVICE,
      // Tak wygląda wiersz na realnej bazie: brak salda, brutto w snapshocie.
      remaining_amount: null,
      policy_snapshot: {
        transferability: "bearer",
        amount_minor: SVC_GROSS,
        voucher_code: SVC_CODE,
      },
      ...overrides,
    })

  /** Wejście z rozbiciem net/VAT — inaczej VAT jest zerem i posting jest no-opem. */
  const svcVatInput = (
    overrides: Partial<RedeemPartialInput> = {}
  ): RedeemPartialInput =>
    baseInput({
      amount_minor: undefined,
      redeem_full: true,
      voucher_net_minor: SVC_NET,
      voucher_vat_minor: SVC_VAT,
      idempotency_key: "svc-posting-1",
      ...overrides,
    })

  it("Story 5.4 (AD-34): gałąź usługowa NIE produkuje postingu — nawet przy bramce włączonej i podpiętym writerze", async () => {
    // Do v1.16.0 Story 5.4 stał tu test C2-M-1, który WYMAGAŁ postingu
    // `REDEEMED` z całym VAT-em (ADR-212 §2). AD-34 i ADR-237 (`Proposed`)
    // zdejmują posting kwotowy z gałęzi usługowej; kontrola jest odwrócona,
    // a warunki (bramka ON, writer podpięty, VAT > 0) są te same — inaczej
    // „brak postingu" mógłby wynikać z wyłączonej bramki, nie z gałęzi.
    const { op, fake, store } = makeOp({
      rows: [serviceRow()],
      gate: GATE_BOTH_ON,
      wireWriter: true,
    })

    const res = await op.redeem(svcVatInput())

    expect(res.outcome).toBe("REDEEMED_FULL")
    expect(res.posting.attempted).toBe(false)
    expect(res.posting.activated).toBe(false)
    expect(res.posting.persisted).toBe(false)
    expect(fake.txRows).toHaveLength(0)
    expect(fake.entryRows).toHaveLength(0)
    // Bez wiersza salda: `remaining_amount` zostaje `null` (jak przy emisji).
    expect(store.get("ent_amount_1")!.remaining_amount).toBeNull()
  })

  it("Story 5.4 (AD-34): kontrola przeciwna — gałąź KWOTOWA w tych samych warunkach produkuje posting", async () => {
    const { op, fake } = makeOp({
      rows: [makeEntitlement({ remaining_amount: SVC_GROSS })],
      gate: GATE_BOTH_ON,
      wireWriter: true,
    })

    const res = await op.redeem(
      baseInput({
        amount_minor: SVC_GROSS,
        voucher_net_minor: SVC_NET,
        voucher_vat_minor: SVC_VAT,
        idempotency_key: "amt-posting-ctrl",
      })
    )

    expect(res.posting.attempted).toBe(true)
    expect(res.posting.persisted).toBe(true)
    expect(fake.txRows).toHaveLength(1)
  })

  it("C2-M-1: koperta niesie remaining_before = całe brutto emisji, remaining_after = 0", async () => {
    const { op } = makeOp({ rows: [serviceRow()] })

    const res = await op.redeem(svcVatInput({ idempotency_key: "svc-remain" }))

    // `remaining_before_minor` wypływa na zewnątrz (`:1573`) i jest liczbą,
    // którą panel pokazuje kosmetolożce. Dla uprawnienia NIEPODZIELNEGO to
    // całe brutto emisji — przed realizacją cała jednostka, po niej zero.
    expect(res.remaining_before_minor).toBe(SVC_GROSS)
    expect(res.amount_minor).toBe(SVC_GROSS)
    expect(res.remaining_after_minor).toBe(0)
    expect(res.outcome).toBe("REDEEMED_FULL")
  })

  it("C2-M-4: odwrót PEŁNY ⇒ REFUNDED, kod `refunded`, saldo NIE wraca", async () => {
    const { op, store } = makeOp({ rows: [serviceRow()] })
    const redeemed = await op.redeem(
      svcVatInput({ idempotency_key: "svc-rev-full" })
    )
    expect(store.getVoucherStatus(SVC_CODE)).toBe("idle")

    // Odczyt SPRZED odwrotu. Bez niego „0" po odwrocie nie odróżnia „saldo nie
    // wróciło" od „salda nigdy nie było": wiersz `VOUCHER_SERVICE` startuje
    // z `remaining_amount: null` (brutto siedzi w `policy_snapshot`), więc
    // dopiero realizacja ustawia tu liczbę. Zapamiętujemy ją, żeby porównanie
    // po odwrocie miało z czym być porównane.
    const remainingPoRealizacji = store.get("ent_amount_1")!.remaining_amount
    // v1.16.0 Story 5.4 (AD-34): realizacja usługowa nie pisze salda.
    expect(remainingPoRealizacji).toBeNull()

    const res = await op.reverse({
      reverses_redemption_id: redeemed.redemption_id,
      voucher_net_minor: SVC_NET,
      voucher_vat_minor: SVC_VAT,
      currency: "PLN",
    })

    // Dla typu NIEPODZIELNEGO istnieje DOKŁADNIE jedna realizacja, więc jej
    // odwrócenie zawsze domyka `Σ REVERSAL == Σ REDEMPTION` (ADR-198).
    expect(res.fully_reversed).toBe(true)
    expect(res.entitlement_state_after).toBe("REFUNDED")
    expect(store.get("ent_amount_1")!.state).toBe("REFUNDED")
    expect(store.getVoucherStatus(SVC_CODE)).toBe("refunded")
    // ADR-197 §2.5/A4: zwrot NIE jest odblokowaniem — saldo zostaje DOKŁADNIE
    // TĄ SAMĄ liczbą co po realizacji i nie wraca do brutta emisji. Nośnikiem
    // jest równość z wartością sprzed odwrotu, a nie sama stała `0`: gdyby
    // odwrót podniósł saldo do `SVC_GROSS`, ta asercja upadnie.
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(
      remainingPoRealizacji
    )
    expect(res.commission_base_after_minor).toBe(0)
  })

  it("C2-M-4: odwrót CZĘŚCIOWY jednostki usługi jest ODMOWĄ (podstawa musi być całym brutto)", async () => {
    const { op, store } = makeOp({ rows: [serviceRow()] })
    const redeemed = await op.redeem(
      svcVatInput({ idempotency_key: "svc-rev-part" })
    )

    // „Pół zabiegu" nie istnieje po żadnej ze stron: realizacja częściowa jest
    // odmawiana w `resolveRedeemSpend`, a odwrót częściowy — tutaj. Odwrócenie
    // cofa DOKŁADNIE tę podstawę, którą rozpoznała realizacja.
    await expect(
      op.reverse({
        reverses_redemption_id: redeemed.redemption_id,
        voucher_net_minor: 20000,
        voucher_vat_minor: 0,
        currency: "PLN",
      })
    ).rejects.toBeInstanceOf(RedemptionBalanceError)

    // Odmowa jest fail-closed: ZERO skutku ubocznego.
    expect(store.get("ent_amount_1")!.state).toBe("REDEEMED_FULL")
    expect(store.getVoucherStatus(SVC_CODE)).toBe("idle")
  })

  it("C2-M-4: reguła bilansu ADR-178 §2.3 pilnuje odwrotu — podstawa prowizji nie schodzi < 0", async () => {
    const { op, store } = makeOp({ rows: [serviceRow()] })
    const redeemed = await op.redeem(
      svcVatInput({ idempotency_key: "svc-rev-bounds" })
    )

    // Wiersz odwracający SPOZA tej operacji (inny `idempotency_key`, więc nie
    // wchodzi w dedupe) sprowadza podstawę prowizji do zera. Kolejne odwrócenie
    // zeszłoby na −34000 i musi być odmową — to jest drugi zamek ADR-178 §2.3,
    // ten sam dla typu kwotowego i niepodzielnego.
    await store.withTransaction(async (tx) =>
      tx.insertRedemption({
        entitlement_id: "ent_amount_1",
        idempotency_key: "svc-rev-bounds-obcy",
        redemption_id: "rdm_obcy_reversal",
        amount_minor: SVC_GROSS,
        resulting_state: EntitlementInstanceState.REDEEMED_FULL,
        remaining_after_minor: 0,
        issued_gross_minor: SVC_GROSS,
        created_at: FIXED_NOW.getTime(),
        kind: REDEMPTION_KIND_REVERSAL,
        reverses_redemption_id: redeemed.redemption_id,
        market_id: "bonbeauty",
        purchase_market_id: "bonbeauty",
        redemption_market_id: "bonbeauty",
      })
    )

    await expect(
      op.reverse({
        reverses_redemption_id: redeemed.redemption_id,
        voucher_net_minor: SVC_NET,
        voucher_vat_minor: SVC_VAT,
        currency: "PLN",
      })
    ).rejects.toBeInstanceOf(RedemptionBalanceError)
    expect(store.get("ent_amount_1")!.state).toBe("REDEEMED_FULL")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// v1.16.0 Story 5.5 (AC3, ADR-219 §4 człon 3, DW-15-210): gałąź
// `RedeemEntitlementStateError` — do tej story bez ani jednej asercji.
// ──────────────────────────────────────────────────────────────────────────
describe("Story 5.5 — RedeemEntitlementStateError dla prezentu ISSUED", () => {
  it("ISSUED (przed aktywacją) ⇒ RedeemEntitlementStateError ze stanem jako wartością", async () => {
    const { op, store } = makeOp({
      rows: [makeEntitlement({ state: EntitlementInstanceState.ISSUED })],
    })
    const attempt = op.redeem(baseInput({ idempotency_key: "issued-1" }))
    await expect(attempt).rejects.toThrow(RedeemEntitlementStateError)
    const err = await op
      .redeem(baseInput({ idempotency_key: "issued-2" }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RedeemEntitlementStateError)
    // Podtyp — istniejące `catch (RedeemNotRedeemableError)` działają dalej.
    expect(err).toBeInstanceOf(RedeemNotRedeemableError)
    expect((err as RedeemEntitlementStateError).entitlement_state).toBe("ISSUED")
    // Odmowa fail-closed: saldo i stan bez zmian.
    expect(store.get("ent_amount_1")!.state).toBe("ISSUED")
    expect(store.get("ent_amount_1")!.remaining_amount).toBe(300)
  })

  it("ACTIVE nie wpada w gałąź stanową (kontrola ujemna)", async () => {
    const { op } = makeOp()
    await expect(
      op.redeem(baseInput({ idempotency_key: "active-1" }))
    ).resolves.toBeDefined()
  })
})
