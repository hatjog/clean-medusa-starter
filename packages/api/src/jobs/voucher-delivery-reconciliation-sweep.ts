/**
 * voucher-delivery-reconciliation-sweep.ts — Story 2.5 (v1.14.0; FR-13, FR-16,
 * FR-16a, NFR3; AD-7 §sweep, metryka PRD §6).
 *
 * ── Po co ten job istnieje (inwariant kompletności, nie „nice-to-have") ──────
 * AD-7 mówi wprost: emit `gp.entitlements.entitlement_state_changed.v1` jest
 * **post-commit best-effort, bez outboxa**. Crash albo dwukrotna porażka emitu
 * oznacza, że mail nie poleci NIGDY i nikt się o tym nie dowie. Ledger 2.3
 * (`voucher_delivery_dispatch`) czyni ten stan WYKRYWALNYM; ten job czyni go
 * NAPRAWIALNYM. Sweep JEST wybranym mechanizmem gwarancji — nie protezą po
 * brakującym outboxie (AD-7 odrzuca outbox świadomie).
 *
 * ── Jedna ścieżka wysyłki (AD-7 single-writer) ──────────────────────────────
 * Sweep NIE wysyła sam. Buduje syntetyczny trigger w kształcie koperty eventu
 * i woła **ten sam czysty handler co subscriber** —
 * `handleVoucherPurchaseDelivery(data, deps)` z 2.3. Handler jest importowany
 * STATYCZNIE (nie wstrzykiwany), więc druga implementacja wysyłki nie może
 * powstać przez pomyłkę w wiringu. Idempotencję daje ledger: `sent`/`delivered`
 * blokują bezwarunkowo, więc wyścig sweep × subscriber kończy się JEDNYM mailem
 * niezależnie od kolejności.
 *
 * ── Trzy kształty luki, które sweep dogania ─────────────────────────────────
 *   1. **Brak wiersza** — zgubiony event (kanoniczna awaria z AD-7).
 *   2. **Porzucony `queued`** — crash procesu między INSERT-em a domknięciem.
 *      2.3 oddelegowało ten przypadek WPROST tutaj (`skipped_in_flight`).
 *      Reguła: patrz D3 poniżej.
 *   3. **`failed`/`retrying`** — legalny retry wg semantyki 2.3; sweep jest
 *      jedynym silnikiem retry, jaki ta ścieżka ma.
 * `sent`/`delivered`/`degraded` i `dead_lettered` NIE są dogadniane: pierwsze
 * trzy znaczą „mail poszedł", `dead_lettered` wymaga decyzji operatora.
 *
 * ── D1 — cadence (`[ASSUMPTION]` 15 min) ────────────────────────────────────
 * `SCHEDULE_CRON` = co 15 min; `[ASSUMPTION]` UTRZYMANY. Cadence i próg wieku to
 * DWIE RÓŻNE liczby i nie wolno ich mylić:
 *   - **cadence 15 min** = jak często sweep patrzy;
 *   - **próg wieku `SWEEP_ENTITLEMENT_GRACE_MS` = 30 min** = jak stary musi być
 *     entitlement, żeby jego brak wysyłki był uznany za lukę, a nie za wysyłkę
 *     w locie.
 * Pełne uzasadnienie i odrzucona alternatywa: story 2.5, `### Decyzje
 * rozstrzygnięte w tej story`.
 *
 * ── D2 — nośnik metryki: licznik PostHog ────────────────────────────────────
 * `epics.md` stawiał parę „raport FR-23 vs Sentry"; wybrany jest **trzeci
 * wariant realnie zastany w jobach tego repo** (`posthog?.capture(...)` —
 * `entitlement-expiry-sweeper.ts`, `alert-evaluator-cron.ts`). To JAWNE odejście
 * od pary z epics.md; uzasadnienie i weryfikacja realizmu FR-23 (verb `gp-ops
 * report-content-state` czyta YAML gp-ops, NIE bazę delivery) są w story.
 *
 * R-2.5-H2: zastany wzorzec był **martwy** — klucza `"posthog"` nikt nie
 * rejestrował, więc każdy `capture` był no-opem i alert AC3 nie mógł powstać.
 * Nośnik jest domknięty loaderem (`loaders/posthog.ts` →
 * `lib/instrumentation/posthog-metrics-client.ts`, lazy `POSTHOG_API_KEY`),
 * a brak klucza zostawia JEDEN `warn` na proces. Metryka pozostaje opcjonalna,
 * więc każdy licznik ma też ślad w logu podsumowującym — ale cisza nie jest już
 * stanem domyślnym.
 *
 * ── Okno skanu (R-2.5-H1) ───────────────────────────────────────────────────
 * Skan ma OBIE granice wieku. Górna (`SWEEP_ENTITLEMENT_GRACE_MS`) chroni przed
 * wyścigiem z wysyłką w locie, dolna (`SWEEP_GAP_LOOKBACK_MS`, opcjonalnie
 * zawężona kotwicą `GP_VOUCHER_DELIVERY_SWEEP_EPOCH`) chroni przed dosyłką do
 * CAŁEJ historii sprzed istnienia ledgera (2.3). Backfill starszy niż okno jest
 * decyzją PO i operacją ręczną — nigdy domyślnym zachowaniem crona.
 *
 * ── Granice ─────────────────────────────────────────────────────────────────
 * Job NIE emituje `gp.communication.delivery_state_changed.v1` (AD-7: enum
 * zapożyczony, event nie), NIE buduje outboxa, NIE woła `createNotifications`
 * bezpośrednio, NIE pisze do ledgera z pominięciem jego API i NIGDY nie rzuca
 * wyjątku wywracającego scheduler.
 *
 * Kill-switch `FLOW_DISABLED` (ADR-161) działa na sweep tak samo jak na
 * subscribera, bo dosyłka idzie tą samą ścieżką: przy wyłączonym flow wysyłka
 * kończy się wierszem `failed` z kodem `FLOW_DISABLED`.
 *
 * R-2.5-H3 — parkowanie jest ODWRACALNE. Awaria GLOBALNA (kill-switch, brak
 * szablonu dla locale do Epiku 4, brak konfiguracji providera) NIE zużywa
 * budżetu prób: sweep zwraca próbę przez `releaseAttemptBudget`, więc po
 * usunięciu przyczyny mail dojdzie bez ręcznego UPDATE na produkcyjnej bazie.
 * Budżet `SWEEP_MAX_ATTEMPT_COUNT` obowiązuje wyłącznie realne odrzucenia
 * wysyłki, a wiersze, które go wyczerpały, są WYKLUCZONE ze skanu (żeby nie
 * zjadały batcha) i widoczne osobnym licznikiem zaparkowanych.
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { isNotificationProviderReadyForSweep } from "../lib/vendor-notification-provider-readiness"
import {
  getPosthogCaptureClient,
  POSTHOG_CONTAINER_KEY,
  type PosthogCaptureClient,
} from "../lib/instrumentation/posthog-metrics-client"
import {
  createMarketLocalesReader,
  type MarketLocalesSql,
} from "../lib/read-market-locales"
import { VOUCHER_MODULE } from "../modules/voucher"
import {
  PgDispatchLedger,
  type DeliveryGapCandidate,
  type DeliveryGapScanPort,
  type DispatchLedgerSql,
} from "../modules/voucher-delivery/dispatch-ledger"
import { DISPATCH_STATES_ALLOWING_RETRY } from "../modules/voucher-delivery/delivery-state"
import {
  ENTITLEMENT_STATE_CHANGED_EVENT,
  handleVoucherPurchaseDelivery,
  MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
  MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE,
  MARKET_RUNTIME_CONFIG_UNAVAILABLE_ERROR_CODE,
  STALE_QUEUED_THRESHOLD_MS,
  type PurchaseDeliveryDeps,
  type PurchaseDeliveryOutcome,
  type PurchaseDeliveryResult,
  type PurchaseDeliverySourceReader,
} from "../subscribers/voucher-purchase-delivery"
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

export const SCHEDULE_NAME = "voucher-delivery-reconciliation-sweep" as const

/**
 * D1 — cadence sweepa. `[ASSUMPTION]` 15 min z epics.md / AD-7 UTRZYMANY.
 * NIE mylić z progiem wieku (`SWEEP_ENTITLEMENT_GRACE_MS`): to „jak często
 * patrzymy", nie „od kiedy uznajemy brak maila za lukę".
 */
export const SCHEDULE_CRON = "*/15 * * * *" as const

/**
 * D1 — próg wieku (grace-window). Entitlement młodszy niż 30 minut NIE jest
 * kandydatem: legalna wysyłka może być w locie i sweep nie może się z nią
 * ścigać. Wartość jest 2× cadence i ≥ `STALE_QUEUED_THRESHOLD_MS` (15 min),
 * czyli progu, po którym 2.3 uznaje rezerwację za porzuconą — dzięki temu
 * „entitlement jest już kandydatem" nigdy nie wyprzedza „rezerwacja jest już
 * rozstrzygnięta".
 */
export const SWEEP_ENTITLEMENT_GRACE_MS = 30 * 60 * 1000

/**
 * D3 — próg porzucenia rezerwacji `queued`. REUŻYWA stałej z 2.3, żeby nie
 * powstała druga, rozjeżdżalna definicja „porzuconego queued": subscriber
 * loguje `stale_queued` po tym samym czasie, po którym sweep przejmuje wiersz.
 */
export const SWEEP_STALE_QUEUED_MS = STALE_QUEUED_THRESHOLD_MS

/**
 * Bounded batch (AC1): maksymalna liczba WIERSZY skanu na przebieg. Jeden
 * przebieg na zaległościach nie może zablokować puli połączeń ani wystrzelić
 * nieograniczonej liczby maili. Pominięta reszta jest logowana i dogoniona
 * w kolejnym przebiegu.
 */
export const SWEEP_BATCH_LIMIT = 200

/**
 * Górna granica prób dosyłki dla JEDNEGO wiersza ledgera — budżet REALNYCH
 * odrzuceń wysyłki. Wiersz, który go wyczerpał, jest ZAPARKOWANY: nie wraca ze
 * skanu (żeby nie zjadał batcha, R-2.5-H3) i jest raportowany osobnym
 * licznikiem, więc alert na nim nie gaśnie.
 *
 * Awarie GLOBALNE (patrz `SWEEP_GLOBAL_FAILURE_ERROR_CODES`) budżetu NIE
 * zużywają — inaczej odwracalna awaria konfiguracji zamieniałaby się po 5
 * przebiegach (75 min) w trwałą utratę maili dla całego okna awarii.
 */
export const SWEEP_MAX_ATTEMPT_COUNT = 5

/**
 * Najwyżej jedno automatyczne odzyskanie budżetu konfiguracji na wiersz.
 *
 * Retry dostaje szansę po poprawce konfiguracji bez ręcznego UPDATE, ale
 * kod, który został utracony przez warstwę pośrednią, nie może odparkowywać
 * tego samego dispatchu w nieskończoność. Kolejny przypadek pozostaje
 * zaparkowany i widoczny w metryce operatorskiej.
 */
export const SWEEP_MAX_CONFIGURATION_RECOVERIES = 1

/**
 * Okno skanu i licznika granicy H1 (7 dni) — JEDNA stała, bo obie liczby muszą
 * mówić o tym samym zbiorze (R-2.5-H1/L11). Skan bez dolnej granicy dosyłałby
 * maile do całej historii sprzed ledgera 2.3, a COUNT bez niej rósłby z całą
 * historią przy każdym przebiegu.
 */
export const SWEEP_GAP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/** Nazwa zachowana dla czytelności call-site'u licznika granicy H1. */
export const SWEEP_BEYOND_STATE_LOOKBACK_MS = SWEEP_GAP_LOOKBACK_MS

/**
 * Kotwica czasowa (R-2.5-H1): opcjonalna data ISO 8601, PRZED którą sweep nie
 * schodzi NIGDY, nawet gdyby okno `SWEEP_GAP_LOOKBACK_MS` sięgało dalej.
 * Naturalna wartość to data wdrożenia ledgera 2.3 na danym środowisku.
 * Wartość węższa z dwóch wygrywa; nieparsowalna jest ignorowana z `warn`
 * (kotwica nie może rozszerzyć okna — tylko je zawęzić).
 */
export const SWEEP_LEDGER_EPOCH_ENV = "GP_VOUCHER_DELIVERY_SWEEP_EPOCH" as const

/**
 * R-2.5-H4 — typy z taksonomii L1, których dotyczy matryca AD-7. Bez tego
 * filtra `SUBSCRIPTION_B2C`/`SUBSCRIPTION_B2B`/`CREDIT_PACK`/`BUNDLE` w stanie
 * ISSUED/ACTIVE są „lukami buyer-maila", których `voucher_purchase_confirmation`
 * nie dotyczy i nigdy nie będzie dotyczyć: automat je obsłuży, odrzuci i zobaczy
 * ponownie za 15 minut — a alert nie ma jak zgasnąć.
 */
export const SWEEP_SOURCE_ENTITLEMENT_TYPES = [
  "VOUCHER_AMOUNT",
  "VOUCHER_SERVICE",
] as const

/**
 * R-2.5-H3 — kody awarii GLOBALNEJ: nie są odrzuceniem wysyłki przez providera,
 * tylko stanem konfiguracji/środowiska, który dotyczy WSZYSTKICH wierszy naraz
 * i ustępuje bez ich udziału (kill-switch, szablon locale dowieziony w Epiku 4,
 * konfiguracja providera). Takie próby są zwracane do budżetu, więc parkowanie
 * pozostaje odwracalne bez ręcznej interwencji w bazie.
 */
export const SWEEP_GLOBAL_FAILURE_ERROR_CODES: readonly string[] = [
  "FLOW_DISABLED",
  MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
  // Story 5.7 fix-round: `market_runtime_config` bez tabeli / bez kompletu
  // danych to stan KONFIGURACJI rynku — ustępuje po `db:migrate:app` albo
  // `gp-config-sync-market-runtime --apply`, bez udziału wiersza. Bez tego
  // wpisu poprawka konfiguracji nie odparkowywałaby wierszy, które ta awaria
  // zaparkowała, i mail przepadałby dla całego okna awarii.
  MARKET_RUNTIME_CONFIG_UNAVAILABLE_ERROR_CODE,
  MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE,
  // Kształt bazy deep-linku: `..._NOT_CONFIGURED` łapie sufiks, `..._NOT_REACHABLE`
  // nie — a jest tą samą klasą (env rynku do poprawienia przez operatora).
  "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_REACHABLE",
  // Żywy zakup 2026-08-04 (zamówienie 20): Brevo odrzucał HTTP 401
  // `unauthorized`, bo adres IP hosta nie był autoryzowany na koncie. To stan
  // KONFIGURACJI po stronie operatora, dotyczy WSZYSTKICH wierszy naraz i
  // ustępuje bez ich udziału — dokładnie ta klasa, dla której ta lista powstała.
  // Zmierzone: 3 z 5 prób (13:16, 14:00, 14:15) poszły wyłącznie na okno
  // propagacji autoryzacji IP; sonda o 14:16 na `POST /v3/smtp/email` wróciła
  // HTTP 201, czyli poprawka operatora ZADZIAŁAŁA, tylko budżet już się palił.
  // Bez tego wpisu odwracalna blokada zamieniałaby się po 75 min w trwałe
  // zaparkowanie wiersza.
  //
  // ZAKRES ŚWIADOMIE WĄSKI: to NIE jest „każde 401 od providera". Kod
  // `BREVO_INVALID_API_KEY` (i pochodne dotyczące samego klucza) NIE ustępuje
  // sam — nie może odparkowywać wierszy w nieskończoność. Ochroną drugiego
  // rzędu pozostaje `SWEEP_MAX_CONFIGURATION_RECOVERIES`.
  "BREVO_UNAUTHORIZED",
]

/** Sufiks kodów konfiguracyjnych (`BREVO_TEMPLATE_NOT_CONFIGURED` itp.). */
const GLOBAL_FAILURE_CODE_SUFFIX = "_NOT_CONFIGURED"

export function isGlobalFailureErrorCode(code: string | null): boolean {
  if (!code) return false
  return (
    SWEEP_GLOBAL_FAILURE_ERROR_CODES.includes(code) ||
    code.endsWith(GLOBAL_FAILURE_CODE_SUFFIX)
  )
}

/**
 * Wyniki handlera, które znaczą „luka jest NIEDOMYKALNA przez automat": brak
 * encji źródłowej, brak odbiorcy, brak kodu vouchera. Nie tworzą wiersza
 * ledgera, więc nie ma czego parkować — muszą mieć WŁASNY licznik, inaczej
 * alert „luka otwarta" nigdy nie zgaśnie (R-2.5-H4, R-2.5-I14).
 * Poziom logu jest `error`: brak danych źródłowych to alarm, nie `continue`.
 */
const UNRESOLVABLE_OUTCOMES: readonly PurchaseDeliveryOutcome[] = [
  "skipped_source_not_found",
  "skipped_missing_recipient",
  "skipped_missing_voucher_code",
]

/**
 * Stany `entitlement_instance`, w których wysyłka jest jeszcze oczekiwana —
 * dokładnie matryca AD-7 (`DELIVERABLE_TO_STATES` w subscriberze).
 *
 * GRANICA (lekcja H1 z `voucher-ledger-reconciliation`): skan po BIEŻĄCYM
 * stanie jest z definicji częściowo fail-open — entitlement może awansować do
 * REDEEMED/EXPIRED/CLOSED, zanim sweep zobaczy lukę, i wtedy z tego zbioru
 * wypada. Świadomie NIE rozszerzamy zbioru: dosyłka „kupiłaś voucher" do
 * entitlementu już zrealizowanego albo wygasłego jest szkodliwa, a handler
 * i tak odrzuciłby taki stan (poza matrycą AD-7). Granica nie jest jednak cicha:
 * `countGapsBeyondSourceStates` liczy te przypadki i sweep raportuje je jako
 * `gap_beyond_source_states` — luka poza zasięgiem automatu jest WIDOCZNA,
 * a decyzja o ręcznej dosyłce należy do operatora.
 */
export const SWEEP_SOURCE_STATES = ["ISSUED", "ACTIVE"] as const

/**
 * Zbiór OCZEKIWANYCH szablonów. Parametr skanu, nie literał w SQL-u: dołożenie
 * `voucher_handoff_link` (Story 2.4) nie wymaga przepisania zapytania.
 *
 * Dziś zbiór zawiera WYŁĄCZNIE `voucher_purchase_confirmation` — jedyny szablon
 * matrycy AD-7, który jest BEZWARUNKOWY. `voucher_handoff_link` jest warunkowy
 * (`purchase_mode = gift` ∧ send-timing „od razu"), a warunek żyje w
 * `line_item.metadata` zamówienia, nie w `entitlement_instance` — SQL skanu nie
 * ma go z czego wyliczyć. Wpisanie go tutaj zamieniłoby KAŻDY zakup dla siebie
 * w permanentną „lukę", więc alert nigdy by nie zgasł.
 *
 * Konsekwencja jest korzystna: luka na szablonie bezwarunkowym wystarcza, by
 * uruchomić handler, a handler dosyła OBA szablony (ledger deduplikuje), więc
 * prezent zgubiony razem z buyer-mailem też jest dogoniony. Nie jest dogoniony
 * przypadek „buyer-mail poszedł, handoff zginął osobno" — to jawna granica
 * 2.5, właściciel domknięcia: story 2.4 / follow-up (patrz Completion Notes).
 */
export const SWEEP_EXPECTED_TEMPLATE_KEYS = [
  NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION,
] as const

/** Kod zapisywany przy przejęciu porzuconej rezerwacji `queued` (D3). */
export const ABANDONED_QUEUED_ERROR_CODE =
  "VOUCHER_DELIVERY_QUEUED_ABANDONED" as const

/** Nazwy metryk — stałe, żeby dashboard i test odwoływały się do jednego literału. */
export const METRIC_GAP = "gp.voucher_delivery.reconciliation_sweep.gap" as const
export const METRIC_HEARTBEAT =
  "gp.voucher_delivery.reconciliation_sweep.heartbeat" as const

/**
 * Logger sweepa. `error` przyjmuje `unknown` w drugim argumencie, żeby ta sama
 * instancja spełniała kontrakt `LoggerLike` subscribera (który przekazuje tam
 * wyjątek) — inaczej sweep musiałby trzymać dwa loggery.
 */
export type SweepLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: unknown) => void
}

/**
 * Port metryki (D2). Kształt jest celowo węższy niż klient PostHoga — job nie
 * może zależeć od konkretnego SDK, a test musi umieć zasserować payload.
 * Payload NIGDY nie zawiera PII: wyłącznie liczniki i `market_id` (D-70).
 */
export type SweepMetricsPort = {
  capture: (event: string, properties: Record<string, unknown>) => void
}

export type SweepRunStatus =
  /** Przebieg wykonany (nawet jeśli 0 luk). */
  | "completed"
  /** AC4 — brak readiness-green providera: zero zapytań, zero wysyłek. */
  | "skipped_provider_not_ready"
  /** Skan luk padł — job nie rzuca, ale nie udaje sukcesu „0 luk". */
  | "scan_failed"

/**
 * Liczniki per rynek (AC3 — wymiar `market_id`).
 *
 * R-2.5-M7/L10: jednostką jest ENTITLEMENT (nie para entitlement × szablon),
 * a zbiór kubełków jest DOMKNIĘTY:
 *   `found = recovered + still_failing + unresolvable + exhausted + skipped
 *            + state_mismatch + errored`
 * Bez tej domkniętości nie da się napisać reguły alertu „luka domknięta",
 * bo rynek z samymi `skipped`/`exhausted` raportowałby „nic się nie zepsuło".
 * Handoff (drugi szablon matrycy AD-7) ma WŁASNE pola — mieszanie go z
 * buyer-mailem łamało relację `found` ↔ wynik.
 */
export type SweepMarketCounters = {
  market_id: string
  /** Luka WYKRYTA (rozmiar luki przed dosyłką), per entitlement. */
  found: number
  /** Luka DOMKNIĘTA (mail poszedł w tym przebiegu). */
  recovered: number
  /** Luka NADAL otwarta po próbie dosyłki (wiersz `failed`). */
  still_failing: number
  /** Luka NIEDOMYKALNA przez automat (brak danych źródłowych) — alarm. */
  unresolvable: number
  /** Wiersz zaparkowany (wyczerpany budżet prób) — czeka na decyzję operatora. */
  exhausted: number
  /** Pominięte bez rozstrzygnięcia (wyścig o rezerwację, wysyłka w locie). */
  skipped: number
  /** Rozjazd skanu i semantyki stanów — „nie powinno się zdarzyć". */
  state_mismatch: number
  /** Wyjątek per-wiersz (przebieg kontynuowany). */
  errored: number
  /** Wysyłka handoffu (2.4) domknięta w tym przebiegu. */
  handoff_recovered: number
  /** Wysyłka handoffu nadal nieudana. */
  handoff_still_failing: number
  /** Wiersze zaparkowane w ledgerze dla tego rynku (stan, nie zdarzenie). */
  parked: number
}

export type SweepReport = {
  status: SweepRunStatus
  /** Wiersze zwrócone ze skanu — PARY entitlement × szablon (R-2.5-L10). */
  scanned: number
  /** Unikalne entitlementy w batchu (jednostka liczników per-market). */
  entitlements_scanned: number
  /** Entitlementy, dla których uruchomiono ścieżkę subscribera. */
  attempted: number
  recovered: number
  still_failing: number
  /** Brak danych źródłowych — luka niedomykalna przez automat (alarm). */
  unresolvable: number
  /** Pominięte bez rozstrzygnięcia (rezerwacja przejęta przez kogoś innego). */
  skipped: number
  /** Rozjazd zapytania skanu i semantyki stanów (logowany jako `error`). */
  state_mismatch: number
  /** Wiersze z wyczerpanym budżetem prób napotkane w tym przebiegu. */
  exhausted: number
  /** Wiersze zaparkowane w ledgerze OGÓŁEM (stan bazy, nie tego przebiegu). */
  parked_total: number
  /** Zwroty budżetu prób po awarii globalnej (odparkowanie, R-2.5-H3). */
  attempt_budget_released: number
  /** Przejęte porzucone rezerwacje `queued` (D3). */
  reclaimed_queued: number
  /** Wyjątki per-wiersz (przebieg kontynuowany). */
  errored: number
  /** Wysyłki handoffu (2.4) domknięte / nadal nieudane. */
  handoff_recovered: number
  handoff_still_failing: number
  /** Skan dobił do limitu — reszta zaległości czeka na kolejny przebieg. */
  truncated: boolean
  /** Granica H1 — luki poza `SWEEP_SOURCE_STATES` (liczone, NIE dosyłane). */
  gap_beyond_source_states: number
  /** Okno skanu (R-2.5-H1) — ISO 8601, raportowane, nie domyślane. */
  scan_window_from: string | null
  scan_window_to: string | null
  per_market: SweepMarketCounters[]
}

export type SweepDeps = {
  scanner: DeliveryGapScanPort
  /**
   * Porty ścieżki subscribera z 2.3. Sweep przekazuje je do
   * `handleVoucherPurchaseDelivery` — nie ma tu drugiej implementacji wysyłki.
   */
  delivery: PurchaseDeliveryDeps
  logger: SweepLogger
  metrics?: SweepMetricsPort
  now?: () => Date
  /**
   * AC4 — gate readiness; domyślnie helper z 2.2 w wariancie dla automatów
   * (R-2.5-M5): shim RESEND/SENDGRID/SMTP NIE jest gotowością dla sweepa.
   */
  isProviderReady?: () => boolean
  templateKeys?: readonly string[]
  entitlementTypes?: readonly string[]
  batchLimit?: number
  /** Okno skanu — nadpisywalne w testach; domyślnie `SWEEP_GAP_LOOKBACK_MS`. */
  lookbackMs?: number
  env?: NodeJS.ProcessEnv
}

function emptyReport(status: SweepRunStatus): SweepReport {
  return {
    status,
    scanned: 0,
    entitlements_scanned: 0,
    attempted: 0,
    recovered: 0,
    still_failing: 0,
    unresolvable: 0,
    skipped: 0,
    state_mismatch: 0,
    exhausted: 0,
    parked_total: 0,
    attempt_budget_released: 0,
    reclaimed_queued: 0,
    errored: 0,
    handoff_recovered: 0,
    handoff_still_failing: 0,
    truncated: false,
    gap_beyond_source_states: 0,
    scan_window_from: null,
    scan_window_to: null,
    per_market: [],
  }
}

/** Klucz wymiaru metryki dla entitlementu bez `market_id` w projekcji. */
const UNKNOWN_MARKET = "unknown"

/** Kubełki ROZŁĄCZNE — dokładnie jeden na entitlement (domknięcie `found`). */
type SweepBucket =
  | "recovered"
  | "still_failing"
  | "unresolvable"
  | "exhausted"
  | "skipped"
  | "state_mismatch"
  | "errored"

/** Kubełki mapują się na pola LICZBOWE — `market_id` nie jest licznikiem. */
type SweepCounterField = {
  [K in keyof SweepMarketCounters]: SweepMarketCounters[K] extends number
    ? K
    : never
}[keyof SweepMarketCounters]

const BUCKET_FIELD: Record<SweepBucket, SweepCounterField> = {
  recovered: "recovered",
  still_failing: "still_failing",
  unresolvable: "unresolvable",
  exhausted: "exhausted",
  skipped: "skipped",
  state_mismatch: "state_mismatch",
  errored: "errored",
}

class MarketTally {
  private readonly rows = new Map<string, SweepMarketCounters>()

  private row(marketId: string | null): SweepMarketCounters {
    const key = marketId ?? UNKNOWN_MARKET
    const existing = this.rows.get(key)
    if (existing) return existing
    const fresh: SweepMarketCounters = {
      market_id: key,
      found: 0,
      recovered: 0,
      still_failing: 0,
      unresolvable: 0,
      exhausted: 0,
      skipped: 0,
      state_mismatch: 0,
      errored: 0,
      handoff_recovered: 0,
      handoff_still_failing: 0,
      parked: 0,
    }
    this.rows.set(key, fresh)
    return fresh
  }

  /** Luka wykryta + jej JEDYNE rozstrzygnięcie — zawsze razem, na jednym rynku. */
  resolve(marketId: string | null, bucket: SweepBucket): void {
    const row = this.row(marketId)
    row.found += 1
    row[BUCKET_FIELD[bucket]] += 1
  }

  handoff(marketId: string | null, outcome: "sent" | "failed"): void {
    const row = this.row(marketId)
    if (outcome === "sent") row.handoff_recovered += 1
    else row.handoff_still_failing += 1
  }

  parked(marketId: string | null, count: number): void {
    this.row(marketId).parked += count
  }

  toArray(): SweepMarketCounters[] {
    return [...this.rows.values()].sort((a, b) =>
      a.market_id.localeCompare(b.market_id),
    )
  }
}

/** Grupa wierszy skanu dla JEDNEGO entitlementu (dosyłka jest per entitlement). */
type SweepTarget = {
  entitlement_id: string
  candidate: DeliveryGapCandidate
  rows: DeliveryGapCandidate[]
}

/**
 * R-2.5-H1 — okno skanu. Dolna granica to węższa z dwóch: `now − lookback`
 * albo kotwica `GP_VOUCHER_DELIVERY_SWEEP_EPOCH` (data wdrożenia ledgera).
 * Kotwica może okno WYŁĄCZNIE zawęzić — nigdy rozszerzyć.
 */
export function resolveScanWindowStart(
  startedAt: Date,
  lookbackMs: number,
  env: NodeJS.ProcessEnv,
  logger?: SweepLogger,
): Date {
  const rolling = new Date(startedAt.getTime() - lookbackMs)
  const raw = env[SWEEP_LEDGER_EPOCH_ENV]?.trim()
  if (!raw) return rolling

  const epoch = new Date(raw)
  if (Number.isNaN(epoch.getTime())) {
    logger?.warn(
      `[${SCHEDULE_NAME}] ${SWEEP_LEDGER_EPOCH_ENV} nie jest datą ISO 8601 — ` +
        "kotwica zignorowana, obowiązuje okno kroczące",
      { raw_length: raw.length },
    )
    return rolling
  }

  return epoch.getTime() > rolling.getTime() ? epoch : rolling
}

/**
 * Rdzeń sweepa — czysta funkcja na wstrzykiwanych portach. Testowalna bez
 * kontenera Medusy, bez żywego Postgresa i bez sieci. NIGDY nie rzuca.
 */
export async function runVoucherDeliveryReconciliationSweep(
  deps: SweepDeps,
): Promise<SweepReport> {
  const { scanner, logger, metrics } = deps
  const now = deps.now ?? (() => new Date())
  const isReady = deps.isProviderReady ?? isNotificationProviderReadyForSweep
  const templateKeys =
    deps.templateKeys && deps.templateKeys.length > 0
      ? deps.templateKeys
      : SWEEP_EXPECTED_TEMPLATE_KEYS
  const entitlementTypes =
    deps.entitlementTypes && deps.entitlementTypes.length > 0
      ? deps.entitlementTypes
      : SWEEP_SOURCE_ENTITLEMENT_TYPES
  const batchLimit = deps.batchLimit ?? SWEEP_BATCH_LIMIT
  const env = deps.env ?? process.env
  const lookbackMs = deps.lookbackMs ?? SWEEP_GAP_LOOKBACK_MS

  // ── AC4: gate readiness PRZED jakimkolwiek zapytaniem ─────────────────────
  // Kolejność jest częścią kontraktu: no-op musi być zerowy również w liczbie
  // zapytań, żeby lokalny dev i CI nie generowały wierszy `failed`/DLQ „z niczego".
  if (!isReady()) {
    // DOKŁADNIE jeden log na przebieg — nie per wiersz, nie per minutę.
    logger.info(
      `[${SCHEDULE_NAME}] provider notyfikacji nie jest readiness-green — ` +
        "przebieg pominięty (no-op: zero zapytań, zero wysyłek, zero DLQ)",
      { status: "skipped_provider_not_ready" },
    )
    // Telemetria rozróżnia „nie działało" od „0 luk" — inaczej alert milczałby
    // dokładnie wtedy, gdy nic nie działa.
    metrics?.capture(METRIC_HEARTBEAT, {
      schedule_name: SCHEDULE_NAME,
      status: "skipped_provider_not_ready",
    })
    return emptyReport("skipped_provider_not_ready")
  }

  const startedAt = now()
  const createdBefore = new Date(
    startedAt.getTime() - SWEEP_ENTITLEMENT_GRACE_MS,
  ).toISOString()
  // R-2.5-H1 — DOLNA granica okna. Pierwszy przebieg NIE dosyła historii
  // sprzed istnienia ledgera; backfill jest osobną, świadomą decyzją PO.
  const createdAfter = resolveScanWindowStart(
    startedAt,
    lookbackMs,
    env,
    logger,
  ).toISOString()
  const staleQueuedBefore = new Date(
    startedAt.getTime() - SWEEP_STALE_QUEUED_MS,
  ).toISOString()
  const report = emptyReport("completed")
  report.scan_window_from = createdAfter
  report.scan_window_to = createdBefore

  // Historical summary rows may have had their mutable `error_code` reset by
  // retry. `first_error_code` is backfilled from append-only audit, so this
  // gives each configuration failure one bounded recovery attempt.
  try {
    report.attempt_budget_released +=
      await scanner.releaseParkedConfigurationFailureBudgets({
        max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        max_configuration_recoveries: SWEEP_MAX_CONFIGURATION_RECOVERIES,
        error_codes: SWEEP_GLOBAL_FAILURE_ERROR_CODES,
      })
  } catch (error) {
    logger.warn(
      `[${SCHEDULE_NAME}] odparkowanie historycznych awarii konfiguracji nieudane`,
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
  }

  let scan
  try {
    scan = await scanner.scanDeliveryGaps({
      template_keys: templateKeys,
      source_states: SWEEP_SOURCE_STATES,
      entitlement_types: entitlementTypes,
      created_before: createdBefore,
      created_after: createdAfter,
      stale_queued_before: staleQueuedBefore,
      max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
      limit: batchLimit,
    })
  } catch (error) {
    logger.error(
      `[${SCHEDULE_NAME}] skan luk nieudany — przebieg przerwany bez wysyłek`,
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
    metrics?.capture(METRIC_HEARTBEAT, {
      schedule_name: SCHEDULE_NAME,
      status: "scan_failed",
    })
    return emptyReport("scan_failed")
  }

  report.truncated = scan.truncated

  // ── R-2.5-M8: drugi, wąski skan STALLED wierszy ledgera ───────────────────
  // Skan po `entitlement_instance` wchodzi wyłącznie przez zbiór szablonów
  // OCZEKIWANYCH, więc wiersz szablonu warunkowego (handoff z 2.4) w stanie
  // `failed` nie wraca, gdy buyer-mail jest już `sent` — i nic go nie ponawia.
  // Ten skan nie zna predykatu gift: wiersz istnieje tylko wtedy, gdy predykat
  // już raz przeszedł.
  let stalled: DeliveryGapCandidate[] = []
  try {
    stalled = await scanner.scanStalledDispatches({
      source_states: SWEEP_SOURCE_STATES,
      entitlement_types: entitlementTypes,
      created_before: createdBefore,
      created_after: createdAfter,
      max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
      limit: batchLimit,
    })
  } catch (error) {
    logger.warn(
      `[${SCHEDULE_NAME}] skan stalled wierszy ledgera nieudany — dosyłka ` +
        "szablonów warunkowych pominięta w tym przebiegu",
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
  }

  // Pary (entitlement × szablon) z OBU skanów; klucz pary usuwa nakładki.
  const pairs = new Map<string, DeliveryGapCandidate>()
  for (const candidate of [...scan.candidates, ...stalled]) {
    pairs.set(`${candidate.entitlement_id}::${candidate.template_key}`, candidate)
  }
  report.scanned = pairs.size

  const tally = new MarketTally()
  /** Dosyłka jest per ENTITLEMENT — handler obsługuje wszystkie szablony naraz. */
  const targets = new Map<string, SweepTarget>()
  for (const candidate of pairs.values()) {
    const target = targets.get(candidate.entitlement_id)
    if (target) {
      target.rows.push(candidate)
      continue
    }
    if (targets.size >= batchLimit) {
      // Bounded batch obowiązuje SUMĘ obu skanów (AC1) — inaczej dołożenie
      // drugiego zapytania po cichu podwoiłoby liczbę wysyłek na przebieg.
      report.truncated = true
      continue
    }
    targets.set(candidate.entitlement_id, {
      entitlement_id: candidate.entitlement_id,
      candidate,
      rows: [candidate],
    })
  }
  report.entitlements_scanned = targets.size

  // ── R-2.5-M6: wiersz zaparkowany blokuje CAŁY entitlement ─────────────────
  // Próg prób żyje przy wierszu, ale handler wysyła wszystkie szablony naraz:
  // bez tego guardu druga luka reaktywowałaby wiersz zaparkowany przez
  // `reserveDispatch` i próg przestałby obowiązywać dokładnie tam, gdzie miał.
  const parkedEntitlements = new Map<string, number>()
  try {
    const parkedRows = await scanner.listParkedDispatches({
      entitlement_ids: [...targets.keys()],
      max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
    })
    for (const row of parkedRows) {
      parkedEntitlements.set(
        row.entitlement_id,
        (parkedEntitlements.get(row.entitlement_id) ?? 0) + 1,
      )
    }
  } catch (error) {
    // Fail-closed byłoby gorsze (zero dosyłek), fail-open bez śladu też —
    // logujemy i idziemy dalej z samym guardem `attempt_count` per wiersz.
    logger.warn(
      `[${SCHEDULE_NAME}] odczyt wierszy zaparkowanych nieudany — guard ` +
        "per-entitlement niedostępny w tym przebiegu",
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
  }

  for (const target of targets.values()) {
    const candidate = target.candidate

    if (parkedEntitlements.has(target.entitlement_id)) {
      report.exhausted += 1
      tally.resolve(candidate.market_id, "exhausted")
      logger.warn(
        `[${SCHEDULE_NAME}] entitlement ma wiersz z wyczerpanym budżetem prób ` +
          "— dosyłka wstrzymana dla WSZYSTKICH jego szablonów",
        {
          entitlement_id: target.entitlement_id,
          market_id: candidate.market_id,
          parked_rows: parkedEntitlements.get(target.entitlement_id) ?? 0,
          max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
        },
      )
      continue
    }

    let eligible = false
    let blocker: SweepBucket | null = null
    for (const row of target.rows) {
      try {
        const decision = await prepareCandidate(
          row,
          staleQueuedBefore,
          deps,
          report,
        )
        if (decision === "eligible") {
          eligible = true
        } else if (blocker === null || decision === "state_mismatch") {
          blocker = decision
        }
      } catch (error) {
        // Awaria pojedynczego wiersza nie przerywa przebiegu (AC2).
        eligible = false
        blocker = "errored"
        logger.warn(
          `[${SCHEDULE_NAME}] przygotowanie wiersza nieudane — wiersz pominięty`,
          {
            entitlement_id: row.entitlement_id,
            market_id: row.market_id,
            template_key: row.template_key,
            error_class: errorClass(error),
            error_code: errorCode(error),
          },
        )
        break
      }
    }

    if (!eligible) {
      const bucket = blocker ?? "skipped"
      applyBucket(report, bucket)
      tally.resolve(candidate.market_id, bucket)
      continue
    }

    report.attempted += 1
    try {
      const result = await handleVoucherPurchaseDelivery(
        buildSweepTrigger(candidate),
        deps.delivery,
      )

      // R-2.5-I15: wymiar metryki to rynek ROZSTRZYGNIĘTY przez handler (ten
      // sam, który trafia do wiersza ledgera), a nie surowa projekcja skanu.
      const marketId = result.market_id ?? candidate.market_id
      const bucket = classifyOutcome(result.outcome)
      applyBucket(report, bucket)
      tally.resolve(marketId, bucket)

      await releaseBudgetOnGlobalFailure(
        result.outcome,
        result.dispatch_id,
        result.error_code,
        deps,
        report,
      )

      // Handoff jest osobnym wierszem ledgera i osobnym licznikiem (R-2.5-M7)
      // — WYŁĄCZNIE gdy realnie doszło do próby wysyłki. `skipped_not_eligible`
      // (zakup dla siebie) to zdecydowana większość ruchu i zalałby liczniki.
      const handoff = result.handoff
      if (handoff && (handoff.outcome === "sent" || handoff.outcome === "failed")) {
        tally.handoff(marketId, handoff.outcome)
        if (handoff.outcome === "sent") report.handoff_recovered += 1
        else report.handoff_still_failing += 1
        await releaseBudgetOnGlobalFailure(
          handoff.outcome,
          handoff.dispatch_id,
          handoff.error_code,
          deps,
          report,
        )
      }

      logDispatchOutcome(logger, candidate, result, bucket)
    } catch (error) {
      // Handler z 2.3 nie rzuca, ale sweep nie może na tym STAĆ: awaria
      // pojedynczego wiersza nie przerywa przebiegu i nie wywraca schedulera.
      report.errored += 1
      tally.resolve(candidate.market_id, "errored")
      logger.warn(
        `[${SCHEDULE_NAME}] dosyłka wiersza nieudana — przebieg kontynuowany`,
        {
          entitlement_id: candidate.entitlement_id,
          market_id: candidate.market_id,
          error_class: errorClass(error),
          error_code: errorCode(error),
        },
      )
    }
  }

  // ── R-2.5-H3: wiersze ZAPARKOWANE są stanem bazy, nie zdarzeniem przebiegu ─
  // Są wykluczone ze skanu (żeby nie zjadały batcha), więc bez tego licznika
  // znikałyby z obserwowalności dokładnie wtedy, gdy zaczynają boleć.
  try {
    for (const row of await scanner.countParkedDispatchesByMarket({
      max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
    })) {
      tally.parked(row.market_id, row.parked)
      report.parked_total += row.parked
    }
  } catch (error) {
    logger.warn(
      `[${SCHEDULE_NAME}] licznik wierszy zaparkowanych nieosiągalny`,
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
  }

  // ── Granica H1: luki poza matrycą stanów — liczone, NIE dosyłane ───────────
  try {
    report.gap_beyond_source_states = await scanner.countGapsBeyondSourceStates({
      template_keys: templateKeys,
      source_states: SWEEP_SOURCE_STATES,
      entitlement_types: entitlementTypes,
      created_before: createdBefore,
      // TO SAMO okno, co skan dosyłający — inaczej obie liczby mówiłyby
      // o różnych zbiorach pod jedną nazwą.
      created_after: createdAfter,
    })
  } catch (error) {
    // Licznik obserwowalności nie może wywrócić dosyłek, które już się udały.
    logger.warn(
      `[${SCHEDULE_NAME}] licznik luk poza stanami źródłowymi nieosiągalny`,
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
  }

  report.per_market = tally.toArray()

  if (report.truncated) {
    // Zero cichego truncate (AC1).
    logger.warn(
      `[${SCHEDULE_NAME}] skan dobił do limitu batcha — reszta zaległości ` +
        "zostanie dogoniona w kolejnym przebiegu",
      { batch_limit: batchLimit, scanned: report.scanned },
    )
  }

  if (report.exhausted > 0 || report.parked_total > 0) {
    logger.warn(
      `[${SCHEDULE_NAME}] wiersze po ${SWEEP_MAX_ATTEMPT_COUNT} próbach bez ` +
        "sukcesu — dosyłka wstrzymana, wymagana decyzja operatora " +
        "(awarie konfiguracyjne NIE zużywają budżetu prób)",
      { exhausted: report.exhausted, parked_total: report.parked_total },
    )
  }

  if (report.unresolvable > 0) {
    // „Brak danych źródłowych to alarm, nie `continue`" — luka, której automat
    // nie domknie NIGDY, musi być widoczna jako błąd, nie jako `skipped`.
    logger.error(
      `[${SCHEDULE_NAME}] luki NIEDOMYKALNE przez automat (brak danych ` +
        "źródłowych) — wymagana interwencja, sweep ich nie domknie",
      { unresolvable: report.unresolvable },
    )
  }

  if (report.state_mismatch > 0) {
    logger.error(
      `[${SCHEDULE_NAME}] rozjazd zapytania skanu i semantyki stanów`,
      { state_mismatch: report.state_mismatch },
    )
  }

  if (report.gap_beyond_source_states > 0) {
    logger.warn(
      `[${SCHEDULE_NAME}] luki poza stanami źródłowymi (granica H1) — sweep ich ` +
        "NIE dosyła; wymagana decyzja operatora",
      {
        gap_beyond_source_states: report.gap_beyond_source_states,
        source_states: [...SWEEP_SOURCE_STATES],
      },
    )
  }

  // ── AC3: metryka alertowa, wymiar `market_id`, zero PII ───────────────────
  // Zbiór kubełków jest DOMKNIĘTY (R-2.5-M7): reguła alertu „luka domknięta"
  // to `recovered + unresolvable == entitlements_without_dispatch`, a rynek
  // z samymi `exhausted`/`unresolvable` nie udaje już, że nic się nie zepsuło.
  for (const row of report.per_market) {
    metrics?.capture(METRIC_GAP, {
      schedule_name: SCHEDULE_NAME,
      market_id: row.market_id,
      entitlements_without_dispatch: row.found,
      recovered: row.recovered,
      still_failing: row.still_failing,
      unresolvable: row.unresolvable,
      exhausted: row.exhausted,
      skipped: row.skipped,
      state_mismatch: row.state_mismatch,
      errored: row.errored,
      handoff_recovered: row.handoff_recovered,
      handoff_still_failing: row.handoff_still_failing,
      parked: row.parked,
    })
  }

  metrics?.capture(METRIC_HEARTBEAT, {
    schedule_name: SCHEDULE_NAME,
    ...heartbeatCounters(report),
    started_at: startedAt.toISOString(),
    completed_at: now().toISOString(),
  })

  logger.info(`[${SCHEDULE_NAME}] przebieg zakończony`, heartbeatCounters(report))

  return report
}

/** Jeden kształt liczników dla heartbeatu i logu — bez rozjazdu pól. */
function heartbeatCounters(report: SweepReport): Record<string, unknown> {
  return {
    status: report.status,
    // `scanned` liczy PARY, `entitlements_scanned` — entitlementy (R-2.5-L10).
    scanned: report.scanned,
    entitlements_scanned: report.entitlements_scanned,
    attempted: report.attempted,
    recovered: report.recovered,
    still_failing: report.still_failing,
    unresolvable: report.unresolvable,
    skipped: report.skipped,
    state_mismatch: report.state_mismatch,
    exhausted: report.exhausted,
    parked_total: report.parked_total,
    attempt_budget_released: report.attempt_budget_released,
    reclaimed_queued: report.reclaimed_queued,
    errored: report.errored,
    handoff_recovered: report.handoff_recovered,
    handoff_still_failing: report.handoff_still_failing,
    truncated: report.truncated,
    gap_beyond_source_states: report.gap_beyond_source_states,
    scan_window_from: report.scan_window_from,
    scan_window_to: report.scan_window_to,
  }
}

/** Decyzja per wiersz PRZED dosyłką. */
type PrepareDecision = "eligible" | "skipped" | "exhausted" | "state_mismatch"

/**
 * Decyzja per wiersz PRZED dosyłką. Zwraca `"eligible"`, gdy wiersz kwalifikuje
 * się do dosyłki w tym przebiegu; pozostałe wartości nazywają POWÓD odmowy,
 * żeby raport i metryka nie sklejały trzech różnych zdarzeń w jeden `skipped`
 * (R-2.5-I14).
 */
async function prepareCandidate(
  candidate: DeliveryGapCandidate,
  staleQueuedBefore: string,
  deps: SweepDeps,
  report: SweepReport,
): Promise<PrepareDecision> {
  // Brak wiersza = kanoniczna luka z AD-7 (zgubiony event) — nic do przejmowania.
  if (!candidate.dispatch_status || !candidate.dispatch_id) {
    return "eligible"
  }

  // Defense-in-depth: wiersze z wyczerpanym budżetem są WYKLUCZONE już w SQL-u
  // skanu (R-2.5-H3), więc tutaj mogą trafić tylko z innej implementacji portu.
  if (candidate.attempt_count >= SWEEP_MAX_ATTEMPT_COUNT) {
    deps.logger.warn(
      `[${SCHEDULE_NAME}] wiersz wyczerpał próg prób — dosyłka wstrzymana`,
      {
        entitlement_id: candidate.entitlement_id,
        market_id: candidate.market_id,
        template_key: candidate.template_key,
        dispatch_status: candidate.dispatch_status,
        attempt_count: candidate.attempt_count,
        max_attempt_count: SWEEP_MAX_ATTEMPT_COUNT,
      },
    )
    return "exhausted"
  }

  // D3 — porzucona rezerwacja `queued`: JEDNO warunkowe UPDATE queued→failed
  // (guard `status='queued' AND queued_at < próg`), po którym dosyłka biegnie
  // ZASTANĄ ścieżką retry z 2.3. Bez tego kroku handler zobaczyłby `queued`
  // i zwrócił `skipped_in_flight` — czyli mail nigdy by nie poleciał.
  if (candidate.dispatch_status === "queued") {
    const reclaimed = await deps.scanner.abandonStaleQueued({
      dispatch_id: candidate.dispatch_id,
      stale_queued_before: staleQueuedBefore,
      error_code: ABANDONED_QUEUED_ERROR_CODE,
    })

    if (!reclaimed) {
      // Guard nie przepuścił: wiersz zmienił stan między skanem a przejęciem
      // (inny sweep / subscriber domknął wysyłkę). Nie zgadujemy — pomijamy.
      deps.logger.info(
        `[${SCHEDULE_NAME}] porzucona rezerwacja zmieniła stan między skanem ` +
          "a przejęciem — wiersz pominięty",
        {
          entitlement_id: candidate.entitlement_id,
          market_id: candidate.market_id,
          template_key: candidate.template_key,
          dispatch_id: candidate.dispatch_id,
        },
      )
      return "skipped"
    }

    report.reclaimed_queued += 1
    deps.logger.warn(
      `[${SCHEDULE_NAME}] przejęto porzuconą rezerwację \`queued\` (D3) — ` +
        "dosyłka pójdzie zastaną ścieżką retry",
      {
        entitlement_id: candidate.entitlement_id,
        market_id: candidate.market_id,
        template_key: candidate.template_key,
        dispatch_id: candidate.dispatch_id,
        queued_at: candidate.queued_at,
        error_code: ABANDONED_QUEUED_ERROR_CODE,
      },
    )
    return "eligible"
  }

  // `failed`/`retrying` — legalny retry wg semantyki 2.3.
  if (
    DISPATCH_STATES_ALLOWING_RETRY.includes(candidate.dispatch_status)
  ) {
    return "eligible"
  }

  // Stan blokujący (`sent`/`delivered`/`degraded`/`dead_lettered`) nie powinien
  // wrócić ze skanu. Jeśli wrócił, SQL i semantyka stanów się rozjechały —
  // pomijamy fail-loud, zamiast wysyłać drugi mail.
  deps.logger.error(
    `[${SCHEDULE_NAME}] skan zwrócił wiersz w stanie blokującym dosyłkę — ` +
      "pominięto (rozjazd zapytania skanu i semantyki stanów)",
    {
      entitlement_id: candidate.entitlement_id,
      market_id: candidate.market_id,
      template_key: candidate.template_key,
      dispatch_status: candidate.dispatch_status,
    },
  )
  return "state_mismatch"
}

/** Wynik handlera → JEDEN rozłączny kubełek (domknięcie `found`). */
function classifyOutcome(outcome: PurchaseDeliveryOutcome): SweepBucket {
  if (outcome === "sent") return "recovered"
  if (outcome === "failed") return "still_failing"
  if (UNRESOLVABLE_OUTCOMES.includes(outcome)) return "unresolvable"
  return "skipped"
}

function applyBucket(report: SweepReport, bucket: SweepBucket): void {
  if (bucket === "recovered") report.recovered += 1
  else if (bucket === "still_failing") report.still_failing += 1
  else if (bucket === "unresolvable") report.unresolvable += 1
  else if (bucket === "exhausted") report.exhausted += 1
  else if (bucket === "state_mismatch") report.state_mismatch += 1
  else if (bucket === "errored") report.errored += 1
  else report.skipped += 1
}

/**
 * R-2.5-H3 — zwrot budżetu prób po awarii GLOBALNEJ. Bez tego kill-switch albo
 * brak szablonu dla `ua`/`de` (stan trwający do Epiku 4) parkowałby WSZYSTKIE
 * wiersze rynku po 75 minutach, a jedyną ścieżką powrotu byłby ręczny UPDATE
 * na produkcyjnej bazie.
 */
async function releaseBudgetOnGlobalFailure(
  outcome: PurchaseDeliveryOutcome,
  dispatchId: string | null,
  errorCodeValue: string | null,
  deps: SweepDeps,
  report: SweepReport,
): Promise<void> {
  if (outcome !== "failed" || !dispatchId) return
  if (!isGlobalFailureErrorCode(errorCodeValue)) return

  try {
    const released = await deps.scanner.releaseAttemptBudget({
      dispatch_id: dispatchId,
      error_code: errorCodeValue as string,
      max_configuration_recoveries: SWEEP_MAX_CONFIGURATION_RECOVERIES,
    })
    if (released) report.attempt_budget_released += 1
  } catch (error) {
    // Nieudany zwrot budżetu nie może wywrócić przebiegu — najgorsze, co się
    // stanie, to jedna zużyta próba więcej.
    deps.logger.warn(
      `[${SCHEDULE_NAME}] zwrot budżetu prób po awarii globalnej nieudany`,
      {
        dispatch_id: dispatchId,
        error_code: errorCodeValue,
        error_class: errorClass(error),
      },
    )
  }
}

/** Log per dosyłkę; „luka niedomykalna" jest `error`, nie `info` (R-2.5-H4). */
function logDispatchOutcome(
  logger: SweepLogger,
  candidate: DeliveryGapCandidate,
  result: PurchaseDeliveryResult,
  bucket: SweepBucket,
): void {
  const meta = {
    entitlement_id: candidate.entitlement_id,
    market_id: result.market_id ?? candidate.market_id,
    entitlement_state: candidate.entitlement_state,
    outcome: result.outcome,
    handoff_outcome: result.handoff?.outcome ?? null,
    error_code: result.error_code,
  }

  if (bucket === "unresolvable") {
    logger.error(
      `[${SCHEDULE_NAME}] luka NIEDOMYKALNA przez automat — brak danych ` +
        "źródłowych, wymagana interwencja",
      meta,
    )
    return
  }

  logger.info(`[${SCHEDULE_NAME}] dosyłka przez ścieżkę subscribera`, meta)
}

/**
 * Syntetyczny trigger w kształcie koperty `envelope.v1`. `scope.market_id` jest
 * ustawiony JAWNIE, bo to jedyny nośnik rynku, jaki handler czyta z koperty —
 * bez niego dosyłka spadałaby na konfiguracyjny fallback (R-2.2-M4).
 *
 * `from_state` jest `null`: sweep nie zna tranzycji, która zginęła, i nie udaje,
 * że zna. Handler i tak rozstrzyga po `to_state`.
 */
export function buildSweepTrigger(candidate: DeliveryGapCandidate): {
  event_type: string
  scope: { market_id: string | null }
  payload: { entitlement_id: string; to_state: string; from_state: null }
} {
  return {
    event_type: ENTITLEMENT_STATE_CHANGED_EVENT,
    scope: { market_id: candidate.market_id },
    payload: {
      entitlement_id: candidate.entitlement_id,
      to_state: candidate.entitlement_state,
      from_state: null,
    },
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}

/** Do logu idzie KOD błędu, nigdy `message` (może nieść adres / treść maila). */
function errorCode(error: unknown): string | null {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    for (const key of ["error_code", "code"] as const) {
      const value = record[key]
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim()
      }
    }
  }
  return null
}

function resolveLogger(container: MedusaContainer | undefined): SweepLogger {
  const fallback: SweepLogger = {
    info: (m, meta) => console.log(`[${SCHEDULE_NAME}] ${m}`, meta ?? {}),
    warn: (m, meta) => console.warn(`[${SCHEDULE_NAME}] ${m}`, meta ?? {}),
    error: (m, meta) => console.error(`[${SCHEDULE_NAME}] ${m}`, meta ?? {}),
  }
  try {
    const resolved = container?.resolve?.("logger") as
      | Partial<SweepLogger>
      | undefined
    if (resolved && typeof resolved.info === "function") {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch {
    // fall through — brak loggera w kontenerze nie może wywrócić joba
  }
  return fallback
}

function resolveOptional<T>(
  container: MedusaContainer | undefined,
  key: string,
): T | null {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Cienki wrapper kontenerowy (D2): adaptuje opcjonalnego PostHoga do portu
 * metryki. Brak PostHoga = brak metryki, ale NIE brak sygnału — liczniki są
 * też w logu podsumowującym, a sam brak nośnika zostawia `warn` (R-2.5-H2).
 */
export function createPosthogSweepMetrics(
  posthog: PosthogCaptureClient | null,
): SweepMetricsPort | undefined {
  if (!posthog) return undefined
  return {
    capture(event, properties) {
      posthog.capture({ distinctId: SCHEDULE_NAME, event, properties })
    },
  }
}

/**
 * R-2.5-H2 — nośnik metryki MUSI istnieć w runtime. Kolejność: klient
 * zarejestrowany przez `loaders/posthog.ts`, a gdy loader nie zdążył /
 * kontener go nie zna — ten sam lazy klient z env, którego loader używa.
 * Brak `POSTHOG_API_KEY` = jeden `warn` na proces, nigdy cisza.
 */
export function resolveSweepMetrics(
  container: MedusaContainer | undefined,
  logger: SweepLogger,
): SweepMetricsPort | undefined {
  const fromContainer = resolveOptional<PosthogCaptureClient>(
    container,
    POSTHOG_CONTAINER_KEY,
  )
  const client =
    fromContainer ??
    getPosthogCaptureClient((message, meta) => logger.warn(message, meta))

  return createPosthogSweepMetrics(client)
}

/**
 * Kontenerowe wejście crona. Cienkie: rozwiązuje zależności dokładnie tak, jak
 * robi to subscriber (ten sam ledger, ten sam reader locale, ten sam dispatcher
 * na `Modules.NOTIFICATION`), i oddaje sterowanie czystej funkcji.
 *
 * NIGDY nie rzuca: wyjątek z tego joba wywróciłby scheduler Medusy, a wtedy
 * przestałyby biegać także pozostałe crony.
 */
export default async function voucherDeliveryReconciliationSweepJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = resolveLogger(container)

  try {
    const sql = container.resolve(
      ContainerRegistrationKeys.PG_CONNECTION,
    ) as DispatchLedgerSql & MarketLocalesSql
    const notificationModule = container.resolve(Modules.NOTIFICATION) as {
      createNotifications?: (
        data: unknown,
        ...rest: unknown[]
      ) => Promise<unknown>
      send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
    }
    const ledger = new PgDispatchLedger(sql)

    const delivery: PurchaseDeliveryDeps = {
      sourceReader: container.resolve(
        VOUCHER_MODULE,
      ) as PurchaseDeliverySourceReader,
      ledger,
      dispatcher: {
        async dispatch(payload) {
          return typeof notificationModule.createNotifications === "function"
            ? notificationModule.createNotifications(payload)
            : notificationModule.send?.(payload)
        },
      },
      marketLocales: createMarketLocalesReader(sql, logger),
      logger,
    }

    await runVoucherDeliveryReconciliationSweep({
      scanner: ledger,
      delivery,
      logger,
      metrics: resolveSweepMetrics(container, logger),
    })
  } catch (error) {
    logger.error(
      `[${SCHEDULE_NAME}] przebieg przerwany błędem zależności — scheduler ` +
        "nietknięty",
      { error_class: errorClass(error), error_code: errorCode(error) },
    )
  }
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
