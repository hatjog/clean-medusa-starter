/**
 * idempotency-barrier.ts — PORT bariery idempotencji dostawy.
 *
 * v1.15.0 Story 4.1 (FR-9a, FR-9b, AD-23, NFR-1, NFR-4, ADR-196).
 *
 * ── Co ten plik zastępuje ──────────────────────────────────────────────────
 * Mapę `idempotencyCache` w pamięci procesu (`gateway.ts:76` do v1.14.0) wraz
 * z sekwencją `get` → warunek wygaśnięcia → `delete` (odczyt) i osobnym `set`
 * PO powrocie od providera (zapis). To jest dokładnie kształt `odczyt →
 * operacja → zapis`, który AD-23 nazywa defektem: przy dwóch instancjach każda
 * miała własną mapę, więc drugie żądanie skierowane do drugiej instancji nie
 * widziało pierwszego w ogóle i mail szedł dwa razy.
 *
 * ── Dlaczego PORT, a nie implementacja w tym pakiecie ──────────────────────
 * `@gp/messaging` jest provider-neutralny i nie ma (ani nie może mieć) zależności
 * od Knexa, `pg` ani Medusy — jego `package.json` deklaruje `@gp/audit` i
 * `js-yaml`. Wstawienie tu sterownika bazy byłoby zmianą architektury pakietu.
 * Rozstrzygnięcie ADR-196 §D1: gateway zna WYŁĄCZNIE ten interfejs, a jedyna
 * implementacja produkcyjna (`PgDispatchIdempotencyBarrier`) mieszka w
 * `packages/api`, czyli tam, gdzie i tak jest sterownik i migracje.
 *
 * Wariant odrzucony: „bariera wychodzi z gatewaya do właściciela wiersza
 * skutku, a gateway zostaje bezstanowy". Odrzucony, bo wiersz skutku
 * (`voucher_delivery_dispatch`) istnieje TYLKO dla ścieżki zakupowej vouchera.
 * Call-site'y bez wiersza skutku (magic-link, potwierdzenie wizyty,
 * powiadomienie o odbiorze) zostałyby wtedy BEZ jakiejkolwiek bariery — a AC2
 * wymaga nazwanego nośnika dla KAŻDEGO. Gateway jest jedynym miejscem, przez
 * które przechodzą wszystkie.
 *
 * ── Bariera jest JEDNĄ operacją atomową PRZED skutkiem (AD-23) ─────────────
 * `claim()` jest wołane ZANIM gateway dotknie providera i musi być
 * zrealizowane JEDNYM stwierdzeniem wykonywalnym (`INSERT … ON CONFLICT …
 * DO UPDATE … WHERE <wygasło> RETURNING`), którego werdykt czyta się z LICZBY
 * ZWRÓCONYCH WIERSZY. Kontrakt zabrania implementacji poprzedzającej zapis
 * odczytem: „sprawdź, czy jest, potem wstaw" przepuszcza dwa równoległe
 * procesy przez okno między odczytem a zapisem.
 *
 * Odczyt w `BarrierClaim.dispatch` jest dozwolony, bo następuje PO werdykcie
 * i go nie zmienia — służy wyłącznie odtworzeniu wyniku poprzedniego przebiegu,
 * żeby ponowienie dostało tę samą odpowiedź zamiast błędu.
 *
 * ── Trzy stany i to, co je rozróżnia (FR-9b, NFR-4) ────────────────────────
 *   `in_flight`  — klucz zajęty, provider jeszcze nie odpowiedział. Okno
 *                  {@link DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS} chroni przed
 *                  wieczną blokadą po awarii procesu MIĘDZY `claim` a `settle`.
 *   `settled`    — przebieg się zakończył. `expires_at = null` znaczy
 *                  BEZTERMINOWO (sukces oraz porażka NIEJEDNOZNACZNA rozstrzygnięta
 *                  jako „mail mógł pójść" po wyczerpaniu okna nie wraca), a
 *                  `expires_at` z datą znaczy OKNO (porażka niejednoznaczna).
 *   brak wiersza — porażka ROZSTRZYGNIĘTA PRZED WYSYŁKĄ (`preflight`), którą
 *                  `release()` kasuje. Ponowienie jest w pełni legalne, bo
 *                  wiemy, że nic nie poszło.
 *
 * Klasyfikacja ma JEDNO źródło prawdy: flagę `preflight` na
 * `MessagingProviderError`. Ten port świadomie NIE zna żadnej listy kodów
 * błędów — druga lista byłaby drugą prawdą i rozjechałaby się przy pierwszym
 * nowym kodzie (dokładnie klasa defektu, którą Story 4.1 zamyka).
 *
 * ── Okno jest w PREDYKACIE, nie w harmonogramie (AD-23, NFR-4) ─────────────
 * Wygasanie realizuje `WHERE` operacji `claim`, a nie cron. Konsekwencja jest
 * wprost taka, jakiej wymaga AC4: ZATRZYMANY SPRZĄTACZ NIE ZMIENIA WERDYKTU
 * BARIERY. Kasowanie wygasłych wierszy jest wyłącznie HIGIENĄ.
 *
 * @module idempotency-barrier
 */
import type { NotificationDispatch } from "./types";

/** Nazwa tabeli bariery. Zakładana przez migrację `1779002000000` (rejestr v1.15.0). */
export const MESSAGING_DISPATCH_BARRIER_TABLE = "messaging_dispatch_barrier";

/**
 * Kod wysyłki, gdy NOŚNIK bariery jest niedostępny (kontener nie oddał
 * połączenia z bazą, `claim` nie doszedł do bazy).
 *
 * ── Dlaczego ten kod mieszka w PORCIE, a nie przy implementacji ────────────
 * Bo konsumentem klasyfikacji jest reconciliation sweep w `packages/api`, a
 * jego lista awarii globalnych musi widzieć KOMPLET kodów bariery z JEDNEGO
 * miejsca. Gdy kod żył przy sterowniku, a `MESSAGING_DISPATCH_IN_FLIGHT` przy
 * gatewayu, nie było gdzie zapisać „to są wszystkie kody bariery" — i przy
 * integracji Story 4.1 żaden z nich nie trafił do klasyfikacji sweepa
 * (R-4.1-H2). `packages/api` re-eksportuje tę stałą, więc wołający się nie
 * zmieniają.
 */
export const MESSAGING_BARRIER_UNAVAILABLE = "MESSAGING_BARRIER_UNAVAILABLE";

export type BarrierClaimOutcome =
  /** Klucz był wolny albo wygasł — WOLNO wołać providera. */
  | "claimed"
  /**
   * Klucz jest zajęty i wciąż w oknie — NIE WOLNO wołać providera.
   * `dispatch` niesie wynik poprzedniego przebiegu, gdy ten się zakończył.
   */
  | "blocked";

export interface BarrierClaim {
  outcome: BarrierClaimOutcome;
  /**
   * Wynik poprzedniego przebiegu — obecny wyłącznie przy `blocked` i tylko
   * wtedy, gdy tamten przebieg zdążył się rozstrzygnąć (`settle`).
   *
   * `null` przy `blocked` znaczy „inny proces JEST TERAZ w locie" — nie znaczy
   * „nie ma bariery". Wołający nie ma prawa potraktować tego jak zgody na wysyłkę.
   */
  dispatch: NotificationDispatch | null;
}

export interface BarrierClaimInput {
  barrier_key: string;
  /** Baza czasu wołającego — patrz „Baza czasu" niżej. */
  now: Date;
  /** Jak długo zajęcie `in_flight` blokuje, zanim stanie się przejmowalne. */
  in_flight_window_ms: number;
  /**
   * Token TEGO przebiegu — podaje WOŁAJĄCY, z tego samego powodu, co `now`:
   * implementacja bariery ma być pozbawiona własnego źródła niedeterminizmu,
   * żeby test mógł pokazać przejęcie zajęcia bez zgadywania wartości.
   *
   * Bariera NIE oddaje tokenu z powrotem w {@link BarrierClaim} — wołający już
   * go zna, a pole, którego nikt nie czyta, byłoby deklaracją bez konsumenta.
   */
  claim_token: string;
}

export interface BarrierSettleInput {
  barrier_key: string;
  /**
   * Token zajęcia, które domykamy. Domknięcie CUDZEGO zajęcia jest zabronione
   * i implementacja MUSI je odrzucić warunkiem w `WHERE` (R-4.1-M3) — inaczej
   * spóźnione domknięcie poprzedniego przebiegu nadpisuje rozstrzygnięcie
   * bieżącego, łącznie z zamianą bariery bezterminowej na okno.
   */
  claim_token: string;
  dispatch: NotificationDispatch;
  /**
   * `null` = bariera BEZTERMINOWA (mail poszedł — kasowanie wpisu to ryzyko
   * duplikatu). Data = koniec okna dla stanu NIEJEDNOZNACZNEGO.
   */
  expires_at: Date | null;
}

/**
 * Kontrakt trwałej bariery dostawy.
 *
 * ── Baza czasu ─────────────────────────────────────────────────────────────
 * Czas podaje WOŁAJĄCY (`now`), a nie `now()` bazy. Powód jest ten sam, co
 * w replay-guardzie 5.3: zegar procesu jest już bazą czasu dla `audit_event`
 * i dla znaczników dispatchu, więc okno liczone zegarem bazy mogłoby się
 * z nimi rozjechać. Efekt uboczny — oba brzegi okna da się pokazać w teście
 * bez czekania zegarem ściennym — jest korzyścią, nie powodem.
 */
export interface DispatchIdempotencyBarrier {
  /**
   * JEDNA operacja atomowa. Zajmuje klucz albo stwierdza, że jest zajęty.
   *
   * Implementacja MUSI rozstrzygać werdykt wynikiem pojedynczego stwierdzenia
   * (liczba wierszy / `RETURNING`), nigdy porównaniem w kodzie po `SELECT`.
   */
  claim(input: BarrierClaimInput): Promise<BarrierClaim>;

  /** Domyka zajęcie wynikiem przebiegu. Patrz {@link BarrierSettleInput.expires_at}. */
  settle(input: BarrierSettleInput): Promise<void>;

  /**
   * Zwalnia zajęcie w całości — WYŁĄCZNIE dla porażki rozstrzygniętej przed
   * wysyłką (`MessagingProviderError.preflight === true`). Po zwolnieniu
   * ponowienie tego samego zdarzenia jest w pełni legalne i MUSI zawołać
   * providera; to jest główny scenariusz wyjścia ze stanu „rejestr pusty".
   *
   * Zwolnienie wolno wykonać WYŁĄCZNIE na WŁASNYM, NIEDOMKNIĘTYM zajęciu —
   * implementacja MUSI sprawdzić OBA warunki (`state = 'in_flight'` ORAZ
   * `claim_token`). Sam `state` nie wystarcza: nie odróżnia zajęcia własnego
   * od przejętego przez inny proces po wygaśnięciu okna (R-4.1-M3).
   */
  release(input: { barrier_key: string; claim_token: string }): Promise<void>;
}

/**
 * Okno zajęcia `in_flight` — 15 minut.
 *
 * WYPROWADZENIE (a nie „bo tak wygodnie"): to jest ta sama liczba, którą ledger
 * dostarczeń nazywa progiem PORZUCONEJ REZERWACJI
 * (`STALE_QUEUED_THRESHOLD_MS = 15 * 60 * 1000`,
 * `subscribers/voucher-purchase-delivery.ts`, reużywana przez sweep 2.5 jako
 * `SWEEP_STALE_QUEUED_MS`). Oba mechanizmy odpowiadają na to samo pytanie —
 * „od kiedy uznajemy, że proces, który zajął zasób, już nie wróci" — więc
 * osobna wartość byłaby DRUGĄ definicją tego samego progu i rozjechałaby się
 * przy pierwszej zmianie. Parity egzekwuje test w `packages/api`, który pęka
 * po zmianie którejkolwiek ze stałych osobno.
 *
 * Dolna granica poprawności jest znacznie niższa (timeout klienta Brevo to
 * `BREVO_DEFAULT_TIMEOUT_MS = 10 s`), więc 15 min jest z zapasem po stronie
 * bezpiecznej: krótsze okno pozwoliłoby drugiej instancji przejąć zajęcie,
 * gdy pierwsza jeszcze czeka na providera — czyli wysłać drugi mail.
 */
export const DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Okno bariery dla porażki NIEJEDNOZNACZNEJ — 8 dni.
 *
 * WYPROWADZENIE z HORYZONTU PONOWIEŃ (AD-23, AC4). Pytanie brzmi: jak długo to
 * samo zdarzenie może LEGALNIE wrócić i spowodować drugi mail? Składniki są
 * zmierzone w kodzie, nie założone:
 *
 *   1. `SWEEP_GAP_LOOKBACK_MS = 7 dni` — okno, w którym reconciliation sweep
 *      (`jobs/voucher-delivery-reconciliation-sweep.ts`) w ogóle SCHODZI po
 *      luki. Entitlement sprzed trzech dni jest wciąż kandydatem do dosyłki.
 *   2. `SWEEP_ENTITLEMENT_GRACE_MS = 30 min` — próg wieku, zanim entitlement
 *      stanie się kandydatem.
 *   3. `SWEEP_MAX_ATTEMPT_COUNT (5) × cadence sweepa (15 min) = 75 min` —
 *      budżet realnych prób dosyłki dla jednego wiersza.
 *
 * Suma: 7 dni + 105 min. Zaokrąglone w GÓRĘ do 8 dni, bo okno DŁUŻSZE kosztuje
 * wyłącznie miejsce w tabeli (higiena), a okno KRÓTSZE kosztuje DRUGI MAIL do
 * klientki.
 *
 * DLACZEGO NIE 24 h (wartość `DEFAULT_TTL_MS` ze starej mapy): przepisanie jej
 * jest odrzucone wprost przez AC4. Zmierzona konsekwencja: dostawa, która
 * skończyła się timeoutem-after-send (mail MÓGŁ pójść), po 24 h przestawałaby
 * blokować, a sweep ma prawo wrócić po nią jeszcze przez sześć kolejnych dni —
 * czyli stara wartość produkowała duplikat w scenariuszu, który realnie
 * istnieje w tym repo. 24 h było poprawne dla mapy, która i tak ginęła przy
 * restarcie procesu; dla magazynu trwałego nie jest.
 *
 * Wartość produkcyjna jest WSTRZYKIWANA z `packages/api`, gdzie te trzy stałe
 * żyją — ta jest domyślną dla wołających spoza monorepo backendu i jest
 * pilnowana testem parity.
 */
export const DEFAULT_BARRIER_AMBIGUOUS_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
