/**
 * refund-entitlement.test.ts — Story 4.3 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 refund).
 *
 * Pokrywa DWA mechanizmy zwrotu + granice fail-closed:
 *   AC1 (a) — odstąpienie 14 dni → pełny zwrot niewykorzystanego, routing przez
 *             wireEntitlementTransition (3.4); po oknie ⇒ fail-closed; prawo gaśnie
 *             WYŁĄCZNIE przy REDEEMED_FULL (reuse 4.1).
 *   AC2 (b) — zwrot salda `remaining` po partial (art. 385¹ KC); copy rozróżnia (a)/(b).
 *   AC3     — RODO art. 26 carry-forward KONSUMUJE istniejący kontrakt DSAR (NIE buduje).
 *   ADR-139 §Granice — refund posting = NO posting + alarm (deferred architectural),
 *             nawet przy bramce „on" (BRAK payloadu postingu — fail-closed).
 *   Idempotencja — replay (REFUNDED terminal) ⇒ no-op (jeden zwrot, NIE podwaja).
 *   Fail-closed — nielegalny stan/typ odrzucony PRZED efektami ubocznymi.
 */

import { describe, it, expect } from "@jest/globals"

import {
  EntitlementInstanceState,
  EntitlementType,
  snapshotPolicy,
} from "../models/entitlement"
import {
  RefundEntitlementOperation,
  InMemoryRefundEntitlementStore,
  EntitlementNotRefundableError,
  ENTITLEMENT_REFUNDED_EVENT_TYPE,
  type RefundableEntitlement,
  type RefundEntitlementDeps,
  type RefundLifecycleEnvelope,
} from "../workflows/refund-entitlement"
import {
  determineRefundMechanism,
  isWithinWithdrawalWindow,
  resolveRefundChannel,
  resolveRefundWindowDays,
  buildRefundCopy,
  assertRefundCopyDistinct,
  buildDsarCarryForward,
  DSAR_CONTRACT_REF,
  DSAR_CARRY_FORWARD_ADR,
  WITHDRAWAL_WINDOW_DAYS,
  RefundWithdrawalWindowError,
  RefundMechanismError,
  RefundAmountError,
  RefundChannelError,
  RefundCopyAmbiguityError,
  RefundBalanceInvariantError,
} from "../entitlement-refund"
import type {
  TransitionEventEnvelope,
  PostingActivationGate,
  TransitionLedgerWriter,
} from "../entitlement-transition-wiring"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date("2026-06-02T12:00:00.000Z")

function makeEntitlement(
  overrides: Partial<RefundableEntitlement> = {}
): RefundableEntitlement {
  return {
    id: "ent_refund_001",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    state: EntitlementInstanceState.ACTIVE,
    remaining_amount: 10000,
    policy_snapshot: snapshotPolicy({
      validity_months: 12,
      refund_channel: "original_payment",
      currency_code: "PLN",
    }),
    vat_classification: "MPV",
    issued_amount_currency: "PLN",
    issued_at: NOW, // domyślnie w oknie 14 dni
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    vendor_id: "seller_bb",
    location_id: null,
    ...overrides,
  }
}

function makeOp(
  store: InMemoryRefundEntitlementStore,
  opts: {
    gate?: PostingActivationGate
    writer?: TransitionLedgerWriter
    withDeferralSink?: boolean
  } = {}
): {
  op: RefundEntitlementOperation
  emitted: Array<TransitionEventEnvelope | RefundLifecycleEnvelope>
  deferralAlarms: number
} {
  const emitted: Array<TransitionEventEnvelope | RefundLifecycleEnvelope> = []
  let deferralAlarms = 0
  const deps: RefundEntitlementDeps = {
    store,
    events: {
      async emit(event) {
        emitted.push(event)
      },
    },
    clock: () => NOW,
  }
  if (opts.gate) deps.postingActivation = opts.gate
  if (opts.writer) deps.ledgerWriter = opts.writer
  if (opts.withDeferralSink) {
    deps.deferralSink = {
      async alarm() {
        deferralAlarms++
      },
    }
  }
  return { op: new RefundEntitlementOperation(deps), emitted, deferralAlarms: 0 }
}

// ---------------------------------------------------------------------------
// AC1 — mechanizm (a) odstąpienie 14 dni → pełny zwrot + reverse routing
// ---------------------------------------------------------------------------

describe("refund (a) — odstąpienie 14 dni (AC1)", () => {
  it("voucher niewykorzystany w oknie ⇒ PEŁNY zwrot + tranzycja → REFUNDED", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const { op, emitted } = makeOp(store)

    const res = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_001",
      mechanism: "withdrawal",
      currency: "PLN",
    })

    expect(res.mechanism).toBe("withdrawal")
    expect(res.refunded_amount_minor).toBe(10000) // pełny zwrot (== remaining == issued)
    expect(res.fully_unused).toBe(true)
    expect(res.withdrawal_right_extinguished).toBe(false)
    expect(res.new_state).toBe(EntitlementInstanceState.REFUNDED)
    expect(res.idempotent).toBe(false)
    expect(store.get("ent_refund_001")?.state).toBe(
      EntitlementInstanceState.REFUNDED
    )

    // Tranzycja routuje przez okablowanie 3.4: 2 audyty (REFUND_REQUESTED, REFUNDED)
    const audits = store.listAudits()
    expect(audits).toHaveLength(2)
    expect(audits[0].to_state).toBe(EntitlementInstanceState.REFUND_REQUESTED)
    expect(audits[1].from_state).toBe(EntitlementInstanceState.REFUND_REQUESTED)
    expect(audits[1].to_state).toBe(EntitlementInstanceState.REFUNDED)

    // Event tranzycji + rich refund event wyemitowane post-COMMIT.
    const refundEvents = emitted.filter(
      (e) => (e as RefundLifecycleEnvelope).event_type === ENTITLEMENT_REFUNDED_EVENT_TYPE
    )
    expect(refundEvents).toHaveLength(1)
  })

  it("po oknie 14 dni ⇒ FAIL-CLOSED (RefundWithdrawalWindowError, brak efektów)", async () => {
    const store = new InMemoryRefundEntitlementStore([
      makeEntitlement({ issued_at: new Date(NOW.getTime() - 20 * DAY_MS) }),
    ])
    const { op, emitted } = makeOp(store)

    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_late",
        mechanism: "withdrawal",
      })
    ).rejects.toBeInstanceOf(RefundWithdrawalWindowError)

    // Fail-closed: ZERO efektów ubocznych (brak tranzycji/audytu/eventu).
    expect(store.get("ent_refund_001")?.state).toBe(
      EntitlementInstanceState.ACTIVE
    )
    expect(store.listAudits()).toHaveLength(0)
    expect(store.listRefundEvents()).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  it("prawo odstąpienia respektuje REDEEMED_FULL z 4.1 ⇒ fail-closed (a)", async () => {
    const store = new InMemoryRefundEntitlementStore(
      [
        makeEntitlement({
          state: EntitlementInstanceState.REDEEMED_FULL,
          remaining_amount: 0,
        }),
      ],
      { ent_refund_001: 10000 }
    )
    const { op } = makeOp(store)

    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_full",
        mechanism: "withdrawal",
      })
    ).rejects.toMatchObject({
      name: "RefundMechanismError",
      reason: "withdrawal_right_extinguished",
    })
    expect(store.get("ent_refund_001")?.state).toBe(
      EntitlementInstanceState.REDEEMED_FULL
    )
  })

  it("próba (a) po jakimkolwiek redeem ⇒ kieruje do (b) (RefundMechanismError partially_redeemed)", async () => {
    const store = new InMemoryRefundEntitlementStore(
      [
        makeEntitlement({
          state: EntitlementInstanceState.REDEEMED_PARTIAL,
          remaining_amount: 4000,
        }),
      ],
      { ent_refund_001: 10000 }
    )
    const { op } = makeOp(store)

    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_partial_a",
        mechanism: "withdrawal",
      })
    ).rejects.toMatchObject({
      name: "RefundMechanismError",
      reason: "partially_redeemed",
    })
    expect(store.listAudits()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC2 — mechanizm (b) zwrot salda po partial + copy rozróżnia (a)/(b)
// ---------------------------------------------------------------------------

describe("refund (b) — zwrot salda po partial (AC2)", () => {
  it("zwraca remaining (NIE ponad) + tranzycja → REFUNDED", async () => {
    const store = new InMemoryRefundEntitlementStore(
      [
        makeEntitlement({
          state: EntitlementInstanceState.REDEEMED_PARTIAL,
          remaining_amount: 4000,
        }),
      ],
      { ent_refund_001: 10000 }
    )
    const { op } = makeOp(store)

    const res = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_bal",
      mechanism: "balance",
    })

    expect(res.mechanism).toBe("balance")
    expect(res.refunded_amount_minor).toBe(4000) // remaining, NIGDY ponad
    expect(res.fully_unused).toBe(false)
    expect(res.new_state).toBe(EntitlementInstanceState.REFUNDED)
    expect(store.get("ent_refund_001")?.state).toBe(
      EntitlementInstanceState.REFUNDED
    )
  })

  it("copy rozróżnia (a) od (b) — podstawa i kwota NIGDY mylące (UX-DR-14)", () => {
    const a = buildRefundCopy({
      mechanism: "withdrawal",
      refunded_amount_minor: 10000,
      currency: "PLN",
    })
    const b = buildRefundCopy({
      mechanism: "balance",
      refunded_amount_minor: 4000,
      currency: "PLN",
    })
    // Podstawa + komunikat różne; brak sygnału przepadku (assertNoForfeitureCopy w buildRefundCopy).
    expect(a.basis).not.toBe(b.basis)
    expect(a.message).not.toBe(b.message)
    expect(() => assertRefundCopyDistinct(a, b)).not.toThrow()
  })

  it("assertRefundCopyDistinct rzuca gdy copy nierozróżnialne", () => {
    const a = buildRefundCopy({
      mechanism: "withdrawal",
      refunded_amount_minor: 10000,
      currency: "PLN",
    })
    expect(() => assertRefundCopyDistinct(a, a)).toThrow(RefundCopyAmbiguityError)
  })

  it("zwrot salda z remaining=0 ⇒ fail-closed (RefundAmountError)", async () => {
    const store = new InMemoryRefundEntitlementStore(
      [
        makeEntitlement({
          state: EntitlementInstanceState.SETTLED,
          remaining_amount: 0,
        }),
      ],
      { ent_refund_001: 10000 }
    )
    const { op } = makeOp(store)
    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_zero",
        mechanism: "balance",
      })
    ).rejects.toBeInstanceOf(RefundAmountError)
  })
})

// ---------------------------------------------------------------------------
// AC3 — RODO art. 26 carry-forward KONSUMUJE istniejący kontrakt DSAR
// ---------------------------------------------------------------------------

describe("refund — RODO art. 26 carry-forward (AC3)", () => {
  it("wynik referencjonuje istniejący kontrakt DSAR (NIE buduje nowego kanału)", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const { op } = makeOp(store)
    const res = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_dsar",
      mechanism: "withdrawal",
    })
    expect(res.dsar_carry_forward.contract_ref).toBe(DSAR_CONTRACT_REF)
    expect(res.dsar_carry_forward.adr_ref).toBe(DSAR_CARRY_FORWARD_ADR)
    expect(res.dsar_carry_forward.dsar_procedure_field).toBe("dsar_procedure")
    expect(res.dsar_carry_forward.response_sla_field).toBe("response_sla_days")
    expect(res.dsar_carry_forward.scope.market_id).toBe("bonbeauty")
  })

  it("buildDsarCarryForward jest czystą referencją (pola kontraktu, scope per administrator)", () => {
    const cf = buildDsarCarryForward({
      market_id: "bonbeauty",
      sales_channel_id: "sc_bonbeauty",
    })
    expect(cf.contract_ref).toContain("consent-privacy-dsar-integrity.v1")
    expect(cf.scope.sales_channel_id).toBe("sc_bonbeauty")
  })
})

// ---------------------------------------------------------------------------
// ADR-139 §Granice — refund posting FAIL-CLOSED (NO posting + alarm/deferral)
// ---------------------------------------------------------------------------

describe("refund — posting derecognition FAIL-CLOSED (ADR-139 §Granice)", () => {
  it("posting hook audit-only (attempted:false) + marker deferralu (runtime_enabled=false)", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const { op } = makeOp(store)
    const res = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_gate_off",
      mechanism: "withdrawal",
    })
    expect(res.posting.attempted).toBe(false)
    expect(res.posting.persisted).toBe(false)
    expect(res.posting_deferred.deferred).toBe(true)
    expect(res.posting_deferred.requires_adr).toContain("ADR-required")
    expect(res.posting_deferred.unposted_amount_minor).toBe(10000)
  })

  it("nawet z bramką on + writerem ⇒ BRAK postingu (fail-closed, NIE wymyśla księgowania)", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const writes: unknown[] = []
    const writer: TransitionLedgerWriter = {
      async write(req) {
        writes.push(req)
        return { applied: true, deduped: false, transaction_id: "tx_should_not_happen" }
      },
    }
    const gateOn: PostingActivationGate = {
      runtimeEnabled: true,
      isMarketActivated: () => true,
    }
    const { op } = makeOp(store, { gate: gateOn, writer })

    const res = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_gate_on",
      mechanism: "withdrawal",
    })

    // Refund NIE przekazuje payloadu postingu ⇒ writer NIGDY nie wołany, mimo bramki on.
    expect(writes).toHaveLength(0)
    expect(res.posting.attempted).toBe(false)
    expect(res.posting_deferred.deferred).toBe(true)
  })

  it("alarm deferralu emitowany przez deferralSink (best-effort)", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    let alarms = 0
    const op = new RefundEntitlementOperation({
      store,
      events: { async emit() {} },
      clock: () => NOW,
      deferralSink: {
        async alarm() {
          alarms++
        },
      },
    })
    await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_alarm",
      mechanism: "withdrawal",
    })
    expect(alarms).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Idempotencja — replay (REFUNDED terminal) ⇒ no-op (jeden zwrot)
// ---------------------------------------------------------------------------

describe("refund — idempotencja (replay ⇒ no-op)", () => {
  it("powtórny refund (REFUNDED) ⇒ idempotent, ZERO podwójnego zwrotu/tranzycji", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const { op } = makeOp(store)

    const first = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_idem",
      mechanism: "withdrawal",
    })
    expect(first.idempotent).toBe(false)
    const auditsAfterFirst = store.listAudits().length

    const second = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_idem",
      mechanism: "withdrawal",
    })
    expect(second.idempotent).toBe(true)
    expect(second.posting.deduped).toBe(true)
    expect(second.new_state).toBe(EntitlementInstanceState.REFUNDED)
    // ZERO nowych audytów / rich-eventów na ścieżce replay.
    expect(store.listAudits().length).toBe(auditsAfterFirst)
    expect(store.listRefundEvents()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Fail-closed — nielegalny stan/typ/kanał odrzucony PRZED efektami
// ---------------------------------------------------------------------------

describe("refund — fail-closed guardy", () => {
  it("nielegalny stan źródłowy (VOIDED) ⇒ EntitlementNotRefundableError", async () => {
    const store = new InMemoryRefundEntitlementStore([
      makeEntitlement({ state: EntitlementInstanceState.VOIDED }),
    ])
    const { op } = makeOp(store)
    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_void",
        mechanism: "balance",
      })
    ).rejects.toBeInstanceOf(EntitlementNotRefundableError)
    expect(store.listAudits()).toHaveLength(0)
  })

  it("nieznany kanał zwrotu ⇒ RefundChannelError (fail-closed)", async () => {
    const store = new InMemoryRefundEntitlementStore([
      makeEntitlement({
        policy_snapshot: snapshotPolicy({
          validity_months: 12,
          refund_channel: "bank_transfer", // spoza REFUND_CHANNELS
          currency_code: "PLN",
        }),
      }),
    ])
    const { op } = makeOp(store)
    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_badchan",
        mechanism: "withdrawal",
      })
    ).rejects.toBeInstanceOf(RefundChannelError)
  })

  it("brak market_id ⇒ fail-loud (NFR3 izolacja per-market)", async () => {
    const store = new InMemoryRefundEntitlementStore([
      makeEntitlement({ market_id: null }),
    ])
    const { op } = makeOp(store)
    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_nomarket",
        mechanism: "withdrawal",
      })
    ).rejects.toBeInstanceOf(EntitlementNotRefundableError)
  })
})

// ---------------------------------------------------------------------------
// Czyste helpery (determinacja / okno / kanał / window-days)
// ---------------------------------------------------------------------------

describe("entitlement-refund — czyste helpery", () => {
  it("isWithinWithdrawalWindow: w oknie / po oknie / data wstecz", () => {
    const issued = new Date("2026-06-01T00:00:00.000Z")
    expect(isWithinWithdrawalWindow(issued, new Date("2026-06-10T00:00:00.000Z"))).toBe(true)
    expect(isWithinWithdrawalWindow(issued, new Date("2026-06-20T00:00:00.000Z"))).toBe(false)
    // now < issued ⇒ fail-closed false
    expect(isWithinWithdrawalWindow(issued, new Date("2026-05-30T00:00:00.000Z"))).toBe(false)
  })

  it("resolveRefundWindowDays: default 14 / override z polityki", () => {
    expect(resolveRefundWindowDays({})).toBe(WITHDRAWAL_WINDOW_DAYS)
    expect(resolveRefundWindowDays({ refund_window_days: 30 })).toBe(30)
    expect(resolveRefundWindowDays({ withdrawal: { window_days: 7 } })).toBe(7)
  })

  it("resolveRefundChannel: fail-closed na nieznanym/brakującym kanale", () => {
    expect(resolveRefundChannel({ refund_channel: "store_credit" })).toBe("store_credit")
    expect(() => resolveRefundChannel({})).toThrow(RefundChannelError)
    expect(() => resolveRefundChannel({ refund_channel: "paypal" })).toThrow(
      RefundChannelError
    )
  })

  it("determineRefundMechanism (a): pełny zwrot niewykorzystanego w oknie", () => {
    const d = determineRefundMechanism({
      requested: "withdrawal",
      state: EntitlementInstanceState.ACTIVE,
      remaining_minor: 10000,
      issued_gross_minor: 10000,
      issued_at: NOW,
      now: NOW,
    })
    expect(d.mechanism).toBe("withdrawal")
    expect(d.refunded_amount_minor).toBe(10000)
    expect(d.fully_unused).toBe(true)
  })

  it("determineRefundMechanism (b): zwrot remaining dozwolony po partial", () => {
    const d = determineRefundMechanism({
      requested: "balance",
      state: EntitlementInstanceState.REDEEMED_PARTIAL,
      remaining_minor: 4000,
      issued_gross_minor: 10000,
      issued_at: NOW,
      now: NOW,
    })
    expect(d.mechanism).toBe("balance")
    expect(d.refunded_amount_minor).toBe(4000)
    expect(d.fully_unused).toBe(false)
  })

  it("determineRefundMechanism (a) po oknie ⇒ rzuca RefundWithdrawalWindowError", () => {
    expect(() =>
      determineRefundMechanism({
        requested: "withdrawal",
        state: EntitlementInstanceState.ACTIVE,
        remaining_minor: 10000,
        issued_gross_minor: 10000,
        issued_at: new Date(NOW.getTime() - 30 * DAY_MS),
        now: NOW,
      })
    ).toThrow(RefundWithdrawalWindowError)
  })
})

// ---------------------------------------------------------------------------
// M1 — inwariant remaining ≤ issued_gross (fail-closed, over-refund niemożliwy)
// ---------------------------------------------------------------------------

describe("refund M1 — inwariant remaining ≤ issued_gross", () => {
  it("determineRefundMechanism: remaining > issued_gross ⇒ RefundBalanceInvariantError", () => {
    expect(() =>
      determineRefundMechanism({
        requested: "withdrawal",
        state: EntitlementInstanceState.ACTIVE,
        remaining_minor: 12000, // > issued_gross
        issued_gross_minor: 10000,
        issued_at: NOW,
        now: NOW,
      })
    ).toThrow(RefundBalanceInvariantError)
  })

  it("over-refund przez caller: remaining > issued_gross z redemption ⇒ fail-closed", async () => {
    // remaining=10000, issuedGross=8000 (z redempcji) ⇒ naruszony inwariant
    const store = new InMemoryRefundEntitlementStore(
      [makeEntitlement({ remaining_amount: 10000 })],
      { ent_refund_001: 8000 } // issued_gross < remaining
    )
    const { op } = makeOp(store)
    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_overrefund",
        mechanism: "withdrawal",
      })
    ).rejects.toBeInstanceOf(RefundBalanceInvariantError)
    // fail-closed: ZERO efektów ubocznych
    expect(store.listAudits()).toHaveLength(0)
    expect(store.get("ent_refund_001")?.state).toBe(EntitlementInstanceState.ACTIVE)
  })
})

// ---------------------------------------------------------------------------
// M2 — granularność idempotencji domena (REFUNDED) vs refund_id (payment key)
// ---------------------------------------------------------------------------

describe("refund M2 — granularność idempotencji domena↔płatność", () => {
  it("replay z innym refund_id na REFUNDED ⇒ fail-closed (EntitlementNotRefundableError)", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const { op } = makeOp(store)

    // Pierwsza operacja — sukces
    await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_original",
      mechanism: "withdrawal",
    })

    // Replay z INNYM refund_id ⇒ fail-closed (ryzyko podwójnego zwrotu płatności po E6)
    await expect(
      op.refund({
        entitlement_id: "ent_refund_001",
        refund_id: "rf_different", // ← inny refund_id na REFUNDED
        mechanism: "withdrawal",
      })
    ).rejects.toBeInstanceOf(EntitlementNotRefundableError)
  })
})

// ---------------------------------------------------------------------------
// L1 — replay zwraca wartości oryginalnego refundu (NIE bieżącego inputu)
// ---------------------------------------------------------------------------

describe("refund L1 — replay echo oryginalnych wartości", () => {
  it("replay zwraca mechanizm/kwotę z utrwalonej koperty, nie z bieżącego inputu", async () => {
    const store = new InMemoryRefundEntitlementStore([makeEntitlement()])
    const { op } = makeOp(store)

    // Pierwsza operacja — withdrawal, kwota 10000
    const original = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_l1_orig",
      mechanism: "withdrawal",
    })

    // Replay z tym samym refund_id, ale innym mechanism w parametrach (ignorowany)
    const replay = await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_l1_orig", // ten sam
      mechanism: "balance", // ← inny, ignorowany — zwróć ORYGINALNY
    })

    expect(replay.idempotent).toBe(true)
    expect(replay.mechanism).toBe(original.mechanism) // "withdrawal", nie "balance"
    expect(replay.refunded_amount_minor).toBe(original.refunded_amount_minor) // 10000 z oryginału
    expect(replay.copy.basis).toBe(original.copy.basis) // oryginalna podstawa
  })
})

// ---------------------------------------------------------------------------
// L2 — remaining_amount zerowane przy REFUNDED (defense-in-depth)
// ---------------------------------------------------------------------------

describe("refund L2 — remaining_amount = 0 po REFUNDED", () => {
  it("po przejściu do REFUNDED remaining_amount wynosi 0 (spójność stan↔saldo)", async () => {
    const store = new InMemoryRefundEntitlementStore(
      [makeEntitlement({ remaining_amount: 4000 })],
      { ent_refund_001: 10000 }
    )
    const { op } = makeOp(store)

    await op.refund({
      entitlement_id: "ent_refund_001",
      refund_id: "rf_l2",
      mechanism: "balance",
    })

    const ent = store.get("ent_refund_001")
    expect(ent?.state).toBe(EntitlementInstanceState.REFUNDED)
    expect(ent?.remaining_amount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// L3 — granica okna 14 dni (dokładnie 14 dób inclusive, +1ms poza)
// ---------------------------------------------------------------------------

describe("refund L3 — granica okna 14 dni (isWithinWithdrawalWindow)", () => {
  it("dokładnie 14 × DAY_MS od emisji = inclusive (mieści się)", () => {
    const issued = new Date("2026-06-01T00:00:00.000Z")
    const exactly14 = new Date(issued.getTime() + WITHDRAWAL_WINDOW_DAYS * DAY_MS)
    expect(isWithinWithdrawalWindow(issued, exactly14)).toBe(true)
  })

  it("14 × DAY_MS + 1ms od emisji = poza oknem (fail-closed)", () => {
    const issued = new Date("2026-06-01T00:00:00.000Z")
    const over14 = new Date(issued.getTime() + WITHDRAWAL_WINDOW_DAYS * DAY_MS + 1)
    expect(isWithinWithdrawalWindow(issued, over14)).toBe(false)
  })
})
