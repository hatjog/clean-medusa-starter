/**
 * v1.16.0 Story 5.4 AC3 (AD-34; wchłonięta 5.6, `DW-15-162`) — gałąź kwotowa
 * produkuje posting i saldo, usługowa nie.
 *
 * MIERZONE: „posting ZAPISANY do `voucher_ledger_*`" (bramka aktywacji włączona
 * seamem testowym + realny `VoucherLedgerWriter`), oraz osobno „posting
 * WYPRODUKOWANY" (`posting.attempted` z wyniku operacji). Produkcja ma
 * `runtime_enabled=false`, więc tam wiersze ledgera nie powstają dla ŻADNEJ
 * gałęzi — dlatego bramka jest włączona tutaj, inaczej rozłączność byłaby
 * nieodróżnialna od wyłączonej bramki.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  VOUCHER_AMOUNT_FIXTURE as AMT,
  VOUCHER_SERVICE_FIXTURE as SVC,
} from "../fixtures/entitlement-voucher-amount.fixture"
import { resolveRlsConnectionSource } from "../../lib/rls-connection-source"
import { VoucherLedgerWriter } from "../../modules/voucher/ledger-writer"
import { createRedeemPartialOperationFromPool } from "../../modules/voucher/workflows/redeem-partial-entitlement"
import {
  Harness,
  MARKET,
  measure,
  resetState,
  runOrSkip,
  seedVoucherWithEntitlement,
  setUpHarness,
  tearDownHarness,
} from "./helpers/voucher-service-redeem-pg-harness"

let h: Harness

runOrSkip("Story 5.4 AC3 — rozłączność gałęzi kwotowej i usługowej", () => {
  beforeAll(async () => {
    h = await setUpHarness()
  })
  afterAll(async () => tearDownHarness(h))
  beforeEach(async () => {
    await resetState(h.admin)
    await seedVoucherWithEntitlement(h.admin, AMT)
    await seedVoucherWithEntitlement(h.admin, SVC)
  })

  function operation() {
    const source = resolveRlsConnectionSource(h.container, ContainerRegistrationKeys.PG_CONNECTION)
    return createRedeemPartialOperationFromPool(source as any, {
      ledgerWriter: new VoucherLedgerWriter(source as any),
      postingActivation: { runtimeEnabled: true, isMarketActivated: () => true },
    })
  }

  it("gałąź kwotowa produkuje posting i saldo, usługowa nie (asercja niepustości PRZED rozłącznością)", async () => {
    // Lekcja „pusty join wygląda jak brak zjawiska": najpierw zbiór kwotowy niepusty.
    const amountCount = await h.admin.raw(
      `SELECT count(*)::int AS n FROM entitlement_instance WHERE entitlement_type = 'VOUCHER_AMOUNT'`,
    )
    expect(amountCount.rows[0].n).toBeGreaterThan(0)

    const { runInHttpMarketContext } = require("../../lib/http-market-context")
    const run = (code: string, key: string) =>
      runInHttpMarketContext(MARKET, () =>
        operation().redeem({
          voucher_code: code,
          redeem_full: true,
          idempotency_key_header: key,
          redemption_market_id: MARKET,
          vendor_id: "ven_story54",
          actor: "vendor",
          actor_hint: "vendor:story54-ac3",
          voucher_net_minor: Math.round((code === AMT.code ? AMT.grossMinor : SVC.grossMinor) / 1.23),
          voucher_vat_minor:
            (code === AMT.code ? AMT.grossMinor : SVC.grossMinor) -
            Math.round((code === AMT.code ? AMT.grossMinor : SVC.grossMinor) / 1.23),
        }),
      )

    const amountRes = await run(AMT.code, "story54-ac3-amount-01")
    const serviceRes = await run(SVC.code, "story54-ac3-service-01")

    const amount = await measure(h.admin, AMT.code, AMT.entitlementId)
    const service = await measure(h.admin, SVC.code, SVC.entitlementId)

    // Posting WYPRODUKOWANY.
    expect(amountRes.posting.attempted).toBe(true)
    expect(serviceRes.posting.attempted).toBe(false)
    // Posting ZAPISANY do voucher_ledger_*.
    expect(amountRes.posting.persisted).toBe(true)
    expect(amount.ledger_transactions).toBe(1)
    expect(amount.ledger_entries).toBeGreaterThan(0)
    expect(service.ledger_transactions).toBe(0)
    expect(service.ledger_entries).toBe(0)
    // Saldo: kwotowe zapisane (0 po całości), usługowe nietknięte (NULL).
    expect(amount.remaining_amount).toBe(0)
    expect(service.remaining_amount).toBeNull()
    // Obie gałęzie kończą stanem terminalnym i zostawiają ślad.
    expect(amount.entitlement_state).toBe("REDEEMED_FULL")
    expect(service.entitlement_state).toBe("REDEEMED_FULL")
    expect(amount.redemption_rows).toBe(1)
    expect(service.redemption_rows).toBe(1)
  })
})
