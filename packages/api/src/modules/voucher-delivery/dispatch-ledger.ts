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

import {
  classifyProviderErrorKind,
  type ProviderErrorKind,
} from "@gp/messaging"

import { toKnexPositionalSql } from "../../lib/knex-positional-sql"
import {
  DELIVERY_DISPATCH_STATES,
  DISPATCH_STATES_ALLOWING_RETRY,
  DISPATCH_STATES_BLOCKING_RESEND,
  isDeliveryDispatchState,
  type DeliveryDispatchState,
} from "./delivery-state"
import { isRecipientHash, type RecipientHash } from "./recipient-hash"
import { CALLER_FORBIDDEN_ATTEMPT_FIELDS } from "./attempt-policy"

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
  /** Pierwotna przyczyna — nie jest kasowana przez retry summary row. */
  first_error_code: string | null
  first_failed_at: string | null
  /** Ile razy automat przywrócił budżet po awarii konfiguracji. */
  configuration_recovery_count: number
  /**
   * Kod HTTP ostatniej odpowiedzi providera (`401`, `429`, `500`, …) albo
   * `null`, gdy fail nastąpił ZANIM cokolwiek poszło do providera
   * (pre-flight: brak szablonu, brak sendera, brak klucza).
   *
   * Bez tej pary (`provider_status_code`, `provider_message`) ledger nie
   * odróżniał problemu konta od błędu kodu — patrz żywy zakup 2026-08-01.
   */
  provider_status_code: number | null
  /**
   * ZREDAGOWANY komunikat providera. Zapis przechodzi przez
   * `sanitizeProviderDetail` (`@gp/messaging`): adresy, IP, sekrety i długie
   * tokeny są zastąpione placeholderami. Surowego body NIE zapisujemy nigdy.
   */
  provider_message: string | null
  /**
   * RODZAJ awarii providera wyprowadzony z pary (`provider_status_code`,
   * `provider_message`) — kanał DIAGNOSTYCZNY obok redakcji, nie zamiast niej.
   *
   * Redakcja usuwa OBA nośniki informacji potrzebnej do naprawy: adres IP i
   * link autoryzacyjny. Operator widział klasę problemu, ale nie wiedział, KTÓRY
   * adres autoryzować — diagnoza opierała się na domyśle (`api.ipify.org` z
   * hosta plus założenie, że Brevo widzi ten sam adres). To pole niesie ENUM,
   * nie dane, więc niczego nie odsłania.
   *
   * `null` znaczy „nie rozpoznano" — nigdy „nie było awarii".
   */
  provider_error_kind: ProviderErrorKind | null
  /**
   * Token wiążący DOSTARCZONĄ wiadomość z przebiegiem, który ją wysłał —
   * dziś kod vouchera, bo ten jest już obecny w temacie maila.
   *
   * Powód istnienia: delivery-smoke (AD-15 punkt 2) potwierdza odbiór
   * automatycznie. Strategia podstawowa (`rfc822msgid:` po
   * `provider_message_id`) bywa niedostępna — zakup z 2026-08-01 dał dwa
   * wiersze `sent` z `provider_message_id IS NULL`. Udokumentowany fallback
   * pełnotekstowy był wtedy STRUKTURALNIE niewykonalny: nic trwałego nie
   * łączyło wiadomości z entitlementem.
   *
   * KONTRAKT BEZPIECZEŃSTWA: traktuj jak sekret bearer. Narzędzia evidence
   * zapisują wyłącznie `sha256` i nazwę strategii, nigdy wartość.
   */
  correlation_token: string | null
  attempt_count: number
  /** ISO 8601 — moment wejścia w `queued` (staleness porzuconych rezerwacji). */
  queued_at: string | null
}

/**
 * Wejście tranzycji `queued → failed`.
 *
 * `provider_status_code` / `provider_message` są OPCJONALNE, bo nie każda
 * porażka pochodzi od providera: fail pre-flight (brak szablonu, brak sendera,
 * brak klucza) i błędy konfiguracji wykryte przed wysyłką nie mają odpowiedzi
 * HTTP. Ich `null` jest wtedy INFORMACJĄ („nic nie poszło do providera"), nie
 * brakiem danych.
 *
 * KONTRAKT BEZPIECZEŃSTWA: `provider_message` MUSI być już zredagowane
 * (`sanitizeProviderDetail` z `@gp/messaging`). Ledger jest ostatnim ogniwem,
 * a nie miejscem, w którym redakcja się zaczyna — dlatego przycina długość,
 * ale nie próbuje ratować surowego body.
 */
export interface MarkFailedInput {
  dispatch_id: string
  error_code: string
  provider?: string | null
  provider_status_code?: number | null
  provider_message?: string | null
}

export interface DispatchLedgerPort {
  reserveDispatch(input: ReserveDispatchInput): Promise<ReserveDispatchResult>
  markSent(input: {
    dispatch_id: string
    provider: string
    provider_message_id: string | null
    /** Patrz `DispatchRow.correlation_token`. Opcjonalny: brak tokenu nie blokuje wysyłki. */
    correlation_token?: string | null
  }): Promise<boolean>
  markFailed(input: MarkFailedInput): Promise<boolean>
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
  /**
   * R-2.5-H4 — typy z taksonomii L1, których dotyczy matryca AD-7 (dziś:
   * warianty voucherowe). Bez tego filtra `SUBSCRIPTION_*`/`CREDIT_PACK`/`BUNDLE`
   * są „lukami buyer-maila", których automat nigdy nie domknie: wracają
   * w KAŻDYM przebiegu, zajmują batch i nie pozwalają zgasnąć alertowi.
   * Pusty zbiór jest błędem wołającego, nie „skanuj wszystkie typy".
   */
  entitlement_types: readonly string[]
  /** ISO 8601 — entitlementy MŁODSZE są pomijane (grace-window sweepa). */
  created_before: string
  /**
   * R-2.5-H1 — DOLNA granica wieku (backfill-guard). Bez niej pierwszy przebieg
   * na środowisku readiness-green traktuje CAŁĄ historię sprzed istnienia
   * ledgera (2.3) jako luki i dosyła do niej maile — nieodwracalnie. Okno jest
   * TYM SAMYM oknem, w którym liczona jest granica H1
   * (`countGapsBeyondSourceStates`), więc obie liczby mówią o tym samym zbiorze.
   */
  created_after: string
  /** ISO 8601 — `queued` starsze = rezerwacja PORZUCONA, nie wysyłka w locie. */
  stale_queued_before: string
  /**
   * R-2.5-H3 — wiersze z wyczerpanym budżetem prób (`attempt_count >=`) są
   * ZAPARKOWANE i NIE wracają ze skanu: inaczej 200 takich wierszy zajmuje cały
   * batch i sweep nigdy nie zobaczy świeżych luk (starvation). Są nadal
   * widoczne — przez `countParkedDispatchesByMarket`, nie przez zjadanie batcha.
   */
  max_attempt_count: number
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
  /** Ten sam filtr typów co skan — inaczej licznik mierzyłby inny zbiór. */
  entitlement_types: readonly string[]
  created_before: string
  /** ISO 8601 — dolna granica okna (skan bez niej byłby pełnym seq-scanem). */
  created_after: string
}

/**
 * Story 2.5 (R-2.5-M8) — skan STALLED sterowany LEDGEREM, nie
 * `entitlement_instance`. Uzupełnia `scanDeliveryGaps`, który wchodzi wyłącznie
 * przez zbiór szablonów OCZEKIWANYCH: wiersz szablonu warunkowego (np. handoff
 * z 2.4) w stanie `failed`/`retrying` nie ma jak wrócić z tamtego skanu, gdy
 * buyer-mail jest już `sent` — a wtedy nie ma go kto ponowić.
 *
 * Ten skan nie potrzebuje predykatu warunku (gift itp.): wiersz ledgera istnieje
 * WYŁĄCZNIE dlatego, że predykat już raz przeszedł.
 */
export interface ScanStalledDispatchesInput {
  source_states: readonly string[]
  entitlement_types: readonly string[]
  created_before: string
  created_after: string
  max_attempt_count: number
  limit: number
}

/** Wiersz zaparkowany: wyczerpał budżet prób i czeka na decyzję operatora. */
export interface ParkedDispatchRow {
  dispatch_id: string
  entitlement_id: string
  market_id: string | null
  template_key: string
  attempt_count: number
  first_error_code: string | null
}

/** Zaparkowane wiersze per rynek — nośnik alertu, gdy sweep ich nie dosyła. */
export interface ParkedDispatchMarketCount {
  market_id: string | null
  parked: number
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
  /** R-2.5-M8 — skan stalled wierszy ledgera (szablony warunkowe też). */
  scanStalledDispatches(
    input: ScanStalledDispatchesInput,
  ): Promise<DeliveryGapCandidate[]>
  /**
   * R-2.5-M6 — wiersze ZAPARKOWANE dla wskazanych entitlementów.
   *
   * Story 4.4 (FR-9e): decyzja o wyczerpaniu budżetu żyje PRZY WIERSZU i od tej
   * story sweep też wyklucza PER WIERSZ — zaparkowany wiersz nie wstrzymuje
   * pozostałych szablonów tego samego entitlementu. Było to możliwe dopiero po
   * scelowaniu wejścia dosyłki (`dispatch_target`, wprowadzony przez TĘ story
   * 4.4 w handlerze zbudowanym w 2.3/2.4): dopóki handler wysyłał komplet
   * szablonów naraz, jedynym sposobem na nieobejście progu przez
   * `reserveDispatch` było wykluczenie CAŁEGO entitlementu.
   *
   * Zapytanie zwraca `template_key` wiersza, bo to on — obok `entitlement_id` —
   * jest kluczem wykluczenia po stronie sweepa. `recipient_hash` NIE wchodzi do
   * tego klucza świadomie: kandydat skanu go nie niesie (wiersza dostawy może
   * jeszcze nie być), więc dopasowanie po nim byłoby niemożliwe. Skutkiem jest
   * wykluczenie o granulacji (entitlement, szablon) — węższe niż zastane
   * per-entitlement i nigdy szersze, czyli bezpieczne w stronę progu.
   *
   * GRANICA ŚWIADOMA (review 4.4, finding #7): para `(entitlement, szablon)` NIE
   * jest tożsamością wiersza — tą jest trójka z `recipient_hash`
   * (`voucher_delivery_dispatch_identity_uq`). Gdyby jedna para miała DWA różne
   * `recipient_hash` (zmiana adresu obdarowanej, ponowne wydanie handoffu),
   * zaparkowany wiersz adresu A wykluczałby ze skanu zdrowy wiersz adresu B —
   * czyli literę AC1 („wykluczenie działa na wierszach") ta granulacja oblewa.
   * Dziś jest to nieosiągalne, bo `recipient_hash` obu szablonów jest FUNKCJĄ
   * projekcji źródłowej entitlementu (buyer → `buyer_email`, handoff →
   * `gift_recipient_email`), a nie parametrem wywołania: przy danym
   * entitlemencie para wyznacza hash jednoznacznie. Ta niezmienniczość jest
   * mierzona testem `wykluczenie po parze == wykluczenie po wierszu, dopóki
   * para wyznacza hash` — jeśli kiedyś powstanie ścieżka nadająca drugi hash
   * tej samej parze, ten test pęknie i klucz trzeba będzie poszerzyć.
   */
  listParkedDispatches(input: {
    entitlement_ids: readonly string[]
    max_attempt_count: number
  }): Promise<ParkedDispatchRow[]>
  /** R-2.5-H3 — zaparkowane per rynek (alert; wiersze NIE wracają ze skanu). */
  countParkedDispatchesByMarket(input: {
    max_attempt_count: number
  }): Promise<ParkedDispatchMarketCount[]>
  /**
   * R-2.5-H3 — zwrot budżetu prób po awarii GLOBALNEJ (kill-switch, brak
   * szablonu locale, brak klucza providera). Taka awaria nie jest odrzuceniem
   * wysyłki przez providera, tylko brakiem konfiguracji: gdyby zużywała budżet,
   * odwracalna awaria konfiguracji zamieniałaby się po 5 przebiegach (75 min)
   * w TRWAŁĄ utratę maili dla całego okna awarii, bez ścieżki odparkowania.
   *
   * Guard `status='failed' AND error_code = …` sprawia, że dekrement dotyczy
   * WYŁĄCZNIE wiersza, który właśnie padł z tym kodem — nie cofa prób zużytych
   * na realne odrzucenia providera. `max_configuration_recoveries` stanowi
   * trwałą granicę: konfiguracja, której operator nie naprawi, nie może
   * uruchamiać tego samego wiersza bez końca.
   */
  releaseAttemptBudget(input: {
    dispatch_id: string
    error_code: string
    max_configuration_recoveries: number
  }): Promise<boolean>
  /**
   * Odparkuj historyczne wiersze, których pierwotna (niemutowalna) przyczyna
   * była globalną awarią konfiguracji. Licznik odzyskań jest zapisywany przy
   * wierszu, aby uszkodzony albo utracony aktualny kod nie zamienił tego
   * jednorazowego odzyskania w pętlę co cykl crona.
   */
  releaseParkedConfigurationFailureBudgets(input: {
    max_attempt_count: number
    max_configuration_recoveries: number
    error_codes: readonly string[]
  }): Promise<number>
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
  first_error_code, first_failed_at, configuration_recovery_count, queued_at,
  provider_status_code, provider_message, provider_error_kind, correlation_token
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
    // AD-23 (Story 4.4): numer próby nadaje POLITYKA. Typ już go nie ma, ale
    // wejście bywa budowane dynamicznie (payload webhooka 4.2/4.3, `as`) —
    // ciche zignorowanie `attempt_no` wyglądałoby jak skuteczne nadanie numeru.
    assertNoCallerAttemptNumber(input)

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
                -- Odpowiedź providera dotyczy KONKRETNEJ próby. Zostawiona przy
                -- przejęciu retry opisywałaby próbę, która już się nie liczy —
                -- operator czytałby HTTP 401 sprzed dwóch podejść jak bieżący
                -- stan. Historia zostaje w tabeli audytu.
                provider_status_code = NULL,
                provider_message = NULL,
                provider_error_kind = NULL,
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
    correlation_token?: string | null
  }): Promise<boolean> {
    const nowIso = this.now().toISOString()
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET status = 'sent',
              provider = $1,
              provider_message_id = $2,
              -- COALESCE, nie nadpisanie: ponowna wysyłka bez tokenu (np. ścieżka
              -- recovery) nie może SKASOWAĆ wiązania ustalonego przy pierwszej
              -- udanej próbie. Zapisany token jest faktem o dostarczonej
              -- wiadomości, a nie o ostatnim wywołaniu.
              correlation_token = COALESCE($3, correlation_token),
              error_code = NULL,
              -- Sukces kasuje diagnostyke porazki razem ze statusem bledu:
              -- wiersz 'sent' z HTTP 401 poprzedniej proby czytalby sie jak
              -- "poszlo mimo bledu". Slad porazki zyje w tabeli audytu.
              provider_status_code = NULL,
              provider_message = NULL,
              provider_error_kind = NULL,
              sent_at = $4,
              updated_at = $5
        WHERE dispatch_id = $6
          AND status = 'queued'
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.provider,
        input.provider_message_id,
        input.correlation_token ?? null,
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

  async markFailed(input: MarkFailedInput): Promise<boolean> {
    const nowIso = this.now().toISOString()
    const providerResponse = normalizeProviderResponse(input)
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET status = 'failed',
              provider = COALESCE($1, provider),
              error_code = $2,
              first_error_code = COALESCE(first_error_code, $2),
              first_failed_at = COALESCE(first_failed_at, $3),
              failed_at = $3,
              updated_at = $4,
              provider_status_code = $6,
              provider_message = $7,
              provider_error_kind = $8
        WHERE dispatch_id = $5
          AND status = 'queued'
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.provider ?? null,
        input.error_code,
        nowIso,
        nowIso,
        input.dispatch_id,
        providerResponse.status_code,
        providerResponse.message,
        providerResponse.error_kind,
      ],
    )

    if (rows.length === 0) return false

    const row = normalizeRow(rows[0])
    await this.appendAudit(
      row,
      "queued",
      "failed",
      input.error_code,
      nowIso,
      providerResponse,
    )
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
   * Sortowanie jest deterministyczne, ale NIE jest samym „od najstarszych":
   * pierwszym kluczem jest liczba dotychczasowych prób (R-2.5-H3/H4). Inaczej
   * najstarsze wiersze, które padają w każdym przebiegu, zajmowałyby początek
   * batcha bez końca i świeże luki nigdy nie zmieściłyby się w limicie.
   *
   * `truncated` jest liczone przez pobranie `limit + 1` wiersza (R-2.5-I13):
   * zaległość o rozmiarze DOKŁADNIE `limit` nie jest już fałszywie raportowana
   * jako „reszta czeka".
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
    if (input.entitlement_types.length === 0) {
      throw new DispatchLedgerError(
        "scanDeliveryGaps wymaga niepustego zbioru entitlement_types — skan bez " +
          "filtra typu traktuje subskrypcje i credit-packi jako luki buyer-maila",
        "VOUCHER_DELIVERY_GAP_SCAN_ENTITLEMENT_TYPES_EMPTY",
      )
    }
    assertGapScanWindow(input.created_after, input.created_before)
    assertMaxAttemptCount(input.max_attempt_count)
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new DispatchLedgerError(
        "scanDeliveryGaps wymaga limitu >= 1 — skan bez limitu może wystrzelić " +
          "nieograniczoną liczbę wysyłek",
        "VOUCHER_DELIVERY_GAP_SCAN_LIMIT_INVALID",
      )
    }

    const templateKeys = [...input.template_keys]
    const sourceStates = [...input.source_states]
    const entitlementTypes = [...input.entitlement_types]
    const retryStates = [...DISPATCH_STATES_ALLOWING_RETRY]

    // Numeracja `$N` jest rosnąca wzdłuż tekstu zapytania — kolejność bindingów
    // to: szablony, stany źródłowe, typy, created_before, created_after,
    // stale_queued_before, stany retry, max_attempt_count, limit.
    let position = 0
    const templatePlaceholders = templateKeys
      .map(() => `($${++position})`)
      .join(", ")
    const statePlaceholders = sourceStates.map(() => `$${++position}`).join(", ")
    const typePlaceholders = entitlementTypes
      .map(() => `$${++position}`)
      .join(", ")
    const createdBeforePlaceholder = `$${++position}`
    const createdAfterPlaceholder = `$${++position}`
    const staleQueuedPlaceholder = `$${++position}`
    const retryPlaceholders = retryStates.map(() => `$${++position}`).join(", ")
    const maxAttemptPlaceholder = `$${++position}`
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
          AND e.entitlement_type IN (${typePlaceholders})
          AND e.created_at < ${createdBeforePlaceholder}
          AND e.created_at >= ${createdAfterPlaceholder}
          AND (
                d.dispatch_id IS NULL
             OR (d.status = 'queued' AND d.queued_at < ${staleQueuedPlaceholder})
             OR d.status IN (${retryPlaceholders})
          )
          AND (d.dispatch_id IS NULL OR d.attempt_count < ${maxAttemptPlaceholder})
        ORDER BY COALESCE(d.attempt_count, 0) ASC, e.created_at ASC, e.id ASC,
                 t.template_key ASC
        LIMIT ${limitPlaceholder}`,
      [
        ...templateKeys,
        ...sourceStates,
        ...entitlementTypes,
        input.created_before,
        input.created_after,
        input.stale_queued_before,
        ...retryStates,
        input.max_attempt_count,
        // +1 wiersz sondujący: obecność `limit + 1` znaczy „reszta ISTNIEJE".
        input.limit + 1,
      ],
    )

    const truncated = rows.length > input.limit
    const candidates = rows
      .slice(0, input.limit)
      .map((row) => normalizeGapCandidate(row))

    return { candidates, truncated }
  }

  /**
   * R-2.5-M8 — skan STALLED sterowany ledgerem: wiersze `failed`/`retrying`
   * (dowolnego szablonu, także warunkowego) dla entitlementów, które nadal są
   * w matrycy AD-7. `scanDeliveryGaps` ich nie znajdzie, gdy szablon
   * bezwarunkowy jest już `sent` — a wtedy nic ich nie ponawia.
   */
  async scanStalledDispatches(
    input: ScanStalledDispatchesInput,
  ): Promise<DeliveryGapCandidate[]> {
    if (input.source_states.length === 0 || input.entitlement_types.length === 0) {
      throw new DispatchLedgerError(
        "scanStalledDispatches wymaga niepustych zbiorów source_states " +
          "i entitlement_types",
        "VOUCHER_DELIVERY_STALLED_SCAN_INPUT_EMPTY",
      )
    }
    assertGapScanWindow(input.created_after, input.created_before)
    assertMaxAttemptCount(input.max_attempt_count)
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new DispatchLedgerError(
        "scanStalledDispatches wymaga limitu >= 1",
        "VOUCHER_DELIVERY_STALLED_SCAN_LIMIT_INVALID",
      )
    }

    const retryStates = [...DISPATCH_STATES_ALLOWING_RETRY]
    const sourceStates = [...input.source_states]
    const entitlementTypes = [...input.entitlement_types]

    let position = 0
    const retryPlaceholders = retryStates.map(() => `$${++position}`).join(", ")
    const maxAttemptPlaceholder = `$${++position}`
    const statePlaceholders = sourceStates.map(() => `$${++position}`).join(", ")
    const typePlaceholders = entitlementTypes
      .map(() => `$${++position}`)
      .join(", ")
    const createdBeforePlaceholder = `$${++position}`
    const createdAfterPlaceholder = `$${++position}`
    const limitPlaceholder = `$${++position}`

    const rows = await this.queryRows<Record<string, unknown>>(
      `SELECT e.id            AS entitlement_id,
              e.market_id     AS market_id,
              e.state         AS entitlement_state,
              d.template_key  AS template_key,
              d.dispatch_id   AS dispatch_id,
              d.status        AS dispatch_status,
              d.queued_at     AS queued_at,
              d.attempt_count AS attempt_count
         FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE} d
         JOIN ${ENTITLEMENT_INSTANCE_TABLE} e ON e.id = d.entitlement_id
        WHERE d.status IN (${retryPlaceholders})
          AND d.attempt_count < ${maxAttemptPlaceholder}
          AND e.state IN (${statePlaceholders})
          AND e.entitlement_type IN (${typePlaceholders})
          AND e.created_at < ${createdBeforePlaceholder}
          AND e.created_at >= ${createdAfterPlaceholder}
        ORDER BY d.attempt_count ASC, e.created_at ASC, e.id ASC,
                 d.template_key ASC
        LIMIT ${limitPlaceholder}`,
      [
        ...retryStates,
        input.max_attempt_count,
        ...sourceStates,
        ...entitlementTypes,
        input.created_before,
        input.created_after,
        input.limit,
      ],
    )

    return rows.map((row) => normalizeGapCandidate(row))
  }

  /** R-2.5-M6 — zaparkowane wiersze wskazanych entitlementów. */
  async listParkedDispatches(input: {
    entitlement_ids: readonly string[]
    max_attempt_count: number
  }): Promise<ParkedDispatchRow[]> {
    assertMaxAttemptCount(input.max_attempt_count)
    const ids = [...input.entitlement_ids]
    if (ids.length === 0) return []

    let position = 0
    const maxAttemptPlaceholder = `$${++position}`
    const idPlaceholders = ids.map(() => `$${++position}`).join(", ")

    const rows = await this.queryRows<Record<string, unknown>>(
      `SELECT dispatch_id, entitlement_id, market_id, template_key, attempt_count,
              first_error_code
         FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}
        WHERE attempt_count >= ${maxAttemptPlaceholder}
          AND status <> 'sent'
          AND status <> 'delivered'
          AND status <> 'degraded'
          AND entitlement_id IN (${idPlaceholders})`,
      [input.max_attempt_count, ...ids],
    )

    return rows.map((row) => ({
      dispatch_id: String(row.dispatch_id ?? ""),
      entitlement_id: String(row.entitlement_id ?? ""),
      market_id: row.market_id == null ? null : String(row.market_id),
      template_key: String(row.template_key ?? ""),
      attempt_count: Number(row.attempt_count ?? 0),
      first_error_code:
        row.first_error_code == null ? null : String(row.first_error_code),
    }))
  }

  /** R-2.5-H3 — nośnik alertu dla wierszy, których sweep świadomie nie dosyła. */
  async countParkedDispatchesByMarket(input: {
    max_attempt_count: number
  }): Promise<ParkedDispatchMarketCount[]> {
    assertMaxAttemptCount(input.max_attempt_count)

    const rows = await this.queryRows<Record<string, unknown>>(
      `SELECT market_id, COUNT(*)::int AS parked
         FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}
        WHERE attempt_count >= $1
          AND status <> 'sent'
          AND status <> 'delivered'
          AND status <> 'degraded'
        GROUP BY market_id`,
      [input.max_attempt_count],
    )

    return rows.map((row) => ({
      market_id: row.market_id == null ? null : String(row.market_id),
      parked: Number(row.parked ?? 0),
    }))
  }

  /** R-2.5-H3 — awaria konfiguracyjna nie zużywa budżetu prób (odparkowanie). */
  async releaseAttemptBudget(input: {
    dispatch_id: string
    error_code: string
    max_configuration_recoveries: number
  }): Promise<boolean> {
    assertConfigurationRecoveryLimit(input.max_configuration_recoveries)
    const nowIso = this.now().toISOString()
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET attempt_count = GREATEST(attempt_count - 1, 1),
              configuration_recovery_count = configuration_recovery_count + 1,
              updated_at = $1
        WHERE dispatch_id = $2
          AND status = 'failed'
          AND error_code = $3
          AND attempt_count > 0
          AND configuration_recovery_count < $4
      RETURNING ${SELECT_COLUMNS}`,
      [
        nowIso,
        input.dispatch_id,
        input.error_code,
        input.max_configuration_recoveries,
      ],
    )

    return rows.length > 0
  }

  async releaseParkedConfigurationFailureBudgets(input: {
    max_attempt_count: number
    max_configuration_recoveries: number
    error_codes: readonly string[]
  }): Promise<number> {
    assertMaxAttemptCount(input.max_attempt_count)
    assertConfigurationRecoveryLimit(input.max_configuration_recoveries)
    const codes = [...input.error_codes]
    const codePlaceholders = codes.map((_code, index) => `$${index + 4}`).join(", ")
    const nowIso = this.now().toISOString()
    const rows = await this.queryRows<DispatchRow>(
      `UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}
          SET attempt_count = LEAST(attempt_count, $1 - 1),
              configuration_recovery_count = configuration_recovery_count + 1,
              updated_at = $2
        WHERE status = 'failed'
          AND attempt_count >= $1
          -- Tylko historyczny summary z utraconą diagnostyką. Stabilne ID
          -- notyfikacji chroni aktualny kod od następnej próby; ten fallback
          -- wolno wykonać ograniczoną liczbę razy, nie w każdym cyklu crona.
          AND error_code = 'VOUCHER_DELIVERY_DISPATCH_FAILED'
          AND configuration_recovery_count < $3
          AND first_error_code IS NOT NULL
          AND (
            first_error_code IN (${codePlaceholders})
            OR first_error_code LIKE '%\\_NOT\\_CONFIGURED' ESCAPE '\\'
          )
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.max_attempt_count,
        nowIso,
        input.max_configuration_recoveries,
        ...codes,
      ],
    )
    return rows.length
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
    if (
      input.template_keys.length === 0 ||
      input.source_states.length === 0 ||
      input.entitlement_types.length === 0
    ) {
      throw new DispatchLedgerError(
        "countGapsBeyondSourceStates wymaga niepustych zbiorów template_keys, " +
          "source_states i entitlement_types",
        "VOUCHER_DELIVERY_GAP_COUNT_INPUT_EMPTY",
      )
    }

    const sourceStates = [...input.source_states]
    const templateKeys = [...input.template_keys]
    const entitlementTypes = [...input.entitlement_types]

    let position = 0
    const statePlaceholders = sourceStates.map(() => `$${++position}`).join(", ")
    const typePlaceholders = entitlementTypes
      .map(() => `$${++position}`)
      .join(", ")
    const createdBeforePlaceholder = `$${++position}`
    const createdAfterPlaceholder = `$${++position}`
    const templatePlaceholders = templateKeys
      .map(() => `$${++position}`)
      .join(", ")
    const expectedTemplateCountPlaceholder = `$${++position}`

    // R-2.5-L11: licznik pyta o TĘ SAMĄ jednostkę co skan (para entitlement ×
    // oczekiwany szablon). Wariant `NOT EXISTS (… template_key IN (…))` pytał
    // o „ŻADNEGO wiersza" — po dołożeniu drugiego szablonu entitlement z samym
    // handoffem przestałby być liczony, choć buyer-maila nie ma.
    const rows = await this.queryRows<{ gap_count: number | string }>(
      `SELECT COUNT(*)::int AS gap_count
         FROM ${ENTITLEMENT_INSTANCE_TABLE} e
        WHERE e.state NOT IN (${statePlaceholders})
          AND e.entitlement_type IN (${typePlaceholders})
          AND e.created_at < ${createdBeforePlaceholder}
          AND e.created_at >= ${createdAfterPlaceholder}
          AND (
                SELECT COUNT(DISTINCT d.template_key)
                  FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE} d
                 WHERE d.entitlement_id = e.id
                   AND d.template_key IN (${templatePlaceholders})
              ) < ${expectedTemplateCountPlaceholder}`,
      [
        ...sourceStates,
        ...entitlementTypes,
        input.created_before,
        input.created_after,
        ...templateKeys,
        templateKeys.length,
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
              first_error_code = COALESCE(first_error_code, $1),
              first_failed_at = COALESCE(first_failed_at, $2),
              failed_at = $2,
              updated_at = $3,
              -- Przejęcie PORZUCONEJ rezerwacji nie ma odpowiedzi providera:
              -- proces, który wysyłał, zniknął. Zostawienie tu wartości
              -- z poprzedniej próby przypisałoby cudzy HTTP status zdarzeniu,
              -- które nigdy nie dotknęło providera.
              provider_status_code = NULL,
              provider_message = NULL,
              provider_error_kind = NULL
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
   * Append-only wpis audytowy. Zapisujemy hash odbiorcy, kod błędu oraz
   * ZREDAGOWANĄ odpowiedź providera — nigdy adresu, nigdy surowego body,
   * nigdy sekretu (D-70 / AC2).
   *
   * Odpowiedź providera trafia TAKŻE tutaj, bo wiersz `..._dispatch` jest
   * mutowalnym podsumowaniem ostatniej próby: retry kasuje `provider_message`,
   * a bez kopii w audycie przyczyna pierwszej porażki znikałaby przy pierwszym
   * ponowieniu — dokładnie ten problem zamykała migracja `first_error_code`.
   */
  private async appendAudit(
    row: DispatchRow,
    fromStatus: DeliveryDispatchState | null,
    toStatus: DeliveryDispatchState,
    errorCode: string | null,
    occurredAtIso: string,
    providerResponse: NormalizedProviderResponse = EMPTY_PROVIDER_RESPONSE,
  ): Promise<void> {
    await this.queryRows(
      `INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE} (
         dispatch_id, entitlement_id, template_key, recipient_hash, market_id,
         from_status, to_status, error_code, attempt_count, occurred_at,
         provider_status_code, provider_message, provider_error_kind
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
        providerResponse.status_code,
        providerResponse.message,
        providerResponse.error_kind,
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

/**
 * Odpowiedź providera po normalizacji — kształt, w którym wolno ją ZAPISAĆ.
 *
 * Oba pola są `null`-owalne z tego samego powodu: porażka pre-flight nie ma
 * odpowiedzi HTTP, a `null` znaczy wtedy „nic nie poszło do providera".
 */
interface NormalizedProviderResponse {
  status_code: number | null
  message: string | null
  error_kind: ProviderErrorKind | null
}

const EMPTY_PROVIDER_RESPONSE: NormalizedProviderResponse = {
  status_code: null,
  message: null,
  error_kind: null,
}

/**
 * Twardy limit długości `provider_message` po stronie aplikacji.
 *
 * Redakcja i przycięcie dzieją się WYŻEJ (`sanitizeProviderDetail`
 * w `@gp/messaging`); ten limit jest drugą, niezależną barierą — CHECK w
 * bazie jest trzecią. Trzy warstwy, bo pojedyncza bariera na treści od
 * zewnętrznego providera to za mało.
 */
const PROVIDER_MESSAGE_MAX_LENGTH = 512

/**
 * Sprowadza wejście `markFailed` do zapisywalnego kształtu.
 *
 * NIE redaguje — redakcja jest kontraktem wołającego (`MarkFailedInput`).
 * Tutaj bronimy wyłącznie przed wartościami, które rozwaliłyby CHECK w bazie:
 * status spoza zakresu HTTP i komunikat dłuższy niż kolumna.
 */
function normalizeProviderResponse(
  input: MarkFailedInput,
): NormalizedProviderResponse {
  const status_code = normalizeStatusCode(input.provider_status_code)
  const message = normalizeProviderMessage(input.provider_message)
  return {
    status_code,
    message,
    // Rodzaj jest WYPROWADZANY z tego, co i tak zapisujemy — nie jest kolejnym
    // polem do wypełnienia przez wołającego, które ktoś zapomni podać albo poda
    // niespójnie z treścią. Klasyfikator działa na tekście JUŻ zredagowanym,
    // więc nie ma ścieżki, którą wprowadzałby z powrotem PII.
    error_kind: classifyProviderErrorKind({ status_code, detail: message }),
  }
}

/** Enum znanych rodzajów — patrz `ProviderErrorKind` w `@gp/messaging`. */
const KNOWN_PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  "IP_NOT_AUTHORIZED",
]

function normalizeProviderErrorKind(raw: unknown): ProviderErrorKind | null {
  if (typeof raw !== "string") return null
  return KNOWN_PROVIDER_ERROR_KINDS.includes(raw as ProviderErrorKind)
    ? (raw as ProviderErrorKind)
    : null
}

function normalizeStatusCode(raw: unknown): number | null {
  if (raw == null) return null
  const parsed = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) return null
  return parsed
}

function normalizeProviderMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.length > PROVIDER_MESSAGE_MAX_LENGTH
    ? trimmed.slice(0, PROVIDER_MESSAGE_MAX_LENGTH)
    : trimmed
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
    first_error_code:
      record.first_error_code == null ? null : String(record.first_error_code),
    first_failed_at: normalizeTimestamp(record.first_failed_at),
    configuration_recovery_count: Number(record.configuration_recovery_count ?? 0),
    // `provider_status_code` jest `integer`, ale sterownik potrafi oddać go
    // jako string — ten sam kształt defektu co ADR-166 R-1 (`numeric` → string,
    // `typeof === "number"` cicho degradowało do fallbacku). Konwertujemy
    // JAWNIE i odrzucamy wartości nieliczbowe zamiast wpuszczać `NaN`.
    provider_status_code: normalizeStatusCode(record.provider_status_code),
    provider_message:
      record.provider_message == null ? null : String(record.provider_message),
    // Wartość spoza enumu (kolumna jest `text`, więc baza jej nie pilnuje)
    // degraduje do `null`, a nie przechodzi dalej jako etykieta, której kod nie
    // zna — `null` znaczy „nie rozpoznano" i to jest uczciwe.
    provider_error_kind: normalizeProviderErrorKind(record.provider_error_kind),
    correlation_token:
      record.correlation_token == null ? null : String(record.correlation_token),
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

/**
 * R-2.5-H1 — okno skanu MUSI być domknięte z obu stron i niepuste. Brak dolnej
 * granicy nie jest „szerszym skanem", tylko dosyłką do całej historii sprzed
 * istnienia ledgera; odwrócone okno byłoby cichym no-opem.
 */
function assertGapScanWindow(createdAfter: string, createdBefore: string): void {
  if (!createdAfter || !createdBefore) {
    throw new DispatchLedgerError(
      "skan luk wymaga OBU granic okna (created_after, created_before) — skan " +
        "bez dolnej granicy dosyła maile do całej historii",
      "VOUCHER_DELIVERY_GAP_SCAN_WINDOW_INVALID",
    )
  }
  if (!(createdAfter < createdBefore)) {
    throw new DispatchLedgerError(
      `skan luk dostał odwrócone okno (created_after=${createdAfter} >= ` +
        `created_before=${createdBefore}) — to cichy no-op, nie skan`,
      "VOUCHER_DELIVERY_GAP_SCAN_WINDOW_INVALID",
    )
  }
}

/** R-2.5-H3 — próg parkowania jest kontraktem SQL-a, nie sugestią wołającego. */
function assertMaxAttemptCount(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new DispatchLedgerError(
      "max_attempt_count musi być liczbą całkowitą >= 1",
      "VOUCHER_DELIVERY_MAX_ATTEMPT_COUNT_INVALID",
    )
  }
}

function assertConfigurationRecoveryLimit(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DispatchLedgerError(
      "max_configuration_recoveries musi być liczbą całkowitą >= 0",
      "VOUCHER_DELIVERY_CONFIGURATION_RECOVERY_LIMIT_INVALID",
    )
  }
}

/**
 * AD-23 (Story 4.4) — wywołujący NIE nadaje numeru próby.
 *
 * Inkrement `attempt_count` dzieje się wyłącznie w warunkowym `UPDATE … WHERE
 * status IN (…)` przejęcia retry. Wejście z polem `attempt_count`/`attempt_no`
 * jest ODRZUCANE, nie ignorowane: cicha akceptacja wyglądałaby jak skuteczne
 * nadanie numeru z zewnątrz, a gdyby `attempt_no` trafił kiedyś do klucza
 * bariery idempotencji (rozstrzygnięcie P-3, Story 4.1), oznaczałaby, że
 * dowolny wywołujący potrafi wyprodukować nowy klucz i obejść barierę.
 */
function assertNoCallerAttemptNumber(input: object): void {
  const carried = CALLER_FORBIDDEN_ATTEMPT_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input, field),
  )
  if (carried.length > 0) {
    throw new DispatchLedgerError(
      `numer próby nadaje polityka, nie wywołujący (AD-23) — wejście niesie: ${carried.join(", ")}`,
      "VOUCHER_DELIVERY_ATTEMPT_NUMBER_NOT_CALLER_OWNED",
    )
  }
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
