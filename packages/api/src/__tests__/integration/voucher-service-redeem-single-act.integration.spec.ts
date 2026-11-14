/**
 * v1.16.0 Story 5.4 AC1 (FR-19, AD-34, ADR-237) — realizacja `VOUCHER_SERVICE`
 * przez trasę panelu JEDNYM aktem, bez wiersza salda i bez postingu kwotowego.
 * Uprząż i jej granice: `helpers/voucher-service-redeem-pg-harness.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "@jest/globals"

import { VOUCHER_SERVICE_FIXTURE as SVC } from "../fixtures/entitlement-voucher-amount.fixture"
import {
  callRedeemRoute,
  Harness,
  measure,
  resetState,
  runOrSkip,
  seedVoucherWithEntitlement,
  setUpHarness,
  tearDownHarness,
} from "./helpers/voucher-service-redeem-pg-harness"

let h: Harness

runOrSkip("Story 5.4 AC1 — VOUCHER_SERVICE: jeden akt, bez salda i postingu", () => {
  beforeAll(async () => {
    h = await setUpHarness()
  })
  afterAll(async () => tearDownHarness(h))
  beforeEach(async () => {
    await resetState(h.admin)
    await seedVoucherWithEntitlement(h.admin, SVC)
  })

  it("trasa (member + x-seller-id) zużywa uprawnienie w całości jednym aktem; stan terminalny zapisany", async () => {
    const before = await measure(h.admin, SVC.code, SVC.entitlementId)
    expect(before.voucher_status).toBe("idle")
    expect(before.entitlement_state).toBe("ACTIVE")
    expect(before.remaining_amount).toBeNull()

    const res = await callRedeemRoute(h, SVC.code, "story54-ac1-key-0001")
    expect(res.statusCode).toBe(200)
    expect(res.body.outcome).toBe("redeemed_now")
    expect(res.body.envelope.new_status).toBe("claimed")

    const after = await measure(h.admin, SVC.code, SVC.entitlementId)
    // Stan terminalny w obu warstwach.
    expect(after.voucher_status).toBe("claimed")
    expect(after.entitlement_state).toBe("REDEEMED_FULL")
    // Jeden akt = jeden wiersz kanoniczny (ślad AD-17).
    expect(after.redemption_rows).toBe(1)
    // Bez wiersza salda: `remaining_amount` NIE zmienione (zostaje NULL).
    expect(after.remaining_amount).toBeNull()
    // Bez postingu kwotowego: zero wierszy w `voucher_ledger_*`.
    expect(after.ledger_transactions).toBe(0)
    expect(after.ledger_entries).toBe(0)
    expect(after.ledger_posting_applied_rows).toBe(0)
  })

  it("stan terminalny jest widoczny z panelu — odczyt trasą lookupu sprzedawcy", async () => {
    await callRedeemRoute(h, SVC.code, "story54-ac1-key-0002")
    const { runInHttpMarketContext } = require("../../lib/http-market-context")
    const view = await runInHttpMarketContext("bonbeauty", () =>
      h.service.getForSeller("sel_story54", SVC.code),
    )
    expect(view?.status).toBe("claimed")
  })

  it("drugi akt (inny klucz) jest odmową — realizacja częściowa ani ponowna nie istnieje", async () => {
    await callRedeemRoute(h, SVC.code, "story54-ac1-key-0003")
    const second = await callRedeemRoute(h, SVC.code, "story54-ac1-key-0004")
    expect(second.statusCode).toBeGreaterThanOrEqual(400)
    const after = await measure(h.admin, SVC.code, SVC.entitlementId)
    expect(after.redemption_rows).toBe(1)
  })
})
