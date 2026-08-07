/**
 * messaging-dispatch-barrier — TRWAŁA bariera idempotencji wysyłki.
 *
 * v1.15.0 Story 4.1 (FR-9a, FR-9b, AD-23, NFR-1, NFR-4, ADR-196).
 *
 * Implementacja portu `DispatchIdempotencyBarrier` z `@gp/messaging`. Port
 * mieszka tam, bo gateway musi go znać; implementacja mieszka TUTAJ, bo tutaj
 * jest sterownik bazy. `@gp/messaging` jest provider-neutralny i nie ma
 * zależności od Knexa ani Medusy — i ma jej nie mieć (ADR-196 §D1).
 *
 * ── Bariera jest JEDNYM stwierdzeniem wykonywalnym (AD-23) ─────────────────
 * `claim` wysyła do bazy DOKŁADNIE jedno `INSERT … ON CONFLICT … DO UPDATE …
 * WHERE …` i czyta werdykt z LICZBY ZWRÓCONYCH WIERSZY. Nie ma poprzedzającego
 * `SELECT`. Trzy przypadki rozstrzyga sama baza:
 *
 *   1. klucza nie ma            → `INSERT` wchodzi     → 1 wiersz → ZAJĘTE
 *   2. klucz jest, ale WYGASŁ   → predykat prawdziwy,
 *                                 `DO UPDATE` odnawia  → 1 wiersz → ZAJĘTE
 *   3. klucz jest i żyje ALBO
 *      jest bezterminowy        → predykat fałszywy    → 0 wierszy → ZABLOKOWANE
 *
 * Odczyt wyniku poprzedniego przebiegu (`findSettledDispatch`) następuje
 * DOPIERO PO werdykcie i go nie zmienia — służy wyłącznie temu, żeby ponowienie
 * dostało tę samą odpowiedź zamiast błędu.
 *
 * ── Bezterminowość jest własnością DANYCH ─────────────────────────────────
 * `expires_at IS NULL` znaczy „nigdy nie wygasa". Predykat nie ma na to osobnej
 * gałęzi: `NULL <= $now` nigdy nie jest prawdą, a jawny warunek
 * `expires_at IS NOT NULL` czyni intencję czytelną zamiast polegać na
 * trójwartościowej logice po cichu.
 *
 * @module messaging-dispatch-barrier
 */
import {
  MESSAGING_BARRIER_UNAVAILABLE,
  MESSAGING_DISPATCH_BARRIER_TABLE,
  MessagingProviderError,
  type BarrierClaim,
  type BarrierClaimInput,
  type BarrierSettleInput,
  type DispatchIdempotencyBarrier,
  type NotificationDispatch,
} from "@gp/messaging"

import { toKnexPositionalSql } from "../knex-positional-sql"
import {
  requireMarketContext,
  type SystemExecutionOrigin,
} from "../system-market-context"

export { MESSAGING_DISPATCH_BARRIER_TABLE }

/** Minimalny kontrakt, jakiego bariera potrzebuje od `PG_CONNECTION` (instancja Knexa). */
export type DispatchBarrierDb = {
  raw: (sql: string, bindings?: readonly unknown[]) => Promise<unknown>
}

/**
 * Okno zajęcia `in_flight`.
 *
 * WYPROWADZENIE: to jest ta sama liczba, którą ledger dostarczeń nazywa progiem
 * PORZUCONEJ REZERWACJI (`STALE_QUEUED_THRESHOLD_MS`,
 * `subscribers/voucher-purchase-delivery.ts`, reużywana przez sweep 2.5 jako
 * `SWEEP_STALE_QUEUED_MS`). Oba mechanizmy odpowiadają na to samo pytanie —
 * „od kiedy uznajemy, że proces, który zajął zasób, już nie wróci".
 *
 * Ta stała jest tu POWTÓRZONA, a nie zaimportowana z subscribera, żeby lib
 * bariery nie ciągnął za sobą modułu subscribera (i całego jego drzewa
 * zależności) na gorącą ścieżkę wysyłki. Rozjazd NIE jest możliwy po cichu:
 * `__tests__/lib/messaging-dispatch-barrier.unit.spec.ts` importuje
 * OBIE i pęka, gdy którakolwiek zmieni się osobno.
 */
export const BARRIER_IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000

/**
 * Okno bariery dla porażki NIEJEDNOZNACZNEJ — wyprowadzone z HORYZONTU PONOWIEŃ.
 *
 * Pytanie: jak długo to samo zdarzenie może LEGALNIE wrócić i spowodować drugi
 * mail? Składniki są ZMIERZONE w kodzie sweepa, nie założone:
 *
 *   1. `SWEEP_GAP_LOOKBACK_MS = 7 dni` — okno, w którym sweep w ogóle schodzi
 *      po luki (entitlement sprzed trzech dni jest wciąż kandydatem).
 *   2. `SWEEP_ENTITLEMENT_GRACE_MS = 30 min` — próg wieku kandydata.
 *   3. `SWEEP_MAX_ATTEMPT_COUNT (5) × cadence (15 min) = 75 min` — budżet prób.
 *
 * Suma: 7 dni + 105 min, zaokrąglone w GÓRĘ do 8 dni. Okno DŁUŻSZE kosztuje
 * wyłącznie miejsce w tabeli (higiena); okno KRÓTSZE kosztuje DRUGI MAIL.
 *
 * DLACZEGO NIE 24 h (wartość starej mapy): dostawa zakończona timeoutem-after-send
 * przestawałaby blokować po dobie, a sweep ma prawo wrócić po nią jeszcze przez
 * sześć kolejnych dni. Dla mapy, która i tak ginęła przy restarcie procesu,
 * 24 h było bez znaczenia; dla magazynu trwałego jest różnicą między jednym
 * a dwoma mailami.
 *
 * Parity ze stałymi sweepa jest egzekwowana tym samym testem, co wyżej.
 */
export const BARRIER_AMBIGUOUS_WINDOW_MS = 8 * 24 * 60 * 60 * 1000

/** Odczytuje wiersze `RETURNING` niezależnie od kształtu oddanego przez sterownik. */
function returnedRows(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result
  }
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) {
      return rows
    }
  }
  return []
}

/**
 * `jsonb` wraca z `pg` już zdeserializowany, ale przez inne warstwy potrafi
 * przyjść jako string. Nierozpoznany kształt traktujemy jak BRAK wyniku —
 * to jest strona bezpieczna: wołający dostanie „w locie", a nie zgodę na wysyłkę.
 */
function parseDispatch(value: unknown): NotificationDispatch | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as NotificationDispatch
    } catch {
      return null
    }
  }
  if (typeof value === "object") {
    return value as NotificationDispatch
  }
  return null
}

export class PgDispatchIdempotencyBarrier implements DispatchIdempotencyBarrier {
  constructor(private readonly db: DispatchBarrierDb) {}

  async claim(input: BarrierClaimInput): Promise<BarrierClaim> {
    const nowIso = input.now.toISOString()
    const expiresIso = new Date(
      input.now.getTime() + input.in_flight_window_ms,
    ).toISOString()

    // JEDNO stwierdzenie. Werdykt = liczba wierszy z `RETURNING`.
    // `WHERE` na `DO UPDATE` to CAŁE egzekwowanie okna.
    const { text, bindings } = toKnexPositionalSql(
      `INSERT INTO ${MESSAGING_DISPATCH_BARRIER_TABLE}
         (barrier_key, state, dispatch, expires_at, claim_token, claim_count, created_at, updated_at)
       VALUES ($1, 'in_flight', NULL, $2, $4, 1, $3, $3)
       ON CONFLICT (barrier_key) DO UPDATE
         SET state       = 'in_flight',
             dispatch    = NULL,
             expires_at  = EXCLUDED.expires_at,
             claim_token = EXCLUDED.claim_token,
             claim_count = ${MESSAGING_DISPATCH_BARRIER_TABLE}.claim_count + 1,
             updated_at  = EXCLUDED.updated_at
       WHERE ${MESSAGING_DISPATCH_BARRIER_TABLE}.expires_at IS NOT NULL
         AND ${MESSAGING_DISPATCH_BARRIER_TABLE}.expires_at <= $3
       RETURNING barrier_key`,
      [input.barrier_key, expiresIso, nowIso, input.claim_token],
    )

    const claimed = returnedRows(await this.db.raw(text, bindings)).length > 0
    if (claimed) {
      // Wiersz niesie teraz token TEGO przebiegu (`EXCLUDED.claim_token` na
      // obu gałęziach), więc domknięcie wołającego trafi we własne zajęcie.
      return { outcome: "claimed", dispatch: null }
    }

    // PO werdykcie: odtworzenie wyniku poprzedniego przebiegu. `null` znaczy
    // „inny proces jest TERAZ w locie" — nigdy „nie ma bariery".
    return {
      outcome: "blocked",
      dispatch: await this.findSettledDispatch(input.barrier_key),
    }
  }

  /**
   * Domknięcie WŁASNEGO zajęcia.
   *
   * Warunek `claim_token = $5` jest istotny (R-4.1-M3): bez niego spóźnione
   * domknięcie procesu, którego zajęcie zostało już przejęte po wygaśnięciu
   * okna, NADPISYWAŁO rozstrzygnięcie procesu bieżącego — łącznie z zamianą
   * bariery BEZTERMINOWEJ (mail poszedł) na okno 8 dni, po którym ponowienie
   * wysłałoby drugi mail.
   */
  async settle(input: BarrierSettleInput): Promise<void> {
    const { text, bindings } = toKnexPositionalSql(
      `UPDATE ${MESSAGING_DISPATCH_BARRIER_TABLE}
          SET state      = 'settled',
              dispatch   = $1::jsonb,
              expires_at = $2,
              updated_at = $3
        WHERE barrier_key = $4
          AND claim_token = $5`,
      [
        JSON.stringify(input.dispatch),
        input.expires_at ? input.expires_at.toISOString() : null,
        new Date().toISOString(),
        input.barrier_key,
        input.claim_token,
      ],
    )
    await this.db.raw(text, bindings)
  }

  /**
   * Zwolnienie WŁASNEGO, NIEDOMKNIĘTEGO zajęcia.
   *
   * OBA warunki są konieczne i każdy odpowiada za co innego:
   *  * `state = 'in_flight'` — nie rusza zajęcia ROZSTRZYGNIĘTEGO (skasowanie
   *    bariery po udanej wysyłce = droga do drugiego maila);
   *  * `claim_token = $2` — nie rusza zajęcia CUDZEGO (R-4.1-M3). Sam `state`
   *    tego nie odróżniał: po przejęciu wygasłego zajęcia przez inny proces
   *    wiersz jest znowu `in_flight`, więc spóźniony `release` kasował cudze
   *    zajęcie w locie i otwierał drogę trzeciemu przebiegowi.
   */
  async release(input: { barrier_key: string; claim_token: string }): Promise<void> {
    const { text, bindings } = toKnexPositionalSql(
      `DELETE FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}
        WHERE barrier_key = $1
          AND claim_token = $2
          AND state = 'in_flight'`,
      [input.barrier_key, input.claim_token],
    )
    await this.db.raw(text, bindings)
  }

  private async findSettledDispatch(
    barrierKey: string,
  ): Promise<NotificationDispatch | null> {
    const { text, bindings } = toKnexPositionalSql(
      `SELECT dispatch FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}
        WHERE barrier_key = $1 AND state = 'settled'`,
      [barrierKey],
    )
    const rows = returnedRows(await this.db.raw(text, bindings))
    if (rows.length === 0) {
      return null
    }
    return parseDispatch((rows[0] as { dispatch?: unknown }).dispatch)
  }
}

/**
 * Kod błędu wysyłki, gdy nośnik bariery jest NIEDOSTĘPNY.
 *
 * Klasyfikowany jako PRE-FLIGHT (`preflight: true`), i to jest rozstrzygnięcie,
 * nie szczegół: skoro bariery nie ma, to na pewno NIC nie poszło do providera,
 * więc ponowienie po naprawie połączenia jest legalne i musi wysłać.
 *
 * Definicja mieszka w `@gp/messaging` (port), żeby sweep widział KOMPLET kodów
 * bariery z jednego miejsca (R-4.1-H2). Tu jest re-eksport dla wołających.
 */
export { MESSAGING_BARRIER_UNAVAILABLE }

/**
 * Bariera ODMAWIAJĄCA — dla przypadku, w którym kontener nie oddał połączenia
 * z bazą.
 *
 * Po co ona istnieje zamiast `undefined`: gateway bez bariery wysyłałby maile
 * BEZ JAKIEJKOLWIEK ochrony i wyglądałby przy tym na działający. Odmowa jest
 * głośna i policzalna; cicha wysyłka bez bariery jest dokładnie tym stanem,
 * który ta story zamyka.
 */
export function unavailableDispatchBarrier(
  onDenied?: (barrierKey: string) => void,
): DispatchIdempotencyBarrier {
  const deny = (barrierKey: string): never => {
    onDenied?.(barrierKey)
    throw new BarrierUnavailableError()
  }
  return {
    claim: async (input) => deny(input.barrier_key),
    settle: async (input) => deny(input.barrier_key),
    release: async (input) => deny(input.barrier_key),
  }
}

/**
 * ── Dlaczego to dziedziczy po `MessagingProviderError` (R-4.1-L1, R-4.1-H2) ─
 * Bo `preflight` musi mieć KONSUMENTA. Gdy ta klasa dziedziczyła po gołym
 * `Error`, gateway rozpoznawał flagę wyłącznie w gałęzi
 * `error instanceof MessagingProviderError` — a ten wyjątek ani nie był tym
 * typem, ani nie leciał przez ten blok. Flaga była deklaracją bez odbiorcy,
 * a kod błędu nie docierał do wiersza dostawy w ogóle.
 *
 * Po zmianie gateway łapie ten wyjątek wokół `claim()`, zamienia go na wynik
 * `failed` Z KODEM (`barrierUnavailableDispatch`) i czyta `preflight`, żeby
 * rozstrzygnąć, czy trzeba zwalniać ewentualne zajęcie.
 */
export class BarrierUnavailableError extends MessagingProviderError {
  /** `true`: `claim` nie doszedł do bazy, więc NA PEWNO nic nie poszło do providera. */
  constructor() {
    super(
      "Nośnik bariery idempotencji wysyłki jest niedostępny — wysyłka wstrzymana, " +
        "żeby nie pójść bez ochrony przed duplikatem",
      { error_code: MESSAGING_BARRIER_UNAVAILABLE, preflight: true },
    )
    this.name = "BarrierUnavailableError"
  }
}

/** Opcje diagnostyczne sprzątania — trafiają do logu i metryki. */
export type BarrierPurgeOptions = {
  origin?: SystemExecutionOrigin
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void
    error?: (message: string, meta?: Record<string, unknown>) => void
  }
}

/**
 * HIGIENA, NIE POPRAWNOŚĆ — odzyskuje miejsce po wygasłych wpisach.
 *
 * Werdykt bariery nie zależy od tego, czy ta funkcja kiedykolwiek się wykona
 * (okno siedzi w predykacie `claim`); jej zatrzymanie powoduje wyłącznie wzrost
 * tabeli. Wiersze BEZTERMINOWE (`expires_at IS NULL`) nie są kasowane NIGDY —
 * to są dostawy, które poszły, a ich usunięcie byłoby ryzykiem duplikatu maila.
 *
 * ── Dlaczego WOŁA nośnik kontekstu rynku (AD-21 / ADR-177) ────────────────
 * To jest NOWA powierzchnia zapisu poza żądaniem HTTP. `DELETE` bez
 * zadeklarowanego rynku skasowałby wiersze WSZYSTKICH rynków. Rynek pochodzi
 * z `requireMarketContext`, a nie z argumentu: gdyby był argumentem, wołający,
 * który go pominie, obchodziłby kontrolę bez śladu. Brak kontekstu = ODMOWA
 * GŁOŚNA, nie „skasuj wszystko".
 *
 * Rynek wiersza bariery jest PIERWSZYM członem `barrier_key`
 * (`market_id|flow_id|channel|idempotency_key` — `buildBarrierKey`
 * w `@gp/messaging`), więc zawężenie nie wymaga ani dodatkowej kolumny, ani
 * drugiego zapytania.
 *
 * @throws SystemMarketContextError gdy wywołanie leci poza kontekstem rynku —
 *         PRZED jakąkolwiek wysyłką do bazy.
 */
export async function purgeExpiredDispatchBarrierRows(
  db: DispatchBarrierDb,
  now: Date,
  options?: BarrierPurgeOptions,
): Promise<number | null> {
  const { market_id: marketId } = requireMarketContext(
    `${MESSAGING_DISPATCH_BARRIER_TABLE}.purge`,
    { origin: options?.origin, logger: options?.logger },
  )

  const { text, bindings } = toKnexPositionalSql(
    `DELETE FROM ${MESSAGING_DISPATCH_BARRIER_TABLE}
      WHERE expires_at IS NOT NULL
        AND expires_at <= $1
        AND split_part(barrier_key, '|', 1) = $2`,
    // `split_part`, a nie `LIKE '<market>|%'`: identyfikator rynku jest danymi,
    // a `%`/`_` w danych zamieniłyby zawężenie w dopasowanie szersze, niż
    // deklaruje kontekst — czyli kasowanie cudzych wierszy.
    [now.toISOString(), marketId],
  )
  const result = await db.raw(text, bindings)
  if (result && typeof result === "object") {
    const rowCount = (result as { rowCount?: unknown }).rowCount
    if (typeof rowCount === "number") {
      return rowCount
    }
  }
  return null
}
