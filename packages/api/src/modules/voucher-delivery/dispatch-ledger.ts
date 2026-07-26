/**
 * dispatch-ledger.ts — ledger dostarczeń `voucher_delivery_dispatch`
 * (Story 2.3, AC1 / AC2 / AC5; AD-7).
 *
 * ── Po co ledger, skoro emit `entitlement_state_changed` jest best-effort ────
 * AD-7 mówi wprost: emit jest post-commit best-effort (bez outboxa) — zgubiony
 * event to zgubiony mail. Ledger jest tym, co czyni reconciliation sweep
 * (Story 2.5) możliwym: sweep skanuje entitlementy ISSUED/ACTIVE bez wiersza
 * dispatch. **Ta story buduje TYLKO ledger — joba sweepa NIE.**
 *
 * ── Inwarianty ──────────────────────────────────────────────────────────────
 *  1. **Zero surowego PII.** Ledger poznaje odbiorcę wyłącznie jako
 *     `RecipientHash` (`sha256:<hex>`); typ jest brandowany, więc podanie
 *     surowego adresu to błąd kompilacji, a nie kwestia dyscypliny (D-70).
 *  2. **INSERT-first `ON CONFLICT DO NOTHING`**, nigdy „SELECT then INSERT" —
 *     dwa równoległe workery są bezpieczne na poziomie constraintu DB
 *     `UNIQUE (entitlement_id, template_key, recipient_hash)` (AC5).
 *  3. **Single-writer tranzycji.** `markSent`/`markFailed` aktualizują wiersz
 *     WYŁĄCZNIE gdy jest w `queued` (guard w `WHERE`), więc rezerwację może
 *     domknąć tylko ten, kto ją zdobył. `sent` blokuje bezwarunkowo, `failed`
 *     dopuszcza legalny retry (`failed → queued` z inkrementem `attempt_count`).
 *  4. **Append-only audit.** Każda tranzycja dopisuje wiersz do
 *     `voucher_delivery_dispatch_audit`; audit nigdy nie jest aktualizowany.
 *  5. **`gp.communication.delivery_state_changed.v1` NIE jest emitowany** —
 *     enum stanów jest zapożyczony, event nie (AD-7). Ten moduł nie ma i nie
 *     może mieć zależności od event busa.
 *
 * Relacja do zastanej `voucher_delivery_decision` (D-72): tabele są
 * ROZŁĄCZNE i żadna nie zastępuje drugiej. `voucher_delivery_decision` jest
 * append-only DECYZJĄ 5-stepowego kontraktu PII-consent (`consent_audit_id` →
 * `outcome`), keyowaną po zgodzie. `voucher_delivery_dispatch` jest LEDGEREM
 * IDEMPOTENCJI WYSYŁKI keyowanym po `(entitlement_id, template_key,
 * recipient_hash)` — odpowiada na pytanie „czy ten mail już poszedł", nie „jak
 * skończył się krok dostarczenia".
 */

import { randomUUID } from "node:crypto"

import { toKnexPositionalSql } from "../../lib/knex-positional-sql"
import {
  DELIVERY_DISPATCH_STATES,
  DISPATCH_STATES_ALLOWING_RETRY,
  DISPATCH_STATES_BLOCKING_RESEND,
  isDeliveryDispatchState,
  type DeliveryDispatchState,
} from "./delivery-state"
import { isRecipientHash, type RecipientHash } from "./recipient-hash"

export const VOUCHER_DELIVERY_DISPATCH_TABLE = "voucher_delivery_dispatch"
export const VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE =
  "voucher_delivery_dispatch_audit"

/**
 * Minimalny port SQL. Ledger nie zależy od Knexa jako typu, żeby testy
 * jednostkowe mogły podstawić atrapę bez kontenera i bez żywego Postgresa.
 *
 * **Dialekt jest częścią kontraktu portu:** implementacją produkcyjną jest
 * `ContainerRegistrationKeys.PG_CONNECTION`, czyli instancja **Knexa**, której
 * formatter rozumie WYŁĄCZNIE `?` (przy `$N` rzuca `Expected N bindings, saw 0`,
 * więc zapytanie nie dochodzi do bazy). Zapytania w tym pliku pisze się w
 * czytelnej składni `$N`, a `queryRows`/`appendAudit` konwertują je przez
 * `toKnexPositionalSql` — ten sam wzorzec, co zastane `withClaimTransaction`
 * (`api/store/vouchers/[code]/claim/helpers.ts`). Do `raw` NIGDY nie trafia `$N`.
 */
export interface DispatchLedgerSql {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>
}

export interface DispatchIdentity {
  entitlement_id: string
  template_key: string
  recipient_hash: RecipientHash
}

export interface ReserveDispatchInput extends DispatchIdentity {
  market_id: string
  flow_id: string
  locale: string
}

export type ReserveDispatchOutcome =
  /** Wiersz powstał teraz — wolno wysyłać. */
  | "reserved"
  /** Wiersz istniał w stanie retry-owalnym i został przejęty — wolno wysyłać. */
  | "retry_reserved"
  /** Mail już poszedł (`sent`/`delivered`/`degraded`) albo `dead_lettered` — NIE wysyłamy. */
  | "blocked"
  /** Rezerwację trzyma ktoś inny (`queued`) — NIE wysyłamy; dogania sweep 2.5. */
  | "in_flight"

export interface ReserveDispatchResult {
  outcome: ReserveDispatchOutcome
  dispatch_id: string | null
  status: DeliveryDispatchState | null
  attempt_count: number
  /**
   * ISO 8601 momentu wejścia w `queued` (R-2.3-L9). Wołający używa go do
   * rozpoznania PORZUCONEJ rezerwacji: `in_flight` starsze niż próg to nie
   * „wysyłka w locie", tylko wiersz po crashu — i musi być widoczny jako `warn`,
   * a nie `info`, dopóki sweep 2.5 nie istnieje.
   */
  queued_at: string | null
}

export interface DispatchRow {
  dispatch_id: string
  entitlement_id: string
  template_key: string
  recipient_hash: string
  market_id: string
  flow_id: string
  locale: string
  status: DeliveryDispatchState
  provider: string | null
  provider_message_id: string | null
  error_code: string | null
  attempt_count: number
  /** ISO 8601 — moment wejścia w `queued` (staleness porzuconych rezerwacji). */
  queued_at: string | null
}

export interface DispatchLedgerPort {
  reserveDispatch(input: ReserveDispatchInput): Promise<ReserveDispatchResult>
  markSent(input: {
    dispatch_id: string
    provider: string
    provider_message_id: string | null
  }): Promise<boolean>
  markFailed(input: {
    dispatch_id: string
    error_code: string
    provider?: string | null
  }): Promise<boolean>
  findByIdentity(identity: DispatchIdentity): Promise<DispatchRow | null>
}

export class DispatchLedgerError extends Error {
  readonly error_code: string

  constructor(message: string, errorCode: string) {
    super(message)
    this.name = "DispatchLedgerError"
    this.error_code = errorCode
  }
}

const SELECT_COLUMNS = `
  dispatch_id, entitlement_id, template_key, recipient_hash, market_id,
  flow_id, locale, status, provider, provider_message_id, error_code, attempt_count,
  queued_at
`

export interface PgDispatchLedgerOptions {
  now?: () => Date
  uuid?: () => string
}

export class PgDispatchLedger implements DispatchLedgerPort {
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(
    private readonly sql: DispatchLedgerSql,
    options: PgDispatchLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.uuid = options.uuid ?? (() => randomUUID())
  }

  /**
   * Rezerwuje wysyłkę: INSERT-first `ON CONFLICT DO NOTHING` ze `status='queued'`.
   *
   * Kolejność jest istotna: najpierw próba INSERT-u (atomowa na constraincie),
   * dopiero po konflikcie odczyt istniejącego wiersza. Odwrotna kolejność
   * („SELECT then INSERT") przepuszcza dwa równoległe workery przez okno między
   * odczytem a zapisem — dokładnie ten wyścig, przed którym broni AC5.
   */
  async reserveDispatch(
    input: ReserveDispatchInput,
  ): Promise<ReserveDispatchResult> {
    assertRecipientHash(input.recipient_hash)

    const dispatchId = this.uuid()
    const nowIso = this.now().toISOString()

    const inserted = await this.queryRows<DispatchRow>(
      `INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_TABLE} (
         dispatch_id, entitlement_id, template_key, recipient_hash, market_id,
         flow_id, locale, status, attempt_count, queued_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 1, $8, $9, $10)
       ON CONFLICT (entitlement_id, template_key, recipient_hash) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        dispatchId,
        input.entitlement_id,
        input.template_key,
        input.recipient_hash,
        input.market_id,
        input.flow_id,
        input.locale,
        nowIso,
        nowIso,
        nowIso,
      ],
    )

    if (inserted.length > 0) {
      const row = normalizeRow(inserted[0])
      await this.appendAudit(row, null, "queued", null, nowIso)
      return {
        outcome: "reserved",
        dispatch_id: row.dispatch_id,
        status: row.status,
        attempt_count: row.attempt_count,
        queued_at: row.queued_at,
      }
    }

    const existing = await this.findByIdentity(input)
    if (!existing) {
      // Konflikt bez wiersza = wiersz zniknął między INSERT-em a odczytem.
      // `findByIdentity` biegnie POZA transakcją, więc to okno jest normalne
      // (równoległy retry kasujący/przepisujący wiersz), nie tylko ręczna
      // interwencja. Nie zgadujemy — traktujemy jak „ktoś inny trzyma to teraz",
      // więc nie wysyłamy; dogonienie należy do sweepa 2.5.
      return {
        outcome: "in_flight",
        dispatch_id: null,
        status: null,
        attempt_count: 0,
        queued_at: null,
      }
    }

    if (DISPATCH_STATES_BLOCKING_RESEND.includes(existing.status)) {
      return {
        outcome: "blocked",
        dispatch_id: existing.dispatch_id,
        status: existing.status,
        attempt_count: existing.attempt_count,
        queued_at: existing.queued_at,
      }
    }

    if (existing.status === "dead_lettered") {
      // Terminalne z decyzji operatora — wznowienie wymaga świadomej akcji
      // (sweep/runbook 2.5), nie automatycznego retry z konsumpcji eventu.
      return {
        outcome: "blocked",
        dispatch_id: existing.dispatch_id,
        status: existing.status,
        attempt_count: existing.attempt_count,
        queued_at: existing.queued_at,
      }
    }

    if (DISPATCH_STATES_ALLOWING_RETRY.includes(existing.status)) {
      // Guard `status IN (...)` w WHERE czyni przejęcie retry ATOMOWYM:
      // dwa workery widzące ten sam `failed` dają dokładnie jedno UPDATE=1.
      //
      // Lista stanów jest rozwijana na JAWNE placeholdery, a nie bindowana jako
      // tablica do `ANY(?)`: formatter Knexa rozwija tablicę w `?, ?`, więc
      // `ANY` z bindingiem tablicowym dałby niepoprawny SQL (patrz guard
      // w `toKnexPositionalSql`).
      const retryStates = [...DISPATCH_STATES_ALLOWING_RETRY]
      const retryPlaceholders = retryStates
        .map((_state, index) => `$${index + 7}`)
        .join(", ")
      const reclaimed = await this.queryRows<DispatchRow>(
        `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
            SET status = 'queued',
                attempt_count = attempt_count + 1,
                error_code = NULL,
                failed_at = NULL,
                queued_at = $1,
                updated_at = $2,
                locale = $3,
                market_id = $4,
                flow_id = $5
          WHERE dispatch_id = $6
            AND status IN (${retryPlaceholders})
        RETURNING ${SELECT_COLUMNS}`,
        [
          nowIso,
          nowIso,
          input.locale,
          input.market_id,
          input.flow_id,
          existing.dispatch_id,
          ...retryStates,
        ],
      )

      if (reclaimed.length === 0) {
        // Wyścig — inny worker przejął retry pierwszy.
        return {
          outcome: "in_flight",
          dispatch_id: existing.dispatch_id,
          status: existing.status,
          attempt_count: existing.attempt_count,
          queued_at: existing.queued_at,
        }
      }

      const row = normalizeRow(reclaimed[0])
      await this.appendAudit(row, existing.status, "queued", null, nowIso)
      return {
        outcome: "retry_reserved",
        dispatch_id: row.dispatch_id,
        status: row.status,
        attempt_count: row.attempt_count,
        queued_at: row.queued_at,
      }
    }

    // `queued` — wysyłka w locie u innego workera. Świadomie NIE wysyłamy
    // drugi raz; porzucone `queued` (crash po INSERT) dogania sweep 2.5.
    return {
      outcome: "in_flight",
      dispatch_id: existing.dispatch_id,
      status: existing.status,
      attempt_count: existing.attempt_count,
      queued_at: existing.queued_at,
    }
  }

  async markSent(input: {
    dispatch_id: string
    provider: string
    provider_message_id: string | null
  }): Promise<boolean> {
    const nowIso = this.now().toISOString()
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET status = 'sent',
              provider = $1,
              provider_message_id = $2,
              error_code = NULL,
              sent_at = $3,
              updated_at = $4
        WHERE dispatch_id = $5
          AND status = 'queued'
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.provider,
        input.provider_message_id,
        nowIso,
        nowIso,
        input.dispatch_id,
      ],
    )

    if (rows.length === 0) return false

    const row = normalizeRow(rows[0])
    await this.appendAudit(row, "queued", "sent", null, nowIso)
    return true
  }

  async markFailed(input: {
    dispatch_id: string
    error_code: string
    provider?: string | null
  }): Promise<boolean> {
    const nowIso = this.now().toISOString()
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET status = 'failed',
              provider = COALESCE($1, provider),
              error_code = $2,
              failed_at = $3,
              updated_at = $4
        WHERE dispatch_id = $5
          AND status = 'queued'
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.provider ?? null,
        input.error_code,
        nowIso,
        nowIso,
        input.dispatch_id,
      ],
    )

    if (rows.length === 0) return false

    const row = normalizeRow(rows[0])
    await this.appendAudit(row, "queued", "failed", input.error_code, nowIso)
    return true
  }

  async findByIdentity(identity: DispatchIdentity): Promise<DispatchRow | null> {
    assertRecipientHash(identity.recipient_hash)
    const rows = await this.queryRows<DispatchRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}
        WHERE entitlement_id = $1
          AND template_key = $2
          AND recipient_hash = $3
        LIMIT 1`,
      [identity.entitlement_id, identity.template_key, identity.recipient_hash],
    )

    return rows.length > 0 ? normalizeRow(rows[0]) : null
  }

  /**
   * Append-only wpis audytowy. Zapisujemy WYŁĄCZNIE hash odbiorcy i kod błędu —
   * nigdy adresu ani treści odpowiedzi providera (D-70 / AC2).
   */
  private async appendAudit(
    row: DispatchRow,
    fromStatus: DeliveryDispatchState | null,
    toStatus: DeliveryDispatchState,
    errorCode: string | null,
    occurredAtIso: string,
  ): Promise<void> {
    await this.queryRows(
      `INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE} (
         dispatch_id, entitlement_id, template_key, recipient_hash, market_id,
         from_status, to_status, error_code, attempt_count, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.dispatch_id,
        row.entitlement_id,
        row.template_key,
        row.recipient_hash,
        row.market_id,
        fromStatus,
        toStatus,
        errorCode,
        row.attempt_count,
        occurredAtIso,
      ],
    )
  }

  /**
   * Jedyne miejsce, w którym ledger dotyka sterownika. Konwersja `$N`→`?` jest
   * tutaj, a nie w wywołaniach, żeby nie dało się jej pominąć w nowym zapytaniu.
   */
  private async queryRows<T>(
    sql: string,
    bindings: readonly unknown[],
  ): Promise<T[]> {
    const { text, bindings: knexBindings } = toKnexPositionalSql(sql, bindings)
    const result = await this.sql.raw(text, knexBindings)
    return extractRows<T>(result)
  }
}

/** Knex `raw` (pg) zwraca `{ rows }`; sterowniki testowe mogą zwrócić tablicę. */
export function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) return rows as T[]
  }
  return []
}

function normalizeRow(raw: unknown): DispatchRow {
  const record = (raw ?? {}) as Record<string, unknown>
  const status = record.status

  if (!isDeliveryDispatchState(status)) {
    throw new DispatchLedgerError(
      `Wiersz ${VOUCHER_DELIVERY_DISPATCH_TABLE} ma status spoza kontraktu: ` +
        `${String(status)} (dozwolone: ${DELIVERY_DISPATCH_STATES.join(", ")})`,
      "VOUCHER_DELIVERY_DISPATCH_STATUS_UNKNOWN",
    )
  }

  return {
    dispatch_id: String(record.dispatch_id ?? ""),
    entitlement_id: String(record.entitlement_id ?? ""),
    template_key: String(record.template_key ?? ""),
    recipient_hash: String(record.recipient_hash ?? ""),
    market_id: String(record.market_id ?? ""),
    flow_id: String(record.flow_id ?? ""),
    locale: String(record.locale ?? ""),
    status,
    provider: record.provider == null ? null : String(record.provider),
    provider_message_id:
      record.provider_message_id == null
        ? null
        : String(record.provider_message_id),
    error_code: record.error_code == null ? null : String(record.error_code),
    attempt_count: Number(record.attempt_count ?? 0),
    queued_at: normalizeTimestamp(record.queued_at),
  }
}

/** `timestamptz` wraca ze sterownika jako `Date`; ledger operuje na ISO 8601. */
function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  const text = String(value)
  return text.length > 0 ? text : null
}

function assertRecipientHash(value: string): void {
  // Runtime backstop dla wywołań z JS-a / `as any` — brandowany typ chroni tylko
  // ścieżkę kompilowaną. Bez tego surowy adres mógłby wejść do kolumny klucza.
  if (!isRecipientHash(value)) {
    throw new DispatchLedgerError(
      "recipient_hash musi być postaci sha256:<64 hex> — ledger nie przyjmuje surowego adresu e-mail (D-70)",
      "VOUCHER_DELIVERY_RECIPIENT_HASH_INVALID",
    )
  }
}
