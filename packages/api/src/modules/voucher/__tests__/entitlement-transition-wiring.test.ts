/**
 * entitlement-transition-wiring.test.ts — Story 3.4 (v1.11.0 Epic 3 / Wave 3).
 *
 * Pokrywa okablowanie maszyny stanów L4 (event + audit + posting hook) na
 * in-memory fake PG (wzorzec ledger-writer.test.ts — bez realnego DB):
 *   AC1 — dozwolona tranzycja → 3 efekty (event + audit + posting hook);
 *         runtime_enabled=false ⇒ hook audit-only / no-op (NIE pisze ledger);
 *         symulacja "on" (wstrzyknięta bramka) ⇒ pisze przez writer idempotentnie.
 *   AC1 — replay tranzycji ⇒ no-op posting (writer dedup, NIE podwaja ledger).
 *   AC2 — niedozwolona tranzycja → fail-closed, ZERO efektów ubocznych.
 *   AC3 — inwariant taksonomii: 13 stanów + graf tranzycji niezmienne (D-5).
 */

import { describe, it, expect, jest } from "@jest/globals"
import {
  EntitlementInstanceState,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
  EntitlementTransitionError,
} from "../models/entitlement"
import { VOUCHER_LIABILITY_ONLY_V1 } from "../posting-profile"
import {
  VoucherLedgerWriter,
  deriveLedgerTransactionId,
  type LedgerPgClient,
  type LedgerPgPool,
} from "../ledger-writer"
import {
  wireEntitlementTransition,
  wireEntitlementTransitionPersisted,
  emitTransitionEventAfterCommit,
  buildTransitionEnvelopes,
  buildGenesisIssuedTransition,
  runTransitionPostingHook,
  defaultPostingActivationGate,
  assertWiringTransition,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  ENTITLEMENT_GENESIS,
  EntitlementGenesisError,
  type TransitionInput,
  type TransitionWiringDeps,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type PostingActivationGate,
} from "../entitlement-transition-wiring"

// ---------------------------------------------------------------------------
// In-memory fake PG: honoruje ON CONFLICT DO NOTHING na ledger_posting_applied.
// (kopia wzorca z ledger-writer.test.ts — dedup po transaction_id).
// ---------------------------------------------------------------------------

type Captured = { sql: string; params: unknown[] }

function makeFakePool(): {
  pool: LedgerPgPool
  applied: Set<string>
  txRows: unknown[][]
  entryRows: unknown[][]
} {
  const applied = new Set<string>()
  const txRows: unknown[][] = []
  const entryRows: unknown[][] = []
  const captured: Captured[] = []

  const query = (async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params })
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

// ---------------------------------------------------------------------------
// Harness: zbiera audyty + eventy, opcjonalny writer, konfigurowalna bramka.
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-06-02T10:00:00.000Z")

function makeHarness(opts?: {
  gate?: PostingActivationGate
  wireWriter?: boolean
  emitThrows?: boolean
}): {
  deps: TransitionWiringDeps
  audits: TransitionAuditEnvelope[]
  events: TransitionEventEnvelope[]
  fake: ReturnType<typeof makeFakePool>
} {
  const audits: TransitionAuditEnvelope[] = []
  const events: TransitionEventEnvelope[] = []
  const fake = makeFakePool()
  const deps: TransitionWiringDeps = {
    appendAudit: async (a) => {
      audits.push(a)
    },
    emitEvent: async (e) => {
      if (opts?.emitThrows) throw new Error("event bus down")
      events.push(e)
    },
    ...(opts?.wireWriter ? { ledgerWriter: new VoucherLedgerWriter(fake.pool) } : {}),
    ...(opts?.gate ? { postingActivation: opts.gate } : {}),
    clock: () => FIXED_NOW,
  }
  return { deps, audits, events, fake }
}

/** Dozwolona tranzycja ISSUED → ACTIVE z payloadem postingu ISSUED (MPV). */
function issuedToActiveInput(
  entitlementId = "ent_1"
): TransitionInput {
  return {
    from: EntitlementInstanceState.ISSUED,
    to: EntitlementInstanceState.ACTIVE,
    entitlement_id: entitlementId,
    scope: { instance_id: entitlementId, market_id: "pl", sales_channel_id: "sc_pl" },
    actor: "system",
    actor_hint: "subscriber:path-y",
    occurred_at: "2026-06-02T09:00:00.000Z",
    posting: {
      lifecycle_event: "ISSUED",
      vat_classification: "MPV",
      net_minor: 10000,
      vat_minor: 2300,
      currency: "PLN",
    },
  }
}

/** Bramka "obie warstwy on" — SYMULACJA aktywacji (seam testowy, NIE flip flagi). */
const GATE_BOTH_ON: PostingActivationGate = {
  runtimeEnabled: true,
  isMarketActivated: () => true,
}

// ===========================================================================
// AC1 — dozwolona tranzycja → 3 efekty (event + audit + posting hook)
// ===========================================================================

describe("Story 3.4 AC1 — dozwolona tranzycja → event + audit + posting hook", () => {
  it("produkuje event (envelope.v1, AR-EVENTS) + append-only audit (kto/co/kiedy/scope/wynik)", async () => {
    const { deps, audits, events } = makeHarness()
    const result = await wireEntitlementTransition(deps, issuedToActiveInput())

    // (1) Event — envelope.v1 + AR-EVENTS naming.
    expect(events).toHaveLength(1)
    expect(result.emitFailed).toBe(false)
    expect(events[0].schema_version).toBe("1")
    expect(events[0].event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(events[0].event_type).toBe("gp.entitlements.entitlement_state_changed.v1")
    expect(events[0].payload).toMatchObject({
      entitlement_id: "ent_1",
      from_state: "ISSUED",
      to_state: "ACTIVE",
    })

    // (2) Audit — append-only, pięć osi.
    expect(audits).toHaveLength(1)
    const a = audits[0]
    expect(a.actor).toBe("system") // kto
    expect(a.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE) // co
    expect(a.from_state).toBe("ISSUED")
    expect(a.to_state).toBe("ACTIVE")
    expect(a.occurred_at).toBe("2026-06-02T09:00:00.000Z") // kiedy
    expect(a.scope).toMatchObject({ instance_id: "ent_1", market_id: "pl", sales_channel_id: "sc_pl" }) // scope
    expect(a.outcome).toBe("transitioned") // wynik
  })

  it("runtime_enabled=false (default gate) ⇒ posting hook audit-only / NO-OP (NIE pisze ledger)", async () => {
    const { deps, audits, events, fake } = makeHarness({ wireWriter: true })
    // Sanity: domyślna bramka czyta REALNĄ flagę (false) — bez flipowania.
    expect(defaultPostingActivationGate().runtimeEnabled).toBe(false)
    expect(VOUCHER_LIABILITY_ONLY_V1.runtime_enabled).toBe(false)

    const result = await wireEntitlementTransition(deps, issuedToActiveInput())

    // Hook PODPIĘTY (attempted) ale NIE aktywowany, NIE persystuje.
    expect(result.posting.attempted).toBe(true)
    expect(result.posting.activated).toBe(false)
    expect(result.posting.persisted).toBe(false)
    expect(result.posting.reason).toContain("runtime_enabled=false")
    // ZERO wpisów do voucher_ledger_*.
    expect(fake.txRows).toHaveLength(0)
    expect(fake.entryRows).toHaveLength(0)
    expect(fake.applied.size).toBe(0)
    // Audyt + event POWSTAJĄ niezależnie od bramki.
    expect(audits).toHaveLength(1)
    expect(events).toHaveLength(1)
    // transaction_id policzony deterministycznie nawet gdy inert.
    expect(result.posting.transaction_id).toMatch(/^[0-9a-f]{64}$/)
  })

  it("symulacja OBIE warstwy on (wstrzyknięta bramka) ⇒ pisze przez writer (idempotentnie)", async () => {
    const { deps, fake } = makeHarness({ wireWriter: true, gate: GATE_BOTH_ON })
    const result = await wireEntitlementTransition(deps, issuedToActiveInput())

    expect(result.posting.activated).toBe(true)
    expect(result.posting.persisted).toBe(true)
    expect(result.posting.deduped).toBe(false)
    // Faktyczny zapis do voucher_ledger_* przez writer (2.6).
    expect(fake.txRows).toHaveLength(1)
    expect(fake.entryRows.length).toBeGreaterThan(0)
    expect(fake.applied.size).toBe(1)
    // transaction_id = deterministyczny (ADR-139 D3).
    expect(result.posting.transaction_id).toBe(
      deriveLedgerTransactionId({ entitlement_id: "ent_1", lifecycle_event: "ISSUED" })
    )
  })

  it("per-market off (warstwa B) ⇒ no-op nawet gdy runtime_enabled symulowane on", async () => {
    const gate: PostingActivationGate = { runtimeEnabled: true, isMarketActivated: () => false }
    const { deps, fake } = makeHarness({ wireWriter: true, gate })
    const result = await wireEntitlementTransition(deps, issuedToActiveInput())

    expect(result.posting.activated).toBe(false)
    expect(result.posting.persisted).toBe(false)
    expect(result.posting.reason).toContain("per-market")
    expect(fake.txRows).toHaveLength(0)
  })
})

// ===========================================================================
// AC1 — replay tranzycji ⇒ no-op posting (writer dedup, NIE podwaja ledger)
// ===========================================================================

describe("Story 3.4 AC1 — replay tranzycji ⇒ no-op posting (idempotencja)", () => {
  it("druga identyczna tranzycja (sym. on) ⇒ writer dedup, NIE podwaja wpisu ledger", async () => {
    const { deps, fake } = makeHarness({ wireWriter: true, gate: GATE_BOTH_ON })

    const first = await wireEntitlementTransition(deps, issuedToActiveInput())
    expect(first.posting.persisted).toBe(true)
    expect(first.posting.deduped).toBe(false)

    const replay = await wireEntitlementTransition(deps, issuedToActiveInput())
    expect(replay.posting.persisted).toBe(false)
    expect(replay.posting.deduped).toBe(true)
    expect(replay.posting.reason).toContain("replay")

    // Ten sam transaction_id; ledger NIE podwojony (1 nagłówek, 1 applied).
    expect(replay.posting.transaction_id).toBe(first.posting.transaction_id)
    expect(fake.txRows).toHaveLength(1)
    expect(fake.applied.size).toBe(1)
  })
})

// ===========================================================================
// AC2 — niedozwolona tranzycja → fail-closed, ZERO efektów ubocznych
// ===========================================================================

describe("Story 3.4 AC2 — niedozwolona tranzycja fail-closed (bez side-effectów)", () => {
  it("rzuca EntitlementTransitionError i NIE produkuje eventu/audytu/postingu", async () => {
    const { deps, audits, events, fake } = makeHarness({ wireWriter: true, gate: GATE_BOTH_ON })
    const illegal: TransitionInput = {
      ...issuedToActiveInput(),
      // ISSUED → REFUNDED jest NIEDOZWOLone (graf: ISSUED → ACTIVE/VOIDED/EXPIRED).
      to: EntitlementInstanceState.REFUNDED,
    }

    await expect(wireEntitlementTransition(deps, illegal)).rejects.toBeInstanceOf(
      EntitlementTransitionError
    )

    // ZERO efektów ubocznych na odrzuconej ścieżce.
    expect(audits).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(fake.txRows).toHaveLength(0)
    expect(fake.applied.size).toBe(0)
  })
})

// ===========================================================================
// AC1 — best-effort emit: 2× fail NIE blokuje tranzycji (reconciliation 2.6)
// ===========================================================================

describe("Story 3.4 AC1 — emit eventu best-effort (NIE blokuje tranzycji)", () => {
  it("2× fail emitu ⇒ emitFailed=true, ale audit+posting wykonane (tranzycja nieprzerwana)", async () => {
    const { deps, audits, fake } = makeHarness({
      wireWriter: true,
      gate: GATE_BOTH_ON,
      emitThrows: true,
    })
    const result = await wireEntitlementTransition(deps, issuedToActiveInput())

    expect(result.emitFailed).toBe(true)
    // Tranzycja NIE przerwana: audit zapisany, posting zaksięgowany.
    expect(audits).toHaveLength(1)
    expect(result.posting.persisted).toBe(true)
    expect(fake.txRows).toHaveLength(1)
  })
})

// ===========================================================================
// Posting hook — brak payloadu (tranzycja niefinansowa) ⇒ wired, no-op
// ===========================================================================

describe("Story 3.4 — posting hook bez payloadu (tranzycja niefinansowa)", () => {
  it("brak input.posting ⇒ hook attempted=false, wired ale nic nie księguje", async () => {
    const result = await runTransitionPostingHook(
      { postingActivation: GATE_BOTH_ON },
      {
        from: EntitlementInstanceState.ACTIVE,
        to: EntitlementInstanceState.DISPUTED,
        entitlement_id: "ent_x",
        scope: { instance_id: "ent_x", market_id: "pl" },
        actor: "system",
      },
      FIXED_NOW
    )
    expect(result.attempted).toBe(false)
    expect(result.persisted).toBe(false)
    expect(result.reason).toContain("brak payloadu")
  })
})

// ===========================================================================
// AC3 — inwariant taksonomii: 13 stanów + graf tranzycji niezmienne (D-5)
// ===========================================================================

describe("Story 3.4 AC3 — inwariant taksonomii (wyłącznie okablowanie, D-5)", () => {
  it("ALL_ENTITLEMENT_INSTANCE_STATES = dokładnie 13 stanów w stałej kolejności", () => {
    expect(ALL_ENTITLEMENT_INSTANCE_STATES).toEqual([
      "ISSUED",
      "ACTIVE",
      "REDEMPTION_REQUESTED",
      "REDEEMED_PARTIAL",
      "REDEEMED_FULL",
      "SETTLED",
      "CLOSED",
      "VOIDED",
      "EXPIRED",
      "REFUND_REQUESTED",
      "REFUNDED",
      "DISPUTED",
      "PENDING_VENDOR_DECISION",
    ])
  })

  it("graf ALLOWED_ENTITLEMENT_TRANSITIONS niezmieniony względem baseline (snapshot D-5)", () => {
    // Snapshot baseline (models/entitlement.ts @ baseline_commit) — okablowanie 3.4
    // NIE zmienia semantyki żadnej tranzycji ani nie dodaje/usuwa stanu.
    expect(ALLOWED_ENTITLEMENT_TRANSITIONS).toEqual({
      ISSUED: ["ACTIVE", "VOIDED", "EXPIRED"],
      ACTIVE: [
        "REDEMPTION_REQUESTED",
        "EXPIRED",
        "VOIDED",
        "REFUND_REQUESTED",
        "DISPUTED",
        "PENDING_VENDOR_DECISION",
      ],
      REDEMPTION_REQUESTED: [
        "REDEEMED_PARTIAL",
        "REDEEMED_FULL",
        "ACTIVE",
        "DISPUTED",
        "VOIDED",
        "PENDING_VENDOR_DECISION",
      ],
      REDEEMED_PARTIAL: [
        "REDEMPTION_REQUESTED",
        "REDEEMED_FULL",
        "SETTLED",
        "REFUND_REQUESTED",
        "DISPUTED",
      ],
      REDEEMED_FULL: ["SETTLED", "REFUND_REQUESTED", "DISPUTED"],
      SETTLED: ["CLOSED", "REFUND_REQUESTED", "DISPUTED"],
      CLOSED: [],
      VOIDED: [],
      EXPIRED: ["REFUND_REQUESTED", "CLOSED"],
      REFUND_REQUESTED: ["REFUNDED", "DISPUTED", "ACTIVE"],
      REFUNDED: [],
      DISPUTED: ["ACTIVE", "REFUNDED", "CLOSED", "VOIDED"],
      PENDING_VENDOR_DECISION: ["VOIDED", "ACTIVE", "REDEEMED_PARTIAL", "REDEEMED_FULL"],
    })
  })

  it("buildTransitionEnvelopes jest czyste i nie woła assertTransition (wszystkie pary stanów)", () => {
    // AC3: builder NIE waliduje grafu (to robi orkiestrator) — kształt zależy
    // wyłącznie od inputu, deterministycznie, dla DOWOLNEJ pary stanów.
    const { event, audit } = buildTransitionEnvelopes(
      {
        from: EntitlementInstanceState.SETTLED,
        to: EntitlementInstanceState.CLOSED,
        entitlement_id: "ent_z",
        scope: { instance_id: "ent_z", market_id: "pl" },
        actor: "admin",
      },
      FIXED_NOW
    )
    expect(event.payload.from_state).toBe("SETTLED")
    expect(event.payload.to_state).toBe("CLOSED")
    // Klucz cykl-safe (AI-Review-2): zawiera dyskryminator wystąpienia
    // (tu `occurred_at` = FIXED_NOW, bo brak `occurred_at`/`transition_seq`).
    expect(audit.idempotency_key).toBe(
      "entitlement:ent_z:transition:SETTLED->CLOSED@2026-06-02T10:00:00.000Z"
    )
    expect(event.idempotency_key).toBe(audit.idempotency_key)
  })
})

// ===========================================================================
// AI-Review-1 — GENEZA ISSUED (Path Y live-issue) przez JEDNOLITY punkt
// ===========================================================================

describe("Story 3.4 AI-Review-1 — geneza ISSUED (Path Y) przez okablowanie", () => {
  it("geneza (ENTITLEMENT_GENESIS → ISSUED) ⇒ event + audit; posting hook WYWOŁANY no-op (runtime_enabled=false)", async () => {
    const { deps, audits, events, fake } = makeHarness({ wireWriter: true })
    const input = buildGenesisIssuedTransition({
      entitlement_id: "ent_live_1",
      scope: { instance_id: "ent_live_1", market_id: "bonbeauty", sales_channel_id: null },
      actor: "system",
      actor_hint: "subscriber:path-y:live-issue",
      occurred_at: "2026-06-02T09:00:00.000Z",
      transition_seq: "dedupe_abc",
    })
    const result = await wireEntitlementTransition(deps, input)

    // (1) event + (2) audit powstają na genezie ISSUED.
    expect(events).toHaveLength(1)
    expect(events[0].payload.from_state).toBe(ENTITLEMENT_GENESIS)
    expect(events[0].payload.to_state).toBe("ISSUED")
    expect(audits).toHaveLength(1)
    expect(audits[0].from_state).toBe(ENTITLEMENT_GENESIS)
    expect(audits[0].to_state).toBe("ISSUED")
    // (3) posting hook WYWOŁANY (attempted=false bo brak payloadu finansowego) —
    // ZERO zapisu ledger przy runtime_enabled=false.
    expect(result.posting.attempted).toBe(false)
    expect(result.posting.persisted).toBe(false)
    expect(fake.txRows).toHaveLength(0)
    expect(fake.applied.size).toBe(0)
  })

  it("geneza ISSUED z payloadem ⇒ posting hook policzy transaction_id, no-op (runtime_enabled=false)", async () => {
    const { deps, fake } = makeHarness({ wireWriter: true })
    const input = buildGenesisIssuedTransition({
      entitlement_id: "ent_live_2",
      scope: { instance_id: "ent_live_2", market_id: "bonbeauty" },
      transition_seq: "dedupe_xyz",
      posting: {
        lifecycle_event: "ISSUED",
        vat_classification: "MPV",
        net_minor: 10000,
        vat_minor: 2300,
        currency: "PLN",
      },
    })
    const result = await wireEntitlementTransition(deps, input)
    expect(result.posting.attempted).toBe(true)
    expect(result.posting.activated).toBe(false)
    expect(result.posting.persisted).toBe(false)
    expect(result.posting.reason).toContain("runtime_enabled=false")
    expect(result.posting.transaction_id).toMatch(/^[0-9a-f]{64}$/)
    expect(fake.txRows).toHaveLength(0) // zero zapisu ledger
  })

  it("geneza do stanu innego niż ISSUED ⇒ fail-closed (EntitlementGenesisError), ZERO efektów", async () => {
    const { deps, audits, events, fake } = makeHarness({ wireWriter: true, gate: GATE_BOTH_ON })
    const illegalGenesis: TransitionInput = {
      from: ENTITLEMENT_GENESIS,
      to: EntitlementInstanceState.ACTIVE, // geneza dozwolona wyłącznie → ISSUED
      entitlement_id: "ent_bad",
      scope: { instance_id: "ent_bad", market_id: "pl" },
      actor: "system",
    }
    await expect(wireEntitlementTransition(deps, illegalGenesis)).rejects.toBeInstanceOf(
      EntitlementGenesisError
    )
    expect(audits).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(fake.txRows).toHaveLength(0)
  })

  it("assertWiringTransition: geneza→ISSUED OK; geneza→inny rzuca; realny graf deleguje do assertTransition", () => {
    expect(() =>
      assertWiringTransition(ENTITLEMENT_GENESIS, EntitlementInstanceState.ISSUED)
    ).not.toThrow()
    expect(() =>
      assertWiringTransition(ENTITLEMENT_GENESIS, EntitlementInstanceState.VOIDED)
    ).toThrow(EntitlementGenesisError)
    // realny graf nadal egzekwowany (ISSUED→REFUNDED niedozwolone).
    expect(() =>
      assertWiringTransition(
        EntitlementInstanceState.ISSUED,
        EntitlementInstanceState.REFUNDED
      )
    ).toThrow()
  })
})

// ===========================================================================
// AI-Review-2 — idempotency_key cykl-safe (append-only audit nie gubi wpisów)
// ===========================================================================

describe("Story 3.4 AI-Review-2 — idempotency_key odporny na cykle grafu", () => {
  it("legalny cykl ACTIVE→DISPUTED→ACTIVE→DISPUTED ⇒ 4 RÓŻNE klucze (audit nie zwija)", async () => {
    const { deps, audits } = makeHarness()
    // Sekwencja legalnych tranzycji w cyklu (różne `transition_seq` = różne wystąpienia).
    const steps: Array<[EntitlementInstanceState, EntitlementInstanceState, number]> = [
      [EntitlementInstanceState.ACTIVE, EntitlementInstanceState.DISPUTED, 1],
      [EntitlementInstanceState.DISPUTED, EntitlementInstanceState.ACTIVE, 2],
      [EntitlementInstanceState.ACTIVE, EntitlementInstanceState.DISPUTED, 3],
      [EntitlementInstanceState.DISPUTED, EntitlementInstanceState.ACTIVE, 4],
    ]
    for (const [from, to, seq] of steps) {
      await wireEntitlementTransition(deps, {
        from,
        to,
        entitlement_id: "ent_cycle",
        scope: { instance_id: "ent_cycle", market_id: "pl" },
        actor: "system",
        occurred_at: "2026-06-02T09:00:00.000Z", // ten sam timestamp — seq dyskryminuje
        transition_seq: seq,
      })
    }
    const keys = audits.map((a) => a.idempotency_key)
    // 4 wpisy, 4 UNIKATOWE klucze — drugie wystąpienie ACTIVE→DISPUTED NIE koliduje.
    expect(audits).toHaveLength(4)
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]).toContain("ACTIVE->DISPUTED@1")
    expect(keys[2]).toContain("ACTIVE->DISPUTED@3")
    expect(keys[0]).not.toBe(keys[2])
  })

  it("brak transition_seq ⇒ occurred_at dyskryminuje (różne-w-czasie wystąpienia tej samej krawędzi)", () => {
    const a = buildTransitionEnvelopes(
      {
        from: EntitlementInstanceState.ACTIVE,
        to: EntitlementInstanceState.DISPUTED,
        entitlement_id: "ent_t",
        scope: { instance_id: "ent_t", market_id: "pl" },
        actor: "system",
        occurred_at: "2026-06-02T09:00:00.000Z",
      },
      FIXED_NOW
    )
    const b = buildTransitionEnvelopes(
      {
        from: EntitlementInstanceState.ACTIVE,
        to: EntitlementInstanceState.DISPUTED,
        entitlement_id: "ent_t",
        scope: { instance_id: "ent_t", market_id: "pl" },
        actor: "system",
        occurred_at: "2026-06-02T11:30:00.000Z",
      },
      FIXED_NOW
    )
    expect(a.audit.idempotency_key).not.toBe(b.audit.idempotency_key)
  })
})

// ===========================================================================
// AI-Review-3 — post-COMMIT split (persisted bez emitu; emit osobno po commit)
// ===========================================================================

describe("Story 3.4 AI-Review-3 — kontrakt atomowości / post-COMMIT", () => {
  it("wireEntitlementTransitionPersisted NIE emituje eventu (audit + posting w tx)", async () => {
    const { deps, audits, events } = makeHarness({ wireWriter: true })
    const { event, audit, posting } = await wireEntitlementTransitionPersisted(
      deps,
      issuedToActiveInput()
    )
    // Audit zapisany (w tx), ale ZERO emisji eventu (to robi caller PO commit).
    expect(audits).toHaveLength(1)
    expect(events).toHaveLength(0)
    expect(audit.to_state).toBe("ACTIVE")
    expect(posting.attempted).toBe(true)
    expect(posting.persisted).toBe(false) // runtime_enabled=false
    // event zbudowany, zwrócony do emisji post-commit.
    expect(event.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
  })

  it("emitTransitionEventAfterCommit emituje event zwrócony przez persisted (po commit)", async () => {
    const { deps, events } = makeHarness()
    const { event } = await wireEntitlementTransitionPersisted(deps, issuedToActiveInput())
    expect(events).toHaveLength(0)
    const failed = await emitTransitionEventAfterCommit(deps.emitEvent, event)
    expect(failed).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0].payload.to_state).toBe("ACTIVE")
  })

  it("emit best-effort: 2× fail ⇒ emitFailed=true, NIE rzuca (reconciliation 2.6)", async () => {
    const { deps } = makeHarness({ emitThrows: true })
    const { event } = await wireEntitlementTransitionPersisted(deps, issuedToActiveInput())
    const failed = await emitTransitionEventAfterCommit(deps.emitEvent, event)
    expect(failed).toBe(true)
  })
})
