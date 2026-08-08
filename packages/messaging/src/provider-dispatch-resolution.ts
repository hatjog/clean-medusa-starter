/**
 * provider-dispatch-resolution.ts — ROZSTRZYGANIE PO STRONIE DOSTAWCY.
 *
 * v1.15.0 Story 4.5 (FR-9f, NFR-1, NFR-4, AD-23).
 *
 * ── Jakie okno ten plik zamyka ─────────────────────────────────────────────
 * Story 4.1 postawiła barierę jako JEDNĄ operację atomową PRZED skutkiem i sama
 * nazwała, czego nie zamknęła (ADR-196 §D6): między `provider.send()`
 * (`gateway.ts`, wysyłka wychodzi do dostawcy) a `settleBarrier()` (domknięcie
 * zajęcia) leży okno. Jeśli przebieg w nim zginie — nie „rzuci wyjątkiem",
 * tylko ZGINIE, bez wykonania `catch` i bez wpisu do logu — zajęcie zostaje
 * `in_flight`, wygasa po 15 minutach i ponowienie wysyła DRUGI mail.
 *
 * Żadna liczba operacji atomowych PO NASZEJ STRONIE tego nie rozstrzygnie,
 * bo brakująca informacja — „czy wiadomość dotarła do dostawcy" — leży
 * po stronie dostawcy. FR-9(f) wymienia dokładnie dwie drogi i obie tam
 * prowadzą: albo dajemy dostawcy klucz, po którym sam odmówi duplikatu, albo
 * pytamy go o tożsamość wiadomości.
 *
 * ── Dlaczego droga „klucz idempotencji u dostawcy" jest ODRZUCONA ──────────
 * Bo została ZMIERZONA, a nie przeczytana (evidence
 * `implementation-artifacts/evidence/4-5/pomiar-zdolnosci-dostawcy.md`, P-1):
 * trzy wywołania `POST /v3/smtp/email` z identycznym payloadem i identyczną
 * wartością klucza — jako nagłówek `Idempotency-Key`, jako `idempotency-key`
 * i jako pole `idempotencyKey` w body — dały **HTTP 201 i trzy różne
 * `messageId`**. Brevo tych nośników nie odrzuca; IGNORUJE je, co jest gorsze,
 * bo wygląda na przyjęte.
 *
 * Zdanie „Brevo tego nie wspiera" istniało w tym repo już wcześniej
 * (`providers/brevo-adapter.ts`) i stało obok zdania FAŁSZYWEGO o kodzie
 * z tego samego komentarza („propagujemy `idempotency_key` w `params`" —
 * `CONTROL_KEYS` w `modules/notification-brevo/intent.ts` wycinał ten klucz,
 * więc do dostawcy nie jechało NIC). Dlatego pierwsza połowa dostała pomiar,
 * a druga została usunięta.
 *
 * ── Dlaczego „rozstrzyganie po identyfikatorze wiadomości" NIE MOŻE oznaczać
 *    naszego `provider_message_id` ──────────────────────────────────────────
 * Bo `provider_message_id` przychodzi w ODPOWIEDZI dostawcy, a chroniony
 * scenariusz to dokładnie ten, w którym odpowiedź nigdy nie została odczytana.
 * Mechanizm oparty na naszym zapisie nie ma danych w sytuacji, dla której jest
 * budowany. (Niezależnie: kolumna jest nullowalna i realnie bywa `NULL` —
 * zakup z 2026-08-01 dał dwa wiersze `sent` z `NULL`, `dispatch-ledger.ts`.)
 *
 * Dlatego tożsamość jest **nadana przez NAS** i **znana PRZED wysyłką**:
 * {@link buildDispatchIdentityTag} wyprowadza ją deterministycznie z klucza
 * bariery. Po śmierci procesu ponowienie odtworzy ją z tego samego intentu bez
 * dostępu do czegokolwiek, co tamten przebieg zdążył zapisać.
 *
 * ── Nośnik: pole `tags` w body, NIE nagłówek ───────────────────────────────
 * Zmierzone (P-2, P-3): `X-Mailin-Tag` dla wysyłek szablonowych **nie dojeżdża**
 * — odczyt po stronie dostawcy oddaje tag skonfigurowany NA SZABLONIE, a nasz
 * nagłówek znika bez śladu. Pole `tags` w body `sendTransacEmail` dojeżdża
 * i wraca w `GET /v3/smtp/emails` (latencja indeksacji zmierzona: 16 s < t ≤ 24 s,
 * czyli o dwa rzędy wielkości poniżej okna `in_flight` = 15 min, w którym ten
 * odczyt jest w ogóle wołany).
 *
 * @module provider-dispatch-resolution
 */
import { createHash } from "node:crypto";

/**
 * Kod wysyłki, gdy zajęcie zostało PRZEJĘTE po wygaśnięciu okna, a dostawca
 * NIE POTRAFIŁ odpowiedzieć, czy wiadomość już u niego jest.
 *
 * ── Dlaczego ten kod mieszka przy kodach bariery ───────────────────────────
 * Z tego samego powodu, co {@link MESSAGING_BARRIER_UNAVAILABLE}
 * (`idempotency-barrier.ts`): konsumentem klasyfikacji jest reconciliation
 * sweep w `packages/api`, a jego lista awarii globalnych musi widzieć KOMPLET
 * kodów bariery z JEDNEGO miejsca. Rozproszenie kodów bariery po plikach było
 * już raz defektem tej rodziny (R-4.1-H2) i skończyło się tym, że żaden z nich
 * nie trafił do klasyfikacji sweepa.
 *
 * ── Dlaczego to jest ODMOWA, a nie wysyłka ─────────────────────────────────
 * Bo alternatywą jest wysłanie w ciemno po przebiegu, który MÓGŁ już wysłać —
 * czyli dokładnie ten drugi mail do klientki, którego ta bariera zabrania.
 * Stan jest PRZEJŚCIOWY (rate limit dostawcy, sieć, brak poświadczeń) i ustępuje
 * bez udziału tego konkretnego wiersza, więc należy do
 * `MESSAGING_BARRIER_TRANSIENT_ERROR_CODES` i sweep po niego wróci.
 */
export const MESSAGING_BARRIER_RECLAIM_UNRESOLVED =
  "MESSAGING_BARRIER_RECLAIM_UNRESOLVED";

/**
 * Prefiks tożsamości wysyłki. Odróżnia nasze tagi od tagów konfigurowanych
 * na szablonie po stronie dostawcy — zmierzone współistnienie obu na jednym
 * wierszu odczytu (P-3).
 */
export const DISPATCH_IDENTITY_TAG_PREFIX = "gpd";

/**
 * Tożsamość POJEDYNCZEJ wysyłki, wieziona do dostawcy i odczytywana z powrotem.
 *
 * Trzy własności są wymagane i każda ma powód:
 *
 *  1. **Znana PRZED `provider.send`** — inaczej nie istnieje w scenariuszu,
 *     dla którego mechanizm powstaje (proces ginie przed odczytem odpowiedzi).
 *     Dlatego źródłem jest klucz bariery, a nie cokolwiek od dostawcy.
 *  2. **Deterministyczna** — ponowienie MUSI wyprowadzić tę samą wartość
 *     z tego samego intentu, bez dostępu do zapisów tamtego przebiegu.
 *  3. **Bez przecinka i bez danych osobowych** — wartość tagu jest po stronie
 *     dostawcy rozbijana po przecinku (zmierzone na `/v3/smtp/statistics/events`),
 *     a klucz bariery niesie `idempotency_key` call-site'u, który bywa
 *     wyprowadzony z identyfikatorów zamówienia. Skrót SHA-256 spełnia oba
 *     warunki naraz; 128 bitów wyklucza kolizję w populacji wysyłek.
 *
 * ── Dlaczego tożsamość obejmuje TAKŻE adres odbiorcy (R-4.5-M1) ────────────
 * Bo zapytanie odczytowe jest do adresu PRZYWIĄZANE i nie da się tego obejść:
 * `GET /v3/smtp/emails` bez `email` zwraca `400 missing_parameter` (P-6).
 * Dostawca odpowiada więc zawsze o JEDNEJ skrzynce — pytanie „czy ta wysyłka
 * już poszła" jest u niego z definicji pytaniem „czy poszła DO TEGO ADRESU".
 *
 * Gdy tożsamość adresu nie obejmowała (stan sprzed tej poprawki), a ponowienie
 * niosło inny adres przy tym samym `idempotency_key`, mechanizm pytał o tag
 * z klucza bariery w CUDZEJ skrzynce, nie znajdował go i zwracał `not_found` —
 * czyli zgodę na wysyłkę. Zmierzone (R-4.5-M1): na produkcyjnym `BrevoAdapter`
 * wynik brzmiał `not_found` tam, gdzie atrapa suity mówiła `confirmed_sent`.
 * Atrapa ignorowała `recipient_email` i była przez to SŁABSZA niż kontrakt,
 * który odwzorowuje.
 *
 * Po związaniu tożsamości z adresem oba stany świata się zgadzają: inny adres
 * = inna tożsamość = pytanie o właściwą skrzynkę. To NIE otwiera drogi do
 * duplikatu — duplikat jest zdefiniowany jako drugi mail do TEJ SAMEJ
 * klientki, a wysyłka pod inny adres nim nie jest. Klucz bariery pozostaje bez
 * adresu (kontrakt Story 4.1) i to jest świadome rozdzielenie: klucz mówi, co
 * jest „tą samą wysyłką" DLA NAS, tożsamość — o co potrafi odpowiedzieć DOSTAWCA.
 *
 * Adres jest NORMALIZOWANY (trim + małe litery) w tym jednym miejscu. Gdyby
 * normalizacja żyła u wołających, wysyłka i odczyt mogłyby wyprowadzić różne
 * tożsamości z tego samego adresu — a różnica jednej spacji znaczyłaby
 * `not_found`, czyli drugi mail.
 */
export function buildDispatchIdentityTag(
  barrierKey: string,
  recipientEmail: string,
): string {
  const digest = createHash("sha256")
    .update(`${barrierKey}|${normalizeRecipientEmail(recipientEmail)}`)
    .digest("hex");
  return `${DISPATCH_IDENTITY_TAG_PREFIX}${digest.slice(0, 32)}`;
}

/**
 * JEDYNE miejsce normalizacji adresu na potrzeby tożsamości wysyłki. Eksport
 * jest celowy: adapter i gateway muszą użyć TEJ SAMEJ funkcji, inaczej wracamy
 * do dwóch definicji „tego samego adresu".
 */
export function normalizeRecipientEmail(recipientEmail: string): string {
  return recipientEmail.trim().toLowerCase();
}

/** Zapytanie do dostawcy — wszystkie składniki znane PRZED wysyłką. */
export interface ProviderDispatchLookup {
  /** {@link buildDispatchIdentityTag} z klucza bariery tego intentu. */
  dispatch_identity: string;
  /** Adres odbiorcy — u dostawcy filtr OBOWIĄZKOWY (P-6). */
  recipient_email: string;
  /** Klucz szablonu — drugi filtr zawężający po stronie dostawcy. */
  template_key: string;
  /** Dolny brzeg okna ważności. Patrz {@link resolveLookbackWindowMs}. */
  sent_after: Date;
  /** Górny brzeg okna — baza czasu WOŁAJĄCEGO, jak w kontrakcie bariery. */
  now: Date;
}

export type ProviderDispatchResolution =
  /**
   * Dostawca POTWIERDZIŁ, że wiadomość o tej tożsamości u niego jest.
   * Wołający NIE WOLNO wysyłać ponownie; ma odtworzyć wynik i domknąć barierę
   * BEZTERMINOWO — czyli dokończyć to, czego martwy przebieg nie zdążył.
   */
  | {
      outcome: "confirmed_sent";
      provider_message_id?: string;
      sent_at?: string;
    }
  /**
   * Dostawca odpowiedział i w oknie ważności NIE MA wiadomości o tej tożsamości.
   * Wysyłka jest legalna.
   *
   * To jest jedyny werdykt, który otwiera drogę do providera po przejęciu
   * zajęcia — i dlatego wolno go zwrócić WYŁĄCZNIE po udanym odczycie.
   * „Nie udało mi się zapytać" to {@link ProviderDispatchResolution} `unknown`,
   * nigdy `not_found`; sklejenie tych dwóch stanów jest dokładnie tą klasą
   * cichej awarii, którą ta story zamyka.
   */
  | { outcome: "not_found" }
  /** Odczyt się nie powiódł albo dostawca nie ma takiej zdolności. */
  | { outcome: "unknown"; reason: string };

/**
 * Zdolność ROZSTRZYGANIA po stronie dostawcy. Świadomie ODDZIELNA od
 * `IMessagingProvider.send` i opcjonalna: providerzy bez tej zdolności
 * istnieją (SMS, push) i mają wtedy dostawać werdykt `unknown`, czyli ODMOWĘ
 * po przejęciu zajęcia — a nie cichą zgodę na wysyłkę.
 */
export interface IProviderDispatchResolver {
  resolveDispatched(
    lookup: ProviderDispatchLookup,
  ): Promise<ProviderDispatchResolution>;
}

/**
 * OKNO WAŻNOŚCI tej bariery — i miejsce, w którym jest egzekwowane (AD-23).
 *
 * ── Dlaczego to jest bariera BEZ WŁASNEGO WIERSZA SKUTKU ───────────────────
 * Bo jej nośnikiem jest tożsamość zdarzenia PO STRONIE DOSTAWCY, a nie wiersz
 * w naszej bazie. AD-23 mówi dla tego przypadku wprost: okno ważności
 * egzekwowane W PREDYKACIE OPERACJI, wywiedzione z horyzontu ponowień.
 *
 * ── Gdzie dokładnie siedzi to okno ─────────────────────────────────────────
 * W `startDate`/`endDate` TEGO SAMEGO zapytania, które rozstrzyga barierę
 * (`ProviderDispatchLookup.sent_after` → parametr zapytania do dostawcy).
 * Zmierzone, że dostawca ten predykat realnie egzekwuje: to samo zapytanie
 * z oknem zawężało wynik z 9 wierszy do 6, a z oknem sprzed lat dawało 0 (P-5).
 *
 * Konsekwencja jest ta sama, której wymaga AC3: ŻADEN PROCES SPRZĄTAJĄCY NIE
 * BIERZE W TYM UDZIAŁU. Nie ma crona, nie ma joba, nie ma filtra w kodzie po
 * odczycie „na wszelki wypadek" — jest jeden predykat w jednym zapytaniu.
 * Zatrzymanie czegokolwiek u nas nie zmienia werdyktu.
 *
 * ── Wyprowadzenie wartości (nie „bo pasuje do sąsiada") ────────────────────
 * Pytanie brzmi: jak długo TO SAMO zdarzenie może LEGALNIE wrócić i spowodować
 * drugi mail? Składniki zmierzone w kodzie sweepa, te same, z których 4.1
 * wyprowadziła `BARRIER_AMBIGUOUS_WINDOW_MS`:
 *
 *   1. `SWEEP_GAP_LOOKBACK_MS = 7 dni` — dokąd sweep w ogóle schodzi po luki.
 *   2. `SWEEP_ENTITLEMENT_GRACE_MS = 30 min` — próg wieku kandydata.
 *   3. `SWEEP_MAX_ATTEMPT_COUNT (5) × cadence (15 min) = 75 min` — budżet prób.
 *
 * Suma: 7 dni + 105 min, zaokrąglone w GÓRĘ do 8 dni.
 *
 * ── To jest ta sama liczba co okno niejednoznaczne — I TO JEST POWÓD, ──────
 * a nie zbieg okoliczności ani przepisanie. Oba okna odpowiadają na TO SAMO
 * pytanie („dokąd sięga legalne ponowienie"), więc wyprowadzenie musi dać tę
 * samą liczbę; różna byłaby sygnałem błędu w jednym z nich. Nie jest to jednak
 * ta sama STAŁA: tamta opisuje, jak długo NASZ wiersz blokuje, ta — jak głęboko
 * pytamy DOSTAWCĘ. Parity pilnuje test, który pęka po zmianie którejkolwiek
 * z osobna.
 *
 * ── Co jest BEZTERMINOWE, a co ma OKNO (rozróżnienie wymagane przez AC3) ───
 *  * BEZTERMINOWE — werdykt `confirmed_sent`. Po potwierdzeniu „poszło" wołający
 *    domyka barierę z `expires_at = null` i od tej chwili rozstrzyga TANI odczyt
 *    naszego wiersza, bez pytania dostawcy. Ten stan nie wygasa NIGDY, bo mail
 *    już dotarł do klientki i żaden upływ czasu tego nie odwoła.
 *  * OKNO — stan NIEROZSTRZYGNIĘTY, czyli samo pytanie do dostawcy. Poza oknem
 *    dostawca nie odpowiada wiarygodnie, więc pytanie traci sens.
 *
 * Pomieszanie tych dwóch semantyk w jednym predykacie byłoby RED w którąś
 * stronę: albo mail idzie drugi raz po wygaśnięciu, albo legalne ponowienie
 * jest blokowane na zawsze. Dlatego wygasanie dotyczy WYŁĄCZNIE zapytania,
 * a potwierdzenie zapisuje się w barierze bez daty.
 */
export const DISPATCH_RESOLUTION_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

/** Dolny brzeg okna dla podanej bazy czasu. Jedyne miejsce, gdzie się go liczy. */
export function resolveLookbackWindowMs(): number {
  return DISPATCH_RESOLUTION_LOOKBACK_MS;
}

/**
 * Okno bariery po ODMOWIE NIEROZSTRZYGNIĘTEJ — 15 minut (R-4.5-H1).
 *
 * ── Jaki defekt ta stała zamyka ────────────────────────────────────────────
 * Do poprawki cyklu 1 gałąź `unknown` wołała `release()`, a `release()` to
 * `DELETE`. Kasowała więc WIERSZ, w którym mieszka `claim_count` — czyli
 * JEDYNY sygnał, po którym gateway w ogóle wie, że ma zapytać dostawcę.
 * Zmierzona konsekwencja: przebieg A wysyłał i ginął, przebieg B dostawał
 * `unknown` i kasował wiersz, przebieg C zajmował klucz OD ZERA
 * (`claim_count = 1`), rozstrzygania NIE WOŁAŁ i wysyłał DRUGI MAIL. Ścieżka
 * nie była hipotetyczna: `MESSAGING_BARRIER_RECLAIM_UNRESOLVED` jest
 * w `MESSAGING_BARRIER_TRANSIENT_ERROR_CODES`, więc sweep po ten wiersz WRACA
 * z założenia.
 *
 * Odmowa domyka więc barierę z OKNEM zamiast kasować nośnik sygnału.
 * `settle` nie rusza `claim_count` (ani w SQL, ani w atrapie), więc kolejne
 * przejęcie dostaje `> 1` i znowu pyta dostawcę.
 *
 * ── WYPROWADZENIE wartości ─────────────────────────────────────────────────
 * To jest CADENCE SWEEPA — najkrótszy odstęp, po jakim to samo zdarzenie może
 * legalnie wrócić (`SWEEP_MAX_ATTEMPT_COUNT × 15 min` w wyprowadzeniu
 * {@link DISPATCH_RESOLUTION_LOOKBACK_MS}). Krótsze okno kazałoby ponowieniu
 * pytać dostawcę częściej, niż cokolwiek u niego może się zmienić; dłuższe
 * opóźniałoby dostawę ponad horyzont, w którym sweep ma prawo próbować.
 *
 * NIE jest to okno {@link DISPATCH_RESOLUTION_LOOKBACK_MS} (8 dni): tamto
 * mówi, JAK GŁĘBOKO pytamy dostawcę, to — JAK DŁUGO czekamy z kolejnym
 * pytaniem. Zlanie ich dałoby dostawę wstrzymaną na osiem dni za awarię
 * odczytu, która minęła po minucie.
 */
export const DISPATCH_UNRESOLVED_RETRY_WINDOW_MS = 15 * 60 * 1000;
