import { describe, expect, it } from "@jest/globals"
import { resolveVatClassification, type VatClassification } from "../vat-resolver"
import { EntitlementType } from "../models/entitlement"
import {
  VOUCHER_BUNDLE_POSTING_PROFILE_ID,
  VOUCHER_BUNDLE_V1,
  VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID,
  VOUCHER_CREDIT_PACK_V1,
  VOUCHER_LEDGER_ACCOUNTS,
  VOUCHER_LIABILITY_ONLY_V1,
  VOUCHER_POSTING_PROFILE_ID,
  VOUCHER_POSTING_PROFILE_REGISTRY,
  VoucherPostingGuardError,
  VoucherPostingInvariantError,
  assertBalanced,
  assertPostingAccountsAllowed,
  generateVoucherPosting,
  isMoneyAccount,
  resolveVoucherPostingProfile,
} from "../posting-profile"
import type {
  LedgerLine,
  LedgerTransactionV1,
  VoucherPostingProfileId,
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
function assertContractConformance(
  tx: LedgerTransactionV1,
  expectedProfile: VoucherPostingProfileId = VOUCHER_POSTING_PROFILE_ID
): void {
  // entry_type ∈ enum lifecycle (additive, ADR-133 §Decyzja pkt 2b).
  expect(["ENTITLEMENT_ISSUED", "ENTITLEMENT_REDEEMED", "ENTITLEMENT_BREAKAGE"]).toContain(
    tx.entry_type
  )
  // conditional metadata-keys (Story 2.1 if/then).
  expect(tx.metadata.posting_profile).toBe(expectedProfile)
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
  describe("Story 3.3 — rejestr profili keyed by entitlement_type", () => {
    it("rozwiązuje profile deklaratywnie z rejestru, a legacy/brak typu zostaje voucher_liability_only_v1", () => {
      expect(resolveVoucherPostingProfile(undefined).id).toBe(VOUCHER_POSTING_PROFILE_ID)
      expect(resolveVoucherPostingProfile(EntitlementType.VOUCHER_AMOUNT).id).toBe(
        VOUCHER_POSTING_PROFILE_ID
      )
      expect(resolveVoucherPostingProfile(EntitlementType.VOUCHER_SERVICE).id).toBe(
        VOUCHER_POSTING_PROFILE_ID
      )
      expect(resolveVoucherPostingProfile(EntitlementType.CREDIT_PACK).id).toBe(
        VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID
      )
      expect(resolveVoucherPostingProfile(EntitlementType.BUNDLE).id).toBe(
        VOUCHER_BUNDLE_POSTING_PROFILE_ID
      )

      expect(VOUCHER_POSTING_PROFILE_REGISTRY).toMatchObject({
        [EntitlementType.CREDIT_PACK]: VOUCHER_CREDIT_PACK_V1,
        [EntitlementType.BUNDLE]: VOUCHER_BUNDLE_V1,
      })
    })

    it("nieznany entitlement_type rzuca fail-closed, bez cichego fallbacku na legacy", () => {
      expect(() => resolveVoucherPostingProfile("UNKNOWN_TYPE")).toThrow(
        VoucherPostingInvariantError
      )
      expect(() =>
        generateVoucherPosting(
          baseInput({
            entitlement_type: "UNKNOWN_TYPE",
            lifecycle_event: "ISSUED",
            vat_classification: "SPV",
          })
        )
      ).toThrow(VoucherPostingInvariantError)
    })

    it("nowe profile są runtime_disabled i reuse'ują namespace kont entitlement/VAT bez kont pieniężnych", () => {
      for (const profile of [VOUCHER_CREDIT_PACK_V1, VOUCHER_BUNDLE_V1]) {
        expect(profile.runtime_enabled).toBe(false)
        expect(profile.allowed_accounts).toEqual(
          expect.arrayContaining(Object.values(VOUCHER_LEDGER_ACCOUNTS))
        )
        expect(profile.forbidden_money_classes).toEqual(
          expect.arrayContaining([...CASH_ACCOUNTS])
        )
      }
    })
  })

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
      // Carve-out: liability debetowane WARTOŚCIĄ VAT (liability brutto → netto).
      const liabLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY)!
      expect(liabLine.debit_minor).toBe(VAT)
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
      // Carve-out: suspense kredytowane WARTOŚCIĄ VAT, liability debetowane VAT.
      const suspLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)!
      expect(suspLine.credit_minor).toBe(VAT)
      const liabLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY)!
      expect(liabLine.debit_minor).toBe(VAT)
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

  describe("Story 3.3 AC2/AC3 — CREDIT_PACK/BUNDLE golden matrix", () => {
    it("CREDIT_PACK SPV ISSUED zapisuje metadata.posting_profile=voucher_credit_pack_v1", () => {
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            entitlement_type: EntitlementType.CREDIT_PACK,
            lifecycle_event: "ISSUED",
            vat_classification: resolveVatClassification({ vat_rates: [23, "23%"] }),
          })
        )
      )
      assertContractConformance(tx, VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID)
      expect(tx.metadata.vat_classification).toBe("SPV")
      expect(accountsTouched(tx)).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)
    })

    it("BUNDLE jednolite stawki ⇒ SPV przy ISSUED i posting_profile=voucher_bundle_v1", () => {
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            entitlement_type: EntitlementType.BUNDLE,
            lifecycle_event: "ISSUED",
            vat_classification: resolveVatClassification({ vat_rates: [8, "8.00%"] }),
          })
        )
      )
      assertContractConformance(tx, VOUCHER_BUNDLE_POSTING_PROFILE_ID)
      expect(tx.metadata.vat_classification).toBe("SPV")
      expect(accountsTouched(tx)).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION)
    })

    it("BUNDLE mieszane stawki choice_set ⇒ resolver fail-closed MPV; VAT dopiero przy redeem", () => {
      const mixedChoiceSetClassification = resolveVatClassification({ vat_rates: [8, 23] })
      expect(mixedChoiceSetClassification).toBe("MPV")

      const issued = expectPosted(
        generateVoucherPosting(
          baseInput({
            entitlement_type: EntitlementType.BUNDLE,
            lifecycle_event: "ISSUED",
            vat_classification: mixedChoiceSetClassification,
          })
        )
      )
      assertContractConformance(issued, VOUCHER_BUNDLE_POSTING_PROFILE_ID)
      expect(accountsTouched(issued)).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)
      expect(accountsTouched(issued)).not.toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)

      const redeemed = expectPosted(
        generateVoucherPosting(
          baseInput({
            entitlement_type: EntitlementType.BUNDLE,
            lifecycle_event: "REDEEMED",
            vat_classification: mixedChoiceSetClassification,
            redeemed_gross_minor: GROSS / 2,
          })
        )
      )
      assertContractConformance(redeemed, VOUCHER_BUNDLE_POSTING_PROFILE_ID)
      expect(accountsTouched(redeemed)).toContain(VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)
      const outLine = redeemed.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT)!
      expect(outLine.credit_minor).toBe(1150)
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
      // Połowa zrealizowana (redeemed-to-date), połowa wygasa → breakage tylko od
      // remaining 6150; rezydualny zawieszony VAT = 2300 − recognized(6150)=1150.
      const remaining = GROSS / 2
      const tx = expectPosted(
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "EXPIRED",
            vat_classification: "MPV",
            redeemed_gross_to_date_minor: GROSS / 2,
            remaining_gross_minor: remaining,
          })
        )
      )
      assertContractConformance(tx)
      const breakageLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.BREAKAGE)!
      expect(breakageLine.credit_minor).toBe(remaining)
      // Rezydualny zawieszony VAT = 1150 (połowa rozpoznana przy redeemie).
      const suspLine = tx.lines.find((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE)!
      expect(suspLine.debit_minor).toBe(1150)
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

  describe("VER-H1/VER-M1 — kumulatywny VAT multi-installment + Σ-enforcement", () => {
    // Voucher z VAT NIEDZIELĄCYM się równo na raty: net=100 vat=23 gross=123.
    const M_NET = 100
    const M_VAT = 23
    const M_GROSS = M_NET + M_VAT // 123

    function redeemEvent(redeemed: number, toDate: number): VoucherPostingResult {
      return generateVoucherPosting(
        baseInput({
          lifecycle_event: "REDEEMED",
          vat_classification: "MPV",
          net_minor: M_NET,
          vat_minor: M_VAT,
          redeemed_gross_minor: redeemed,
          redeemed_gross_to_date_minor: toDate,
        })
      )
    }

    function recognisedVat(result: VoucherPostingResult): number {
      if (!result.posted) return 0
      const out = result.transaction.lines.find(
        (l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT
      )
      return out ? out.credit_minor : 0
    }

    it("3×41 (PoC VER-H1): Σ recognized output VAT == 23 (suspense netuje do 0)", () => {
      // round-niezależny dawałby 3×round(23·41/123)=3×8=24 ≠ 23 (suspense=-1).
      // Kumulatywny: 8 + 7 + 8 = 23.
      const e1 = redeemEvent(41, 0)
      const e2 = redeemEvent(41, 41)
      const e3 = redeemEvent(41, 82)
      const total = recognisedVat(e1) + recognisedVat(e2) + recognisedVat(e3)
      expect(total).toBe(M_VAT)
      // każdy posted wpis jest wewnętrznie zbilansowany
      for (const e of [e1, e2, e3]) {
        if (e.posted) assertContractConformance(e.transaction)
      }
    })

    it("niesymetryczny podział (1 + 1 + 121): Σ recognized == 23", () => {
      const e1 = redeemEvent(1, 0) // round(23·1/123)=0 → no-op
      const e2 = redeemEvent(1, 1) // round(23·2/123)=0 → no-op
      const e3 = redeemEvent(121, 2) // round(23·123/123)−round(23·2/123)=23−0=23
      const total = recognisedVat(e1) + recognisedVat(e2) + recognisedVat(e3)
      expect(total).toBe(M_VAT)
    })

    it("redeem po 1 minor aż do pełna: Σ recognized == 23 (nigdy stranded)", () => {
      let total = 0
      for (let i = 0; i < M_GROSS; i++) {
        total += recognisedVat(redeemEvent(1, i))
      }
      expect(total).toBe(M_VAT)
    })

    it("over-redeem (redeemed-to-date + ten event > brutto) ⇒ fail-closed", () => {
      expect(() => redeemEvent(42, 82)).toThrow(VoucherPostingInvariantError) // 82+42=124 > 123
    })

    it("over-derecognition przy breakage (prior + remaining > brutto) ⇒ fail-closed", () => {
      expect(() =>
        generateVoucherPosting(
          baseInput({
            lifecycle_event: "EXPIRED",
            vat_classification: "MPV",
            net_minor: M_NET,
            vat_minor: M_VAT,
            redeemed_gross_to_date_minor: 100,
            remaining_gross_minor: 24, // 100+24=124 > 123
          })
        )
      ).toThrow(VoucherPostingInvariantError)
    })

    it("pełny lifecycle (2 partial redeemy + breakage reszty): suspense netuje do 0", () => {
      // gross 123: redeem 41, redeem 41, breakage remaining 41.
      const r1 = recognisedVat(redeemEvent(41, 0)) // 8
      const r2 = recognisedVat(redeemEvent(41, 41)) // 7
      const breakage = generateVoucherPosting(
        baseInput({
          lifecycle_event: "EXPIRED",
          vat_classification: "MPV",
          net_minor: M_NET,
          vat_minor: M_VAT,
          redeemed_gross_to_date_minor: 82,
          remaining_gross_minor: 41,
        })
      )
      const susp = expectPosted(breakage).lines.find(
        (l) => l.account === VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE
      )!
      // suspense zdjęty: r1+r2 (output) + breakage-suspense == 23 (zawieszone przy emisji)
      expect(r1 + r2 + susp.debit_minor).toBe(M_VAT)
    })
  })

  describe("LOW — edge cases (zero-line / case-variant cash)", () => {
    it("breakage netRemaining==0 (saldo w całości VAT) ⇒ no-op, NIE linia zero/zero", () => {
      // net=0, vat=50, gross=50, remaining=całość → netto remaining = 0.
      const spv = generateVoucherPosting(
        baseInput({
          lifecycle_event: "EXPIRED",
          vat_classification: "SPV",
          net_minor: 0,
          vat_minor: 50,
          remaining_gross_minor: 50,
        })
      )
      expect(spv.posted).toBe(false) // no-op zamiast assertBalanced crash

      // MPV: netRemaining 0, ale rezydualny VAT 50 → 2 linie (suspense/breakage), NIE crash.
      const mpv = generateVoucherPosting(
        baseInput({
          lifecycle_event: "EXPIRED",
          vat_classification: "MPV",
          net_minor: 0,
          vat_minor: 50,
          remaining_gross_minor: 50,
        })
      )
      const tx = expectPosted(mpv)
      assertContractConformance(tx)
      expect(tx.lines.length).toBe(2)
      expect(tx.lines.some((l) => l.account === VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY)).toBe(false)
    })

    it("guard klasyfikuje warianty wielkości liter konta pieniężnego jako money_account", () => {
      for (const cash of ["CASH", "Cash", "Cash:settlement", "CASH_CLEARING:psp"]) {
        expect(isMoneyAccount(cash)).toBe(true)
        try {
          assertPostingAccountsAllowed([{ account: cash }, { account: VOUCHER_LEDGER_ACCOUNTS.BREAKAGE }])
          throw new Error("oczekiwano rzutu")
        } catch (e) {
          expect(e).toBeInstanceOf(VoucherPostingGuardError)
          expect((e as VoucherPostingGuardError).kind).toBe("money_account")
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
