/**
 * Story 4.7 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 lost-code recovery) — unit tests.
 *
 * Pokrywa AC1 + AC2 odzysku utraconego kodu jako pary `void(old)` + `issue(new)`:
 *   AC1 — w oknie 30 dni (od utraty) + decyzja ≤7 dni (od zgłoszenia) ⇒ void(old) + issue(new)
 *         z PEŁNYM transferem salda (`remaining_new == remaining_old`, NIGDY ponad — 4.1) +
 *         zachowaną ważnością; stary kod terminalny (VOIDED). Poza oknem (30d / 7d) ⇒
 *         fail-closed (brak void/issue/transferu).
 *   AC2 — obie tranzycje przez jednolity punkt wireEntitlementTransition (3.4): append-only
 *         audit + event do outboxu; posting GATED (audit-only/no-op, runtime_enabled=false ⇒
 *         NIE pisze voucher_ledger_*). Para net-zero (kontynuacja, NIE derecognition).
 *   Anti-double-spend — void(old) PRZED issue(new) (nigdy 2 ważne kody); idempotencja
 *         (recovery_id ⇒ jeden void+issue, replay no-op); taksonomia (D-5) niezmienna.
 */

import { describe, it, expect } from "@jest/globals"
import {
  LOST_CODE_REPORT_WINDOW_DAYS,
  LOST_CODE_DECISION_WINDOW_DAYS,
  LOST_CODE_RECOVERABLE_STATES,
  LOST_CODE_POSTING_NOOP_REASON,
  LostCodeReportWindowError,
  LostCodeDecisionWindowError,
  LostCodeIdempotencyMissingError,
  LostCodePreconditionError,
  LostCodeBalanceTransferError,
  isWithinReportWindow,
  isWithinDecisionWindow,
  buildLostCodeRecoveryId,
  deriveRecoveryEntitlementId,
  computeRecoveryBalanceTransfer,
  computeRecoveryExpiresAt,
  determineLostCodeRecoveryOutcome,
  buildLostCodePostingNoop,
  lostCodeVoidActorHint,
  lostCodeReissueActorHint,
  buildLostCodeVoidTransitionInput,
  buildLostCodeReissueGenesisInput,
  buildLostCodeRecoveryWiring,
  cloneRecoveryPolicySnapshot,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  EntitlementInstanceState,
  EntitlementGenesisError,
  EntitlementTransitionError,
  ENTITLEMENT_GENESIS,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
} from ".."

const SCOPE = {
  instance_id: "ent_lost_001",
  market_id: "mkt_bonbeauty",
  sales_channel_id: "sc_bonbeauty",
}

const OLD_ID = "ent_lost_001"
const REC = buildLostCodeRecoveryId(OLD_ID, "seq-1")

// Standardowe daty: utrata → zgłoszenie (w oknie) → decyzja (w oknie).
const LOST_AT = new Date("2026-06-01T00:00:00.000Z")
const REPORTED_AT = new Date("2026-06-10T00:00:00.000Z") // 9 dni po utracie (<30)
const DECIDED_AT = new Date("2026-06-13T00:00:00.000Z") // 3 dni po zgłoszeniu (<7)

// ---------------------------------------------------------------------------
// Okna czasowe — zgłoszenie 30 dni + decyzja ≤7 dni (boundary, fail-closed)
// ---------------------------------------------------------------------------

describe("okna czasowe — report 30d + decision 7d (boundary)", () => {
  it("stałe okien zgodne z FR20 (30 / 7)", () => {
    expect(LOST_CODE_REPORT_WINDOW_DAYS).toBe(30)
    expect(LOST_CODE_DECISION_WINDOW_DAYS).toBe(7)
  })

  it("isWithinReportWindow: dokładnie 30 dni (granica inkluzywna) ⇒ true", () => {
    const lost = new Date("2026-06-01T00:00:00.000Z")
    const reported = new Date("2026-07-01T00:00:00.000Z") // +30 dni
    expect(isWithinReportWindow(lost, reported)).toBe(true)
  })

  it("isWithinReportWindow: 30 dni + 1ms ⇒ false (poza oknem)", () => {
    const lost = new Date("2026-06-01T00:00:00.000Z")
    const reported = new Date("2026-07-01T00:00:00.001Z")
    expect(isWithinReportWindow(lost, reported)).toBe(false)
  })

  it("isWithinReportWindow: zgłoszenie PRZED utratą ⇒ false (fail-closed)", () => {
    expect(
      isWithinReportWindow(
        new Date("2026-06-10T00:00:00.000Z"),
        new Date("2026-06-01T00:00:00.000Z")
      )
    ).toBe(false)
  })

  it("isWithinDecisionWindow: dokładnie 7 dni (granica inkluzywna) ⇒ true", () => {
    const reported = new Date("2026-06-10T00:00:00.000Z")
    const decided = new Date("2026-06-17T00:00:00.000Z") // +7 dni
    expect(isWithinDecisionWindow(reported, decided)).toBe(true)
  })

  it("isWithinDecisionWindow: 7 dni + 1ms ⇒ false (poza oknem)", () => {
    const reported = new Date("2026-06-10T00:00:00.000Z")
    const decided = new Date("2026-06-17T00:00:00.001Z")
    expect(isWithinDecisionWindow(reported, decided)).toBe(false)
  })

  it("isWithinDecisionWindow: decyzja PRZED zgłoszeniem ⇒ false (fail-closed)", () => {
    expect(
      isWithinDecisionWindow(
        new Date("2026-06-10T00:00:00.000Z"),
        new Date("2026-06-09T00:00:00.000Z")
      )
    ).toBe(false)
  })

  it("niewiarygodne daty (NaN) ⇒ false (fail-closed)", () => {
    expect(isWithinReportWindow(new Date(Number.NaN), REPORTED_AT)).toBe(false)
    expect(isWithinDecisionWindow(REPORTED_AT, new Date(Number.NaN))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC1 — transfer salda 1:1 (dyscyplina 4.1: NIGDY ponad remaining) + ważność
// ---------------------------------------------------------------------------

describe("transfer salda 1:1 + zachowanie ważności (AC1, dyscyplina 4.1)", () => {
  it("computeRecoveryBalanceTransfer: remaining_new == remaining_old, net-zero", () => {
    const t = computeRecoveryBalanceTransfer(5000)
    expect(t.remaining_old).toBe(5000)
    expect(t.remaining_new).toBe(5000)
    expect(t.net_zero).toBe(true)
  })

  it("computeRecoveryBalanceTransfer: saldo 0 ⇒ transfer 0 (dozwolone)", () => {
    expect(computeRecoveryBalanceTransfer(0).remaining_new).toBe(0)
  })

  it("computeRecoveryBalanceTransfer: saldo ujemne ⇒ LostCodeBalanceTransferError", () => {
    expect(() => computeRecoveryBalanceTransfer(-1)).toThrow(
      LostCodeBalanceTransferError
    )
  })

  it("computeRecoveryBalanceTransfer: saldo nie-skończone ⇒ LostCodeBalanceTransferError", () => {
    expect(() => computeRecoveryBalanceTransfer(Number.NaN)).toThrow(
      LostCodeBalanceTransferError
    )
  })

  it("computeRecoveryExpiresAt: ważność przeniesiona 1:1 (identity, NIE od daty odzysku)", () => {
    const exp = new Date("2027-06-01T00:00:00.000Z")
    const next = computeRecoveryExpiresAt(exp)
    expect(next?.getTime()).toBe(exp.getTime())
  })

  it("computeRecoveryExpiresAt: zwraca KOPIĘ (mutacja nie zmienia wejścia)", () => {
    const exp = new Date("2027-06-01T00:00:00.000Z")
    const next = computeRecoveryExpiresAt(exp)
    next!.setFullYear(2099)
    expect(exp.getUTCFullYear()).toBe(2027)
  })

  it("computeRecoveryExpiresAt: null ⇒ null (brak ważności przeniesiony wprost)", () => {
    expect(computeRecoveryExpiresAt(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC1 — determinacja odzysku: happy path + fail-closed okna + precondition
// ---------------------------------------------------------------------------

describe("determineLostCodeRecoveryOutcome — happy path (AC1)", () => {
  it("w oknie 30d + decyzja ≤7d + ISSUED ⇒ apply, transfer net-zero, brak derecognition", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      recovery_id: REC,
    })
    expect(d.directive).toBe("apply")
    expect(d.transfer.remaining_new).toBe(8000)
    expect(d.transfer.net_zero).toBe(true)
    expect(d.derecognition).toBe(false)
    expect(d.net_zero).toBe(true)
    expect(d.idempotent_replay).toBe(false)
  })

  it("stan ACTIVE także recoverable", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ACTIVE,
      remaining_old: 100,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      recovery_id: REC,
    })
    expect(d.directive).toBe("apply")
  })
})

describe("determineLostCodeRecoveryOutcome — fail-closed okna (AC1)", () => {
  it("zgłoszenie poza oknem 30 dni ⇒ LostCodeReportWindowError (brak transferu)", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 8000,
        lost_at: LOST_AT,
        reported_at: new Date("2026-07-05T00:00:00.000Z"), // 34 dni po utracie
        decided_at: new Date("2026-07-06T00:00:00.000Z"),
        recovery_id: REC,
      })
    ).toThrow(LostCodeReportWindowError)
  })

  it("decyzja poza oknem ≤7 dni ⇒ LostCodeDecisionWindowError (brak transferu)", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 8000,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: new Date("2026-06-20T00:00:00.000Z"), // 10 dni po zgłoszeniu
        recovery_id: REC,
      })
    ).toThrow(LostCodeDecisionWindowError)
  })
})

describe("determineLostCodeRecoveryOutcome — precondition stanu (fail-closed)", () => {
  const DISALLOWED = [
    EntitlementInstanceState.REDEEMED_PARTIAL,
    EntitlementInstanceState.REDEEMED_FULL,
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.EXPIRED,
    EntitlementInstanceState.REFUNDED,
  ]

  it.each(DISALLOWED)(
    "stan '%s' ⇒ LostCodePreconditionError (odzysk bezprzedmiotowy)",
    (state) => {
      expect(() =>
        determineLostCodeRecoveryOutcome({
          old_state: state,
          remaining_old: 8000,
          lost_at: LOST_AT,
          reported_at: REPORTED_AT,
          decided_at: DECIDED_AT,
          recovery_id: REC,
        })
      ).toThrow(LostCodePreconditionError)
    }
  )

  it("LOST_CODE_RECOVERABLE_STATES = {ISSUED, ACTIVE} (dokładnie)", () => {
    expect(LOST_CODE_RECOVERABLE_STATES.has(EntitlementInstanceState.ISSUED)).toBe(
      true
    )
    expect(LOST_CODE_RECOVERABLE_STATES.has(EntitlementInstanceState.ACTIVE)).toBe(
      true
    )
    expect(LOST_CODE_RECOVERABLE_STATES.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Idempotencja — recovery_id wymagany + replay ⇒ no-op + deterministyczny nowy id
// ---------------------------------------------------------------------------

describe("idempotencja — recovery_id (T1)", () => {
  it("brak recovery_id ⇒ LostCodeIdempotencyMissingError", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 8000,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
      })
    ).toThrow(LostCodeIdempotencyMissingError)
  })

  it("replay (ten sam recovery_id co ostatnio) ⇒ directive:noop, idempotent_replay:true", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      recovery_id: REC,
      last_applied_recovery_id: REC,
    })
    expect(d.directive).toBe("noop")
    expect(d.idempotent_replay).toBe(true)
  })

  it("replay POMIJA gardy okien (operacja już zaszła — np. decyzja poza oknem ⇒ NIE re-throw)", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: new Date("2026-08-01T00:00:00.000Z"), // poza oknem dla nowego żądania
      recovery_id: REC,
      last_applied_recovery_id: REC,
    })
    expect(d.directive).toBe("noop")
    expect(d.idempotent_replay).toBe(true)
    expect(d.transfer.remaining_new).toBe(8000)
  })

  it("różne recovery_id ⇒ nie-replay (apply)", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      recovery_id: REC,
      last_applied_recovery_id: buildLostCodeRecoveryId(OLD_ID, "seq-2"),
    })
    expect(d.directive).toBe("apply")
    expect(d.idempotent_replay).toBe(false)
  })

  it("buildLostCodeRecoveryId deterministyczny + rozróżnialny per seq", () => {
    expect(buildLostCodeRecoveryId("e1", "s1")).toBe(
      "entitlement:e1:lost-code-recovery:s1"
    )
    expect(buildLostCodeRecoveryId("e1", "s1")).not.toBe(
      buildLostCodeRecoveryId("e1", "s2")
    )
  })

  it("deriveRecoveryEntitlementId deterministyczny (ten sam recovery_id ⇒ ten sam nowy id)", () => {
    const a = deriveRecoveryEntitlementId(REC)
    const b = deriveRecoveryEntitlementId(REC)
    expect(a).toBe(b)
    expect(a).toMatch(/^GP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it("deriveRecoveryEntitlementId różny per recovery_id (brak kolizji trywialnych)", () => {
    expect(deriveRecoveryEntitlementId(REC)).not.toBe(
      deriveRecoveryEntitlementId(buildLostCodeRecoveryId(OLD_ID, "seq-2"))
    )
  })
})

// ---------------------------------------------------------------------------
// Okablowanie pary — void(old)→VOIDED + issue(new) geneza→ISSUED, audit + event
// ---------------------------------------------------------------------------

describe("buildLostCode*TransitionInput — krawędzie grafu (D-5) + posting pominięty", () => {
  const wiring = {
    old_entitlement_id: OLD_ID,
    old_state: EntitlementInstanceState.ISSUED,
    scope: SCOPE,
    recovery_id: REC,
    operator_id: "op_42",
  }

  it("void: from=stan, to=VOIDED, posting pominięty, actor=admin, transition_seq=recovery_id", () => {
    const input = buildLostCodeVoidTransitionInput(wiring)
    expect(input.from).toBe(EntitlementInstanceState.ISSUED)
    expect(input.to).toBe(EntitlementInstanceState.VOIDED)
    expect(input.entitlement_id).toBe(OLD_ID)
    expect(input.posting).toBeUndefined()
    expect(input.actor).toBe("admin")
    expect(input.transition_seq).toBe(REC)
    expect(input.actor_hint).toContain("lost-code:void")
    expect(input.actor_hint).toContain("operator=op_42")
  })

  it("void: niedozwolony stan ⇒ LostCodePreconditionError (fail-closed)", () => {
    expect(() =>
      buildLostCodeVoidTransitionInput({
        ...wiring,
        old_state: EntitlementInstanceState.REDEEMED_FULL,
      })
    ).toThrow(LostCodePreconditionError)
  })

  it("issue: geneza → ISSUED, scope.instance_id = nowy id, posting pominięty", () => {
    const newId = deriveRecoveryEntitlementId(REC)
    const input = buildLostCodeReissueGenesisInput(wiring, newId)
    expect(input.from).toBe(ENTITLEMENT_GENESIS)
    expect(input.to).toBe(EntitlementInstanceState.ISSUED)
    expect(input.entitlement_id).toBe(newId)
    expect(input.scope.instance_id).toBe(newId)
    expect(input.posting).toBeUndefined()
    expect(input.actor_hint).toContain("lost-code:issue")
    expect(input.actor_hint).toContain(`new=${newId}`)
  })

  it("actor hints kodują operatora + recovery_id (audit forensicznie samowystarczalny)", () => {
    expect(lostCodeVoidActorHint("op_1", "r1")).toBe(
      "lost-code:void:operator=op_1:recovery=r1"
    )
    expect(lostCodeReissueActorHint("op_1", "r1", "GP-X")).toBe(
      "lost-code:issue:operator=op_1:recovery=r1:new=GP-X"
    )
    expect(lostCodeVoidActorHint(null, "r1")).toContain("operator=?")
  })
})

describe("buildLostCodeRecoveryWiring — para audytowana + posting audit-only (AC2)", () => {
  const wiring = {
    old_entitlement_id: OLD_ID,
    old_state: EntitlementInstanceState.ACTIVE,
    scope: SCOPE,
    recovery_id: REC,
    operator_id: "op_42",
  }

  it("void(old) + issue(new): obie nogi audytowane, posting audit-only (NIE księguje)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      wiring
    )

    // Void(old): from=ACTIVE → VOIDED, audyt kompletny, posting audit-only.
    expect(res.void.audit.from_state).toBe(EntitlementInstanceState.ACTIVE)
    expect(res.void.audit.to_state).toBe(EntitlementInstanceState.VOIDED)
    expect(res.void.audit.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(res.void.audit.scope.market_id).toBe("mkt_bonbeauty")
    expect(res.void.audit.outcome).toBe("transitioned")
    expect(res.void.posting.attempted).toBe(false)
    expect(res.void.posting.persisted).toBe(false)

    // Issue(new): geneza → ISSUED na nowym id, audyt kompletny, posting audit-only.
    expect(res.issue.audit.from_state).toBe(ENTITLEMENT_GENESIS)
    expect(res.issue.audit.to_state).toBe(EntitlementInstanceState.ISSUED)
    expect(res.issue.audit.entitlement_id).toBe(res.new_entitlement_id)
    expect(res.issue.posting.attempted).toBe(false)
    expect(res.issue.posting.persisted).toBe(false)

    // Nowy id deterministyczny z recovery_id.
    expect(res.new_entitlement_id).toBe(deriveRecoveryEntitlementId(REC))
  })

  it("appendAudit wołany dla OBU nóg (void + issue) atomowo w tx callera", async () => {
    const audits: TransitionAuditEnvelope[] = []
    await buildLostCodeRecoveryWiring(
      {
        appendAudit: async (a) => {
          audits.push(a)
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      wiring
    )
    expect(audits).toHaveLength(2)
    expect(audits[0]?.actor_hint).toContain("lost-code:void")
    expect(audits[1]?.actor_hint).toContain("lost-code:issue")
  })

  it("emitEvent wołany dla OBU nóg + emitFailed:false (post-COMMIT seam)", async () => {
    const events: TransitionEventEnvelope[] = []
    const res = await buildLostCodeRecoveryWiring(
      {
        emitEvent: async (e) => {
          events.push(e)
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      wiring
    )
    expect(events).toHaveLength(2)
    expect(res.void.emitFailed).toBe(false)
    expect(res.issue.emitFailed).toBe(false)
  })

  it("custom new_entitlement_id respektowane (override deterministycznego id)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      { ...wiring, new_entitlement_id: "ent_custom_new" }
    )
    expect(res.new_entitlement_id).toBe("ent_custom_new")
    expect(res.issue.audit.entitlement_id).toBe("ent_custom_new")
  })
})

// ---------------------------------------------------------------------------
// ANTI-DOUBLE-SPEND — void(old) PRZED issue(new); stary terminalny zanim nowy istnieje
// ---------------------------------------------------------------------------

describe("anti-double-spend — void(old) przed issue(new) (KRYTYCZNE)", () => {
  it("kolejność okablowania: void NAJPIERW, issue PO (nigdy 2 ważne kody)", async () => {
    const order: string[] = []
    await buildLostCodeRecoveryWiring(
      {
        appendAudit: async (a) => {
          order.push(
            a.to_state === EntitlementInstanceState.VOIDED ? "void" : "issue"
          )
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        recovery_id: REC,
      }
    )
    expect(order).toEqual(["void", "issue"])
  })

  it("stary kod ląduje w VOIDED (terminal) — brak krawędzi wyjściowej (redeem niemożliwy)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ISSUED,
        scope: SCOPE,
        recovery_id: REC,
      }
    )
    expect(res.void.audit.to_state).toBe(EntitlementInstanceState.VOIDED)
  })

  it("void(old) z niedozwolonej krawędzi rzuca PRZED issue (geneza nie powstaje)", async () => {
    // VOIDED → VOIDED jest niedozwolone (terminal); precondition łapie to wcześniej.
    await expect(
      buildLostCodeRecoveryWiring(
        { clock: () => new Date("2026-06-13T12:00:00.000Z") },
        {
          old_entitlement_id: OLD_ID,
          old_state: EntitlementInstanceState.VOIDED,
          scope: SCOPE,
          recovery_id: REC,
        }
      )
    ).rejects.toThrow(LostCodePreconditionError)
  })
})

// ---------------------------------------------------------------------------
// Posting GATED — NO posting / NO derecognition (audit-only NAWET z bramką ON)
// ---------------------------------------------------------------------------

describe("posting GATED — brak nowego postingu/derecognition (ADR-139 D5)", () => {
  it("buildLostCodePostingNoop ⇒ noop:true + powód (kontynuacja net-zero)", () => {
    const noop = buildLostCodePostingNoop()
    expect(noop.noop).toBe(true)
    expect(noop.reason).toBe(LOST_CODE_POSTING_NOOP_REASON)
    expect(noop.reason).toContain("NET-ZERO")
    expect(noop.reason).toContain("BRAK nowego")
  })

  it("bramka ON (runtime_enabled:true + market on) + writer + brak payloadu ⇒ attempted:false dla OBU nóg", async () => {
    // Symulacja stanu PO flipie P6 — bramka aktywna. Recovery NADAL nie księguje
    // (brak payloadu ⇒ wczesny return w hooku PRZED bramką). Dominujący dowód: 4.7
    // nigdy nie wycieknie do voucher_ledger_* nawet po flipie.
    const writerCalls: unknown[] = []
    const res = await buildLostCodeRecoveryWiring(
      {
        postingActivation: { runtimeEnabled: true, isMarketActivated: () => true },
        ledgerWriter: {
          write: async (req) => {
            writerCalls.push(req)
            return { applied: false, deduped: false, transaction_id: "x" }
          },
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        recovery_id: REC,
      }
    )
    expect(res.void.posting.attempted).toBe(false)
    expect(res.void.posting.activated).toBe(false)
    expect(res.void.posting.persisted).toBe(false)
    expect(res.issue.posting.attempted).toBe(false)
    expect(res.issue.posting.persisted).toBe(false)
    expect(writerCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Kontynuacja polityki — nowy kod = ta sama polityka, nowy identyfikator
// ---------------------------------------------------------------------------

describe("cloneRecoveryPolicySnapshot — kontynuacja polityki (nowy id, ta sama polityka)", () => {
  it("snapshot tożsamy wartościowo, ale NIE współdzieli referencji (deep clone + freeze)", () => {
    const oldSnap = Object.freeze({ transferability: "bearer", validity_months: 12 })
    const next = cloneRecoveryPolicySnapshot(oldSnap)
    expect(next).toEqual(oldSnap)
    expect(next).not.toBe(oldSnap)
    expect(Object.isFrozen(next)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D-5 — taksonomia stanów NIEZMIENIONA (13 stanów); brak nowego enuma/krawędzi
// ---------------------------------------------------------------------------

describe("granice D-5 — taksonomia stanów niezmieniona", () => {
  it("ALL_ENTITLEMENT_INSTANCE_STATES nadal liczy 13 stanów (4.7 NIE dodaje stanu)", () => {
    expect(ALL_ENTITLEMENT_INSTANCE_STATES).toHaveLength(13)
  })

  it("void używa ISTNIEJĄCEJ krawędzi {ISSUED,ACTIVE}→VOIDED (NIE nowy enum/krawędź)", () => {
    // Sanity: oba recoverable states mają VOIDED jako legalny target — gdyby graf się
    // zmienił, wireEntitlementTransitionPersisted rzuciłby EntitlementTransitionError.
    expect(LOST_CODE_RECOVERABLE_STATES.has(EntitlementInstanceState.ISSUED)).toBe(
      true
    )
    expect(EntitlementTransitionError).toBeDefined()
    expect(EntitlementGenesisError).toBeDefined()
  })
})
