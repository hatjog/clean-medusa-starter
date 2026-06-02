/**
 * Story 4.5 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 transfer/gifting) — unit tests.
 *
 * Pokrywa:
 *   AC1 — obdarowanie (recipient ≠ buyer) → recipient binding + claim token wg trybu
 *         `transferability` (bearer / personalized / hybrid), czytanego ZE SNAPSHOTU
 *         policy_snapshot (FR15); reuse v1.8.0 P4 claim token (BEZ nowego UI).
 *   AC2 — claim recipienta → powiązanie wg trybu + aktywacja `ISSUED → ACTIVE` przez
 *         JEDNOLITY punkt wireEntitlementTransition (event + audit kto-obdarował/
 *         kto-zclaimował + posting hook no-op); idempotencja claim (replay = no-op),
 *         claim token jednorazowy (double-claim ⇒ fail-closed); personalized match.
 *   AC3 — transfer/claim = binding-only ⇒ posting hook NO-OP derecognition (audit-only,
 *         runtime_enabled=false, zero zapisu ledgera); taksonomia 13 stanów + tranzycja
 *         ISSUED→ACTIVE niezmienne (D-5); brak zmiany salda.
 */

import { describe, it, expect } from "@jest/globals"
import {
  TRANSFER_POSTING_NOOP_REASON,
  TransferabilityEnumError,
  TransferRecipientRequiredError,
  TransferRecipientSameAsBuyerError,
  TransferStateError,
  TransferClaimTokenSourceError,
  ClaimTokenInvalidError,
  ClaimTokenConsumedError,
  ClaimStateError,
  TransferabilityError,
  readTransferabilityFromSnapshot,
  buildTransferId,
  buildTransferGrant,
  determineClaimOutcome,
  buildTransferPostingNoop,
  claimActorHint,
  buildClaimTransitionInput,
  buildClaimWiring,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
  EntitlementInstanceState,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type EntitlementPolicySnapshot,
  type TransitionAuditEnvelope,
} from ".."

const SCOPE = {
  instance_id: "ent_transfer_001",
  market_id: "mkt_bonbeauty",
  sales_channel_id: "sc_bonbeauty",
}

const snap = (transferability?: string): EntitlementPolicySnapshot =>
  (transferability === undefined
    ? {}
    : { transferability }) as EntitlementPolicySnapshot

const BEARER = snap("bearer")
const PERSONALIZED = snap("personalized")
const HYBRID = snap("hybrid")

// ---------------------------------------------------------------------------
// readTransferabilityFromSnapshot — ZE SNAPSHOTU, default bearer, fail-closed enum
// ---------------------------------------------------------------------------

describe("readTransferabilityFromSnapshot (FR15 — snapshot, nie profil)", () => {
  it("czyta wartość ze snapshotu", () => {
    expect(readTransferabilityFromSnapshot(BEARER)).toBe("bearer")
    expect(readTransferabilityFromSnapshot(PERSONALIZED)).toBe("personalized")
    expect(readTransferabilityFromSnapshot(HYBRID)).toBe("hybrid")
  })

  it("brak pola ⇒ bearer (default § 7 regulaminu)", () => {
    expect(readTransferabilityFromSnapshot(snap())).toBe("bearer")
  })

  it("nieznana wartość ⇒ TransferabilityEnumError (fail-closed)", () => {
    expect(() => readTransferabilityFromSnapshot(snap("public"))).toThrow(
      TransferabilityEnumError
    )
  })
})

// ---------------------------------------------------------------------------
// AC1 — obdarowanie: recipient binding + claim token wg trybu
// ---------------------------------------------------------------------------

describe("buildTransferGrant — bearer (okaziciel) (AC1)", () => {
  it("bearer: binding okazicielski (recipient_customer_id null), reuse claim token v1.8.0", () => {
    const g = buildTransferGrant({
      entitlement_id: "ent_transfer_001",
      state: EntitlementInstanceState.ISSUED,
      policy_snapshot: BEARER,
      buyer_customer_id: "cus_buyer",
      existing_claim_token: "tok-v180-reuse",
      transfer_seq: "seq-1",
    })
    expect(g.transferability).toBe("bearer")
    expect(g.binding.bearer).toBe(true)
    expect(g.binding.recipient_customer_id).toBeNull()
    expect(g.claim_token).toBe("tok-v180-reuse")
    expect(g.claim_token_reused).toBe(true)
    expect(g.transfer_id).toBe("entitlement:ent_transfer_001:transfer:seq-1")
  })

  it("bearer bez existing token: generuje świeży (reuse kształtu v1.8.0 przez seam)", () => {
    const g = buildTransferGrant({
      entitlement_id: "ent_transfer_001",
      state: EntitlementInstanceState.ISSUED,
      policy_snapshot: BEARER,
      buyer_customer_id: "cus_buyer",
      generateClaimToken: () => "tok-fresh",
      transfer_seq: "seq-1",
    })
    expect(g.claim_token).toBe("tok-fresh")
    expect(g.claim_token_reused).toBe(false)
  })

  it("brak źródła claim tokenu ⇒ TransferClaimTokenSourceError (fail-closed)", () => {
    expect(() =>
      buildTransferGrant({
        entitlement_id: "ent_transfer_001",
        state: EntitlementInstanceState.ISSUED,
        policy_snapshot: BEARER,
        buyer_customer_id: "cus_buyer",
        transfer_seq: "seq-1",
      })
    ).toThrow(TransferClaimTokenSourceError)
  })
})

describe("buildTransferGrant — personalized (imienny) (AC1)", () => {
  it("personalized: binding imienny (recipient.customer_id), RODO minimal (tylko id)", () => {
    const g = buildTransferGrant({
      entitlement_id: "ent_transfer_001",
      state: EntitlementInstanceState.ISSUED,
      policy_snapshot: PERSONALIZED,
      buyer_customer_id: "cus_buyer",
      recipient: { customer_id: "cus_recipient" },
      existing_claim_token: "tok-1",
      transfer_seq: "seq-1",
    })
    expect(g.binding.bearer).toBe(false)
    expect(g.binding.recipient_customer_id).toBe("cus_recipient")
    // RODO: binding niesie WYŁĄCZNIE recipient_customer_id (brak imienia/email).
    expect(Object.keys(g.binding).sort()).toEqual([
      "bearer",
      "recipient_customer_id",
      "transferability",
    ])
  })

  it("personalized bez recipient.customer_id ⇒ TransferRecipientRequiredError (fail-closed)", () => {
    expect(() =>
      buildTransferGrant({
        entitlement_id: "ent_transfer_001",
        state: EntitlementInstanceState.ISSUED,
        policy_snapshot: PERSONALIZED,
        buyer_customer_id: "cus_buyer",
        existing_claim_token: "tok-1",
        transfer_seq: "seq-1",
      })
    ).toThrow(TransferRecipientRequiredError)
  })
})

describe("buildTransferGrant — hybrid + granice recipient ≠ buyer / state (AC1)", () => {
  it("hybrid: binding z opcjonalną tożsamością (gdy podana)", () => {
    const g = buildTransferGrant({
      entitlement_id: "ent_transfer_001",
      state: EntitlementInstanceState.ISSUED,
      policy_snapshot: HYBRID,
      buyer_customer_id: "cus_buyer",
      recipient: { customer_id: "cus_recipient" },
      existing_claim_token: "tok-1",
      transfer_seq: "seq-1",
    })
    expect(g.binding.recipient_customer_id).toBe("cus_recipient")
    expect(g.binding.bearer).toBe(false)
  })

  it("hybrid bez tożsamości: binding bez recipient_customer_id (miękki)", () => {
    const g = buildTransferGrant({
      entitlement_id: "ent_transfer_001",
      state: EntitlementInstanceState.ISSUED,
      policy_snapshot: HYBRID,
      buyer_customer_id: "cus_buyer",
      existing_claim_token: "tok-1",
      transfer_seq: "seq-1",
    })
    expect(g.binding.recipient_customer_id).toBeNull()
  })

  it("recipient == buyer ⇒ TransferRecipientSameAsBuyerError (recipient ≠ buyer, AC1)", () => {
    expect(() =>
      buildTransferGrant({
        entitlement_id: "ent_transfer_001",
        state: EntitlementInstanceState.ISSUED,
        policy_snapshot: PERSONALIZED,
        buyer_customer_id: "cus_same",
        recipient: { customer_id: "cus_same" },
        existing_claim_token: "tok-1",
        transfer_seq: "seq-1",
      })
    ).toThrow(TransferRecipientSameAsBuyerError)
  })

  it("gifting ze stanu != ISSUED ⇒ TransferStateError (binding przed aktywacją)", () => {
    expect(() =>
      buildTransferGrant({
        entitlement_id: "ent_transfer_001",
        state: EntitlementInstanceState.ACTIVE,
        policy_snapshot: BEARER,
        buyer_customer_id: "cus_buyer",
        existing_claim_token: "tok-1",
        transfer_seq: "seq-1",
      })
    ).toThrow(TransferStateError)
  })

  it("buildTransferId deterministyczny + stabilny przy replay (idempotencja)", () => {
    expect(buildTransferId("ent_x", "seq-1")).toBe(
      buildTransferId("ent_x", "seq-1")
    )
    expect(buildTransferId("ent_x", "seq-1")).toBe(
      "entitlement:ent_x:transfer:seq-1"
    )
  })
})

// ---------------------------------------------------------------------------
// AC2 — determineClaimOutcome: token jednorazowy + binding wg trybu + idempotencja
// ---------------------------------------------------------------------------

describe("determineClaimOutcome — walidacja tokenu (jednorazowy gate, fail-closed) (AC2)", () => {
  const base = {
    state: EntitlementInstanceState.ISSUED,
    bound_recipient_customer_id: null,
    policy_snapshot: BEARER,
  }

  it("brak nadanego tokenu ⇒ ClaimTokenInvalidError(absent)", () => {
    expect(() =>
      determineClaimOutcome({
        ...base,
        provided_claim_token: "tok-1",
        stored_claim_token: null,
      })
    ).toThrow(ClaimTokenInvalidError)
  })

  it("token mismatch ⇒ ClaimTokenInvalidError(mismatch)", () => {
    expect(() =>
      determineClaimOutcome({
        ...base,
        provided_claim_token: "tok-WRONG",
        stored_claim_token: "tok-1",
      })
    ).toThrow(ClaimTokenInvalidError)
  })

  it("token odwołany (revoked_at) ⇒ ClaimTokenInvalidError(revoked)", () => {
    expect(() =>
      determineClaimOutcome({
        ...base,
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        claim_token_revoked_at: new Date("2026-06-02T00:00:00.000Z"),
      })
    ).toThrow(ClaimTokenInvalidError)
  })
})

describe("determineClaimOutcome — pierwszy claim per tryb (ISSUED → ACTIVE) (AC2)", () => {
  it("bearer: przyjmuje okaziciela (claimant anonimowy), aktywuje", () => {
    const d = determineClaimOutcome({
      provided_claim_token: "tok-1",
      stored_claim_token: "tok-1",
      state: EntitlementInstanceState.ISSUED,
      bound_recipient_customer_id: null,
      policy_snapshot: BEARER,
    })
    expect(d.outcome).toBe("claimed")
    expect(d.transition).toBe(true)
    expect(d.binding.bearer).toBe(true)
    expect(d.binding.recipient_customer_id).toBeNull()
    expect(d.softFlag).toBe(false)
  })

  it("personalized: match (claimant == bound) ⇒ claimed", () => {
    const d = determineClaimOutcome({
      provided_claim_token: "tok-1",
      stored_claim_token: "tok-1",
      state: EntitlementInstanceState.ISSUED,
      bound_recipient_customer_id: "cus_recipient",
      claimant_customer_id: "cus_recipient",
      policy_snapshot: PERSONALIZED,
    })
    expect(d.outcome).toBe("claimed")
    expect(d.binding.recipient_customer_id).toBe("cus_recipient")
  })

  it("personalized: mismatch ⇒ TransferabilityError (reuse 2.6/BE-5, fail-closed)", () => {
    expect(() =>
      determineClaimOutcome({
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.ISSUED,
        bound_recipient_customer_id: "cus_recipient",
        claimant_customer_id: "cus_intruder",
        policy_snapshot: PERSONALIZED,
      })
    ).toThrow(TransferabilityError)
  })

  it("hybrid: mismatch ⇒ soft flag (NIE throw), aktywuje", () => {
    const d = determineClaimOutcome({
      provided_claim_token: "tok-1",
      stored_claim_token: "tok-1",
      state: EntitlementInstanceState.ISSUED,
      bound_recipient_customer_id: "cus_recipient",
      claimant_customer_id: "cus_other",
      policy_snapshot: HYBRID,
    })
    expect(d.outcome).toBe("claimed")
    expect(d.softFlag).toBe(true)
  })
})

describe("determineClaimOutcome — idempotencja / double-claim (token jednorazowy) (AC2)", () => {
  it("bearer replay (ACTIVE, ten sam token) ⇒ idempotent_replay (no-op, brak re-aktywacji)", () => {
    const d = determineClaimOutcome({
      provided_claim_token: "tok-1",
      stored_claim_token: "tok-1",
      state: EntitlementInstanceState.ACTIVE,
      bound_recipient_customer_id: null,
      policy_snapshot: BEARER,
    })
    expect(d.outcome).toBe("idempotent_replay")
    expect(d.transition).toBe(false)
  })

  it("personalized replay (ACTIVE, claimant == bound) ⇒ idempotent_replay (no-op)", () => {
    const d = determineClaimOutcome({
      provided_claim_token: "tok-1",
      stored_claim_token: "tok-1",
      state: EntitlementInstanceState.ACTIVE,
      bound_recipient_customer_id: "cus_recipient",
      claimant_customer_id: "cus_recipient",
      policy_snapshot: PERSONALIZED,
    })
    expect(d.outcome).toBe("idempotent_replay")
    expect(d.transition).toBe(false)
  })

  it("double-claim (ACTIVE, inna tożsamość po zużyciu) ⇒ ClaimTokenConsumedError (fail-closed)", () => {
    expect(() =>
      determineClaimOutcome({
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.ACTIVE,
        bound_recipient_customer_id: "cus_recipient",
        claimant_customer_id: "cus_intruder",
        policy_snapshot: PERSONALIZED,
      })
    ).toThrow(ClaimTokenConsumedError)
  })

  it("claim ze stanu terminalnego (np. REFUNDED) ⇒ ClaimStateError (fail-closed)", () => {
    expect(() =>
      determineClaimOutcome({
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.REFUNDED,
        bound_recipient_customer_id: null,
        policy_snapshot: BEARER,
      })
    ).toThrow(ClaimStateError)
  })
})

// ---------------------------------------------------------------------------
// AC2 — buildClaimWiring: jednolity punkt L4, event + audit + posting no-op
// ---------------------------------------------------------------------------

describe("buildClaimWiring — pierwszy claim przez jednolity punkt (AC2)", () => {
  it("claimed: tranzycja ISSUED→ACTIVE + audit (kto obdarował/kto zclaimował) + posting NO-OP", async () => {
    const audits: TransitionAuditEnvelope[] = []
    const events: unknown[] = []
    const res = await buildClaimWiring(
      {
        appendAudit: async (a) => {
          audits.push(a)
        },
        emitEvent: async (e) => {
          events.push(e)
        },
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
        // brak ledgerWriter/postingActivation ⇒ domyślna bramka (runtime_enabled=false)
      },
      {
        entitlement_id: "ent_transfer_001",
        scope: SCOPE,
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.ISSUED,
        bound_recipient_customer_id: "cus_recipient",
        claimant_customer_id: "cus_recipient",
        gifted_by_customer_id: "cus_buyer",
        policy_snapshot: PERSONALIZED,
        claim_seq: "claim-1",
      }
    )
    expect(res.outcome).toBe("claimed")
    // (1) event tranzycji ISSUED → ACTIVE
    expect(res.event?.payload.from_state).toBe(EntitlementInstanceState.ISSUED)
    expect(res.event?.payload.to_state).toBe(EntitlementInstanceState.ACTIVE)
    expect(res.event?.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(events).toHaveLength(1)
    // (2) append-only audit: kto obdarował / kto zclaimował + scope
    expect(audits).toHaveLength(1)
    expect(res.audit?.actor_hint).toBe(
      "claim:gifted_by=cus_buyer:claimed_by=cus_recipient"
    )
    expect(res.audit?.scope.market_id).toBe("mkt_bonbeauty")
    expect(res.audit?.outcome).toBe("transitioned")
    expect(res.audit?.occurred_at).toBe("2026-06-02T12:00:00.000Z")
    // (3) posting hook NO-OP derecognition (binding-only; brak payloadu) — AC3
    expect(res.posting?.attempted).toBe(false)
    expect(res.posting?.activated).toBe(false)
    expect(res.posting?.persisted).toBe(false)
    expect(res.emitFailed).toBe(false)
  })

  it("bearer claimed: actor_hint koduje okaziciela (claimed_by=bearer)", async () => {
    const res = await buildClaimWiring(
      {
        appendAudit: async () => {},
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_transfer_001",
        scope: SCOPE,
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.ISSUED,
        bound_recipient_customer_id: null,
        gifted_by_customer_id: "cus_buyer",
        policy_snapshot: BEARER,
        claim_seq: "claim-1",
      }
    )
    expect(res.outcome).toBe("claimed")
    expect(res.audit?.actor_hint).toBe(
      "claim:gifted_by=cus_buyer:claimed_by=bearer"
    )
  })
})

describe("buildClaimWiring — idempotencja claim (replay ⇒ no-op) (AC2)", () => {
  it("replay: ZERO efektów ubocznych (brak audytu, brak eventu, brak re-aktywacji)", async () => {
    const audits: TransitionAuditEnvelope[] = []
    const events: unknown[] = []
    const res = await buildClaimWiring(
      {
        appendAudit: async (a) => {
          audits.push(a)
        },
        emitEvent: async (e) => {
          events.push(e)
        },
      },
      {
        entitlement_id: "ent_transfer_001",
        scope: SCOPE,
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.ACTIVE, // już zclaimowany
        bound_recipient_customer_id: "cus_recipient",
        claimant_customer_id: "cus_recipient",
        policy_snapshot: PERSONALIZED,
        claim_seq: "claim-1",
      }
    )
    expect(res.outcome).toBe("idempotent_replay")
    expect(res.event).toBeNull()
    expect(res.audit).toBeNull()
    expect(res.posting).toBeNull()
    // NIE podwaja bindingu / NIE re-aktywuje / NIE emituje drugiego eventu.
    expect(audits).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it("double-claim po zużyciu (inna tożsamość) ⇒ rzuca (fail-closed), zero efektów ubocznych", async () => {
    const audits: TransitionAuditEnvelope[] = []
    await expect(
      buildClaimWiring(
        {
          appendAudit: async (a) => {
            audits.push(a)
          },
        },
        {
          entitlement_id: "ent_transfer_001",
          scope: SCOPE,
          provided_claim_token: "tok-1",
          stored_claim_token: "tok-1",
          state: EntitlementInstanceState.ACTIVE,
          bound_recipient_customer_id: "cus_recipient",
          claimant_customer_id: "cus_intruder",
          policy_snapshot: PERSONALIZED,
          claim_seq: "claim-2",
        }
      )
    ).rejects.toThrow(ClaimTokenConsumedError)
    expect(audits).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC2 — buildClaimTransitionInput: ISSUED → ACTIVE + posting CELOWO pominięty
// ---------------------------------------------------------------------------

describe("buildClaimTransitionInput — aktywacja przez recipienta (AC2)", () => {
  it("from=ISSUED, to=ACTIVE (istniejąca tranzycja, D-5), posting undefined (binding-only)", () => {
    const input = buildClaimTransitionInput({
      entitlement_id: "ent_transfer_001",
      scope: SCOPE,
      provided_claim_token: "tok-1",
      stored_claim_token: "tok-1",
      state: EntitlementInstanceState.ISSUED,
      bound_recipient_customer_id: "cus_recipient",
      claimant_customer_id: "cus_recipient",
      gifted_by_customer_id: "cus_buyer",
      policy_snapshot: PERSONALIZED,
      claim_seq: "claim-1",
    })
    expect(input.from).toBe(EntitlementInstanceState.ISSUED)
    expect(input.to).toBe(EntitlementInstanceState.ACTIVE)
    expect(input.posting).toBeUndefined()
    expect(input.transition_seq).toBe("claim-1")
    expect(input.actor).toBe("customer")
  })

  it("claimActorHint koduje obie tożsamości (kto obdarował / kto zclaimował, RODO id-only)", () => {
    expect(claimActorHint("cus_buyer", "cus_recipient")).toBe(
      "claim:gifted_by=cus_buyer:claimed_by=cus_recipient"
    )
    expect(claimActorHint(null, null)).toBe(
      "claim:gifted_by=?:claimed_by=bearer"
    )
  })
})

// ---------------------------------------------------------------------------
// AC3 — granice: posting no-op derecognition + taksonomia / tranzycja niezmienne
// ---------------------------------------------------------------------------

describe("AC3 — transfer/claim = binding-only, posting GATED, taksonomia niezmienna", () => {
  it("buildTransferPostingNoop: noop derecognition (liability bez zmiany, runtime_enabled=false)", () => {
    const noop = buildTransferPostingNoop()
    expect(noop.noop).toBe(true)
    expect(noop.reason).toBe(TRANSFER_POSTING_NOOP_REASON)
    expect(noop.reason).toContain("NIE derecognition")
    expect(noop.reason).toContain("runtime_enabled zostaje false")
  })

  it("posting hook NIGDY nie księguje na claimie (zero zapisu ledgera), nawet z writerem", async () => {
    let writes = 0
    const res = await buildClaimWiring(
      {
        appendAudit: async () => {},
        // writer podpięty, ale brak payloadu ⇒ hook go NIE woła (no-op derecognition)
        ledgerWriter: {
          write: async () => {
            writes++
            return { transaction_id: "x", applied: true, deduped: false }
          },
        },
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_transfer_001",
        scope: SCOPE,
        provided_claim_token: "tok-1",
        stored_claim_token: "tok-1",
        state: EntitlementInstanceState.ISSUED,
        bound_recipient_customer_id: null,
        policy_snapshot: BEARER,
        claim_seq: "claim-1",
      }
    )
    expect(res.posting?.attempted).toBe(false)
    expect(res.posting?.persisted).toBe(false)
    expect(writes).toBe(0) // ZERO zapisu — binding-only nie woła writera
  })

  it("taksonomia 13 stanów + tranzycja ISSUED→ACTIVE niezmienne (D-5, regresja)", () => {
    expect(ALL_ENTITLEMENT_INSTANCE_STATES).toHaveLength(13)
    // claim używa ISTNIEJĄCEJ krawędzi ISSUED → ACTIVE (nie dodaje stanu/krawędzi).
    expect(
      ALLOWED_ENTITLEMENT_TRANSITIONS[EntitlementInstanceState.ISSUED]
    ).toContain(EntitlementInstanceState.ACTIVE)
  })
})
