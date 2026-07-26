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
 * Story 2.5 dokłada tutaj `DeliveryGapScanPort`: READ-ONLY skan luk, licznik
 * granicy H1 oraz JEDNO warunkowe przejęcie porzuconej rezerwacji `queued`
 * (`queued → failed` z guardem `status='queued' AND queued_at < próg`). Sweep
 * nie zyskuje przez to drugiej ścieżki wysyłki — dosyłką dalej zajmuje się
 * `reserveDispatch` wołany z handlera subscribera.
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
 * Tabela źródłowa skanu luk (Story 2.5). Ledger czyta z niej WYŁĄCZNIE
 * `id`/`market_id`/`state`/`created_at` i nigdy do niej nie pisze — właścicielem
 * `entitlement_instance` jest moduł voucher, nie voucher-delivery.
 */
export const ENTITLEMENT_INSTANCE_TABLE = "entitlement_instance"

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

// ──────────────────────────────────────────────────────────────────────────
// Story 2.5 — skan luk (READ-ONLY) + przejęcie porzuconej rezerwacji `queued`.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Kandydat sweepa: para (entitlement, oczekiwany `template_key`), dla której
 * ledger NIE potwierdza domkniętej wysyłki. `dispatch_*` są `null`, gdy wiersza
 * nie ma w ogóle (zgubiony event — dokładnie przypadek z AD-7).
 */
export interface DeliveryGapCandidate {
  entitlement_id: string
  market_id: string | null
  /** Stan `entitlement_instance` w momencie skanu (ISSUED albo ACTIVE). */
  entitlement_state: string
  template_key: string
  dispatch_id: string | null
  dispatch_status: DeliveryDispatchState | null
  queued_at: string | null
  attempt_count: number
}

export interface ScanDeliveryGapsInput {
  /**
   * Zbiór OCZEKIWANYCH szablonów — parametr, nie literał, żeby dołożenie
   * kolejnego klucza (`voucher_handoff_link`, Story 2.4) nie wymagało zmiany
   * zapytania. Pusty zbiór jest błędem wołającego, nie „skanuj wszystko".
   */
  template_keys: readonly string[]
  /** Stany `entitlement_instance`, w których wysyłka jest jeszcze oczekiwana. */
  source_states: readonly string[]
  /** ISO 8601 — entitlementy MŁODSZE są pomijane (grace-window sweepa). */
  created_before: string
  /** ISO 8601 — `queued` starsze = rezerwacja PORZUCONA, nie wysyłka w locie. */
  stale_queued_before: string
  /** Bounded batch: maksymalna liczba wierszy na przebieg. */
  limit: number
}

export interface DeliveryGapScanResult {
  candidates: DeliveryGapCandidate[]
  /**
   * `true`, gdy skan zwrócił dokładnie `limit` wierszy — reszta zaległości
   * istnieje i zostanie dogoniona w kolejnym przebiegu. Wołający MUSI to
   * zalogować (zero cichego truncate).
   */
  truncated: boolean
}

export interface CountGapsBeyondSourceStatesInput {
  template_keys: readonly string[]
  source_states: readonly string[]
  created_before: string
  /** ISO 8601 — dolna granica okna (skan bez niej byłby pełnym seq-scanem). */
  created_after: string
}

/**
 * Port skanu luk (Story 2.5). Rozdzielony od `DispatchLedgerPort`, bo sweep
 * potrzebuje obu, a subscriber WYŁĄCZNIE tego drugiego — dzięki temu ścieżka
 * subscribera nie zyskuje przypadkiem dostępu do zapytań skanujących.
 */
export interface DeliveryGapScanPort {
  scanDeliveryGaps(input: ScanDeliveryGapsInput): Promise<DeliveryGapScanResult>
  /**
   * Licznik OBSERWOWALNOŚCI granicy H1 (patrz `voucher-ledger-reconciliation`):
   * entitlementy, które wyszły już poza `source_states`, a nie mają ŻADNEGO
   * wiersza dispatch. Sweep ich NIE dosyła (stan poza matrycą AD-7) — ale
   * milczenie o nich byłoby fail-open, więc są liczone.
   */
  countGapsBeyondSourceStates(
    input: CountGapsBeyondSourceStatesInput,
  ): Promise<number>
  /**
   * Przejmuje PORZUCONĄ rezerwację `queued` (D3): jedno warunkowe UPDATE
   * `queued → failed` z guardem `status='queued' AND queued_at < …`. NIE drugi
   * INSERT i NIE nowy wiersz — po tym przejściu legalną ścieżką dosyłki jest
   * zastany retry z 2.3 (`failed → queued` przez `reserveDispatch`).
   */
  abandonStaleQueued(input: {
    dispatch_id: string
    stale_queued_before: string
    error_code: string
  }): Promise<boolean>
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

export class PgDispatchLedger
  implements DispatchLedgerPort, DeliveryGapScanPort
{
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

  // ────────────────────────────────────────────────────────────────────────
  // Story 2.5 — skan luk (READ-ONLY) + przejęcie porzuconego `queued`.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Skan luk: pary (entitlement w `source_states`, oczekiwany `template_key`),
   * dla których ledger NIE potwierdza domkniętej wysyłki.
   *
   * Zapytanie jest READ-ONLY. `CROSS JOIN (VALUES …)` rozwija zbiór oczekiwanych
   * szablonów po stronie SQL-a, więc dołożenie kolejnego klucza nie zmienia
   * kształtu zapytania. Lista wartości jest rozwijana na JAWNE placeholdery —
   * binding tablicowy jest w tym dialekcie błędem (`toKnexPositionalSql`).
   *
   * Trzy rozłączne kształty luki w `WHERE`:
   *   1. `d.dispatch_id IS NULL` — wiersza nie ma (zgubiony event, AD-7);
   *   2. `queued` starsze niż próg — rezerwacja porzucona po crashu (D3);
   *   3. `failed`/`retrying` — legalny retry wg semantyki 2.3.
   * `sent`/`delivered`/`degraded` i `dead_lettered` NIE pasują do żadnego z nich,
   * więc nie wracają ze skanu (blokada jest w SQL-u i powtórnie w ledgerze).
   *
   * Sortowanie jest deterministyczne (`created_at, id, template_key`), żeby
   * bounded batch dogonił zaległości od najstarszych, a nie losowo.
   */
  async scanDeliveryGaps(
    input: ScanDeliveryGapsInput,
  ): Promise<DeliveryGapScanResult> {
    if (input.template_keys.length === 0) {
      throw new DispatchLedgerError(
        "scanDeliveryGaps wymaga niepustego zbioru template_keys — pusty zbiór " +
          "nie znaczy „skanuj wszystko”",
        "VOUCHER_DELIVERY_GAP_SCAN_TEMPLATE_KEYS_EMPTY",
      )
    }
    if (input.source_states.length === 0) {
      throw new DispatchLedgerError(
        "scanDeliveryGaps wymaga niepustego zbioru source_states",
        "VOUCHER_DELIVERY_GAP_SCAN_SOURCE_STATES_EMPTY",
      )
    }
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new DispatchLedgerError(
        "scanDeliveryGaps wymaga limitu >= 1 — skan bez limitu może wystrzelić " +
          "nieograniczoną liczbę wysyłek",
        "VOUCHER_DELIVERY_GAP_SCAN_LIMIT_INVALID",
      )
    }

    const templateKeys = [...input.template_keys]
    const sourceStates = [...input.source_states]
    const retryStates = [...DISPATCH_STATES_ALLOWING_RETRY]

    // Numeracja `$N` jest rosnąca wzdłuż tekstu zapytania — kolejność bindingów
    // to: szablony, stany źródłowe, created_before, stale_queued_before,
    // stany retry, limit.
    let position = 0
    const templatePlaceholders = templateKeys
      .map(() => `($${++position})`)
      .join(", ")
    const statePlaceholders = sourceStates.map(() => `$${++position}`).join(", ")
    const createdBeforePlaceholder = `$${++position}`
    const staleQueuedPlaceholder = `$${++position}`
    const retryPlaceholders = retryStates.map(() => `$${++position}`).join(", ")
    const limitPlaceholder = `$${++position}`

    const rows = await this.queryRows<Record<string, unknown>>(
      `SELECT e.id            AS entitlement_id,
              e.market_id     AS market_id,
              e.state         AS entitlement_state,
              t.template_key  AS template_key,
              d.dispatch_id   AS dispatch_id,
              d.status        AS dispatch_status,
              d.queued_at     AS queued_at,
              d.attempt_count AS attempt_count
         FROM ${ENTITLEMENT_INSTANCE_TABLE} e
         CROSS JOIN (VALUES ${templatePlaceholders}) AS t(template_key)
         LEFT JOIN ${VOUCHER_DELIVERY_DISPATCH_TABLE} d
                ON d.entitlement_id = e.id
               AND d.template_key = t.template_key
        WHERE e.state IN (${statePlaceholders})
          AND e.created_at < ${createdBeforePlaceholder}
          AND (
                d.dispatch_id IS NULL
             OR (d.status = 'queued' AND d.queued_at < ${staleQueuedPlaceholder})
             OR d.status IN (${retryPlaceholders})
          )
        ORDER BY e.created_at ASC, e.id ASC, t.template_key ASC
        LIMIT ${limitPlaceholder}`,
      [
        ...templateKeys,
        ...sourceStates,
        input.created_before,
        input.stale_queued_before,
        ...retryStates,
        input.limit,
      ],
    )

    const candidates = rows.map((row) => normalizeGapCandidate(row))

    return { candidates, truncated: candidates.length >= input.limit }
  }

  /**
   * Licznik granicy H1: entitlementy POZA `source_states` bez ŻADNEGO wiersza
   * dispatch dla oczekiwanych szablonów. Sweep ich nie dosyła (stan poza matrycą
   * AD-7), ale liczy — inaczej „skan po bieżącym stanie" byłby cicho fail-open.
   * Okno `created_after` jest obowiązkowe: COUNT bez niego rósłby z całą historią.
   */
  async countGapsBeyondSourceStates(
    input: CountGapsBeyondSourceStatesInput,
  ): Promise<number> {
    if (input.template_keys.length === 0 || input.source_states.length === 0) {
      throw new DispatchLedgerError(
        "countGapsBeyondSourceStates wymaga niepustych zbiorów template_keys " +
          "i source_states",
        "VOUCHER_DELIVERY_GAP_COUNT_INPUT_EMPTY",
      )
    }

    const sourceStates = [...input.source_states]
    const templateKeys = [...input.template_keys]

    let position = 0
    const statePlaceholders = sourceStates.map(() => `$${++position}`).join(", ")
    const createdBeforePlaceholder = `$${++position}`
    const createdAfterPlaceholder = `$${++position}`
    const templatePlaceholders = templateKeys
      .map(() => `$${++position}`)
      .join(", ")

    const rows = await this.queryRows<{ gap_count: number | string }>(
      `SELECT COUNT(*)::int AS gap_count
         FROM ${ENTITLEMENT_INSTANCE_TABLE} e
        WHERE e.state NOT IN (${statePlaceholders})
          AND e.created_at < ${createdBeforePlaceholder}
          AND e.created_at >= ${createdAfterPlaceholder}
          AND NOT EXISTS (
                SELECT 1
                  FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE} d
                 WHERE d.entitlement_id = e.id
                   AND d.template_key IN (${templatePlaceholders})
              )`,
      [
        ...sourceStates,
        input.created_before,
        input.created_after,
        ...templateKeys,
      ],
    )

    return rows.length > 0 ? Number(rows[0].gap_count ?? 0) : 0
  }

  /**
   * D3 — przejęcie PORZUCONEJ rezerwacji `queued`.
   *
   * Jedno warunkowe UPDATE `queued → failed` z podwójnym guardem
   * (`status='queued'` ORAZ `queued_at < próg`), więc:
   *   - dwa równoległe sweepy dają dokładnie jedno przejęcie (UPDATE=1);
   *   - rezerwacja młodsza niż próg (wysyłka REALNIE w locie) nie jest ruszana,
   *     nawet jeśli wołający pomylił się w wyborze wiersza;
   *   - nie powstaje drugi wiersz ani drugi INSERT — dosyłką zajmuje się zastany
   *     retry z 2.3 (`failed → queued` przez `reserveDispatch`).
   * `error_code` jest wymagany przez CHECK migracji (`status='failed'` ⇒ kod).
   */
  async abandonStaleQueued(input: {
    dispatch_id: string
    stale_queued_before: string
    error_code: string
  }): Promise<boolean> {
    const nowIso = this.now().toISOString()
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET status = 'failed',
              error_code = $1,
              failed_at = $2,
              updated_at = $3
        WHERE dispatch_id = $4
          AND status = 'queued'
          AND queued_at < $5
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.error_code,
        nowIso,
        nowIso,
        input.dispatch_id,
        input.stale_queued_before,
      ],
    )

    if (rows.length === 0) return false

    const row = normalizeRow(rows[0])
    await this.appendAudit(row, "queued", "failed", input.error_code, nowIso)
    return true
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

/**
 * Story 2.5 — normalizacja wiersza skanu. `dispatch_*` są NULL-owalne (LEFT
 * JOIN), ale gdy status jest obecny, MUSI należeć do kontraktu: nieznany status
 * jest fail-loud, a nie cichym „to chyba luka" (dosyłka na podstawie stanu,
 * którego nie rozumiemy, to potencjalny duplikat maila).
 */
function normalizeGapCandidate(raw: unknown): DeliveryGapCandidate {
  const record = (raw ?? {}) as Record<string, unknown>
  const status = record.dispatch_status

  if (status != null && !isDeliveryDispatchState(status)) {
    throw new DispatchLedgerError(
      `Skan luk zwrócił wiersz ze statusem spoza kontraktu: ${String(status)} ` +
        `(dozwolone: ${DELIVERY_DISPATCH_STATES.join(", ")})`,
      "VOUCHER_DELIVERY_DISPATCH_STATUS_UNKNOWN",
    )
  }

  return {
    entitlement_id: String(record.entitlement_id ?? ""),
    market_id: record.market_id == null ? null : String(record.market_id),
    entitlement_state: String(record.entitlement_state ?? ""),
    template_key: String(record.template_key ?? ""),
    dispatch_id:
      record.dispatch_id == null ? null : String(record.dispatch_id),
    dispatch_status: status == null ? null : status,
    queued_at: normalizeTimestamp(record.queued_at),
    attempt_count: Number(record.attempt_count ?? 0),
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
