/**
 * stripe-payment-audit-active-emit.unit.spec.ts — Story 2.1 (v1.14.0, AD-7).
 *
 * AC1: emit `gp.entitlements.entitlement_state_changed.v1` dla genezy ACTIVE
 * (`payment.captured → issue-entitlement`, wiersz tworzony already-ACTIVE):
 *   (a) emit następuje PO commicie transakcji biznesowej (post-commit),
 *   (b) awaria emitu NIE wywraca tranzycji (best-effort, swallow + warn),
 *   (c) envelope zgodny z kontraktem `gp.entitlements.entitlement_state_changed.v1`
 *       i kształtem IDENTYCZNY z genezą ISSUED (ten sam builder/envelope),
 *   (d) replay / idempotentny re-issue NIE re-emituje (zero podwójnego sygnału).
 */
import { StripePaymentAuditWorkflow } from "../../../workflows/payment/stripe-payment-audit"
import {
  buildTransitionEnvelopes,
  buildGenesisActiveTransition,
  buildGenesisIssuedTransition,
  assertWiringTransition,
  ENTITLEMENT_GENESIS,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  EntitlementGenesisError,
  type TransitionEventEnvelope,
} from "../../../modules/voucher/entitlement-transition-wiring"
import { assertEventEnvelopeMatchesContract } from "../../../modules/gp-core/market-lifecycle-events"
import { EntitlementInstanceState } from "../../../modules/voucher/models/entitlement"

type SequenceEntry = { kind: "sql" | "emit"; value: string }

class FakeClient {
  rows = new Map<string, Record<string, unknown>>()
  existingEntitlementId: string | null = null

  constructor(private readonly sequence: SequenceEntry[]) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ) {
    this.sequence.push({ kind: "sql", value: sql.trim().split("\n")[0] })
    if (sql.includes("INSERT INTO webhook_event_processed")) {
      const key = `${params[0]}:stripe`
      if (this.rows.has(key)) return { rows: [] as T[], rowCount: 0 }
      this.rows.set(key, { event_id: params[0] })
      return { rows: [] as T[], rowCount: 1 }
    }
    if (
      sql.includes("FROM entitlement_instance") &&
      sql.includes("SELECT") &&
      this.existingEntitlementId
    ) {
      return {
        rows: [
          { id: this.existingEntitlementId, claim_token: "tok_existing" },
        ] as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("INSERT INTO entitlement_instance")) {
      this.rows.set(params[0] as string, { id: params[0] })
      return { rows: [] as T[], rowCount: 1 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }

  release() {}
}

function capturedPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_active_1",
    request_id: "req_active_1",
    payment_intent_id: "pi_active_1",
    payment_id: "pay_active_1",
    order_id: "ord_active_1",
    market_id: "bonbeauty",
    payment_method_type: "card",
    processing_country: "PL",
    amount_minor: 19900,
    currency: "PLN",
    entitlement_profile: {
      profile_id: "voucher-kwotowy-365d",
      entitlement_type: "VOUCHER_AMOUNT",
      policy: { validity_days: 365 },
      currency: "PLN",
      amount_minor: 19900,
    },
    ...overrides,
  }
}

function makeHarness(options?: {
  existingEntitlementId?: string
  rejectStateChangedEmit?: boolean
}) {
  const sequence: SequenceEntry[] = []
  const client = new FakeClient(sequence)
  if (options?.existingEntitlementId) {
    client.existingEntitlementId = options.existingEntitlementId
  }
  const emitted: Array<{ name: string; data: unknown }> = []
  const eventBus = {
    emit: jest.fn(async (message: { name: string; data: unknown }) => {
      if (
        options?.rejectStateChangedEmit &&
        message.name === ENTITLEMENT_STATE_CHANGED_EVENT_TYPE
      ) {
        throw new Error("bus down (symulowana awaria emitu)")
      }
      sequence.push({ kind: "emit", value: message.name })
      emitted.push(message)
    }),
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const workflow = new StripePaymentAuditWorkflow(
    { connect: async () => client },
    eventBus,
    logger
  )
  return { workflow, client, eventBus, logger, sequence, emitted }
}

function stateChangedEvents(
  emitted: Array<{ name: string; data: unknown }>
): TransitionEventEnvelope[] {
  return emitted
    .filter((m) => m.name === ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    .map((m) => m.data as TransitionEventEnvelope)
}

describe("Story 2.1 AC1 — emit entitlement_state_changed dla genezy ACTIVE", () => {
  it("(a) emituje ISSUED→ACTIVE post-commit dla nowo utworzonego entitlementu", async () => {
    const { workflow, sequence, emitted } = makeHarness()

    await workflow.process("payment.captured", capturedPayload())

    const events = stateChangedEvents(emitted)
    expect(events).toHaveLength(1)
    expect(events[0].payload.from_state).toBe(EntitlementInstanceState.ISSUED)
    expect(events[0].payload.to_state).toBe(EntitlementInstanceState.ACTIVE)
    expect(events[0].scope.market_id).toBe("bonbeauty")

    // Post-commit: COMMIT transakcji biznesowej poprzedza emit eventu.
    const commitIdx = sequence.findIndex(
      (s) => s.kind === "sql" && s.value === "COMMIT"
    )
    const emitIdx = sequence.findIndex(
      (s) => s.kind === "emit" && s.value === ENTITLEMENT_STATE_CHANGED_EVENT_TYPE
    )
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(emitIdx).toBeGreaterThan(commitIdx)
  })

  it("(b) awaria emitu NIE wywraca tranzycji — best-effort, warn, brak wyjątku", async () => {
    const { workflow, client, logger, emitted } = makeHarness({
      rejectStateChangedEmit: true,
    })

    const result = await workflow.process("payment.captured", capturedPayload())

    // Tranzycja biznesowa przeszła: wiersz entitlement_instance INSERT-owany,
    // wynik zwrócony, żaden wyjątek nie propaguje.
    expect(result.entitlement?.entitlement_id).toBeTruthy()
    expect(
      client.rows.has(result.entitlement?.entitlement_id as string)
    ).toBe(true)
    expect(stateChangedEvents(emitted)).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("emit_failed=1/1")
    )
  })

  it("(c) envelope przechodzi kontrakt eventu i ma kształt identyczny z genezą ISSUED", async () => {
    const { workflow, emitted } = makeHarness()
    await workflow.process("payment.captured", capturedPayload())

    const [event] = stateChangedEvents(emitted)
    expect(() =>
      assertEventEnvelopeMatchesContract(
        event,
        "gp.entitlements.entitlement_state_changed.v1"
      )
    ).not.toThrow()

    // Ten sam builder/envelope co ISSUED — identyczny zestaw kluczy koperty
    // i payloadu (żadnego drugiego, równoległego kształtu eventu).
    const issuedReference = buildTransitionEnvelopes(
      buildGenesisIssuedTransition({
        entitlement_id: "ent_ref",
        scope: { instance_id: "ent_ref", market_id: "bonbeauty" },
        actor_hint: "subscriber:path-y:live-issue",
        transition_seq: "ref-1",
      }),
      new Date()
    ).event
    expect(Object.keys(event).sort()).toEqual(
      Object.keys(issuedReference).sort()
    )
    expect(Object.keys(event.payload).sort()).toEqual(
      Object.keys(issuedReference.payload).sort()
    )
  })

  it("(d) replay tego samego event_id jest deduplikowany — zero re-emitu", async () => {
    const { workflow, emitted } = makeHarness()
    await workflow.process("payment.captured", capturedPayload())
    await workflow.process("payment.captured", capturedPayload())

    expect(stateChangedEvents(emitted)).toHaveLength(1)
  })

  it("(d) idempotentny re-issue (wiersz już istnieje) NIE emituje genezy ACTIVE", async () => {
    const { workflow, emitted } = makeHarness({
      existingEntitlementId: "ent_existing_1",
    })

    const result = await workflow.process("payment.captured", capturedPayload())

    expect(result.entitlement?.idempotent).toBe(true)
    expect(stateChangedEvents(emitted)).toHaveLength(0)
  })
})

describe("Story 2.1 AC1 — buildGenesisActiveTransition (wiring)", () => {
  it("modeluje genezę ACTIVE jako legalną krawędź ISSUED→ACTIVE (bez sentinela)", () => {
    const input = buildGenesisActiveTransition({
      entitlement_id: "ent_1",
      scope: { instance_id: "ent_1", market_id: "pl" },
      transition_seq: "seq-1",
    })
    expect(input.from).toBe(EntitlementInstanceState.ISSUED)
    expect(input.to).toBe(EntitlementInstanceState.ACTIVE)
    expect(() => assertWiringTransition(input.from, input.to)).not.toThrow()
  })

  it("NIE rozluźnia fail-closed genezy: sentinel __genesis__ → ACTIVE nadal rzuca", () => {
    expect(() =>
      assertWiringTransition(
        ENTITLEMENT_GENESIS,
        EntitlementInstanceState.ACTIVE
      )
    ).toThrow(EntitlementGenesisError)
  })
})
