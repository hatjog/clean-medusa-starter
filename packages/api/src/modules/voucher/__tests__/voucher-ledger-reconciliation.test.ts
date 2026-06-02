/**
 * voucher-ledger-reconciliation.test.ts — Story 2.6 AC3 (D2, inwariant kompletności).
 *
 * Pokrywa: dosyłka z PERSYSTOWANEGO snapshotu (NIE live state); brak snapshotu ⇒
 * fail-closed alarm; no-op księgowy ze snapshotu (SPV REDEEMED); idempotencja
 * (deduped). Oraz fixy review:
 *   H1 — oczekiwane zdarzenie wykryte NIEZALEŻNIE od awansu stanu po zdarzeniu;
 *   H2 — zgubiona kolejna rata (per-rata transaction_id) wykryta;
 *   M1 — REFUNDED ⇒ alarm refund_out_of_scope (NO posting);
 *   L1 — market_id NULL ⇒ alarm null_market_id;
 *   L4 — runtime_enabled:false + oczekiwane zdarzenia ⇒ alarm, BEZ dosyłki;
 *   skaner PG (createPgExpectedEventScanner / createPgRefundedScanner) na fake-PG.
 */

import { describe, it, expect, jest } from "@jest/globals"
import {
  runVoucherLedgerReconciliation,
  createPgExpectedEventScanner,
  createPgRefundedScanner,
  EXPECTED_EVENT_PROJECTION,
  type ExpectedLedgerEventRef,
  type LedgerEventSnapshot,
  type ReconciliationDeps,
} from "../../../jobs/voucher-ledger-reconciliation"
import {
  deriveLedgerTransactionId,
  type LedgerPgClient,
  type LedgerPgPool,
  type VoucherLedgerWriteResult,
} from "../ledger-writer"
import type { VoucherPostingInput } from "../posting-profile"

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function metrics() {
  return { increment: jest.fn() }
}

function expiredMpvRefAndSnapshot(
  entitlementId = "ent_exp",
  marketId: string | null = "pl"
): { ref: ExpectedLedgerEventRef; snapshot: LedgerEventSnapshot } {
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
    ref: {
      entitlement_id: entitlementId,
      lifecycle_event: "EXPIRED",
      remaining_gross_snapshot: remaining,
      market_id: marketId,
      expected_transaction_id: transaction_id,
    },
    snapshot: {
      entitlement_id: entitlementId,
      lifecycle_event: "EXPIRED",
      remaining_gross_snapshot: remaining,
      posting_input,
      expected_currency: "PLN",
    },
  }
}

function redeemedMpvRefAndSnapshot(
  entitlementId: string,
  redemptionId: string
): { ref: ExpectedLedgerEventRef; snapshot: LedgerEventSnapshot } {
  const transaction_id = deriveLedgerTransactionId({
    entitlement_id: entitlementId,
    lifecycle_event: "REDEEMED",
    redemption_id: redemptionId,
  })
  const posting_input: VoucherPostingInput = {
    lifecycle_event: "REDEEMED",
    vat_classification: "MPV",
    net_minor: 10000,
    vat_minor: 2300,
    redeemed_gross_minor: 6150,
    redeemed_gross_to_date_minor: 0,
    transaction_id,
    occurred_at: "2026-07-01T00:00:00Z",
    scope: { instance_id: "gp-dev", market_id: "pl" },
    currency: "PLN",
  }
  return {
    ref: {
      entitlement_id: entitlementId,
      lifecycle_event: "REDEEMED",
      redemption_id: redemptionId,
      market_id: "pl",
      expected_transaction_id: transaction_id,
    },
    snapshot: {
      entitlement_id: entitlementId,
      lifecycle_event: "REDEEMED",
      redemption_id: redemptionId,
      posting_input,
      expected_currency: "PLN",
    },
  }
}

const ENABLED = { runtimeEnabled: true } as const

describe("Story 2.6 AC3 — reconciliation inwariant kompletności (ADR-139 D2)", () => {
  it("oczekiwane zdarzenie + snapshot ⇒ dosłany (backfilled), z persystowanego snapshotu", async () => {
    const { ref, snapshot } = expiredMpvRefAndSnapshot("ent_exp")
    const write = jest.fn(async () => ({ transaction_id: ref.expected_transaction_id, applied: true, deduped: false } as VoucherLedgerWriteResult))

    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write },
      logger: logger(),
      metrics: metrics(),
      ...ENABLED,
    }

    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.scanned).toBe(1)
    expect(report.backfilled).toBe(1)
    expect(report.alarms).toHaveLength(0)
    expect(write).toHaveBeenCalledTimes(1)
    const arg = (write.mock.calls[0] as unknown[])[0] as { transaction: { transaction_id: string } }
    expect(arg.transaction.transaction_id).toBe(ref.expected_transaction_id)
  })

  it("brak snapshotu ⇒ FAIL-CLOSED alarm (metryka + log error), NIE dosyłka, NIE silent skip", async () => {
    const { ref } = expiredMpvRefAndSnapshot("ent_x")
    const write = jest.fn()
    const log = logger()
    const met = metrics()

    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => null },
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: log,
      metrics: met,
      ...ENABLED,
    }

    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.alarms).toEqual([
      { entitlement_id: "ent_x", lifecycle_event: "EXPIRED", reason: "missing_snapshot" },
    ])
    expect(report.backfilled).toBe(0)
    expect(write).not.toHaveBeenCalled()
    expect(met.increment).toHaveBeenCalledWith(
      "voucher_ledger.reconciliation.missing_snapshot",
      expect.objectContaining({ lifecycle_event: "EXPIRED" })
    )
    expect(log.error).toHaveBeenCalled()
  })

  it("snapshot dający no-op księgowy (SPV REDEEMED) ⇒ noop, brak dosyłki, brak alarmu", async () => {
    const tid = deriveLedgerTransactionId({ entitlement_id: "ent_spv", lifecycle_event: "REDEEMED", redemption_id: "red_1" })
    const ref: ExpectedLedgerEventRef = {
      entitlement_id: "ent_spv",
      lifecycle_event: "REDEEMED",
      redemption_id: "red_1",
      market_id: "pl",
      expected_transaction_id: tid,
    }
    const snapshot: LedgerEventSnapshot = {
      entitlement_id: "ent_spv",
      lifecycle_event: "REDEEMED",
      redemption_id: "red_1",
      posting_input: {
        lifecycle_event: "REDEEMED",
        vat_classification: "SPV",
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
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: logger(),
      ...ENABLED,
    }

    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.noop).toBe(1)
    expect(report.backfilled).toBe(0)
    expect(report.alarms).toHaveLength(0)
    expect(write).not.toHaveBeenCalled()
  })

  it("już-dosłany (writer deduped) ⇒ liczony jako deduped, nie backfilled", async () => {
    const { ref, snapshot } = expiredMpvRefAndSnapshot("ent_exp")
    const write = jest.fn(async () => ({ transaction_id: ref.expected_transaction_id, applied: false, deduped: true } as VoucherLedgerWriteResult))
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write },
      logger: logger(),
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.deduped).toBe(1)
    expect(report.backfilled).toBe(0)
    expect(report.alarms).toHaveLength(0)
  })

  it("pusty scan ⇒ raport zerowy, brak alarmów", async () => {
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [] },
      snapshots: { loadSnapshot: async () => null },
      writer: { write: jest.fn() as ReconciliationDeps["writer"]["write"] },
      logger: logger(),
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report).toEqual({ scanned: 0, backfilled: 0, deduped: 0, noop: 0, alarms: [] })
  })

  // ── H1 — oczekiwane zdarzenie wykryte NIEZALEŻNIE od awansu stanu po zdarzeniu ──
  it("H1: zdarzenie REDEEMED entitlementu, który awansował REDEEMED_FULL→SETTLED→CLOSED, nadal dosłane", async () => {
    // Inwariant nie pyta o bieżący state — dostaje oczekiwane zdarzenie z projekcji
    // (która persystuje mimo awansu). Gdyby skan był po state='REDEEMED_FULL', ten
    // entitlement (teraz CLOSED) byłby pominięty (fail-open H1).
    const { ref, snapshot } = redeemedMpvRefAndSnapshot("ent_closed", "red_1")
    const write = jest.fn(async () => ({ transaction_id: ref.expected_transaction_id, applied: true, deduped: false } as VoucherLedgerWriteResult))
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write },
      logger: logger(),
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.backfilled).toBe(1)
    expect(report.alarms).toHaveLength(0)
    expect(write).toHaveBeenCalledTimes(1)
  })

  // ── H2 — zgubiona kolejna rata (per-rata transaction_id) wykryta ──────────────
  it("H2: rata #1 applied, rata #2 zgubiona ⇒ tylko #2 enumerowana (per-rata) i dosłana", async () => {
    const rata1 = redeemedMpvRefAndSnapshot("ent_mpv", "red_1")
    const rata2 = redeemedMpvRefAndSnapshot("ent_mpv", "red_2")
    // raty mają RÓŻNE transaction_id (per redemption_id) — dowód granularności.
    expect(rata1.ref.expected_transaction_id).not.toBe(rata2.ref.expected_transaction_id)
    // Projekcja (per-rata, NOT EXISTS po transaction_id) zwraca TYLKO #2.
    const write = jest.fn(async () => ({ transaction_id: rata2.ref.expected_transaction_id, applied: true, deduped: false } as VoucherLedgerWriteResult))
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [rata2.ref] },
      snapshots: { loadSnapshot: async (r) => (r.redemption_id === "red_2" ? rata2.snapshot : null) },
      writer: { write },
      logger: logger(),
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.scanned).toBe(1)
    expect(report.backfilled).toBe(1)
    expect(report.alarms).toHaveLength(0)
    const arg = (write.mock.calls[0] as unknown[])[0] as { redemption_id: string }
    expect(arg.redemption_id).toBe("red_2")
  })

  // ── M1 — REFUNDED ⇒ alarm refund_out_of_scope (NO posting) ────────────────────
  it("M1: terminalny REFUNDED ⇒ alarm refund_out_of_scope + metryka, BEZ postingu", async () => {
    const write = jest.fn()
    const met = metrics()
    const log = logger()
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [] },
      refunded: { scanRefundedTerminal: async () => [{ entitlement_id: "ent_ref", market_id: "pl" }] },
      snapshots: { loadSnapshot: async () => null },
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: log,
      metrics: met,
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.alarms).toEqual([
      { entitlement_id: "ent_ref", lifecycle_event: null, reason: "refund_out_of_scope" },
    ])
    expect(write).not.toHaveBeenCalled()
    expect(met.increment).toHaveBeenCalledWith(
      "voucher_ledger.reconciliation.refund_out_of_scope",
      expect.objectContaining({ market_id: "pl" })
    )
    expect(log.error).toHaveBeenCalled()
  })

  // ── L1 — market_id NULL ⇒ alarm null_market_id (+ dosyłka via snapshot) ───────
  it("L1: market_id NULL dla oczekiwanego zdarzenia ⇒ alarm null_market_id, dosyłka nadal działa", async () => {
    const { ref, snapshot } = expiredMpvRefAndSnapshot("ent_nullmkt", null)
    const write = jest.fn(async () => ({ transaction_id: ref.expected_transaction_id, applied: true, deduped: false } as VoucherLedgerWriteResult))
    const met = metrics()
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write },
      logger: logger(),
      metrics: met,
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.alarms).toEqual([
      { entitlement_id: "ent_nullmkt", lifecycle_event: "EXPIRED", reason: "null_market_id" },
    ])
    expect(report.backfilled).toBe(1) // alarm obserwowalności NIE blokuje dosyłki
    expect(met.increment).toHaveBeenCalledWith(
      "voucher_ledger.reconciliation.null_market_id",
      expect.objectContaining({ lifecycle_event: "EXPIRED" })
    )
  })

  // ── L4 — runtime_enabled:false + oczekiwane zdarzenia ⇒ alarm, BEZ dosyłki ─────
  it("L4: posting nieaktywny (runtimeEnabled:false) + oczekiwane zdarzenia ⇒ alarm, writer NIE wołany", async () => {
    const { ref, snapshot } = expiredMpvRefAndSnapshot("ent_disabled")
    const write = jest.fn()
    const met = metrics()
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [ref] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: logger(),
      metrics: met,
      // runtimeEnabled pominięty ⇒ default false (D5: persystencja ≠ aktywacja)
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.alarms).toEqual([
      { entitlement_id: "ent_disabled", lifecycle_event: "EXPIRED", reason: "unexpected_events_while_disabled" },
    ])
    expect(report.backfilled).toBe(0)
    expect(write).not.toHaveBeenCalled()
    expect(met.increment).toHaveBeenCalledWith(
      "voucher_ledger.reconciliation.unexpected_events_while_disabled",
      expect.objectContaining({ lifecycle_event: "EXPIRED" })
    )
  })

  // ── projection_drift — precomputed id ≠ re-derywowany ⇒ alarm, BEZ dosyłki ─────
  it("dryf projekcji (expected_transaction_id ≠ re-derywowany) ⇒ alarm projection_drift, BEZ dosyłki", async () => {
    const { ref, snapshot } = expiredMpvRefAndSnapshot("ent_drift")
    const drifted: ExpectedLedgerEventRef = { ...ref, expected_transaction_id: "deadbeef" }
    const write = jest.fn()
    const deps: ReconciliationDeps = {
      expected: { scanExpectedEventsWithoutPosting: async () => [drifted] },
      snapshots: { loadSnapshot: async () => snapshot },
      writer: { write: write as ReconciliationDeps["writer"]["write"] },
      logger: logger(),
      ...ENABLED,
    }
    const report = await runVoucherLedgerReconciliation(deps)
    expect(report.alarms).toEqual([
      { entitlement_id: "ent_drift", lifecycle_event: "EXPIRED", reason: "projection_drift" },
    ])
    expect(write).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Skaner PG na fake-PG (I3 + H1/H2 na poziomie SQL).
// ──────────────────────────────────────────────────────────────────────────

type ProjectionRow = {
  expected_transaction_id: string
  entitlement_id: string
  lifecycle_event: string
  redemption_id: string | null
  remaining_gross_snapshot: number | null
  market_id: string | null
}

function makeFakeScannerPool(opts: {
  projection: ProjectionRow[]
  appliedTxIds: Set<string>
  refunded: { id: string; market_id: string | null }[]
}): LedgerPgPool {
  const query = (async (sql: string) => {
    const s = sql.trim()
    if (s.includes(EXPECTED_EVENT_PROJECTION)) {
      // modeluj NOT EXISTS po transaction_id (per-rata, H2; niezależne od state, H1)
      const rows = opts.projection.filter(
        (r) => !opts.appliedTxIds.has(r.expected_transaction_id)
      )
      return { rows, rowCount: rows.length }
    }
    if (s.includes("entitlement_instance") && s.includes("REFUNDED")) {
      const rows = opts.refunded.map((r) => ({ id: r.id, market_id: r.market_id }))
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }) as LedgerPgClient["query"]
  const client: LedgerPgClient = { query, release: jest.fn() }
  return { connect: async () => client }
}

describe("Story 2.6 AC3 — skaner PG (createPgExpectedEventScanner / createPgRefundedScanner)", () => {
  it("createPgExpectedEventScanner: NOT EXISTS po transaction_id zwraca tylko zdarzenia bez wpisu (H2 per-rata)", async () => {
    const t1 = deriveLedgerTransactionId({ entitlement_id: "ent_mpv", lifecycle_event: "REDEEMED", redemption_id: "red_1" })
    const t2 = deriveLedgerTransactionId({ entitlement_id: "ent_mpv", lifecycle_event: "REDEEMED", redemption_id: "red_2" })
    const projection: ProjectionRow[] = [
      { expected_transaction_id: t1, entitlement_id: "ent_mpv", lifecycle_event: "REDEEMED", redemption_id: "red_1", remaining_gross_snapshot: null, market_id: "pl" },
      { expected_transaction_id: t2, entitlement_id: "ent_mpv", lifecycle_event: "REDEEMED", redemption_id: "red_2", remaining_gross_snapshot: null, market_id: "pl" },
    ]
    // rata #1 applied → tylko #2 powinna wyjść (zgubiona rata wykryta).
    const pool = makeFakeScannerPool({ projection, appliedTxIds: new Set([t1]), refunded: [] })
    const out = await createPgExpectedEventScanner(pool).scanExpectedEventsWithoutPosting()
    expect(out).toHaveLength(1)
    expect(out[0].redemption_id).toBe("red_2")
    expect(out[0].expected_transaction_id).toBe(t2)
  })

  it("createPgExpectedEventScanner: H1 — zdarzenie pozostaje w projekcji niezależnie od bieżącego stanu", async () => {
    // Projekcja NIE odpytuje entitlement_instance.state — wiersz persystuje mimo
    // awansu REDEEMED_FULL→CLOSED. Skan po state byłby fail-open.
    const tid = deriveLedgerTransactionId({ entitlement_id: "ent_closed", lifecycle_event: "REDEEMED", redemption_id: "red_1" })
    const projection: ProjectionRow[] = [
      { expected_transaction_id: tid, entitlement_id: "ent_closed", lifecycle_event: "REDEEMED", redemption_id: "red_1", remaining_gross_snapshot: null, market_id: "pl" },
    ]
    const pool = makeFakeScannerPool({ projection, appliedTxIds: new Set(), refunded: [] })
    const out = await createPgExpectedEventScanner(pool).scanExpectedEventsWithoutPosting()
    expect(out).toHaveLength(1)
    expect(out[0].entitlement_id).toBe("ent_closed")
  })

  it("createPgExpectedEventScanner: market_id NULL i remaining_gross_snapshot bigint→number zmapowane", async () => {
    const tid = deriveLedgerTransactionId({ entitlement_id: "ent_e", lifecycle_event: "EXPIRED", remaining_gross_snapshot: 999 })
    const projection: ProjectionRow[] = [
      // PG bigint bywa stringiem przez sterownik — sprawdź konwersję.
      { expected_transaction_id: tid, entitlement_id: "ent_e", lifecycle_event: "EXPIRED", redemption_id: null, remaining_gross_snapshot: 999, market_id: null },
    ]
    const pool = makeFakeScannerPool({ projection, appliedTxIds: new Set(), refunded: [] })
    const out = await createPgExpectedEventScanner(pool).scanExpectedEventsWithoutPosting()
    expect(out[0].market_id).toBeNull()
    expect(out[0].remaining_gross_snapshot).toBe(999)
  })

  it("createPgRefundedScanner: zwraca terminalne REFUNDED (state genuinely terminalny)", async () => {
    const pool = makeFakeScannerPool({
      projection: [],
      appliedTxIds: new Set(),
      refunded: [{ id: "ent_r1", market_id: "pl" }, { id: "ent_r2", market_id: null }],
    })
    const out = await createPgRefundedScanner(pool).scanRefundedTerminal()
    expect(out).toEqual([
      { entitlement_id: "ent_r1", market_id: "pl" },
      { entitlement_id: "ent_r2", market_id: null },
    ])
  })
})
