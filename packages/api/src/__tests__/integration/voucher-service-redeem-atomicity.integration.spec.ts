/**
 * v1.16.0 Story 5.4 AC2 (AD-34, AD-17) — akt i ślad są JEDNĄ transakcją.
 * Awaria wstrzykiwana WYŁĄCZNIE w teście (owinięte połączenie PG); produkcja
 * nie ma flagi. Po rollbacku: stan sprzed aktu ORAZ brak śladu.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "@jest/globals"

import { VOUCHER_SERVICE_FIXTURE as SVC } from "../fixtures/entitlement-voucher-amount.fixture"
import {
  callRedeemRoute,
  faultingPgConnection,
  Harness,
  measure,
  resetState,
  runOrSkip,
  seedVoucherWithEntitlement,
  setUpHarness,
  tearDownHarness,
} from "./helpers/voucher-service-redeem-pg-harness"

let h: Harness

const PRISTINE = {
  voucher_status: "idle",
  entitlement_state: "ACTIVE",
  remaining_amount: null,
  redemption_rows: 0,
  voucher_event_rows: 0,
  ledger_transactions: 0,
  ledger_entries: 0,
  ledger_posting_applied_rows: 0,
}

runOrSkip("Story 5.4 AC2 — atomowość aktu i śladu", () => {
  beforeAll(async () => {
    h = await setUpHarness()
  })
  afterAll(async () => tearDownHarness(h))
  beforeEach(async () => {
    await resetState(h.admin)
    await seedVoucherWithEntitlement(h.admin, SVC)
  })

  async function redeemWithFault(failOn: RegExp, key: string) {
    const f = faultingPgConnection(h.db, { failOn })
    await expect(callRedeemRoute(h, SVC.code, key, f.connection)).rejects.toThrow(
      /fault injection/,
    )
    expect(f.failures()).toBe(1)
    return measure(h.admin, SVC.code, SVC.entitlementId)
  }

  it("awaria PO mutacji stanu (REDEMPTION_REQUESTED) i W zapisie śladu ⇒ brak stanu połowicznego", async () => {
    const after = await redeemWithFault(/INSERT INTO voucher_redemption/, "story54-ac2-a-0001")
    expect(after).toEqual(PRISTINE)
  })

  it("wariant odwrotny: ślad zapisany, awaria przy mutacji projekcji vouchera ⇒ ślad też cofnięty", async () => {
    const after = await redeemWithFault(/UPDATE voucher\s+SET/i, "story54-ac2-b-0001")
    expect(after).toEqual(PRISTINE)
  })

  it("awaria na OSTATNIM zapisie aktu (audyt kroku 2) ⇒ ani akt, ani ślad", async () => {
    // Audyt kroku 2 jest drugim INSERT-em do voucher_event z entitlement_id;
    // celujemy w niego po transition_seq `:redeem`.
    let seen = 0
    const f = faultingPgConnection(h.db, {})
    const conn: any = f.connection
    const origAcquire = conn.client.acquireConnection
    conn.client.acquireConnection = async () => {
      const c = await origAcquire()
      const q = c.query
      c.query = async (sql: any, p?: any[]) => {
        const text = typeof sql === "string" ? sql : ""
        if (/INSERT INTO voucher_event \(id, voucher_code, entitlement_id/.test(text)) {
          seen += 1
          if (seen === 2) throw new Error("[story-5.4 fault injection] step2 audit")
        }
        return q(sql, p)
      }
      return c
    }
    await expect(callRedeemRoute(h, SVC.code, "story54-ac2-c-0001", conn)).rejects.toThrow(
      /fault injection/,
    )
    expect(seen).toBe(2)
    expect(await measure(h.admin, SVC.code, SVC.entitlementId)).toEqual(PRISTINE)
  })

  it("KONTROLA NEGATYWNA (mutant: ślad poza transakcją) — asercja atomowości CZERWIENIEJE", async () => {
    // Ślad leci autocommitem osobnym połączeniem, potem awaria na projekcji.
    const f = faultingPgConnection(h.db, {
      divert: { match: /INSERT INTO voucher_redemption/, via: h.admin },
      failOn: /UPDATE voucher\s+SET/i,
    })
    await expect(callRedeemRoute(h, SVC.code, "story54-ac2-m-0001", f.connection)).rejects.toThrow(
      /fault injection/,
    )
    expect(f.diverted()).toBe(1)
    const after = await measure(h.admin, SVC.code, SVC.entitlementId)
    // Pod mutantem stan PRISTINE NIE zachodzi: ślad istnieje bez aktu.
    expect(after).not.toEqual(PRISTINE)
    expect(after.redemption_rows).toBe(1)
    expect(after.entitlement_state).toBe("ACTIVE")
  })

  it("bez awarii ta sama uprząż przepuszcza akt (kontrola dodatnia uprzęży)", async () => {
    const f = faultingPgConnection(h.db, {})
    const res = await callRedeemRoute(h, SVC.code, "story54-ac2-p-0001", f.connection)
    expect(res.statusCode).toBe(200)
    const after = await measure(h.admin, SVC.code, SVC.entitlementId)
    expect(after.entitlement_state).toBe("REDEEMED_FULL")
    expect(after.redemption_rows).toBe(1)
  })
})
