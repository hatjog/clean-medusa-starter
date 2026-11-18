/**
 * Story 8.7 fix (R-7, AD-21): `scopeScannerToMarket` — pod hookiem RLS każdy
 * przebieg per rynek widzi WYŁĄCZNIE kandydatów swojego rynku, więc wiersz nie
 * jest dosyłany N razy przy rosterze N rynków. Kandydat bez rynku / spoza
 * rosteru = nazwany sygnał (raz, w przebiegu pierwszego rynku), nie cisza.
 */
import { describe, expect, it } from "@jest/globals"

import { scopeScannerToMarket } from "../../jobs/voucher-delivery-reconciliation-sweep"
import type { DeliveryGapCandidate, DeliveryGapScanPort } from "../../modules/voucher-delivery/dispatch-ledger"

function candidate(entitlement_id: string, market_id: string | null): DeliveryGapCandidate {
  return {
    entitlement_id,
    market_id,
    entitlement_state: "ISSUED",
    template_key: "voucher_purchase_confirmation",
    dispatch_id: null,
    dispatch_status: null,
    queued_at: null,
    attempt_count: 0,
    non_recipient_failure_count: 0,
  }
}

const ALL = [candidate("e_a", "mkt_a"), candidate("e_b", "mkt_b"), candidate("e_null", null), candidate("e_x", "obcy")]

function scanner(): DeliveryGapScanPort {
  return {
    scanDeliveryGaps: async () => ({ candidates: ALL, truncated: false }),
    scanStalledDispatches: async () => ALL,
  } as unknown as DeliveryGapScanPort
}

describe("Story 8.7 R-7 — skaner sweepa zawężony do rynku przebiegu", () => {
  const roster = ["mkt_a", "mkt_b"]

  it("każdy kandydat rosteru trafia do DOKŁADNIE jednego przebiegu (brak dosyłki N razy)", async () => {
    const seen: string[] = []
    for (const m of roster) {
      const s = scopeScannerToMarket(scanner(), m, roster, { error: () => undefined })
      const gaps = await s.scanDeliveryGaps({} as never)
      const stalled = await s.scanStalledDispatches({} as never)
      expect(stalled.map((c) => c.entitlement_id)).toEqual(gaps.candidates.map((c) => c.entitlement_id))
      seen.push(...gaps.candidates.map((c) => c.entitlement_id))
    }
    expect(seen).toEqual(["e_a", "e_b"])
  })

  it("kandydat bez rynku / spoza rosteru ⇒ GP_SYSTEM_ROW_OUTSIDE_ROSTER raz na przebieg wywołania", async () => {
    const errors: string[] = []
    for (const m of roster) {
      const s = scopeScannerToMarket(scanner(), m, roster, { error: (msg: string) => errors.push(msg) })
      await s.scanDeliveryGaps({} as never)
    }
    expect(errors).toHaveLength(2)
    expect(errors.every((e) => e.includes("GP_SYSTEM_ROW_OUTSIDE_ROSTER"))).toBe(true)
    expect(errors.some((e) => e.includes("entitlement_id=e_null market_id=null"))).toBe(true)
    expect(errors.some((e) => e.includes("entitlement_id=e_x market_id=obcy"))).toBe(true)
  })
})
