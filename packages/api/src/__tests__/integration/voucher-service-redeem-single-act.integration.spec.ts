/**
 * v1.16.0 Story 5.4 AC1 (FR-19, AD-34, ADR-237) — realizacja `VOUCHER_SERVICE`
 * przez trasę panelu JEDNYM aktem, bez wiersza salda i bez postingu kwotowego.
 * Uprząż i jej granice: `helpers/voucher-service-redeem-pg-harness.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "@jest/globals"

import { VOUCHER_SERVICE_FIXTURE as SVC } from "../fixtures/entitlement-voucher-amount.fixture"
import { RlsMarketContextRequiredError } from "../../lib/rls-pool-hook"
import {
  callLookupRoute,
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

/**
 * Story 5.4 fix runda 2 (R-10/R-11) — przepływ panelu lookup → redeem → lookup
 * na realnym Knexie z hookiem RLS, BEZ owijania tras w kontekst rynku.
 */
runOrSkip("Story 5.4 fix runda 2 — lookup trasą panelu w kontekście rynku sprzedawcy", () => {
  const MARKET_B = "market_b_story54"
  const SELLER_B = "sel_story54_b"
  const CODE_B_OTHER_SELLER = "V-STORY54-B-OTHER"
  const CODE_B_SAME_SELLER = "V-STORY54-B-SAME"

  beforeAll(async () => {
    h = await setUpHarness()
  })
  afterAll(async () => tearDownHarness(h))
  beforeEach(async () => {
    await resetState(h.admin)
    await seedVoucherWithEntitlement(h.admin, SVC)
    await h.admin.raw(`INSERT INTO seller (id, metadata) VALUES (?, ?::jsonb)`, [
      SELLER_B,
      JSON.stringify({ gp: { market_id: MARKET_B } }),
    ])
    for (const [code, seller] of [
      [CODE_B_OTHER_SELLER, SELLER_B],
      // Voucher rynku B przypisany sprzedawcy rynku A: własność by przeszła,
      // izolacja rynku MUSI go ukryć.
      [CODE_B_SAME_SELLER, "sel_story54"],
    ]) {
      await h.admin.raw(
        `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle,
                              product_title, value_minor, currency_code, status)
         VALUES (?, ?, ?, 'Salon B', 'salon-b', 'Zabieg', 5000, 'pln', 'idle')`,
        [code, MARKET_B, seller],
      )
    }
  })

  it("kontrola: getForSeller bez kontekstu rynku jest odmową hooka (trasa musi założyć kontekst sama)", async () => {
    // OSOBNA pula: odmowa hooka niszczy surowe połączenie bez zwrotu slotu do
    // puli tarn (zachowanie zastane hooka, nazwane w DW-15-300), więc na puli
    // uprzęży `destroy()` w afterAll czekałby w nieskończoność.
    const knexFactory = require("knex")
    const { installRlsPoolHook } = require("../../lib/rls-pool-hook")
    const { VoucherService } = require("../../modules/voucher/service")
    const { ContainerRegistrationKeys } = require("@medusajs/framework/utils")
    const probe = knexFactory({
      client: "pg",
      connection: (h.db as any).client.config.connection,
      pool: { min: 0, max: 1 },
    })
    installRlsPoolHook(probe)
    const svc = new VoucherService({ [ContainerRegistrationKeys.PG_CONNECTION]: probe })
    await expect(svc.getForSeller("sel_story54", SVC.code)).rejects.toBeInstanceOf(
      RlsMarketContextRequiredError,
    )
    void Promise.race([probe.destroy(), new Promise((r) => setTimeout(r, 200))])
  })

  it("lookup → redeem → lookup potwierdzający: 200 / 200 / 200 claimed", async () => {
    const first = await callLookupRoute(h, SVC.code)
    expect(first.statusCode).toBe(200)
    expect(first.body.voucher.code).toBe(SVC.code)
    expect(first.body.voucher.status).toBe("idle")
    expect(first.body.voucher.market_id).toBe("bonbeauty")

    const redeem = await callRedeemRoute(h, SVC.code, "story54-fix2-key-0001")
    expect(redeem.statusCode).toBe(200)

    const confirm = await callLookupRoute(h, SVC.code)
    expect(confirm.statusCode).toBe(200)
    expect(confirm.body.voucher.status).toBe("claimed")
  })

  it("sprzedawca rynku A na voucherze rynku B ⇒ 404 bajt-w-bajt jak nieznany kod (bez wycieku)", async () => {
    const unknown = await callLookupRoute(h, "V-STORY54-NIE-MA")
    const otherSeller = await callLookupRoute(h, CODE_B_OTHER_SELLER)
    const sameSellerOtherMarket = await callLookupRoute(h, CODE_B_SAME_SELLER)
    expect(unknown.statusCode).toBe(404)
    for (const r of [otherSeller, sameSellerOtherMarket]) {
      expect(r.statusCode).toBe(404)
      expect(JSON.stringify(r.body)).toBe(JSON.stringify(unknown.body))
    }
  })

  it("kontrola dodatnia: sprzedawca rynku B widzi swój voucher rynku B (odmowa wyżej to izolacja, nie awaria)", async () => {
    const own = await callLookupRoute(h, CODE_B_OTHER_SELLER, SELLER_B)
    expect(own.statusCode).toBe(200)
    expect(own.body.voucher.market_id).toBe(MARKET_B)
  })
})
