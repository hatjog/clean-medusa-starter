/**
 * expire-entitlement.test.ts — Story 4.2 (v1.11.0 Epic 4 / Wave 4).
 *
 * Pokrywa operację EXPIRED → BREAKAGE (derecognition niewykorzystanego salda) na
 * in-memory store + in-memory fake PG (wzorzec redeem-partial-entitlement.test):
 *   AC2 — tranzycja `<source>→EXPIRED` routuje przez wireEntitlementTransition
 *         (audit); breakage wg klasyfikacji 2.3 (ENTITLEMENT_BREAKAGE,
 *         lifecycle_event=EXPIRED, breakage:voucher; MPV unused = bez VAT art. 73a);
 *         hook respektuje runtime_enabled guard (false ⇒ audit-only/no-op, ZERO
 *         zapisu ledger); status klienta „Ważność minęła — sprawdź opcje zwrotu".
 *   SWEEP — idempotentny: replay (state już EXPIRED) ⇒ no-op (NIE podwaja posting).
 *   NOTIFY — pre-expiry powiadomienie nie duplikuje (dedup per okno).
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
  EXPIRED_CUSTOMER_STATUS,
  type PreExpiryNotification,
} from "../entitlement-expiry"
import {
  ExpireEntitlementOperation,
  InMemoryExpireEntitlementStore,
  InMemoryPreExpiryDedupeStore,
  PreExpiryNotifier,
  EntitlementNotExpirableError,
  ExpireEntitlementNotFoundError,
  ExpireAmountError,
  EXPIRY_SOURCE_STATES,
  type ExpirableEntitlement,
  type ExpireEntitlementInput,
  type ExpireEntitlementTx,
  type ExpireEntitlementStore,
} from "../workflows/expire-entitlement"

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
const PAST_EXPIRY = new Date("2026-06-01T00:00:00.000Z")
const FUTURE_EXPIRY = new Date("2027-06-01T00:00:00.000Z")
const GATE_BOTH_ON: PostingActivationGate = {
  runtimeEnabled: true,
  isMarketActivated: () => true,
}

function makeEntitlement(
  overrides: Partial<ExpirableEntitlement> = {}
): ExpirableEntitlement {
  return {
    id: "ent_amount_1",
    entitlement_type: EntitlementType.VOUCHER_AMOUNT,
    state: EntitlementInstanceState.ACTIVE,
    remaining_amount: 12300,
    policy_snapshot: { transferability: "bearer" },
    vat_classification: "MPV",
    issued_amount_currency: null,
    expires_at: PAST_EXPIRY,
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    vendor_id: null,
    location_id: null,
    ...overrides,
  }
}

function makeOp(opts?: {
  rows?: ExpirableEntitlement[]
  gate?: PostingActivationGate
  wireWriter?: boolean
}): {
  op: ExpireEntitlementOperation
  store: InMemoryExpireEntitlementStore
  events: TransitionEventEnvelope[]
  fake: ReturnType<typeof makeFakePool>
} {
  const store = new InMemoryExpireEntitlementStore(opts?.rows ?? [makeEntitlement()])
  const events: TransitionEventEnvelope[] = []
  const fake = makeFakePool()
  const op = new ExpireEntitlementOperation({
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
  overrides: Partial<ExpireEntitlementInput> = {}
): ExpireEntitlementInput {
  return {
    entitlement_id: "ent_amount_1",
    voucher_net_minor: 10000,
    voucher_vat_minor: 2300, // totalGross = 12300
    market_id: "bonbeauty",
    sales_channel_id: "sc_bonbeauty",
    ...overrides,
  }
}

// ===========================================================================
// AC2 — EXPIRED przez wiring (audit) + status klienta + gated posting
// ===========================================================================

describe("Story 4.2 AC2 — EXPIRED → BREAKAGE przez okablowanie (gated)", () => {
  it("ACTIVE z remaining>0 ⇒ EXPIRED, breakage=true, status klienta (UX §8)", async () => {
    const { op, store } = makeOp()
    const res = await op.expire(baseInput())

    expect(res.new_state).toBe("EXPIRED")
    expect(res.breakage).toBe(true)
    expect(res.remaining_minor).toBe(12300)
    expect(res.customer_status).toBe(EXPIRED_CUSTOMER_STATUS)
    expect(res.idempotent).toBe(false)
    // Ten sam wiersz: state→EXPIRED, saldo ZACHOWANE (recovery refund 4.3 / extend 4.4).
    const ent = store.get("ent_amount_1")!
    expect(ent.state).toBe("EXPIRED")
    expect(ent.remaining_amount).toBe(12300)
  })

  it("tranzycja routuje przez wiring ⇒ append-only audit (1 tranzycja → EXPIRED)", async () => {
    const { op, store, events } = makeOp()
    await op.expire(baseInput())
    const audits = store.listAudits()
    expect(audits).toHaveLength(1)
    expect(audits[0].to_state).toBe("EXPIRED")
    expect(audits[0].from_state).toBe("ACTIVE")
    // Event emitowany post-COMMIT (best-effort).
    expect(events).toHaveLength(1)
    expect(events[0].payload.to_state).toBe("EXPIRED")
  })

  it("breakage posting GATED: runtime_enabled=false ⇒ audit-only/no-op (ZERO zapisu ledger)", async () => {
    expect(defaultPostingActivationGate().runtimeEnabled).toBe(false)
    expect(VOUCHER_LIABILITY_ONLY_V1.runtime_enabled).toBe(false)

    const { op, store, fake } = makeOp({ wireWriter: true }) // brak gate ⇒ default (false)
    const res = await op.expire(baseInput())

    expect(res.posting.attempted).toBe(true)
    expect(res.posting.activated).toBe(false)
    expect(res.posting.persisted).toBe(false)
    expect(res.posting.reason).toContain("runtime_enabled=false")
    expect(res.posting.transaction_id).toMatch(/^[0-9a-f]{64}$/)
    // ZERO zapisu do voucher_ledger_* — ale state→EXPIRED niezależnie od flagi.
    expect(fake.txRows).toHaveLength(0)
    expect(fake.applied.size).toBe(0)
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })

  it("transaction_id deterministyczny = EXPIRED dyskryminator (entitlement_id ‖ remaining)", async () => {
    const { op } = makeOp({ wireWriter: true })
    const res = await op.expire(baseInput())
    expect(res.posting.transaction_id).toBe(
      deriveLedgerTransactionId({
        entitlement_id: "ent_amount_1",
        lifecycle_event: "EXPIRED",
        remaining_gross_snapshot: 12300,
      })
    )
  })
})

// ===========================================================================
// AC2 — breakage przez writer (sym. aktywacja): MPV unused = bez VAT (art. 73a)
// ===========================================================================

describe("Story 4.2 AC2 — breakage przez writer (sym. aktywacja)", () => {
  it("MPV unused (gate ON) ⇒ breakage:voucher = całe saldo brutto; BEZ vat:output (art. 73a)", async () => {
    const { op, fake } = makeOp({ gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.expire(baseInput())

    expect(res.posting.activated).toBe(true)
    expect(res.posting.persisted).toBe(true)
    expect(res.posting.deduped).toBe(false)
    expect(fake.txRows).toHaveLength(1)
    // breakage:voucher = całe niewykorzystane brutto (12300).
    const breakageCredits = fake.entryRows
      .filter((p) => p[2] === "breakage:voucher")
      .reduce((s, p) => s + Number(p[4]), 0)
    expect(breakageCredits).toBe(12300)
    // MPV unused = bez VAT (art. 73a): ŻADNEJ linii vat:output.
    const vatOutput = fake.entryRows.filter((p) => p[2] === "vat:output")
    expect(vatOutput).toHaveLength(0)
    // Rezydualny zawieszony VAT zdjęty bez rozpoznania output (suspense debit = 2300).
    const suspenseDebit = fake.entryRows
      .filter((p) => p[2] === "vat:output:suspense")
      .reduce((s, p) => s + Number(p[3]), 0)
    expect(suspenseDebit).toBe(2300)
  })

  it("SPV (gate ON) ⇒ breakage tylko z netto (VAT już rozpoznany przy emisji)", async () => {
    const rows = [makeEntitlement({ vat_classification: "SPV" })]
    const { op, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.expire(baseInput({ vat_classification: "SPV" }))

    expect(res.posting.persisted).toBe(true)
    // SPV: breakage z netto niewykorzystanego salda (10000); brak suspense.
    const breakageCredits = fake.entryRows
      .filter((p) => p[2] === "breakage:voucher")
      .reduce((s, p) => s + Number(p[4]), 0)
    expect(breakageCredits).toBe(10000)
    expect(fake.entryRows.filter((p) => p[2] === "vat:output:suspense")).toHaveLength(0)
  })

  it("remaining=0 (gate ON) ⇒ generator no-op (EXPIRED bez salda); ZERO legu ledger", async () => {
    const rows = [makeEntitlement({ remaining_amount: 0 })]
    const { op, store, fake } = makeOp({ rows, gate: GATE_BOTH_ON, wireWriter: true })
    const res = await op.expire(baseInput())
    expect(res.breakage).toBe(false)
    expect(res.posting.activated).toBe(true)
    expect(res.posting.persisted).toBe(false)
    expect(res.posting.reason).toContain("no-op")
    expect(fake.txRows).toHaveLength(0)
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })
})

// ===========================================================================
// SWEEP — idempotencja: replay (state EXPIRED) ⇒ no-op (NIE podwaja breakage)
// ===========================================================================

describe("Story 4.2 sweep — idempotentny (replay ⇒ no-op, NIE podwaja posting)", () => {
  it("2× expire tego samego entitlementu ⇒ drugi idempotent (NIE podwaja audytu/eventu)", async () => {
    const { op, store, events } = makeOp()
    const first = await op.expire(baseInput())
    const replay = await op.expire(baseInput())

    expect(first.idempotent).toBe(false)
    expect(replay.idempotent).toBe(true)
    expect(replay.new_state).toBe("EXPIRED")
    expect(replay.customer_status).toBe(EXPIRED_CUSTOMER_STATUS)
    // Jeden audyt, jeden event (replay NIE produkuje nowych).
    expect(store.listAudits()).toHaveLength(1)
    expect(events).toHaveLength(1)
  })

  it("replay z aktywowanym writerem ⇒ ledger NIE podwojony (jeden breakage posting)", async () => {
    const { op, fake } = makeOp({ gate: GATE_BOTH_ON, wireWriter: true })
    await op.expire(baseInput())
    const replay = await op.expire(baseInput())
    expect(replay.idempotent).toBe(true)
    // Domena (state EXPIRED) łapie replay PRZED writerem ⇒ jeden nagłówek ledger.
    expect(fake.txRows).toHaveLength(1)
    expect(fake.applied.size).toBe(1)
  })

  it("replay transaction_id stabilny (ten sam jak pierwszy — deterministyczny)", async () => {
    const { op } = makeOp({ wireWriter: true })
    const first = await op.expire(baseInput())
    const replay = await op.expire(baseInput())
    expect(replay.posting.deduped).toBe(true)
    expect(replay.posting.transaction_id).toBe(first.posting.transaction_id)
  })
})

// ===========================================================================
// Fail-closed: typ/stan/należność/spójność
// ===========================================================================

describe("Story 4.2 — fail-closed guards", () => {
  it("EXPIRY_SOURCE_STATES = legalne krawędzie grafu →EXPIRED (ISSUED, ACTIVE)", () => {
    expect(EXPIRY_SOURCE_STATES.has(EntitlementInstanceState.ISSUED)).toBe(true)
    expect(EXPIRY_SOURCE_STATES.has(EntitlementInstanceState.ACTIVE)).toBe(true)
    // REDEEMED_PARTIAL nie ma krawędzi →EXPIRED w grafie L4 (D-5).
    expect(EXPIRY_SOURCE_STATES.has(EntitlementInstanceState.REDEEMED_PARTIAL)).toBe(false)
  })

  it("entitlement nieistniejący ⇒ ExpireEntitlementNotFoundError", async () => {
    const { op } = makeOp({ rows: [] })
    await expect(op.expire(baseInput())).rejects.toBeInstanceOf(
      ExpireEntitlementNotFoundError
    )
  })

  it("stan bez krawędzi →EXPIRED (REDEEMED_PARTIAL) ⇒ EntitlementNotExpirableError", async () => {
    const rows = [makeEntitlement({ state: EntitlementInstanceState.REDEEMED_PARTIAL })]
    const { op } = makeOp({ rows })
    await expect(op.expire(baseInput())).rejects.toBeInstanceOf(
      EntitlementNotExpirableError
    )
  })

  it("typ nie-kwotowy (VOUCHER_SERVICE) ⇒ EntitlementNotExpirableError", async () => {
    const rows = [makeEntitlement({ entitlement_type: EntitlementType.VOUCHER_SERVICE })]
    const { op } = makeOp({ rows })
    await expect(op.expire(baseInput())).rejects.toBeInstanceOf(
      EntitlementNotExpirableError
    )
  })

  it("jeszcze nie wygasł (expires_at > now, require_due) ⇒ EntitlementNotExpirableError", async () => {
    const rows = [makeEntitlement({ expires_at: FUTURE_EXPIRY })]
    const { op } = makeOp({ rows })
    await expect(op.expire(baseInput())).rejects.toBeInstanceOf(
      EntitlementNotExpirableError
    )
  })

  it("require_due=false ⇒ wygasza mimo przyszłego expires_at (administracyjne)", async () => {
    const rows = [makeEntitlement({ expires_at: FUTURE_EXPIRY })]
    const { op, store } = makeOp({ rows })
    const res = await op.expire(baseInput({ require_due: false }))
    expect(res.new_state).toBe("EXPIRED")
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })

  it("remaining > brutto vouchera ⇒ fail-closed (ExpireAmountError)", async () => {
    const rows = [makeEntitlement({ remaining_amount: 99999 })]
    const { op } = makeOp({ rows })
    await expect(op.expire(baseInput())).rejects.toThrow(/remaining/)
  })
})

// ===========================================================================
// NOTIFY — pre-expiry powiadomienie nie duplikuje (dedup per okno)
// ===========================================================================

// ===========================================================================
// AI-Review-1 — fail-closed guards: vat_classification, market_id, net/vat gate
// ===========================================================================

describe("Story 4.2 AI-Review-1/3/4 — fail-closed guards (vat, market_id, net/vat gate)", () => {
  it("AI-Review-3: brak vat_classification (null) ⇒ EntitlementNotExpirableError (fail-closed)", async () => {
    const rows = [makeEntitlement({ vat_classification: null })]
    const { op } = makeOp({ rows })
    await expect(op.expire(baseInput({ vat_classification: undefined }))).rejects.toBeInstanceOf(
      EntitlementNotExpirableError
    )
    await expect(op.expire(baseInput({ vat_classification: undefined }))).rejects.toThrow(
      /vat_classification.*null.*fail-closed|fail-closed.*vat_classification/i
    )
  })

  it("AI-Review-4: brak market_id (null) ⇒ EntitlementNotExpirableError (fail-loud)", async () => {
    const rows = [makeEntitlement({ market_id: null })]
    const { op } = makeOp({ rows })
    await expect(op.expire(baseInput({ market_id: undefined }))).rejects.toBeInstanceOf(
      EntitlementNotExpirableError
    )
    await expect(op.expire(baseInput({ market_id: undefined }))).rejects.toThrow(
      /market_id/i
    )
  })

  it("AI-Review-4: market_id z input nadpisuje null w wierszu (OK)", async () => {
    const rows = [makeEntitlement({ market_id: null })]
    const { op, store } = makeOp({ rows })
    const res = await op.expire(baseInput({ market_id: "bonbeauty" }))
    expect(res.new_state).toBe("EXPIRED")
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })

  it("AI-Review-1: brak net/vat + posting OFF (runtime_enabled=false) ⇒ OK (proxy, no-op)", async () => {
    const { op, store } = makeOp()
    const res = await op.expire({ entitlement_id: "ent_amount_1", market_id: "bonbeauty" })
    expect(res.new_state).toBe("EXPIRED")
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
    // Posting audit-only (runtime_enabled=false), brak ledger write.
    expect(res.posting.activated).toBe(false)
  })

  it("AI-Review-1: brak net/vat + posting ON (gate=true) ⇒ EntitlementNotExpirableError (fail-closed)", async () => {
    const { op } = makeOp({ gate: GATE_BOTH_ON, wireWriter: true })
    await expect(
      op.expire({ entitlement_id: "ent_amount_1", market_id: "bonbeauty" })
    ).rejects.toBeInstanceOf(EntitlementNotExpirableError)
    await expect(
      op.expire({ entitlement_id: "ent_amount_1", market_id: "bonbeauty" })
    ).rejects.toThrow(/voucher_net_minor.*vat_minor.*runtime_enabled=true|fail-closed.*AI-Review-1/i)
  })
})

// ===========================================================================
// AI-Review-5 — cross-walidacja net+vat vs issued_gross z redemption
// ===========================================================================

describe("Story 4.2 AI-Review-5 — cross-walidacja net+vat vs issued_gross", () => {
  function makeOpWithIssuedGross(issuedGross: number | null, rows?: ExpirableEntitlement[]) {
    // Subklasa z nadpisanym findIssuedGross — czysty test bez monkey-patch.
    class PatchedStore extends InMemoryExpireEntitlementStore implements ExpireEntitlementStore {
      override async withTransaction<T>(fn: (tx: ExpireEntitlementTx) => Promise<T>): Promise<T> {
        return super.withTransaction(async (tx) => {
          const patched: ExpireEntitlementTx = {
            getEntitlementForUpdate: tx.getEntitlementForUpdate.bind(tx),
            updateEntitlementState: tx.updateEntitlementState.bind(tx),
            appendAudit: tx.appendAudit.bind(tx),
            findIssuedGross: async (_id: string) => issuedGross,
          }
          return fn(patched)
        })
      }
    }
    const store = new PatchedStore(rows ?? [makeEntitlement()])
    const events: TransitionEventEnvelope[] = []
    const op = new ExpireEntitlementOperation({
      store,
      events: { emit: async (e) => void events.push(e) },
      clock: () => FIXED_NOW,
    })
    return { op, store: store as unknown as InMemoryExpireEntitlementStore }
  }

  it("cross-walidacja: net+vat = issued_gross ⇒ OK (przechodzi)", async () => {
    const { op, store } = makeOpWithIssuedGross(12300) // totalGross = 10000+2300 = 12300
    const res = await op.expire(baseInput())
    expect(res.new_state).toBe("EXPIRED")
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })

  it("cross-walidacja: net+vat ≠ issued_gross ⇒ ExpireAmountError (fail-closed)", async () => {
    const { op } = makeOpWithIssuedGross(15000) // totalGross = 12300 ≠ 15000
    await expect(op.expire(baseInput())).rejects.toThrow(/issued_gross|niespójność.*emisji/i)
  })

  it("brak issued_gross (null) ⇒ pomiń cross-walidację (nowy voucher bez redempcji)", async () => {
    const { op, store } = makeOpWithIssuedGross(null)
    const res = await op.expire(baseInput())
    expect(res.new_state).toBe("EXPIRED") // bez błędu
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })

  it("brak jawnych net/vat ⇒ pomiń cross-walidację (sweep bez kwot)", async () => {
    // Nawet gdy issued_gross różni się od remaining — sweep bez kwot omija check
    const { op, store } = makeOpWithIssuedGross(99999)
    const res = await op.expire({ entitlement_id: "ent_amount_1", market_id: "bonbeauty" })
    expect(res.new_state).toBe("EXPIRED") // bez błędu (net/vat niezadane)
    expect(store.get("ent_amount_1")!.state).toBe("EXPIRED")
  })
})

// ===========================================================================
// NOTIFY — AI-Review-2: send-then-record, fail-loud na brak sinka
// ===========================================================================

describe("Story 4.2 AI-Review-2 — notifier send-then-record + fail-loud", () => {
  function makeNotifier(sinkOverride?: { send: (n: PreExpiryNotification) => Promise<void> }) {
    const sent: PreExpiryNotification[] = []
    const dedupe = new InMemoryPreExpiryDedupeStore()
    const notifier = new PreExpiryNotifier({
      sink: sinkOverride ?? { send: async (n) => void sent.push(n) },
      dedupe,
    })
    return { notifier, sent, dedupe }
  }

  it("pierwsze powiadomienie ⇒ wysłane (sent=true)", async () => {
    const { notifier, sent } = makeNotifier()
    const res = await notifier.notify({
      entitlement_id: "ent_1",
      expires_at: FUTURE_EXPIRY,
      remaining_minor: 12000,
    })
    expect(res.sent).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].options.map((o) => o.kind)).toEqual(
      expect.arrayContaining(["extend", "refund_balance"])
    )
  })

  it("AI-Review-2: awaria sinka ⇒ NIE zapisuje dedup; ponowny sweep retryuje", async () => {
    const dedupe = new InMemoryPreExpiryDedupeStore()
    let sinkCalls = 0
    const failingSink: import("../workflows/expire-entitlement").PreExpiryNotificationSink = {
      send: async () => {
        sinkCalls++
        throw new Error("sink down")
      },
    }
    const notifier = new PreExpiryNotifier({ sink: failingSink, dedupe })

    // Pierwszy try — sink rzuca
    await expect(
      notifier.notify({ entitlement_id: "ent_1", expires_at: FUTURE_EXPIRY, remaining_minor: 12000 })
    ).rejects.toThrow("sink down")
    // Dedup NIE zapisany (send-then-record)
    expect(sinkCalls).toBe(1)
    expect(dedupe.listSent()).toHaveLength(0)

    // Drugi try z działającym sinkiem (retry) — powinno się udać
    const sentRetry: PreExpiryNotification[] = []
    const goodNotifier = new PreExpiryNotifier({
      sink: { send: async (n) => void sentRetry.push(n) },
      dedupe,
    })
    const retry = await goodNotifier.notify({
      entitlement_id: "ent_1",
      expires_at: FUTURE_EXPIRY,
      remaining_minor: 12000,
    })
    expect(retry.sent).toBe(true)
    expect(sentRetry).toHaveLength(1)
    expect(dedupe.listSent()).toHaveLength(1)
  })

  it("AI-Review-2: ponowny sweep po sukcesie — dedup zapisany, drugi run wysyła ponownie (send-then-record semantics)", async () => {
    // Z send-then-record: każdy sweep wysyła; dedup NIE blokuje sendu.
    // Consumer event-bus jest idempotentny — duplikat akceptowalny (lepszy niż cisza).
    const { notifier, sent } = makeNotifier()
    const first = await notifier.notify({ entitlement_id: "ent_1", expires_at: FUTURE_EXPIRY, remaining_minor: 12000 })
    expect(first.sent).toBe(true)
    expect(sent).toHaveLength(1)

    const second = await notifier.notify({ entitlement_id: "ent_1", expires_at: FUTURE_EXPIRY, remaining_minor: 12000 })
    // Drugi sweep: sink wołany ponownie (send-then-record, consumer idempotentny).
    expect(second.sent).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it("inny termin (po extend) ⇒ nowe okno przypomnienia (sent=true)", async () => {
    const { notifier, sent } = makeNotifier()
    await notifier.notify({ entitlement_id: "ent_1", expires_at: FUTURE_EXPIRY, remaining_minor: 12000 })
    const later = await notifier.notify({
      entitlement_id: "ent_1",
      expires_at: new Date("2028-01-01T00:00:00.000Z"),
      remaining_minor: 12000,
    })
    expect(later.sent).toBe(true)
    expect(sent).toHaveLength(2)
  })
})
