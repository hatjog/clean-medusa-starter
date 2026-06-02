/**
 * voucher-ledger-reconciliation.test.ts — Story 2.6 AC3 (D2, inwariant kompletności).
 *
 * Pokrywa: dosyłka z PERSYSTOWANEGO snapshotu (NIE live state); brak snapshotu ⇒
 * fail-closed alarm (log error + metryka, NIE cicha dosyłka, NIE silent skip);
 * no-op księgowy ze snapshotu (SPV REDEEMED); idempotencja (deduped).
 */

import { describe, it, expect, jest } from "@jest/globals"
import {
  runVoucherLedgerReconciliation,
  type LedgerEventSnapshot,
  type ReconciliationDeps,
  type TerminalEntitlementRef,
} from "../../../jobs/voucher-ledger-reconciliation"
import {
  deriveLedgerTransactionId,
  type VoucherLedgerWriteResult,
} from "../ledger-writer"
import type { VoucherPostingInput } from "../posting-profile"

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function metrics() {
  return { increment: jest.fn() }
}

function expiredMpvSnapshot(entitlementId = "ent_exp"): LedgerEventSnapshot {
  const remaining = 12300
  const transaction_id = deriveLedgerTransactionId({
    entitlement_id: entitlementId,
    lifecycle_event: "EXPIRED",
    remaining_gross_snapshot: remaining,
  })
  const posting_input: VoucherPostingInput = {
    lifecycle_event: "EXPIRED",
    vat_classification: "MPV",
    net_minor: 10000,
    vat_minor: 2300,
    remaining_gross_minor: remaining,
    redeemed_gross_to_date_minor: 0,
    transaction_id,
    occurred_at: "2026-09-01T00:00:00Z",
    scope: { instance_id: "gp-dev", market_id: "pl" },
    currency: "PLN",
  }
  return {
    entitlement_id: entitlementId,
    lifecycle_event: "EXPIRED",
    remaining_gross_snapshot: remaining,
    posting_input,
    expected_currency: "PLN",
  }
}

describe("Story 2.6 AC3 — reconciliation inwariant kompletności (ADR-139 D2)", () => {
  it("terminalny entitlement + snapshot ⇒ dosłany (backfilled), z persystowanego snapshotu", async () => {
    const ref: TerminalEntitlementRef = { entitlement_id: "ent_exp", lifecycle_event: "EXPIRED", market_id: "pl" }
    const snapshot = expiredMpvSnapshot("ent_exp")
    const write = jest.fn(async () => ({ transaction_id: snapshot.posting_input.transaction_id, applied: true, deduped: false } as VoucherLedgerWriteResult))

    const deps: ReconciliationDeps = {
      scanner: { scanTerminalWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write },
      logger: logger(),
      metrics: metrics(),
    }

    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.scanned).toBe(1)
    expect(report.backfilled).toBe(1)
    expect(report.alarms).toHaveLength(0)
    // dosyłka WYŁĄCZNIE z snapshotu: writer dostał transaction_id ze snapshotu.
    expect(write).toHaveBeenCalledTimes(1)
    const arg = (write.mock.calls[0] as unknown[])[0] as { transaction: { transaction_id: string } }
    expect(arg.transaction.transaction_id).toBe(snapshot.posting_input.transaction_id)
  })

  it("brak snapshotu ⇒ FAIL-CLOSED alarm (metryka + log error), NIE dosyłka, NIE silent skip", async () => {
    const ref: TerminalEntitlementRef = { entitlement_id: "ent_x", lifecycle_event: "EXPIRED", market_id: "pl" }
    const write = jest.fn()
    const log = logger()
    const met = metrics()

    const deps: ReconciliationDeps = {
      scanner: { scanTerminalWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => null }, // brak snapshotu
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: log,
      metrics: met,
    }

    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.alarms).toEqual([
      { entitlement_id: "ent_x", lifecycle_event: "EXPIRED", reason: "missing_snapshot" },
    ])
    expect(report.backfilled).toBe(0)
    expect(write).not.toHaveBeenCalled() // NIE dosyłka z live state
    expect(met.increment).toHaveBeenCalledWith(
      "voucher_ledger.reconciliation.missing_snapshot",
      expect.objectContaining({ lifecycle_event: "EXPIRED" })
    )
    expect(log.error).toHaveBeenCalled() // alarm widoczny, NIE silent skip
  })

  it("snapshot dający no-op księgowy (SPV REDEEMED) ⇒ noop, brak dosyłki, brak alarmu", async () => {
    const ref: TerminalEntitlementRef = { entitlement_id: "ent_spv", lifecycle_event: "REDEEMED", market_id: "pl" }
    const tid = deriveLedgerTransactionId({
      entitlement_id: "ent_spv",
      lifecycle_event: "REDEEMED",
      redemption_id: "red_1",
    })
    const snapshot: LedgerEventSnapshot = {
      entitlement_id: "ent_spv",
      lifecycle_event: "REDEEMED",
      redemption_id: "red_1",
      posting_input: {
        lifecycle_event: "REDEEMED",
        vat_classification: "SPV", // SPV REDEEMED = no-op księgowy (money-ledger)
        net_minor: 10000,
        vat_minor: 2300,
        redeemed_gross_minor: 12300,
        redeemed_gross_to_date_minor: 0,
        transaction_id: tid,
        occurred_at: "2026-07-01T00:00:00Z",
        scope: { instance_id: "gp-dev", market_id: "pl" },
        currency: "PLN",
      },
    }
    const write = jest.fn()
    const deps: ReconciliationDeps = {
      scanner: { scanTerminalWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: logger(),
    }

    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.noop).toBe(1)
    expect(report.backfilled).toBe(0)
    expect(report.alarms).toHaveLength(0)
    expect(write).not.toHaveBeenCalled()
  })

  it("już-dosłany (writer deduped) ⇒ liczony jako deduped, nie backfilled", async () => {
    const ref: TerminalEntitlementRef = { entitlement_id: "ent_exp", lifecycle_event: "EXPIRED", market_id: "pl" }
    const snapshot = expiredMpvSnapshot("ent_exp")
    const write = jest.fn(async () => ({ transaction_id: snapshot.posting_input.transaction_id, applied: false, deduped: true } as VoucherLedgerWriteResult))
    const deps: ReconciliationDeps = {
      scanner: { scanTerminalWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write },
      logger: logger(),
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.deduped).toBe(1)
    expect(report.backfilled).toBe(0)
    expect(report.alarms).toHaveLength(0)
  })

  it("pusty scan ⇒ raport zerowy, brak alarmów", async () => {
    const deps: ReconciliationDeps = {
      scanner: { scanTerminalWithoutPosting: async () => [] },
      snapshots: { loadSnapshot: async () => null },
      writer: { write: jest.fn() as ReconciliationDeps["writer"]["write"] },
      logger: logger(),
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report).toEqual({ scanned: 0, backfilled: 0, deduped: 0, noop: 0, alarms: [] })
  })
})
