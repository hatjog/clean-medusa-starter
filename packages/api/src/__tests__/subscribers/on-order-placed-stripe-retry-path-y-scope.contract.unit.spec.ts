/**
 * Story 11.1 REG-C5-001 — kontrakt wejścia Path Y → liveIssueEntitlementsWithinTx.
 *
 * Workflow NIE jest mockowany: wejście zbudowane przez subscriber trafia do
 * PRAWDZIWEGO `liveIssueEntitlementsWithinTx`, który wymaga obu osi scope
 * (market_id + instance_id) przed business dedupe. Bez instance_id test czerwienieje.
 */
import { afterEach, describe, expect, it } from "@jest/globals"

import {
  buildPathYRecoveryInput,
  PathYRecoveryInputError,
  type DeferredCaptureRow,
} from "../../subscribers/on-order-placed-stripe-retry"
import { liveIssueEntitlementsWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"

const ROW: DeferredCaptureRow = {
  event_id: "evt_11_1_path_y",
  provider: "stripe_path_y",
  market_id: "bonbeauty",
  payment_intent_id: "pi_11_1_path_y",
  envelope: { psp_occurred_at: "2026-11-14T12:00:00.000Z" },
  amount_minor: 25000,
  currency: "PLN",
  payment_id: "pay_11_1",
}

type Recorded = { sql: string; params: unknown[] }

function recordingClient(): { client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }; calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    client: {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params })
        // rowCount 0 na dedupe = no-op (event już skonsumowany) — wystarcza,
        // żeby zmierzyć, że workflow przyjął scope i doszedł do INSERT-u dedupe.
        return { rows: [], rowCount: 0 }
      },
    },
  }
}

const previous = process.env.GP_INSTANCE_ID
afterEach(() => {
  if (previous === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = previous
})

describe("Story 11.1 REG-C5-001 — Path Y przekazuje instance_id do workflow issuance", () => {
  it("wejście z GP_INSTANCE_ID przechodzi przez realny workflow do dedupe z obiema osiami", async () => {
    process.env.GP_INSTANCE_ID = "gp-test"
    const input = buildPathYRecoveryInput(ROW, "order_11_1")
    expect(input.scope).toEqual({ instance_id: "gp-test", market_id: "bonbeauty" })
    const { client, calls } = recordingClient()
    await expect(liveIssueEntitlementsWithinTx(client as never, input as never, new Date())).resolves.toEqual({
      event_processed: false,
      issued: [],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toMatch(/event_processed/i)
    expect(calls[0]!.params).toEqual(expect.arrayContaining(["gp-test", "bonbeauty"]))
  })

  it("kontrola mutanta: scope bez instance_id (stary kształt) jest odrzucany przez workflow", async () => {
    process.env.GP_INSTANCE_ID = "gp-test"
    const input = buildPathYRecoveryInput(ROW, "order_11_1")
    const mutant = { ...input, scope: { market_id: input.scope.market_id } }
    const { client, calls } = recordingClient()
    await expect(liveIssueEntitlementsWithinTx(client as never, mutant as never, new Date())).rejects.toThrow(
      /instance_id nierozwiązywalny/
    )
    expect(calls).toHaveLength(0)
  })

  it("brak GP_INSTANCE_ID ⇒ nazwana odmowa, bez fallbacku 'gp' i bez odczytu z metadata", () => {
    delete process.env.GP_INSTANCE_ID
    const rowWithMetadata = { ...ROW, envelope: { ...ROW.envelope, instance_id: "from-envelope", scope: { instance_id: "x" } } }
    let caught: unknown
    try {
      buildPathYRecoveryInput(rowWithMetadata, "order_11_1")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PathYRecoveryInputError)
    expect((caught as PathYRecoveryInputError).field).toBe("instance_id")
    expect((caught as Error).message).toMatch(/instance_unconfigured/)
  })
})
