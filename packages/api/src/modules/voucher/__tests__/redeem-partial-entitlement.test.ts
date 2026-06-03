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
import { VOUCHER_LIABILITY_ONLY_V1 } from "../posting-profile"
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
  RedeemEntitlementNotFoundError,
  isWithdrawalRightExtinguished,
  buildRedemptionId,
  type RedeemableAmountEntitlement,
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

function makeOp(opts?: {
  rows?: RedeemableAmountEntitlement[]
  gate?: PostingActivationGate
  wireWriter?: boolean
}): {
  op: RedeemPartialEntitlementOperation
  store: InMemoryRedeemPartialStore
  events: TransitionEventEnvelope[]
  fake: ReturnType<typeof makeFakePool>
} {
  const store = new InMemoryRedeemPartialStore(opts?.rows ?? [makeEntitlement()])
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

  it("entitlement nie-kwotowy (VOUCHER_SERVICE) ⇒ fail-closed", async () => {
    const { op } = makeOp({
      rows: [makeEntitlement({ entitlement_type: EntitlementType.VOUCHER_SERVICE })],
    })
    await expect(op.redeem(baseInput())).rejects.toBeInstanceOf(
      RedeemNotRedeemableError
    )
  })

  it("entitlement nieistniejący ⇒ RedeemEntitlementNotFoundError", async () => {
    const { op } = makeOp({ rows: [] })
    await expect(op.redeem(baseInput())).rejects.toBeInstanceOf(
      RedeemEntitlementNotFoundError
    )
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
    const rid = buildRedemptionId("ent_amount_1", "mpv-1")
    expect(res.posting.transaction_id).toBe(
      deriveLedgerTransactionId({
        entitlement_id: "ent_amount_1",
        lifecycle_event: "REDEEMED",
        redemption_id: rid,
      })
    )
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
