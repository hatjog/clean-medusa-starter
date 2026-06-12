/**
 * Posting profile `voucher_liability_only_v1` — Story 2.3 (v1.11.0 Epic 2 / Wave 2).
 *
 * Czysta logika księgowania (pure generator) lifecycle vouchera na istniejącym
 * double-entry ledgerze (GP Core SSOT, ADR-032/005). Produkuje wpisy zgodne z
 * kontraktem `ledger-transaction.v1` (Story 2.1) konsumując `vat_classification`
 * z resolvera SPV/MPV (Story 2.2). Bez I/O, bez stanu globalnego — wyłącznie
 * deterministyczna transformacja wejścia w double-entry lines.
 *
 * KRYTYCZNE (ADR-133 §P6 / FR60): profil jest AUTHORED, ale `runtime_enabled:FALSE`
 * (runtime-disabled). Eksport tego modułu dostarcza ZDOLNOŚĆ — NIE aktywuje profilu
 * w runtime, NIE podpina go do żywej ścieżki order-flow i NIE deklaruje finance
 * sign-off. Flip `runtime_enabled` + sign-off ledgera = WYŁĄCZNIE ręczna decyzja
 * P6 (Robert), FINANCE GATE D-2, governed activation (ADR-099). Pełna matrix
 * GREEN na realnym Postgres jako walidator CI = Story 2.5 (retry slot).
 *
 * Model postingu (ADR-133 §Decyzja pkt 2a/2b, ADR-135 §Decyzja pkt 5):
 *   - ISSUED   → contract liability (IFRS 15, NIE przychód); SPV VAT przy emisji
 *                (`vat:output:emission`), MPV bez VAT przy emisji (suspense).
 *   - REDEEMED → derecognition liability proporcjonalnie do `redeemed`; MPV
 *                VAT-at-redeem (`vat:output:suspense`→`vat:output`); partial obniża
 *                `remaining`, NIE reissue.
 *   - EXPIRED unused → BREAKAGE (jeden wpis `ENTITLEMENT_BREAKAGE`,
 *                `lifecycle_event=EXPIRED`); SPV VAT już rozpoznany, MPV unused =
 *                bez VAT (art. 73a). Expiry bez salda = no-op księgowy.
 *
 * Każdy wpis jest double-entry (≥2 linie, `debits==credits`), append-only (korekta
 * = nowy wpis z korelacją, nigdy mutacja). Posting dotyka WYŁĄCZNIE kont
 * entitlement/VAT; próba zapisu na konto pieniężne (`cash`/`cash_clearing`/
 * `cash_settlement`) jest odrzucona fail-closed przez runtime posting guard
 * (FR33, D-2, ADR-133 §Decyzja pkt 3.ii) — niezależnie od walidatora CI.
 *
 * Granica entitlement-ledger ≠ money-ledger: noga rozpoznania liability brutto
 * (money-leg na koncie `cash`) żyje w osobnym money-ledger. Ten profil generuje
 * wyłącznie reklasyfikacje VAT/liability/breakage w obrębie kont entitlement/VAT,
 * które samobilansują się bez konta pieniężnego. SPV REDEEMED nie ma legu w
 * entitlement-ledgerze (VAT rozpoznany przy emisji, derecognition netto→revenue =
 * money-ledger) → udokumentowany no-op księgowy.
 */

import type { VatClassification } from "./vat-resolver"
import { EntitlementType } from "./models/entitlement"

/** Identyfikator profilu legacy — wartość `metadata.posting_profile` w `ledger-transaction.v1`. */
export const VOUCHER_POSTING_PROFILE_ID = "voucher_liability_only_v1" as const
export const VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID = "voucher_credit_pack_v1" as const
export const VOUCHER_BUNDLE_POSTING_PROFILE_ID = "voucher_bundle_v1" as const

export const VOUCHER_POSTING_PROFILE_IDS = Object.freeze([
  VOUCHER_POSTING_PROFILE_ID,
  VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID,
  VOUCHER_BUNDLE_POSTING_PROFILE_ID,
] as const)

export type VoucherPostingProfileId = (typeof VOUCHER_POSTING_PROFILE_IDS)[number]

/**
 * Konta dozwolone dla posting profile `voucher_liability_only_v1`
 * (ADR-133 §Decyzja pkt 2). REUSE konwencji `<klasa>:<podklasa>:<scope>`.
 */
export const VOUCHER_LEDGER_ACCOUNTS = Object.freeze({
  /** Contract liability z tytułu wyemitowanego vouchera (IFRS 15, NIE przychód). */
  CONTRACT_LIABILITY: "liability:contract_liability:voucher",
  /** Breakage przy wygaśnięciu z niewykorzystanym saldem. */
  BREAKAGE: "breakage:voucher",
  /** Output VAT przy emisji (SPV). */
  VAT_OUTPUT_EMISSION: "vat:output:emission",
  /** VAT w zawieszeniu dla MPV (output dopiero przy redeem). */
  VAT_OUTPUT_SUSPENSE: "vat:output:suspense",
  /** Rozpoznany output VAT przy redeem (MPV: suspense → output). */
  VAT_OUTPUT: "vat:output",
} as const)

/** Zbiór dozwolonych kont (allow-list, ADR-133 §Decyzja pkt 2). */
const ALLOWED_ACCOUNTS: ReadonlySet<string> = new Set(
  Object.values(VOUCHER_LEDGER_ACCOUNTS)
)

/**
 * Pierwsze segmenty namespace traktowane jako konta pieniężne (ZAKAZANE,
 * fail-closed; ADR-007 / FR33 / D-2). Egzekwowane na pierwszym segmencie
 * `<klasa>` (split po `:`), więc `cash`, `cash:settlement`, `cash_clearing:psp`
 * itd. są wszystkie odrzucane.
 */
const FORBIDDEN_MONEY_CLASSES: ReadonlySet<string> = new Set([
  "cash",
  "cash_clearing",
  "cash_settlement",
])

export const VOUCHER_LIABILITY_ONLY_V1 = Object.freeze({
  id: VOUCHER_POSTING_PROFILE_ID,
  /**
   * ADR-133 §P6 (mitygacja ii): profil pozostaje disabled w runtime niezależnie
   * od stanu testów. Flip = wyłącznie ręczna decyzja P6 (Robert), FINANCE GATE
   * D-2, governed activation (ADR-099). Agent NIE flipuje tej flagi.
   */
  runtime_enabled: false as const,
  allowed_accounts: Object.freeze([...ALLOWED_ACCOUNTS]),
  forbidden_money_classes: Object.freeze([...FORBIDDEN_MONEY_CLASSES]),
} as const)

export const VOUCHER_CREDIT_PACK_V1 = Object.freeze({
  id: VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID,
  runtime_enabled: false as const,
  allowed_accounts: Object.freeze([...ALLOWED_ACCOUNTS]),
  forbidden_money_classes: Object.freeze([...FORBIDDEN_MONEY_CLASSES]),
} as const)

export const VOUCHER_BUNDLE_V1 = Object.freeze({
  id: VOUCHER_BUNDLE_POSTING_PROFILE_ID,
  runtime_enabled: false as const,
  allowed_accounts: Object.freeze([...ALLOWED_ACCOUNTS]),
  forbidden_money_classes: Object.freeze([...FORBIDDEN_MONEY_CLASSES]),
} as const)

export type VoucherPostingProfile =
  | typeof VOUCHER_LIABILITY_ONLY_V1
  | typeof VOUCHER_CREDIT_PACK_V1
  | typeof VOUCHER_BUNDLE_V1

export const VOUCHER_POSTING_PROFILES_BY_ID: Readonly<Record<VoucherPostingProfileId, VoucherPostingProfile>> =
  Object.freeze({
    [VOUCHER_POSTING_PROFILE_ID]: VOUCHER_LIABILITY_ONLY_V1,
    [VOUCHER_CREDIT_PACK_POSTING_PROFILE_ID]: VOUCHER_CREDIT_PACK_V1,
    [VOUCHER_BUNDLE_POSTING_PROFILE_ID]: VOUCHER_BUNDLE_V1,
  })

export const VOUCHER_POSTING_PROFILE_REGISTRY: Readonly<
  Partial<Record<EntitlementType, VoucherPostingProfile>>
> = Object.freeze({
  [EntitlementType.VOUCHER_AMOUNT]: VOUCHER_LIABILITY_ONLY_V1,
  [EntitlementType.VOUCHER_SERVICE]: VOUCHER_LIABILITY_ONLY_V1,
  [EntitlementType.CREDIT_PACK]: VOUCHER_CREDIT_PACK_V1,
  [EntitlementType.BUNDLE]: VOUCHER_BUNDLE_V1,
})

// ──────────────────────────────────────────────────────────────────────────
// Typy zgodne z kontraktem `ledger-transaction.v1` (Story 2.1)
// ──────────────────────────────────────────────────────────────────────────

export type LedgerScope = {
  instance_id: string
  market_id: string
  vendor_id?: string | null
  location_id?: string | null
}

export type LedgerLine = {
  ledger_entry_id: string
  account: string
  debit_minor: number
  credit_minor: number
  metadata?: Record<string, unknown>
}

/** Lifecycle-entry typy używane przez profil (ADR-133 §Decyzja pkt 2b). */
export type VoucherEntryType =
  | "ENTITLEMENT_ISSUED"
  | "ENTITLEMENT_REDEEMED"
  | "ENTITLEMENT_BREAKAGE"

export type VoucherLifecycleEvent = "ISSUED" | "REDEEMED" | "EXPIRED"

export type LedgerTransactionV1 = {
  transaction_id: string
  occurred_at: string
  scope: LedgerScope
  currency: string
  entry_type: VoucherEntryType
  lines: LedgerLine[]
  metadata: {
    posting_profile: VoucherPostingProfileId
    vat_classification: VatClassification
    lifecycle_event: string
    [key: string]: unknown
  }
}

/**
 * Wejście generatora. Kwoty w jednostkach minor (grosze), nieujemne całkowite.
 * `net_minor` + `vat_minor` = brutto całego vouchera przy emisji.
 */
export type VoucherPostingInput = {
  /**
   * Wymiar resolvera ADR-140 §3. Brak pola oznacza legacy/voucher path i mapuje
   * się na `voucher_liability_only_v1`; podany nieznany typ rzuca fail-closed.
   */
  entitlement_type?: EntitlementType | string
  lifecycle_event: VoucherLifecycleEvent
  /** Konsumowane z resolvera Story 2.2; profil NIE reklasyfikuje (single source). */
  vat_classification: VatClassification
  /** Netto (ex-VAT) całego vouchera przy emisji, minor units. */
  net_minor: number
  /** VAT całego vouchera przy emisji, minor units. */
  vat_minor: number
  /** REDEEMED: zrealizowane brutto w tym evencie (proporcjonalnie), minor units. */
  redeemed_gross_minor?: number
  /**
   * REDEEMED/EXPIRED: SKUMULOWANE zrealizowane brutto PRZED tym eventem
   * (redeemed-to-date, bez bieżącego eventu), minor units. Default 0.
   *
   * Niezbędne do KUMULATYWNEGO rozpoznania VAT (VER-H1): rozpoznany output VAT
   * tego eventu = `round(vat·(prior+this)/gross) − round(vat·prior/gross)`, dzięki
   * czemu dla DOWOLNEGO podziału partial-redeemów Σ recognized == suspended
   * (`vat:output:suspense` netuje do 0 po pełnym redeemie, ostatni event absorbuje
   * resztę zaokrąglenia). Przy EXPIRED służy do policzenia rezydualnego
   * zawieszonego VAT (vat − recognized-to-date) oraz egzekucji Σ ≤ brutto.
   */
  redeemed_gross_to_date_minor?: number
  /** EXPIRED: niewykorzystane brutto na moment wygaśnięcia (breakage), minor units. */
  remaining_gross_minor?: number
  // koperta `ledger-transaction.v1`
  transaction_id: string
  occurred_at: string
  scope: LedgerScope
  currency: string
}

/**
 * Wynik generatora: albo wpis księgowy (`posted:true`), albo udokumentowany
 * no-op (`posted:false`) — np. SPV REDEEMED (brak legu w entitlement-ledgerze)
 * lub EXPIRED bez salda (ADR-133 §Decyzja pkt 2b).
 */
export type VoucherPostingResult =
  | { posted: true; transaction: LedgerTransactionV1 }
  | { posted: false; reason: string }

// ──────────────────────────────────────────────────────────────────────────
// Runtime posting guard fail-closed (ADR-133 §Decyzja pkt 3.ii; FR33/D-2)
// ──────────────────────────────────────────────────────────────────────────

export class VoucherPostingGuardError extends Error {
  readonly account: string
  readonly kind: "money_account" | "account_outside_namespace"
  constructor(
    message: string,
    account: string,
    kind: "money_account" | "account_outside_namespace"
  ) {
    super(message)
    this.name = "VoucherPostingGuardError"
    this.account = account
    this.kind = kind
  }
}

/**
 * Pierwszy segment namespace (`<klasa>` przed pierwszym `:`), znormalizowany do
 * lowercase. Dzięki temu warianty wielkości liter (`CASH`, `Cash:settlement`)
 * są klasyfikowane jako konto pieniężne (kind=`money_account`), a nie wpadają w
 * ogólny `account_outside_namespace` — taksonomia błędów wiarygodna dla
 * telemetrii D-2 (LOW).
 */
function accountClass(account: string): string {
  const idx = account.indexOf(":")
  return (idx === -1 ? account : account.slice(0, idx)).toLowerCase()
}

/** Czy konto należy do zakazanej klasy pieniężnej (fail-closed). */
export function isMoneyAccount(account: string): boolean {
  return FORBIDDEN_MONEY_CLASSES.has(accountClass(account))
}

/**
 * Runtime posting guard: rzuca fail-closed gdy którakolwiek linia dotyka konta
 * pieniężnego (`cash*`) lub konta spoza dozwolonego namespace entitlement/VAT.
 * Bariera działa NIEZALEŻNIE od walidatora CI (ADR-133 §Decyzja pkt 3 —
 * podwójna bariera entitlement↔money). Wywoływana przez generator przed
 * zwróceniem wpisu; może też być użyta samodzielnie na dowolnym zbiorze linii.
 */
export function assertPostingAccountsAllowed(
  lines: ReadonlyArray<Pick<LedgerLine, "account">>
): void {
  for (const line of lines) {
    // Money-account check NAJPIERW — precyzyjny komunikat dla zakazu kont
    // pieniężnych (FR33/D-2), zanim wpadnie w ogólny allow-list.
    if (isMoneyAccount(line.account)) {
      throw new VoucherPostingGuardError(
        `voucher_liability_only_v1 odrzuca posting na konto pieniężne "${line.account}" (fail-closed, FR33/D-2/ADR-007)`,
        line.account,
        "money_account"
      )
    }
    if (!ALLOWED_ACCOUNTS.has(line.account)) {
      throw new VoucherPostingGuardError(
        `voucher_liability_only_v1 odrzuca konto "${line.account}" spoza dozwolonego namespace entitlement/VAT (fail-closed, ADR-133 §Decyzja pkt 2)`,
        line.account,
        "account_outside_namespace"
      )
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Inwarianty double-entry
// ──────────────────────────────────────────────────────────────────────────

export class VoucherPostingInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VoucherPostingInvariantError"
  }
}

export function resolveVoucherPostingProfile(
  entitlementType: VoucherPostingInput["entitlement_type"]
): VoucherPostingProfile {
  if (entitlementType == null) {
    return VOUCHER_LIABILITY_ONLY_V1
  }
  const profile =
    VOUCHER_POSTING_PROFILE_REGISTRY[
      entitlementType as keyof typeof VOUCHER_POSTING_PROFILE_REGISTRY
    ]
  if (!profile) {
    throw new VoucherPostingInvariantError(
      `nieznany entitlement_type dla posting_profile registry: ${String(entitlementType)}`
    )
  }
  return profile
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new VoucherPostingInvariantError(
      `${label} musi być nieujemną liczbą całkowitą (minor units), otrzymano: ${value}`
    )
  }
}

/**
 * Egzekwuje inwarianty transakcji (ledger README): ≥2 linie, każda linia ma
 * dokładnie jedną stronę dodatnią, suma debetów = suma kredytów. Rzuca przy
 * naruszeniu — generator NIE zwróci niezbilansowanego wpisu.
 */
export function assertBalanced(lines: ReadonlyArray<LedgerLine>): void {
  if (lines.length < 2) {
    throw new VoucherPostingInvariantError(
      `double-entry wymaga ≥2 linii, otrzymano: ${lines.length}`
    )
  }
  let debits = 0
  let credits = 0
  for (const line of lines) {
    assertNonNegativeInteger(line.debit_minor, "debit_minor")
    assertNonNegativeInteger(line.credit_minor, "credit_minor")
    const debitPositive = line.debit_minor > 0
    const creditPositive = line.credit_minor > 0
    // Ledger README: dokładnie jedno z pól debit/credit jest dodatnie.
    if (debitPositive === creditPositive) {
      throw new VoucherPostingInvariantError(
        `linia ${line.ledger_entry_id} musi mieć dokładnie jedną stronę dodatnią (debit=${line.debit_minor}, credit=${line.credit_minor})`
      )
    }
    debits += line.debit_minor
    credits += line.credit_minor
  }
  if (debits !== credits) {
    throw new VoucherPostingInvariantError(
      `double-entry niezbilansowane: debits=${debits} ≠ credits=${credits}`
    )
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Generator double-entry lines per event lifecycle
// ──────────────────────────────────────────────────────────────────────────

/** VAT proporcjonalny do brutto (deterministyczne zaokrąglenie). */
function proportionalVat(
  vatMinor: number,
  portionGrossMinor: number,
  totalGrossMinor: number
): number {
  if (totalGrossMinor === 0) {
    return 0
  }
  return Math.round((vatMinor * portionGrossMinor) / totalGrossMinor)
}

function buildEnvelope(
  input: VoucherPostingInput,
  profile: VoucherPostingProfile,
  entryType: VoucherEntryType,
  lifecycleEvent: string,
  lines: LedgerLine[]
): LedgerTransactionV1 {
  // Podwójna bariera: runtime posting guard (konta) + inwariant double-entry.
  assertPostingAccountsAllowed(lines)
  assertBalanced(lines)
  return {
    transaction_id: input.transaction_id,
    occurred_at: input.occurred_at,
    scope: input.scope,
    currency: input.currency,
    entry_type: entryType,
    lines,
    metadata: {
      posting_profile: profile.id,
      vat_classification: input.vat_classification,
      lifecycle_event: lifecycleEvent,
    },
  }
}

function line(
  input: VoucherPostingInput,
  suffix: string,
  account: string,
  side: "debit" | "credit",
  amountMinor: number,
  note: string
): LedgerLine {
  return {
    ledger_entry_id: `${input.transaction_id}:${suffix}`,
    account,
    debit_minor: side === "debit" ? amountMinor : 0,
    credit_minor: side === "credit" ? amountMinor : 0,
    metadata: { note },
  }
}

/**
 * ISSUED → contract liability (IFRS 15, NIE przychód). W entitlement-ledgerze
 * profil wydziela VAT z liability brutto (carve-out):
 *   - SPV: VAT przy emisji → `liability:contract_liability:voucher` (D) /
 *          `vat:output:emission` (C). Liability zostaje netto.
 *   - MPV: bez VAT przy emisji → VAT do zawieszenia →
 *          `liability:contract_liability:voucher` (D) / `vat:output:suspense` (C).
 *
 * Uwaga: noga rozpoznania liability brutto (Dr `cash`) żyje w money-ledger
 * (poza zakresem profilu, FR33). Carve-out VAT samobilansuje się bez konta
 * pieniężnego.
 */
function generateIssued(input: VoucherPostingInput, profile: VoucherPostingProfile): VoucherPostingResult {
  assertNonNegativeInteger(input.vat_minor, "vat_minor")
  assertNonNegativeInteger(input.net_minor, "net_minor")

  if (input.vat_minor === 0) {
    // Brak VAT do wydzielenia (np. stawka 0%): w entitlement-ledgerze nie ma
    // reklasyfikacji — pełne rozpoznanie liability brutto = money-ledger.
    return {
      posted: false,
      reason:
        "ISSUED bez VAT (vat_minor=0): brak reklasyfikacji w entitlement-ledgerze; rozpoznanie liability brutto = money-ledger (poza zakresem profilu)",
    }
  }

  const vatAccount =
    input.vat_classification === "SPV"
      ? VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_EMISSION
      : VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE
  const note =
    input.vat_classification === "SPV"
      ? "SPV: output VAT rozpoznany przy emisji (vat:output:emission)"
      : "MPV: VAT zawieszony przy emisji (vat:output:suspense), output dopiero przy redeem"

  const lines: LedgerLine[] = [
    line(
      input,
      "issued-liability",
      VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY,
      "debit",
      input.vat_minor,
      "Wydzielenie VAT z liability brutto vouchera (contract liability zostaje netto)"
    ),
    line(input, "issued-vat", vatAccount, "credit", input.vat_minor, note),
  ]

  return { posted: true, transaction: buildEnvelope(input, profile, "ENTITLEMENT_ISSUED", "ISSUED", lines) }
}

/**
 * REDEEMED (full/partial) → derecognition liability proporcjonalnie do
 * `redeemed`. Partial obniża `remaining`, NIE reissue (NIE uruchamia nowej
 * emisji).
 *   - MPV: VAT-at-redeem → `vat:output:suspense` (D) / `vat:output` (C),
 *          proporcjonalnie do zrealizowanego brutto.
 *   - SPV: VAT rozpoznany przy emisji; derecognition netto liability → revenue
 *          jest legiem money-ledger (poza zakresem). W entitlement-ledgerze brak
 *          legu → udokumentowany no-op (VAT już rozpoznany, brak nowego VAT).
 */
function generateRedeemed(input: VoucherPostingInput, profile: VoucherPostingProfile): VoucherPostingResult {
  assertNonNegativeInteger(input.vat_minor, "vat_minor")
  assertNonNegativeInteger(input.net_minor, "net_minor")
  const redeemedGross = input.redeemed_gross_minor ?? 0
  assertNonNegativeInteger(redeemedGross, "redeemed_gross_minor")
  const priorRedeemedGross = input.redeemed_gross_to_date_minor ?? 0
  assertNonNegativeInteger(priorRedeemedGross, "redeemed_gross_to_date_minor")

  const totalGross = input.net_minor + input.vat_minor
  // Σ-enforcement (launcher MEDIUM): redeemed-to-date + ten event NIE może
  // przekroczyć brutto vouchera — over-redeem odrzucany fail-closed. Pełna
  // egzekucja idempotencji/append-only po transaction_id należy do warstwy
  // wołającej / maszyny stanów (Story 3.x); tu minimalny guard kumulatywny.
  const cumulativeRedeemedGross = priorRedeemedGross + redeemedGross
  if (cumulativeRedeemedGross > totalGross) {
    throw new VoucherPostingInvariantError(
      `over-redeem: redeemed-to-date (${priorRedeemedGross}) + redeemed_gross_minor (${redeemedGross}) = ${cumulativeRedeemedGross} > brutto vouchera (${totalGross})`
    )
  }

  if (input.vat_classification === "SPV") {
    return {
      posted: false,
      reason:
        "SPV REDEEMED: VAT rozpoznany przy emisji (brak nowego VAT); derecognition netto liability→revenue = money-leg w money-ledger (poza zakresem entitlement-ledger)",
    }
  }

  // MPV: KUMULATYWNE rozpoznanie zawieszonego VAT (VER-H1). VAT rozpoznany w
  // tym evencie = round(vat·skumulowane/gross) − round(vat·prior/gross), więc
  // dla DOWOLNEGO podziału partial-redeemów Σ recognized == suspended (ostatni
  // event absorbuje resztę zaokrąglenia, suspense netuje do 0 po pełnym redeemie).
  const vatRedeemed =
    proportionalVat(input.vat_minor, cumulativeRedeemedGross, totalGross) -
    proportionalVat(input.vat_minor, priorRedeemedGross, totalGross)
  if (vatRedeemed === 0) {
    return {
      posted: false,
      reason:
        "MPV REDEEMED bez VAT do rozpoznania (vatRedeemed=0): brak legu VAT w entitlement-ledgerze",
    }
  }

  const lines: LedgerLine[] = [
    line(
      input,
      "redeemed-vat-suspense",
      VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE,
      "debit",
      vatRedeemed,
      "MPV: zdjęcie zawieszonego VAT proporcjonalnie do zrealizowanego brutto"
    ),
    line(
      input,
      "redeemed-vat-output",
      VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT,
      "credit",
      vatRedeemed,
      "MPV: rozpoznanie output VAT przy redeem (vat:output)"
    ),
  ]

  return { posted: true, transaction: buildEnvelope(input, profile, "ENTITLEMENT_REDEEMED", "REDEEMED", lines) }
}

/**
 * EXPIRED z niewykorzystanym saldem → BREAKAGE (jeden wpis
 * `ENTITLEMENT_BREAKAGE`, `lifecycle_event=EXPIRED`; ADR-133 §Decyzja pkt 2b).
 *   - SPV: VAT rozpoznany przy emisji → breakage tylko z części netto
 *          niewykorzystanego salda (brak nowego VAT).
 *   - MPV unused: bez VAT (art. 73a) → zawieszony VAT niewykorzystanego salda
 *          NIE staje się output, lecz wpada do breakage razem z netto.
 *
 * Expiry bez salda (`remaining_gross_minor=0`) = no-op księgowy.
 * Forfeiture/partial NIE reklasyfikują (C-68/23) — breakage liczony WYŁĄCZNIE
 * od niewykorzystanego salda.
 */
function generateBreakage(input: VoucherPostingInput, profile: VoucherPostingProfile): VoucherPostingResult {
  assertNonNegativeInteger(input.vat_minor, "vat_minor")
  assertNonNegativeInteger(input.net_minor, "net_minor")
  const remainingGross = input.remaining_gross_minor ?? 0
  assertNonNegativeInteger(remainingGross, "remaining_gross_minor")
  const priorRedeemedGross = input.redeemed_gross_to_date_minor ?? 0
  assertNonNegativeInteger(priorRedeemedGross, "redeemed_gross_to_date_minor")

  const totalGross = input.net_minor + input.vat_minor
  if (remainingGross > totalGross) {
    throw new VoucherPostingInvariantError(
      `remaining_gross_minor (${remainingGross}) > brutto vouchera (${totalGross})`
    )
  }
  // Σ-enforcement (launcher MEDIUM): derecognition (redeemed-to-date + breakage
  // niewykorzystanego salda) NIE może przekroczyć liability brutto. Pełna
  // egzekucja należy do maszyny stanów (Story 3.x); tu minimalny guard.
  if (priorRedeemedGross + remainingGross > totalGross) {
    throw new VoucherPostingInvariantError(
      `derecognition > liability: redeemed-to-date (${priorRedeemedGross}) + remaining_gross_minor (${remainingGross}) = ${priorRedeemedGross + remainingGross} > brutto vouchera (${totalGross})`
    )
  }

  if (remainingGross === 0) {
    return {
      posted: false,
      reason: "EXPIRED bez niewykorzystanego salda: no-op księgowy (ADR-133 §Decyzja pkt 2b)",
    }
  }

  if (input.vat_classification === "SPV") {
    // SPV: VAT już rozpoznany przy emisji — breakage tylko z netto
    // niewykorzystanego salda (proporcjonalnie; brak konta suspense).
    const vatRemaining = proportionalVat(input.vat_minor, remainingGross, totalGross)
    const netRemaining = remainingGross - vatRemaining
    if (netRemaining === 0) {
      // Degenerate (np. salda w całości VAT-only): brak netto liability do
      // derecognition; VAT już rozpoznany przy emisji → no-op księgowy (LOW:
      // nie tworzymy linii zero/zero, która łamałaby assertBalanced).
      return {
        posted: false,
        reason:
          "SPV EXPIRED: netto niewykorzystanego salda = 0 (saldo w całości VAT, rozpoznany przy emisji): no-op księgowy",
      }
    }
    const lines: LedgerLine[] = [
      line(
        input,
        "breakage-liability",
        VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY,
        "debit",
        netRemaining,
        "SPV breakage: derecognition niewykorzystanej liability netto (VAT już rozpoznany przy emisji)"
      ),
      line(
        input,
        "breakage-recognise",
        VOUCHER_LEDGER_ACCOUNTS.BREAKAGE,
        "credit",
        netRemaining,
        "SPV breakage: rozpoznanie breakage z niewykorzystanego salda netto"
      ),
    ]
    return { posted: true, transaction: buildEnvelope(input, profile, "ENTITLEMENT_BREAKAGE", "EXPIRED", lines) }
  }

  // MPV unused = bez VAT (art. 73a): zawieszony VAT niewykorzystanego salda
  // wpada do breakage (NIE staje się output VAT). REZYDUALNY zawieszony VAT =
  // vat − recognized-to-date (kumulatywnie, VER-H1), dzięki czemu po pełnym
  // lifecycle (redeemy + breakage reszty) `vat:output:suspense` netuje do 0.
  // Samobilansujące: Dr liability(netto) + Dr suspense(vat) = Cr breakage(brutto).
  const recognizedToDate = proportionalVat(input.vat_minor, priorRedeemedGross, totalGross)
  const vatRemaining = input.vat_minor - recognizedToDate
  const netRemaining = remainingGross - vatRemaining
  if (netRemaining < 0) {
    // Niespójne wejście: rezydualny VAT > niewykorzystane brutto (np. prior
    // redeemed niespójny z remaining). Fail-closed zamiast linii ujemnej.
    throw new VoucherPostingInvariantError(
      `MPV breakage: rezydualny zawieszony VAT (${vatRemaining}) > niewykorzystane brutto (${remainingGross}) — niespójne redeemed-to-date/remaining`
    )
  }

  // LOW: pomijamy linie o kwocie 0 (zero/zero łamałoby assertBalanced).
  const lines: LedgerLine[] = []
  if (netRemaining > 0) {
    lines.push(
      line(
        input,
        "breakage-liability",
        VOUCHER_LEDGER_ACCOUNTS.CONTRACT_LIABILITY,
        "debit",
        netRemaining,
        "MPV breakage: derecognition niewykorzystanej liability netto"
      )
    )
  }
  if (vatRemaining > 0) {
    lines.push(
      line(
        input,
        "breakage-vat-suspense",
        VOUCHER_LEDGER_ACCOUNTS.VAT_OUTPUT_SUSPENSE,
        "debit",
        vatRemaining,
        "MPV unused: zdjęcie REZYDUALNEGO zawieszonego VAT bez rozpoznania output (art. 73a)"
      )
    )
  }
  lines.push(
    line(
      input,
      "breakage-recognise",
      VOUCHER_LEDGER_ACCOUNTS.BREAKAGE,
      "credit",
      remainingGross,
      "MPV breakage: rozpoznanie breakage z całego niewykorzystanego salda brutto (bez output VAT, art. 73a)"
    )
  )

  return { posted: true, transaction: buildEnvelope(input, profile, "ENTITLEMENT_BREAKAGE", "EXPIRED", lines) }
}

/**
 * Generuje double-entry posting `voucher_liability_only_v1` dla pojedynczego
 * eventu lifecycle. Pure function: bez I/O, bez stanu globalnego, append-only
 * (zwraca nowy wpis, nigdy nie mutuje istniejących). Każdy zwrócony wpis
 * przechodzi runtime posting guard (konta) + inwariant double-entry.
 *
 * KRYTYCZNE: ta funkcja dostarcza ZDOLNOŚĆ. Profil pozostaje runtime-disabled
 * (`VOUCHER_LIABILITY_ONLY_V1.runtime_enabled === false`) — wywołanie generatora
 * NIE aktywuje profilu w runtime ani nie podpina go do order-flow.
 */
export function generateVoucherPosting(
  input: VoucherPostingInput
): VoucherPostingResult {
  const profile = resolveVoucherPostingProfile(input.entitlement_type)
  switch (input.lifecycle_event) {
    case "ISSUED":
      return generateIssued(input, profile)
    case "REDEEMED":
      return generateRedeemed(input, profile)
    case "EXPIRED":
      return generateBreakage(input, profile)
    default: {
      const exhaustive: never = input.lifecycle_event
      throw new VoucherPostingInvariantError(
        `nieobsługiwany lifecycle_event: ${String(exhaustive)}`
      )
    }
  }
}
