/**
 * ledger-writer.test.ts — Story 2.6 AC2 (D3, idempotentny writer).
 *
 * Testy na in-memory mock PG (wzorzec service.test.ts — bez realnego DB).
 * Pokrywa: deterministyczny transaction_id, dedup-INSERT PIERWSZY w DB-tx,
 * replay = no-op (brak duplikatu), currency guard fail-closed, podwójna bariera
 * (cash-reject + double-entry), wymóg dyskryminatora REDEEMED.
 */

import { describe, it, expect, jest } from "@jest/globals"
import {
  VoucherLedgerWriter,
  VoucherLedgerWriteError,
  deriveLedgerTransactionId,
  type LedgerPgClient,
  type LedgerPgPool,
} from "../ledger-writer"
import {
  generateVoucherPosting,
  VOUCHER_POSTING_PROFILE_ID,
  type LedgerTransactionV1,
  type VoucherLifecycleEvent,
} from "../posting-profile"

// ---------------------------------------------------------------------------
// In-memory fake PG: honoruje ON CONFLICT DO NOTHING na ledger_posting_applied.
// ---------------------------------------------------------------------------

type Captured = { sql: string; params: unknown[] }

function makeFakePool(): {
  pool: LedgerPgPool
  queries: Captured[]
  applied: Set<string>
  txRows: unknown[][]
  entryRows: unknown[][]
} {
  const queries: Captured[] = []
  const applied = new Set<string>()
  const txRows: unknown[][] = []
  const entryRows: unknown[][] = []

  const query = (async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params })
    const s = sql.trim()
    if (s.startsWith("INSERT INTO ledger_posting_applied")) {
      const id = String(params[0])
      if (applied.has(id)) {
        return { rows: [], rowCount: 0 } // ON CONFLICT DO NOTHING → replay
      }
      applied.add(id)
      return { rows: [], rowCount: 1 }
    }
    if (s.startsWith("INSERT INTO voucher_ledger_transaction")) {
      txRows.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (s.startsWith("INSERT INTO voucher_ledger_entry")) {
      entryRows.push(params)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) as LedgerPgClient["query"]

  const client: LedgerPgClient = { query, release: jest.fn() }
  const pool: LedgerPgPool = { connect: async () => client }
  return { pool, queries, applied, txRows, entryRows }
}

// ---------------------------------------------------------------------------
// Builders — wynik generateVoucherPosting z deterministycznym transaction_id.
// ---------------------------------------------------------------------------

function issuedMpvTx(entitlementId = "ent_1"): LedgerTransactionV1 {
  const transaction_id = deriveLedgerTransactionId({
    entitlement_id: entitlementId,
    lifecycle_event: "ISSUED",
  })
  const r = generateVoucherPosting({
    lifecycle_event: "ISSUED",
    vat_classification: "MPV",
    net_minor: 10000,
    vat_minor: 2300,
    transaction_id,
    occurred_at: "2026-06-01T09:00:00Z",
    scope: { instance_id: "gp-dev", market_id: "pl" },
    currency: "PLN",
  })
  if (!r.posted) throw new Error("fixture: oczekiwano posted:true")
  return r.transaction
}

describe("Story 2.6 AC2 — idempotentny ledger-writer (ADR-139 D3)", () => {
  it("deterministyczny transaction_id: ten sam event → ten sam sha256", () => {
    const a = deriveLedgerTransactionId({ entitlement_id: "e", lifecycle_event: "ISSUED" })
    const b = deriveLedgerTransactionId({ entitlement_id: "e", lifecycle_event: "ISSUED" })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    const c = deriveLedgerTransactionId({ entitlement_id: "e2", lifecycle_event: "ISSUED" })
    expect(c).not.toBe(a)
  })

  it("zapisuje nagłówek + linie; dedup-INSERT jest PIERWSZY w DB-tx", async () => {
    const { pool, queries, txRows, entryRows } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()

    const res = await writer.write({
      entitlement_id: "ent_1",
      lifecycle_event: "ISSUED",
      transaction: tx,
    })

    expect(res).toEqual({ transaction_id: tx.transaction_id, applied: true, deduped: false })
    expect(txRows).toHaveLength(1)
    expect(entryRows).toHaveLength(tx.lines.length)

    // Kolejność krytyczna: BEGIN → ledger_posting_applied → voucher_ledger_transaction.
    const order = queries.map((q) => q.sql.trim().split(/\s+/).slice(0, 3).join(" "))
    const idxBegin = order.findIndex((s) => s.startsWith("BEGIN"))
    const idxDedup = queries.findIndex((q) =>
      q.sql.trim().startsWith("INSERT INTO ledger_posting_applied")
    )
    const idxTx = queries.findIndex((q) =>
      q.sql.trim().startsWith("INSERT INTO voucher_ledger_transaction")
    )
    expect(idxBegin).toBeGreaterThanOrEqual(0)
    expect(idxDedup).toBeGreaterThan(idxBegin)
    expect(idxTx).toBeGreaterThan(idxDedup) // dedup PRZED transaction (ADR-139 D3)
  })

  it("replay tego samego eventu ⇒ no-op (brak duplikatu wpisu)", async () => {
    const { pool, txRows, entryRows } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()

    const first = await writer.write({ entitlement_id: "ent_1", lifecycle_event: "ISSUED", transaction: tx })
    const second = await writer.write({ entitlement_id: "ent_1", lifecycle_event: "ISSUED", transaction: tx })

    expect(first).toEqual({ transaction_id: tx.transaction_id, applied: true, deduped: false })
    expect(second).toEqual({ transaction_id: tx.transaction_id, applied: false, deduped: true })
    // Replay NIE podwoił wpisów.
    expect(txRows).toHaveLength(1)
    expect(entryRows).toHaveLength(tx.lines.length)
  })

  it("currency consistency guard fail-closed: niezgodna expected_currency ⇒ rzuca", async () => {
    const { pool, txRows } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()

    await expect(
      writer.write({
        entitlement_id: "ent_1",
        lifecycle_event: "ISSUED",
        transaction: tx,
        expected_currency: "EUR",
      })
    ).rejects.toMatchObject({ name: "VoucherLedgerWriteError", kind: "currency_inconsistent" })
    expect(txRows).toHaveLength(0) // fail-closed: nic nie zapisane
  })

  it("podwójna bariera: konto pieniężne cash* ⇒ rzuca (guard z 2.3, fail-closed)", async () => {
    const { pool } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()
    // wstrzyknij linię na konto pieniężne (zachowując balans)
    tx.lines = [
      { ledger_entry_id: `${tx.transaction_id}:a`, account: "cash", debit_minor: 100, credit_minor: 0 },
      { ledger_entry_id: `${tx.transaction_id}:b`, account: "vat:output:suspense", debit_minor: 0, credit_minor: 100 },
    ]

    await expect(
      writer.write({ entitlement_id: "ent_1", lifecycle_event: "ISSUED", transaction: tx })
    ).rejects.toMatchObject({ name: "VoucherPostingGuardError", kind: "money_account" })
  })

  it("podwójna bariera: niezbilansowane debits!=credits ⇒ rzuca", async () => {
    const { pool } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()
    tx.lines[1].credit_minor = tx.lines[1].credit_minor + 1 // rozbalansuj

    await expect(
      writer.write({ entitlement_id: "ent_1", lifecycle_event: "ISSUED", transaction: tx })
    ).rejects.toMatchObject({ name: "VoucherPostingInvariantError" })
  })

  it("transaction_id niezgodny z deterministycznym ⇒ rzuca (fail-closed)", async () => {
    const { pool } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()
    tx.transaction_id = "not-the-deterministic-id"

    await expect(
      writer.write({ entitlement_id: "ent_1", lifecycle_event: "ISSUED", transaction: tx })
    ).rejects.toMatchObject({ name: "VoucherLedgerWriteError", kind: "transaction_id_mismatch" })
  })

  it("REDEEMED bez redemption_id ⇒ rzuca (multi-installment-safe dyskryminator)", () => {
    expect(() =>
      deriveLedgerTransactionId({ entitlement_id: "e", lifecycle_event: "REDEEMED" as VoucherLifecycleEvent })
    ).toThrow(VoucherLedgerWriteError)
  })

  it("EXPIRED dyskryminator = entitlement_id ‖ remaining_gross_snapshot", () => {
    const a = deriveLedgerTransactionId({
      entitlement_id: "e",
      lifecycle_event: "EXPIRED",
      remaining_gross_snapshot: 500,
    })
    const b = deriveLedgerTransactionId({
      entitlement_id: "e",
      lifecycle_event: "EXPIRED",
      remaining_gross_snapshot: 600,
    })
    expect(a).not.toBe(b) // różny snapshot → różny id
    expect(() =>
      deriveLedgerTransactionId({ entitlement_id: "e", lifecycle_event: "EXPIRED" })
    ).toThrow(VoucherLedgerWriteError)
  })

  it("metadata.posting_profile persystowany jako voucher_liability_only_v1", async () => {
    const { pool, txRows } = makeFakePool()
    const writer = new VoucherLedgerWriter(pool)
    const tx = issuedMpvTx()
    await writer.write({ entitlement_id: "ent_1", lifecycle_event: "ISSUED", transaction: tx })
    // params[2] = posting_profile w INSERT voucher_ledger_transaction
    expect(txRows[0][2]).toBe(VOUCHER_POSTING_PROFILE_ID)
  })
})
