/**
 * Idempotentny writer entitlement-ledgera — Story 2.6 (v1.11.0 Epic 2 / Wave 2).
 * Podstawa: ADR-139 D3 (idempotencja deterministyczna) + D1 (persystencja namespaced).
 *
 * Writer jest TRWAŁYM UJŚCIEM dla pure-fn `generateVoucherPosting()` (Story 2.3):
 * konsumuje gotowy `LedgerTransactionV1`, NIE reimplementuje posting/VAT logiki.
 * Persystuje go atomowo do namespaced tabel `voucher_ledger_transaction` /
 * `voucher_ledger_entry`, z dedup przez `ledger_posting_applied`.
 *
 * Idempotencja deterministyczna (ADR-139 D3):
 *   `transaction_id = sha256(entitlement_id ‖ lifecycle_event ‖ dyskryminator)`,
 *   dyskryminator jednoznaczny per-event:
 *     - ISSUED            → `entitlement_id`
 *     - REDEEMED          → `redemption_id` (multi-installment-safe; z payloadu)
 *     - EXPIRED/BREAKAGE  → `entitlement_id ‖ remaining_gross_snapshot`
 *
 * KOLEJNOŚĆ KRYTYCZNA: dedup-INSERT do `ledger_posting_applied`
 * (`ON CONFLICT DO NOTHING`) jest PIERWSZY w jednej hand-rolled DB-tx — PRZED
 * insertem `voucher_ledger_transaction` + `voucher_ledger_entry`. Bez tego
 * deterministyczne `transaction_id` / `ledger_entry_id` powodowałyby konflikt PK
 * (błąd), zamiast cichego no-op. Replay tego samego eventu ⇒ no-op (nie podwaja).
 * READ COMMITTED wystarcza. Konflikt dedup zachowuje PIERWSZY `occurred_at`
 * (nie nadpisujemy istniejącego wiersza applied).
 *
 * Podwójna bariera fail-closed (NIE reimplementacja — reuse z `posting-profile.ts`):
 *   - `assertPostingAccountsAllowed` — runtime posting guard `cash*` / allow-list;
 *   - `assertBalanced`               — inwariant double-entry (`debits == credits`);
 *   - dodatkowo currency consistency guard (3-literowy kod; spójność z oczekiwaną walutą).
 *
 * GRANICA (ADR-139 D5): writer dostarcza PERSYSTENCJĘ. NIE czyta ani NIE flipuje
 * `runtime_enabled` (zostaje `false`); gating order-flow (czy posting w ogóle
 * wywołać) należy do E3/E6. Writer wywołany — zapisuje; aktywacja jest gdzie indziej.
 */

import { createHash } from "node:crypto"
import {
  assertBalanced,
  assertPostingAccountsAllowed,
  VOUCHER_POSTING_PROFILE_ID,
  type LedgerTransactionV1,
  type VoucherLifecycleEvent,
} from "./posting-profile"

// ──────────────────────────────────────────────────────────────────────────
// Minimalne kontrakty PG (pozwalają wstrzyknąć mock w testach — wzorzec
// `service.ts` / `entitlement-expiry-sweeper.ts`).
// ──────────────────────────────────────────────────────────────────────────

export type LedgerPgClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): Promise<{ rows: T[]; rowCount?: number | null }>
  release?: () => void
}

export type LedgerPgPool = {
  connect(): Promise<LedgerPgClient>
}

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

export type VoucherLedgerWriteErrorKind =
  | "missing_discriminator"
  | "transaction_id_mismatch"
  | "currency_inconsistent"
  // L2: błędny `occurred_at` (ISO 8601) — taksonomia ROZDZIELONA od waluty
  // (zła data ≠ problem waluty; ułatwia diagnozę/telemetrię fail-closed).
  | "invalid_occurred_at"
  // L3: niespójna korelacja dyskryminator (req) ↔ transakcja (tx) — entry_type
  // i metadata.lifecycle_event MUSZĄ odpowiadać `req.lifecycle_event` (fail-closed).
  | "inconsistent_correlation"

export class VoucherLedgerWriteError extends Error {
  readonly kind: VoucherLedgerWriteErrorKind
  constructor(message: string, kind: VoucherLedgerWriteErrorKind) {
    super(message)
    this.name = "VoucherLedgerWriteError"
    this.kind = kind
  }
}

// ──────────────────────────────────────────────────────────────────────────
// transaction_id deterministyczny (ADR-139 D3)
// ──────────────────────────────────────────────────────────────────────────

/** Separator preimage — stała, by sha256 był stabilny i odporny na sklejenia. */
const ID_SEP = "‖" // ‖ (U+2016) — zgodnie z notacją ADR-139

export type LedgerLifecycleDiscriminator = {
  entitlement_id: string
  lifecycle_event: VoucherLifecycleEvent
  /** REDEEMED: wymagane (multi-installment-safe). */
  redemption_id?: string | null
  /** EXPIRED/BREAKAGE: wymagane (snapshot rezydualnego brutto na moment wygaśnięcia). */
  remaining_gross_snapshot?: number | null
}

/**
 * Zwraca dyskryminator (część zmienną preimage) dla danego eventu. Fail-closed:
 * brak wymaganego pola ⇒ rzuca (NIE generuje niejednoznacznego id).
 */
function discriminatorFor(d: LedgerLifecycleDiscriminator): string {
  switch (d.lifecycle_event) {
    case "ISSUED":
      return d.entitlement_id
    case "REDEEMED":
      if (!d.redemption_id) {
        throw new VoucherLedgerWriteError(
          "REDEEMED wymaga redemption_id do deterministycznego transaction_id (ADR-139 D3, multi-installment-safe)",
          "missing_discriminator"
        )
      }
      return d.redemption_id
    case "EXPIRED":
      if (d.remaining_gross_snapshot == null) {
        throw new VoucherLedgerWriteError(
          "EXPIRED/BREAKAGE wymaga remaining_gross_snapshot do deterministycznego transaction_id (ADR-139 D3)",
          "missing_discriminator"
        )
      }
      return `${d.entitlement_id}${ID_SEP}${d.remaining_gross_snapshot}`
    default: {
      const exhaustive: never = d.lifecycle_event
      throw new VoucherLedgerWriteError(
        `nieobsługiwany lifecycle_event: ${String(exhaustive)}`,
        "missing_discriminator"
      )
    }
  }
}

/**
 * `transaction_id = sha256(entitlement_id ‖ lifecycle_event ‖ dyskryminator)` (hex).
 * Deterministyczny: ten sam event → ten sam id → dedup PK → replay no-op (D3).
 */
export function deriveLedgerTransactionId(
  d: LedgerLifecycleDiscriminator
): string {
  const preimage = `${d.entitlement_id}${ID_SEP}${d.lifecycle_event}${ID_SEP}${discriminatorFor(
    d
  )}`
  return createHash("sha256").update(preimage, "utf8").digest("hex")
}

// ──────────────────────────────────────────────────────────────────────────
// Writer
// ──────────────────────────────────────────────────────────────────────────

export type VoucherLedgerWriteRequest = LedgerLifecycleDiscriminator & {
  /** Wynik `generateVoucherPosting()` (posted:true). transaction_id MUSI = deterministyczny. */
  transaction: LedgerTransactionV1
  /**
   * Opcjonalna oczekiwana waluta (np. waluta wcześniejszych wpisów tego
   * entitlementu) — currency consistency guard fail-closed jeśli różna.
   */
  expected_currency?: string
}

export type VoucherLedgerWriteResult = {
  transaction_id: string
  /** true = ten wpis fizycznie zapisany; false = dedup (replay) lub already-applied. */
  applied: boolean
  /** true = wpis już istniał (dedup ON CONFLICT) ⇒ no-op (idempotencja). */
  deduped: boolean
}

const ISO3 = /^[A-Z]{3}$/

/**
 * Currency consistency guard fail-closed (ADR-139 D3): waluta musi być
 * 3-literowym kodem (ISO-4217-kształtnym) i — jeśli podano `expected_currency` —
 * zgodna z nim. Niespójność ⇒ rzuca (NIE zapisuje "po cichu" wpisu w innej walucie).
 */
function assertCurrencyConsistent(currency: string, expected?: string): void {
  if (!ISO3.test(currency)) {
    throw new VoucherLedgerWriteError(
      `currency '${currency}' nie jest 3-literowym kodem ISO-4217 (fail-closed, ADR-139 D3)`,
      "currency_inconsistent"
    )
  }
  if (expected !== undefined && expected !== currency) {
    throw new VoucherLedgerWriteError(
      `currency '${currency}' != oczekiwanej '${expected}' (currency consistency guard fail-closed, ADR-139 D3)`,
      "currency_inconsistent"
    )
  }
}

function toEpochMs(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new VoucherLedgerWriteError(
      `occurred_at '${iso}' nie jest poprawnym ISO 8601 datetime (fail-closed)`,
      "invalid_occurred_at"
    )
  }
  return ms
}

/**
 * Oczekiwane `entry_type` + dozwolone `metadata.lifecycle_event` per
 * `req.lifecycle_event` (dyskryminator). Generator (Story 2.3) emituje gruboziarniste
 * lifecycle (ISSUED/REDEEMED/EXPIRED); golden-matrix (D4) używa granularnych
 * REDEEMED_*. Korelacja entry_type↔lifecycle MUSI być spójna (L3, fail-closed) —
 * sam `transaction_id === expectedId` jej NIE egzekwuje (hostile/buggy caller mógłby
 * policzyć id z `req`, a dostarczyć niespójny entry_type/metadata).
 */
const CORRELATION_BY_LIFECYCLE: Readonly<
  Record<VoucherLifecycleEvent, { entry_type: string; metadata_lifecycle: ReadonlySet<string> }>
> = {
  ISSUED: { entry_type: "ENTITLEMENT_ISSUED", metadata_lifecycle: new Set(["ISSUED"]) },
  REDEEMED: {
    entry_type: "ENTITLEMENT_REDEEMED",
    metadata_lifecycle: new Set(["REDEEMED", "REDEEMED_PARTIAL", "REDEEMED_FULL"]),
  },
  // EXPIRED unused → BREAKAGE (ADR-133 §Decyzja pkt 2b): entry_type ENTITLEMENT_BREAKAGE.
  EXPIRED: { entry_type: "ENTITLEMENT_BREAKAGE", metadata_lifecycle: new Set(["EXPIRED"]) },
}

/**
 * Egzekwuje korelację `req.lifecycle_event` ↔ `tx.entry_type` ↔
 * `tx.metadata.lifecycle_event` (L3, fail-closed, PRZED BEGIN). Niespójność ⇒ rzuca
 * (NIE zapisuje pary, której każda kolumna z osobna spełnia swój CHECK, ale których
 * korelacja jest błędna — np. ENTITLEMENT_ISSUED z lifecycle_event REDEEMED).
 */
function assertLifecycleCorrelation(req: LedgerLifecycleDiscriminator, tx: LedgerTransactionV1): void {
  const expected = CORRELATION_BY_LIFECYCLE[req.lifecycle_event]
  if (tx.entry_type !== expected.entry_type) {
    throw new VoucherLedgerWriteError(
      `entry_type '${tx.entry_type}' niespójny z lifecycle_event '${req.lifecycle_event}' ` +
        `(oczekiwano '${expected.entry_type}', L3 korelacja fail-closed)`,
      "inconsistent_correlation"
    )
  }
  const metaLifecycle = tx.metadata.lifecycle_event
  if (!expected.metadata_lifecycle.has(metaLifecycle)) {
    throw new VoucherLedgerWriteError(
      `metadata.lifecycle_event '${metaLifecycle}' niespójny z req.lifecycle_event ` +
        `'${req.lifecycle_event}' (dozwolone: ${[...expected.metadata_lifecycle].join("/")}; L3 korelacja fail-closed)`,
      "inconsistent_correlation"
    )
  }
}

export class VoucherLedgerWriter {
  constructor(private readonly pool: LedgerPgPool) {}

  /**
   * Persystuje `LedgerTransactionV1` atomowo i idempotentnie. Replay tego samego
   * eventu ⇒ `{ applied:false, deduped:true }` (no-op, nie podwaja).
   *
   * Przepływ jednej hand-rolled DB-tx (READ COMMITTED):
   *   1. weryfikacja: deterministyczny transaction_id == transaction.transaction_id,
   *      podwójna bariera (guard kont + double-entry), currency guard — PRZED BEGIN;
   *   2. BEGIN;
   *   3. dedup-INSERT ledger_posting_applied ON CONFLICT DO NOTHING — PIERWSZY;
   *      rowCount 0 ⇒ replay ⇒ COMMIT + no-op (zachowuje pierwszy occurred_at);
   *   4. INSERT voucher_ledger_transaction + linie voucher_ledger_entry;
   *   5. COMMIT.
   */
  async write(
    req: VoucherLedgerWriteRequest
  ): Promise<VoucherLedgerWriteResult> {
    const tx = req.transaction

    // (1) Deterministyczny id + spójność z dostarczoną transakcją (fail-closed).
    const expectedId = deriveLedgerTransactionId(req)
    if (tx.transaction_id !== expectedId) {
      throw new VoucherLedgerWriteError(
        `transaction_id '${tx.transaction_id}' != deterministyczny '${expectedId}' ` +
          `(generateVoucherPosting MUSI dostać deterministyczny transaction_id, ADR-139 D3)`,
        "transaction_id_mismatch"
      )
    }
    // (L3) Korelacja dyskryminator (req) ↔ entry_type/metadata.lifecycle_event (tx)
    // — PRZED BEGIN, fail-closed (transaction_id===expectedId jej NIE egzekwuje).
    assertLifecycleCorrelation(req, tx)
    // Podwójna bariera fail-closed (reuse Story 2.3 — NIE reimplementacja).
    assertPostingAccountsAllowed(tx.lines)
    assertBalanced(tx.lines)
    // Currency consistency guard.
    assertCurrencyConsistent(tx.currency, req.expected_currency)

    const occurredAtMs = toEpochMs(tx.occurred_at)
    const nowMs = Date.now()
    const marketId = tx.scope.market_id
    const lifecycleEvent = tx.metadata.lifecycle_event

    const client = await this.pool.connect()
    let committed = false
    try {
      await client.query("BEGIN")

      // (3) dedup-INSERT PIERWSZY. ON CONFLICT DO NOTHING → rowCount 0 = replay.
      const dedup = await client.query(
        `INSERT INTO ledger_posting_applied
           (transaction_id, entitlement_id, lifecycle_event, market_id, occurred_at, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [
          expectedId,
          req.entitlement_id,
          lifecycleEvent,
          marketId,
          occurredAtMs,
          nowMs,
        ]
      )

      if ((dedup.rowCount ?? 0) === 0) {
        // Replay: wpis już zaksięgowany. NIE wstawiamy transaction/entries
        // (deterministyczne id i tak dałyby konflikt PK). Zachowujemy pierwszy
        // occurred_at (nie aktualizujemy istniejącego applied). No-op.
        await client.query("COMMIT")
        committed = true
        return { transaction_id: expectedId, applied: false, deduped: true }
      }

      // (4) nagłówek transakcji.
      await client.query(
        `INSERT INTO voucher_ledger_transaction
           (transaction_id, entry_type, posting_profile, vat_classification,
            lifecycle_event, instance_id, market_id, vendor_id, location_id,
            currency, occurred_at, created_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          expectedId,
          tx.entry_type,
          tx.metadata.posting_profile ?? VOUCHER_POSTING_PROFILE_ID,
          tx.metadata.vat_classification,
          lifecycleEvent,
          tx.scope.instance_id,
          marketId,
          tx.scope.vendor_id ?? null,
          tx.scope.location_id ?? null,
          tx.currency,
          occurredAtMs,
          nowMs,
          JSON.stringify(tx.metadata),
        ]
      )

      // (4) linie double-entry.
      for (const ln of tx.lines) {
        await client.query(
          `INSERT INTO voucher_ledger_entry
             (ledger_entry_id, transaction_id, account, debit_minor, credit_minor,
              market_id, occurred_at, created_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ln.ledger_entry_id,
            expectedId,
            ln.account,
            ln.debit_minor,
            ln.credit_minor,
            marketId,
            occurredAtMs,
            nowMs,
            ln.metadata ? JSON.stringify(ln.metadata) : null,
          ]
        )
      }

      await client.query("COMMIT")
      committed = true
      return { transaction_id: expectedId, applied: true, deduped: false }
    } catch (err) {
      if (!committed) {
        await client.query("ROLLBACK")
      }
      throw err
    } finally {
      client.release?.()
    }
  }
}
