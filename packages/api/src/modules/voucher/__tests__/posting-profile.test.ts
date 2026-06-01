import { describe, expect, it } from "@jest/globals"
import type { VatClassification } from "../vat-resolver"
import {
  VOUCHER_LEDGER_ACCOUNTS,
  VOUCHER_LIABILITY_ONLY_V1,
  VOUCHER_POSTING_PROFILE_ID,
  VoucherPostingGuardError,
  VoucherPostingInvariantError,
  assertBalanced,
  assertPostingAccountsAllowed,
  generateVoucherPosting,
  isMoneyAccount,
} from "../posting-profile"
import type {
  LedgerLine,
  LedgerTransactionV1,
  VoucherLifecycleEvent,
  VoucherPostingInput,
  VoucherPostingResult,
} from "../posting-profile"

// Voucher 23% VAT: brutto 12300 = netto 10000 + VAT 2300.
const NET = 10000
const VAT = 2300
const GROSS = NET + VAT

function baseInput(
  overrides: Partial<VoucherPostingInput> &
    Pick<VoucherPostingInput, "lifecycle_event" | "vat_classification">
): VoucherPostingInput {
  return {
    net_minor: NET,
    vat_minor: VAT,
    transaction_id: "ltx_test_2300",
    occurred_at: "2026-06-01T09:15:00Z",
    scope: { instance_id: "gp-dev", market_id: "pl", vendor_id: "vendor_abc", location_id: "loc_001" },
    currency: "PLN",
    ...overrides,
  }
}

function expectPosted(result: VoucherPostingResult): LedgerTransactionV1 {
  if (!result.posted) {
    throw new Error(`oczekiwano posted=true, otrzymano no-op: ${result.reason}`)
  }
  return result.transaction
}

function sumSide(lines: LedgerLine[], side: "debit_minor" | "credit_minor"): number {
  return lines.reduce((acc, l) => acc + l[side], 0)
}

function accountsTouched(tx: LedgerTransactionV1): string[] {
  return tx.lines.map((l) => l.account)
}

const CASH_ACCOUNTS = ["cash", "cash_clearing", "cash_settlement"] as const

/** Inwarianty wspólne dla KAŻDEGO wygenerowanego wpisu (kontrakt + ledger README). */
function assertContractConformance(tx: LedgerTransactionV1): void {
  // entry_type ∈ enum lifecycle (additive, ADR-133 §Decyzja pkt 2b).
  expect(["ENTITLEMENT_ISSUED", "ENTITLEMENT_REDEEMED", "ENTITLEMENT_BREAKAGE"]).toContain(
    tx.entry_type
  )
  // conditional metadata-keys (Story 2.1 if/then).
  expect(tx.metadata.posting_profile).toBe(VOUCHER_POSTING_PROFILE_ID)
  expect(["SPV", "MPV"]).toContain(tx.metadata.vat_classification)
  expect(typeof tx.metadata.lifecycle_event).toBe("string")
  // lines: minItems 2; każda linia ma dokładnie jedną stronę dodatnią; balans.
  expect(tx.lines.length).toBeGreaterThanOrEqual(2)
  for (const l of tx.lines) {
    expect(l.ledger_entry_id.length).toBeGreaterThan(0)
    expect(l.account.length).toBeGreaterThan(0)
    expect(Number.isInteger(l.debit_minor) && l.debit_minor >= 0).toBe(true)
    expect(Number.isInteger(l.credit_minor) && l.credit_minor >= 0).toBe(true)
    expect(l.debit_minor > 0).not.toBe(l.credit_minor > 0)
  }
  // double-entry: debits == credits.
  expect(sumSide(tx.lines, "debit_minor")).toBe(sumSide(tx.lines, "credit_minor"))
  // NIGDY konto pieniężne.
  for (const account of accountsTouched(tx)) {
    expect(isMoneyAccount(account)).toBe(false)
  }
  // assertBalanced/guard nie rzucają (defensywne powtórzenie).
  expect(() => assertBalanced(tx.lines)).not.toThrow()
  expect(() => assertPostingAccountsAllowed(tx.lines)).not.toThrow()
}

describe("posting profile voucher_liability_only_v1", () => {
  describe("T3 — runtime-disabled (ADR-133 §P6)", () => {
    it("profil jest AUTHORED ale runtime_enabled:FALSE", () => {
      expect(VOUCHER_LIABILITY_ONLY_V1.id).toBe("voucher_liability_only_v1")
      expect(VOUCHER_LIABILITY_ONLY_V1.runtime_enabled).toBe(false)
    })
    it("deklaruje dozwolone konta entitlement/VAT i zakazane klasy pieniężne", () => {
      expect(VOUCHER_LIABILITY_ONLY_V1.allowed_accounts).toEqual(
        expect.arrayContaining(Object.values(VOUCHER_LEDGER_ACCOUNTS))
      )
      expect(VOUCHER_LIABILITY_ONLY_V1.forbidden_money_classes).toEqual(
        expect.arrayContaining([...CASH_ACCOUNTS])
      )
    })
  })

  describe("AC1 — ISSUED ⇒ contract liability + VAT wg SPV/MPV", () => {
    it("SPV: VAT przy emisji (vat:output:emission), liability netto, double-entry", () => {
      const tx = expectPosted(
        generateVoucherPosting(baseInput({ lifecycle_event: "ISSUED", vat_classification: "SPV" }))
      )
      assertContractConformance(tx)
      expect(tx.entry_type).toBe("ENTITLEMENT_ISSUED")
      const accounts = accountsTouched(tx)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)
      // SPV przy emisji NIE używa suspense/output.
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)
      const vatLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)!
      expect(vatLine.credit_minor).toBe(VAT)
    })

    it("MPV: bez VAT przy emisji (suspense, NIE emission/output), double-entry", () => {
      const tx = expectPosted(
        generateVoucherPosting(baseInput({ lifecycle_event: "ISSUED", vat_classification: "MPV" }))
      )
      assertContractConformance(tx)
      const accounts = accountsTouched(tx)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)
      // MPV przy emisji NIE rozpoznaje output VAT.
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)
    })

    it("liability:contract_liability:voucher to NIE konto przychodu (IFRS 15)", () => {
      const tx = expectPosted(
        generateVoucherPosting(baseInput({ lifecycle_event: "ISSUED", vat_classification: "SPV" }))
      )
      for (const a of accountsTouched(tx)) {
        expect(a).not.toMatch(/revenue/)
      }
    })
  })

  describe("AC2 — REDEEMED (full/partial) ⇒ derecognition proporcjonalna; MPV VAT-at-redeem", () => {
    it("MPV partial: VAT proporcjonalny suspense→output; obniża remaining (NIE reissue)", () => {
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "REDEEMED",
            vat_classification: "MPV",
            redeemed_gross_minor: GROSS / 2, // 6150 = 50%
          })
        )
      )
      assertContractConformance(tx)
      expect(tx.entry_type).toBe("ENTITLEMENT_REDEEMED")
      const accounts = accountsTouched(tx)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)
      // proporcjonalnie: 2300 * 6150/12300 = 1150
      const outLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)!
      expect(outLine.credit_minor).toBe(1150)
      // partial: NIE generuje nowej emisji (entry_type ≠ ISSUED, brak emission VAT).
      expect(tx.entry_type).not.toBe("ENTITLEMENT_ISSUED")
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)
    })

    it("MPV full: pełne rozpoznanie zawieszonego VAT (2300)", () => {
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "REDEEMED",
            vat_classification: "MPV",
            redeemed_gross_minor: GROSS,
          })
        )
      )
      assertContractConformance(tx)
      const outLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)!
      expect(outLine.credit_minor).toBe(VAT)
    })

    it("SPV redeem (partial i full): no-op księgowy (VAT przy emisji; derecognition netto = money-ledger)", () => {
      for (const redeemed of [GROSS / 2, GROSS]) {
        const result = generateVoucherPosting(
          baseInput({
            lifecycle_event: "REDEEMED",
            vat_classification: "SPV",
            redeemed_gross_minor: redeemed,
          })
        )
        expect(result.posted).toBe(false)
        if (!result.posted) {
          expect(result.reason).toMatch(/money-ledger|emisj/i)
        }
      }
    })

    it("redeemed_gross_minor > brutto ⇒ rzuca inwariant", () => {
      expect(() =>
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "REDEEMED",
            vat_classification: "MPV",
            redeemed_gross_minor: GROSS + 1,
          })
        )
      ).toThrow(VoucherPostingInvariantError)
    })
  })

  describe("AC3 — EXPIRED unused ⇒ breakage; MPV unused bez VAT (art. 73a)", () => {
    it("SPV breakage: derecognition netto → breakage, brak nowego VAT", () => {
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "EXPIRED",
            vat_classification: "SPV",
            remaining_gross_minor: GROSS,
          })
        )
      )
      assertContractConformance(tx)
      expect(tx.entry_type).toBe("ENTITLEMENT_BREAKAGE")
      expect(tx.metadata.lifecycle_event).toBe("EXPIRED")
      const accounts = accountsTouched(tx)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.BREAKAGE)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY)
      // SPV: VAT rozpoznany przy emisji — żaden VAT-account nie jest dotykany.
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)
      const breakageLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.BREAKAGE)!
      expect(breakageLine.credit_minor).toBe(NET)
    })

    it("MPV breakage unused: zawieszony VAT do breakage, NIGDY do vat:output (art. 73a)", () => {
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "EXPIRED",
            vat_classification: "MPV",
            remaining_gross_minor: GROSS,
          })
        )
      )
      assertContractConformance(tx)
      const accounts = accountsTouched(tx)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.BREAKAGE)
      expect(accounts).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)
      // MPV unused = bez VAT: output VAT NIE jest rozpoznany.
      expect(accounts).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)
      // całe brutto trafia do breakage.
      const breakageLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.BREAKAGE)!
      expect(breakageLine.credit_minor).toBe(GROSS)
    })

    it("EXPIRED bez salda (remaining=0): no-op księgowy", () => {
      for (const vat of ["SPV", "MPV"] as VatClassification[]) {
        const result = generateVoucherPosting(
          baseInput({ lifecycle_event: "EXPIRED", vat_classification: vat, remaining_gross_minor: 0 })
        )
        expect(result.posted).toBe(false)
      }
    })

    it("forfeiture/partial NIE reklasyfikują: breakage liczony WYŁĄCZNIE od salda niewykorzystanego", () => {
      // Połowa zrealizowana, połowa wygasa → breakage tylko od remaining 6150.
      const remaining = GROSS / 2
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "EXPIRED",
            vat_classification: "MPV",
            remaining_gross_minor: remaining,
          })
        )
      )
      assertContractConformance(tx)
      const breakageLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.BREAKAGE)!
      expect(breakageLine.credit_minor).toBe(remaining)
    })
  })

  describe("AC4 — runtime posting guard fail-closed na konta pieniężne (FR33/D-2)", () => {
    it.each(CASH_ACCOUNTS)("odrzuca posting na konto pieniężne %s (fail-closed)", (cash) => {
      const lines = [
        { account: cash },
        { account: VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY },
      ]
      expect(() => assertPostingAccountsAllowed(lines)).toThrow(VoucherPostingGuardError)
      try {
        assertPostingAccountsAllowed(lines)
      } catch (e) {
        expect((e as VoucherPostingGuardError).kind).toBe("money_account")
        expect((e as VoucherPostingGuardError).account).toBe(cash)
      }
    })

    it("isMoneyAccount wykrywa też namespaced konta pieniężne (np. cash:settlement)", () => {
      expect(isMoneyAccount("cash")).toBe(true)
      expect(isMoneyAccount("cash:settlement")).toBe(true)
      expect(isMoneyAccount("cash_clearing:psp")).toBe(true)
      expect(isMoneyAccount(VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY)).toBe(false)
    })

    it("odrzuca konto spoza dozwolonego namespace entitlement/VAT (fail-closed)", () => {
      const lines = [
        { account: "revenue:gross" },
        { account: VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY },
      ]
      expect(() => assertPostingAccountsAllowed(lines)).toThrow(VoucherPostingGuardError)
      try {
        assertPostingAccountsAllowed(lines)
      } catch (e) {
        expect((e as VoucherPostingGuardError).kind).toBe("account_outside_namespace")
      }
    })

    it("generator NIGDY nie produkuje wpisu dotykającego konta pieniężnego", () => {
      const events: Array<[VoucherLifecycleEvent, VatClassification, Partial<VoucherPostingInput>]> = [
        ["ISSUED", "SPV", {}],
        ["ISSUED", "MPV", {}],
        ["REDEEMED", "MPV", { redeemed_gross_minor: GROSS }],
        ["EXPIRED", "SPV", { remaining_gross_minor: GROSS }],
        ["EXPIRED", "MPV", { remaining_gross_minor: GROSS }],
      ]
      for (const [lifecycle_event, vat_classification, extra] of events) {
        const result = generateVoucherPosting(
          baseInput({ lifecycle_event, vat_classification, ...extra })
        )
        if (result.posted) {
          for (const a of accountsTouched(result.transaction)) {
            expect(isMoneyAccount(a)).toBe(false)
          }
        }
      }
    })
  })

  describe("Inwarianty: double-entry + append-only (pure)", () => {
    it("assertBalanced rzuca przy niezbilansowanym wpisie", () => {
      const lines: LedgerLine[] = [
        { ledger_entry_id: "a", account: VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY, debit_minor: 100, credit_minor: 0 },
        { ledger_entry_id: "b", account: VOUCHER_LEDGER_ACCOUNTS.BREAKAGE, debit_minor: 0, credit_minor: 99 },
      ]
      expect(() => assertBalanced(lines)).toThrow(VoucherPostingInvariantError)
    })
    it("assertBalanced rzuca gdy <2 linii", () => {
      expect(() =>
        assertBalanced([
          { ledger_entry_id: "a", account: VOUCHER_LEDGER_ACCOUNTS.BREAKAGE, debit_minor: 100, credit_minor: 0 },
        ])
      ).toThrow(VoucherPostingInvariantError)
    })
    it("generator jest pure: nie mutuje wejścia, powtarzalny wynik", () => {
      const input = baseInput({ lifecycle_event: "ISSUED", vat_classification: "MPV" })
      const snapshot = JSON.parse(JSON.stringify(input))
      const a = generateVoucherPosting(input)
      const b = generateVoucherPosting(input)
      expect(a).toEqual(b)
      expect(input).toEqual(snapshot)
    })
  })

  // Pełna macierz {ISSUED, REDEEMED_PARTIAL, REDEEMED_FULL, BREAKAGE} × {SPV, MPV}
  // — każda komórka: debits==credits, dozwolone konta, brak kont pieniężnych.
  describe("Macierz lifecycle × klasyfikacja (double-entry GREEN)", () => {
    const cells: Array<{
      name: string
      lifecycle_event: VoucherLifecycleEvent
      extra: Partial<VoucherPostingInput>
      // czy komórka generuje wpis (true) czy udokumentowany no-op (false)
      posts: Record<VatClassification, boolean>
    }> = [
      { name: "ISSUED", lifecycle_event: "ISSUED", extra: {}, posts: { SPV: true, MPV: true } },
      {
        name: "REDEEMED_PARTIAL",
        lifecycle_event: "REDEEMED",
        extra: { redeemed_gross_minor: GROSS / 2 },
        posts: { SPV: false, MPV: true },
      },
      {
        name: "REDEEMED_FULL",
        lifecycle_event: "REDEEMED",
        extra: { redeemed_gross_minor: GROSS },
        posts: { SPV: false, MPV: true },
      },
      {
        name: "BREAKAGE",
        lifecycle_event: "EXPIRED",
        extra: { remaining_gross_minor: GROSS },
        posts: { SPV: true, MPV: true },
      },
    ]

    for (const cell of cells) {
      for (const vat of ["SPV", "MPV"] as VatClassification[]) {
        it(`${cell.name} × ${vat}`, () => {
          const result = generateVoucherPosting(
            baseInput({ lifecycle_event: cell.lifecycle_event, vat_classification: vat, ...cell.extra })
          )
          expect(result.posted).toBe(cell.posts[vat])
          if (result.posted) {
            assertContractConformance(result.transaction)
            expect(result.transaction.metadata.vat_classification).toBe(vat)
          }
        })
      }
    }
  })
})
