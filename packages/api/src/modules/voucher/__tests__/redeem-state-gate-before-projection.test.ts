/**
 * v1.16.0 Story 3.8 AC1 — anty-regresja kolejności (ADR-219 §4 człon 1).
 *
 * Bramka stanu UPRAWNIENIA (`REDEEMABLE_SOURCE_STATES.has(ent.state)`) MUSI biec
 * PRZED projekcją `voucher_status` (`deps.writeProjection`) w TEJ SAMEJ
 * transakcji — dla obu tras genezy ADR-174:
 *   - Path Y / live-issue: wiersz powstaje w `ISSUED` ⇒ odmowa stanowa, ZERO projekcji;
 *   - captured-path (`payment.captured`): wiersz powstaje w `ACTIVE` ⇒ bramka, potem projekcja.
 *
 * Kolejność jest dziś poprawna wyłącznie dzięki kolejności wywołań (DW-15-210),
 * nie kontraktowi — ten test jest tym kontraktem. Asertuje REJESTR WYWOŁAŃ
 * (wywołanie SAMEJ bramki `REDEEMABLE_SOURCE_STATES.has` vs wywołanie
 * `writeProjection`), nie sam wynik.
 *
 * Review-fix R-1/R-7 (checkpoint 2026-11-14, D-6): poprzednia wersja rejestrowała
 * KAŻDY odczyt `ent.state` (Proxy), a odczyty stanu w kroku 1 tranzycji też leżą
 * przed projekcją — mutant „bramka za projekcją” zostawiał test captured-path
 * zielonym. Teraz rejestrowane jest wywołanie bramki (spy na `has` eksportowanego
 * zbioru), więc przeniesienie bramki za `writeProjection` czerwieni test 2.
 * Mutant i jego diff: evidence/3-8/mutant-gate-after-projection.md.
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals"
import { EntitlementInstanceState, EntitlementType } from "../models/entitlement"
import {
  RedeemPartialEntitlementOperation,
  InMemoryRedeemPartialStore,
  RedeemEntitlementStateError,
  REDEEMABLE_SOURCE_STATES,
  type ProjectionQueryable,
  type RedeemableAmountEntitlement,
  type RedeemPartialStore,
  type RedeemPartialTx,
} from "../workflows/redeem-partial-entitlement"

const CODE = "GP-ORDER-0001"
const NOW = new Date("2026-11-14T10:00:00.000Z")

type Call = { kind: "gate" | "projection"; tx: number }

/**
 * Store rejestrujący: deleguje do `InMemoryRedeemPartialStore`, ale
 *  - pamięta numer BIEŻĄCEJ tx (`activeTx`), żeby wywołanie bramki dało się
 *    przypisać do transakcji,
 *  - `projectionClient()` zwraca klienta oznaczonego numerem tx N,
 * więc test widzi kolejność ORAZ to, że projekcja dostała klienta TEJ SAMEJ tx.
 */
class RecordingStore implements RedeemPartialStore {
  calls: Call[] = []
  activeTx = 0
  private txSeq = 0
  constructor(readonly inner: InMemoryRedeemPartialStore) {}

  async withTransaction<T>(fn: (tx: RedeemPartialTx) => Promise<T>): Promise<T> {
    const txId = ++this.txSeq
    return this.inner.withTransaction(async (tx) => {
      const proxied = new Proxy(tx, {
        get: (t, p, r) => {
          if (p === "projectionClient") {
            return () =>
              ({ __tx: txId, query: async () => ({ rows: [], rowCount: 0 }) }) as unknown as ProjectionQueryable
          }
          const v = Reflect.get(t, p, r)
          return typeof v === "function" ? v.bind(t) : v
        },
      })
      this.activeTx = txId
      try {
        return await fn(proxied)
      } finally {
        this.activeTx = 0
      }
    })
  }
}

/**
 * Spy na SAMĄ bramkę: `REDEEMABLE_SOURCE_STATES.has(state)`. Rejestruje tylko
 * wywołania z tx (activeTx > 0) — inne użycia zbioru poza operacją nie liczą się.
 */
function spyGate(store: RecordingStore) {
  const gate = REDEEMABLE_SOURCE_STATES as Set<EntitlementInstanceState>
  const original = Set.prototype.has
  return jest.spyOn(gate, "has").mockImplementation(function (this: Set<EntitlementInstanceState>, v) {
    if (store.activeTx > 0) store.calls.push({ kind: "gate", tx: store.activeTx })
    return original.call(gate, v)
  })
}

afterEach(() => {
  jest.restoreAllMocks()
})

function row(state: EntitlementInstanceState): RedeemableAmountEntitlement {
  return {
    id: "ent_3_8",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    state,
    remaining_amount: 300,
    policy_snapshot: { transferability: "bearer", voucher_code: CODE },
    vat_classification: "MPV",
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    vendor_id: null,
    location_id: null,
    recipient_customer_id: null,
  }
}

function setup(state: EntitlementInstanceState, projectionThrows = false) {
  const inner = new InMemoryRedeemPartialStore([row(state)])
  const store = new RecordingStore(inner)
  spyGate(store)
  const projectionTx: number[] = []
  const op = new RedeemPartialEntitlementOperation({
    store,
    events: { emit: async () => undefined },
    clock: () => NOW,
    writeProjection: async (client) => {
      const txId = (client as unknown as { __tx: number }).__tx
      projectionTx.push(txId)
      store.calls.push({ kind: "projection", tx: txId })
      if (projectionThrows) throw new Error("projection failed")
    },
  })
  const input = {
    voucher_code: CODE,
    amount_minor: 100,
    idempotency_key: "k-3-8",
    currency: "PLN",
    voucher_net_minor: 244,
    voucher_vat_minor: 56,
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
  }
  return { op, store, inner, projectionTx, input }
}

describe("Story 3.8 AC1 — bramka stanu uprawnienia przed projekcją voucher_status (ADR-219 §4 człon 1)", () => {
  it("Path Y (geneza ISSUED): odmowa stanowa, projekcja NIE wywołana, stan nietknięty", async () => {
    const { op, store, inner, projectionTx, input } = setup(EntitlementInstanceState.ISSUED)
    await expect(op.redeem(input)).rejects.toBeInstanceOf(RedeemEntitlementStateError)
    expect(projectionTx).toEqual([])
    // Odmowa pochodzi z BRAMKI (wywołana dokładnie raz), nie z dalszego kroku.
    expect(store.calls.filter((c) => c.kind === "gate")).toHaveLength(1)
    expect(store.calls.some((c) => c.kind === "projection")).toBe(false)
    expect(inner.get("ent_3_8")!.state).toBe(EntitlementInstanceState.ISSUED)
    expect(inner.listAudits()).toHaveLength(0)
  })

  it("captured-path (geneza ACTIVE): bramka czyta stan PRZED projekcją, w tej samej tx", async () => {
    const { op, store, projectionTx, input } = setup(EntitlementInstanceState.ACTIVE)
    await op.redeem(input)
    expect(projectionTx).toHaveLength(1)
    const pIdx = store.calls.findIndex((c) => c.kind === "projection")
    const gateIdx = store.calls.findIndex((c) => c.kind === "gate")
    expect(store.calls.filter((c) => c.kind === "gate")).toHaveLength(1)
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeLessThan(pIdx)
    // Ta sama transakcja: odczyt stanu i klient projekcji z tej samej tx.
    expect(store.calls[gateIdx].tx).toBe(store.calls[pIdx].tx)
  })

  it("captured-path: rzut z projekcji wycofuje CAŁĄ tx (fakt i projekcja są jedną transakcją)", async () => {
    const { op, inner, input } = setup(EntitlementInstanceState.ACTIVE, true)
    await expect(op.redeem(input)).rejects.toThrow("projection failed")
    const ent = inner.get("ent_3_8")!
    expect(ent.state).toBe(EntitlementInstanceState.ACTIVE)
    expect(ent.remaining_amount).toBe(300)
    expect(inner.listRedemptions()).toHaveLength(0)
    expect(inner.listAudits()).toHaveLength(0)
  })
})
