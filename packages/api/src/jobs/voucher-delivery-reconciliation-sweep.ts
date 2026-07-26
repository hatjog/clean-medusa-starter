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
 * Metryka jest opcjonalna w kontenerze, więc każdy licznik ma też ślad w logu
 * podsumowującym — brak PostHoga nie może oznaczać braku sygnału.
 *
 * ── Granice ─────────────────────────────────────────────────────────────────
 * Job NIE emituje `gp.communication.delivery_state_changed.v1` (AD-7: enum
 * zapożyczony, event nie), NIE buduje outboxa, NIE woła `createNotifications`
 * bezpośrednio, NIE pisze do ledgera z pominięciem jego API i NIGDY nie rzuca
 * wyjątku wywracającego scheduler.
 *
 * Kill-switch `FLOW_DISABLED` (ADR-161) działa na sweep tak samo jak na
 * subscribera, bo dosyłka idzie tą samą ścieżką: przy wyłączonym flow wysyłka
 * kończy się wierszem `failed` z kodem `FLOW_DISABLED`. Żeby wyłączony flow nie
 * generował nieskończonego retry co 15 minut, obowiązuje próg
 * `SWEEP_MAX_ATTEMPT_COUNT` (dalej: `exhausted` + `warn`, bez wysyłki).
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { isNotificationProviderReady } from "../lib/vendor-notification-provider-readiness"
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
  STALE_QUEUED_THRESHOLD_MS,
  type PurchaseDeliveryDeps,
  type PurchaseDeliveryOutcome,
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
 * Górna granica prób dosyłki dla JEDNEGO wiersza ledgera. Powyżej sweep nie
 * wysyła i zgłasza `exhausted` — inaczej trwała awaria konfiguracji (brak
 * szablonu dla `ua`/`de`, `FLOW_DISABLED`) generowałaby próbę co 15 minut bez
 * końca. Wznowienie po naprawie = decyzja operatora (jak `dead_lettered`).
 */
export const SWEEP_MAX_ATTEMPT_COUNT = 5

/**
 * Okno licznika granicy H1 (7 dni). `countGapsBeyondSourceStates` bez okna
 * byłby COUNT-em po całej historii przy każdym przebiegu.
 */
export const SWEEP_BEYOND_STATE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

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

/** Liczniki per rynek (AC3 — wymiar `market_id`). */
export type SweepMarketCounters = {
  market_id: string
  /** Luka WYKRYTA (rozmiar luki przed dosyłką). */
  found: number
  /** Luka DOMKNIĘTA (mail poszedł w tym przebiegu). */
  recovered: number
  /** Luka NADAL otwarta po próbie dosyłki (wiersz `failed`). */
  still_failing: number
}

export type SweepReport = {
  status: SweepRunStatus
  /** Wiersze zwrócone ze skanu (pary entitlement × oczekiwany szablon). */
  scanned: number
  /** Entitlementy, dla których uruchomiono ścieżkę subscribera. */
  attempted: number
  recovered: number
  still_failing: number
  /** Pominięte bez wysyłki (rezerwacja przejęta przez kogoś innego, blokada). */
  skipped: number
  /** Przekroczony `SWEEP_MAX_ATTEMPT_COUNT` — wymaga decyzji operatora. */
  exhausted: number
  /** Przejęte porzucone rezerwacje `queued` (D3). */
  reclaimed_queued: number
  /** Wyjątki per-wiersz (przebieg kontynuowany). */
  errored: number
  /** Skan dobił do limitu — reszta zaległości czeka na kolejny przebieg. */
  truncated: boolean
  /** Granica H1 — luki poza `SWEEP_SOURCE_STATES` (liczone, NIE dosyłane). */
  gap_beyond_source_states: number
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
  /** AC4 — gate readiness; domyślnie ZASTANY helper z 2.2, nie druga definicja. */
  isProviderReady?: () => boolean
  templateKeys?: readonly string[]
  batchLimit?: number
}

function emptyReport(status: SweepRunStatus): SweepReport {
  return {
    status,
    scanned: 0,
    attempted: 0,
    recovered: 0,
    still_failing: 0,
    skipped: 0,
    exhausted: 0,
    reclaimed_queued: 0,
    errored: 0,
    truncated: false,
    gap_beyond_source_states: 0,
    per_market: [],
  }
}

/** Klucz wymiaru metryki dla entitlementu bez `market_id` w projekcji. */
const UNKNOWN_MARKET = "unknown"

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
    }
    this.rows.set(key, fresh)
    return fresh
  }

  found(marketId: string | null): void {
    this.row(marketId).found += 1
  }

  recovered(marketId: string | null): void {
    this.row(marketId).recovered += 1
  }

  stillFailing(marketId: string | null): void {
    this.row(marketId).still_failing += 1
  }

  toArray(): SweepMarketCounters[] {
    return [...this.rows.values()].sort((a, b) =>
      a.market_id.localeCompare(b.market_id),
    )
  }
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
  const isReady = deps.isProviderReady ?? isNotificationProviderReady
  const templateKeys =
    deps.templateKeys && deps.templateKeys.length > 0
      ? deps.templateKeys
      : SWEEP_EXPECTED_TEMPLATE_KEYS
  const batchLimit = deps.batchLimit ?? SWEEP_BATCH_LIMIT

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
  const staleQueuedBefore = new Date(
    startedAt.getTime() - SWEEP_STALE_QUEUED_MS,
  ).toISOString()

  let scan
  try {
    scan = await scanner.scanDeliveryGaps({
      template_keys: templateKeys,
      source_states: SWEEP_SOURCE_STATES,
      created_before: createdBefore,
      stale_queued_before: staleQueuedBefore,
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

  const report = emptyReport("completed")
  report.scanned = scan.candidates.length
  report.truncated = scan.truncated

  const tally = new MarketTally()
  /** Entitlementy do dosyłki — dedup, bo handler obsługuje OBA szablony naraz. */
  const targets = new Map<string, DeliveryGapCandidate>()

  for (const candidate of scan.candidates) {
    tally.found(candidate.market_id)

    try {
      if (!(await prepareCandidate(candidate, staleQueuedBefore, deps, report))) {
        continue
      }
    } catch (error) {
      // Awaria pojedynczego wiersza nie przerywa przebiegu (AC2).
      report.errored += 1
      logger.warn(
        `[${SCHEDULE_NAME}] przygotowanie wiersza nieudane — wiersz pominięty`,
        {
          entitlement_id: candidate.entitlement_id,
          market_id: candidate.market_id,
          template_key: candidate.template_key,
          error_class: errorClass(error),
          error_code: errorCode(error),
        },
      )
      continue
    }

    if (!targets.has(candidate.entitlement_id)) {
      targets.set(candidate.entitlement_id, candidate)
    }
  }

  for (const candidate of targets.values()) {
    report.attempted += 1
    try {
      const result = await handleVoucherPurchaseDelivery(
        buildSweepTrigger(candidate),
        deps.delivery,
      )

      tallyOutcome(result.outcome, candidate.market_id, tally, report)
      // Handoff jest osobnym wierszem ledgera, więc liczymy go osobno — ale
      // WYŁĄCZNIE gdy realnie doszło do próby wysyłki. `skipped_not_eligible`
      // (zakup dla siebie) to zdecydowana większość ruchu i zalałoby liczniki.
      if (
        result.handoff &&
        (result.handoff.outcome === "sent" || result.handoff.outcome === "failed")
      ) {
        tallyOutcome(result.handoff.outcome, candidate.market_id, tally, report)
      }

      logger.info(`[${SCHEDULE_NAME}] dosyłka przez ścieżkę subscribera`, {
        entitlement_id: candidate.entitlement_id,
        market_id: candidate.market_id,
        entitlement_state: candidate.entitlement_state,
        outcome: result.outcome,
        handoff_outcome: result.handoff?.outcome ?? null,
        error_code: result.error_code,
      })
    } catch (error) {
      // Handler z 2.3 nie rzuca, ale sweep nie może na tym STAĆ: awaria
      // pojedynczego wiersza nie przerywa przebiegu i nie wywraca schedulera.
      report.errored += 1
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

  // ── Granica H1: luki poza matrycą stanów — liczone, NIE dosyłane ───────────
  try {
    report.gap_beyond_source_states = await scanner.countGapsBeyondSourceStates({
      template_keys: templateKeys,
      source_states: SWEEP_SOURCE_STATES,
      created_before: createdBefore,
      created_after: new Date(
        startedAt.getTime() - SWEEP_BEYOND_STATE_LOOKBACK_MS,
      ).toISOString(),
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

  if (report.exhausted > 0) {
    logger.warn(
      `[${SCHEDULE_NAME}] wiersze po ${SWEEP_MAX_ATTEMPT_COUNT} próbach bez ` +
        "sukcesu — dosyłka wstrzymana, wymagana decyzja operatora",
      { exhausted: report.exhausted },
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
  for (const row of report.per_market) {
    metrics?.capture(METRIC_GAP, {
      schedule_name: SCHEDULE_NAME,
      market_id: row.market_id,
      // found ≠ recovered ≠ still_failing: sam licznik dosyłek nie mówi,
      // czy alert ma zgasnąć.
      entitlements_without_dispatch: row.found,
      recovered: row.recovered,
      still_failing: row.still_failing,
    })
  }

  metrics?.capture(METRIC_HEARTBEAT, {
    schedule_name: SCHEDULE_NAME,
    status: report.status,
    scanned: report.scanned,
    attempted: report.attempted,
    recovered: report.recovered,
    still_failing: report.still_failing,
    skipped: report.skipped,
    exhausted: report.exhausted,
    reclaimed_queued: report.reclaimed_queued,
    errored: report.errored,
    truncated: report.truncated,
    gap_beyond_source_states: report.gap_beyond_source_states,
    started_at: startedAt.toISOString(),
    completed_at: now().toISOString(),
  })

  logger.info(`[${SCHEDULE_NAME}] przebieg zakończony`, {
    status: report.status,
    scanned: report.scanned,
    attempted: report.attempted,
    recovered: report.recovered,
    still_failing: report.still_failing,
    skipped: report.skipped,
    exhausted: report.exhausted,
    reclaimed_queued: report.reclaimed_queued,
    errored: report.errored,
    truncated: report.truncated,
    gap_beyond_source_states: report.gap_beyond_source_states,
  })

  return report
}

/**
 * Decyzja per wiersz PRZED dosyłką. Zwraca `false`, gdy wiersz nie kwalifikuje
 * się do dosyłki w tym przebiegu.
 */
async function prepareCandidate(
  candidate: DeliveryGapCandidate,
  staleQueuedBefore: string,
  deps: SweepDeps,
  report: SweepReport,
): Promise<boolean> {
  // Brak wiersza = kanoniczna luka z AD-7 (zgubiony event) — nic do przejmowania.
  if (!candidate.dispatch_status || !candidate.dispatch_id) {
    return true
  }

  // Próg prób obowiązuje PRZED przejęciem rezerwacji: inaczej trwała awaria
  // konfiguracji zwiększałaby `attempt_count` co 15 minut bez końca.
  if (candidate.attempt_count >= SWEEP_MAX_ATTEMPT_COUNT) {
    report.exhausted += 1
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
    return false
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
      report.skipped += 1
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
      return false
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
    return true
  }

  // `failed`/`retrying` — legalny retry wg semantyki 2.3.
  if (
    DISPATCH_STATES_ALLOWING_RETRY.includes(candidate.dispatch_status)
  ) {
    return true
  }

  // Stan blokujący (`sent`/`delivered`/`degraded`/`dead_lettered`) nie powinien
  // wrócić ze skanu. Jeśli wrócił, SQL i semantyka stanów się rozjechały —
  // pomijamy fail-loud, zamiast wysyłać drugi mail.
  report.skipped += 1
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
  return false
}

function tallyOutcome(
  outcome: PurchaseDeliveryOutcome,
  marketId: string | null,
  tally: MarketTally,
  report: SweepReport,
): void {
  if (outcome === "sent") {
    report.recovered += 1
    tally.recovered(marketId)
    return
  }
  if (outcome === "failed") {
    report.still_failing += 1
    tally.stillFailing(marketId)
    return
  }
  report.skipped += 1
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

/** Klient PostHoga z kontenera (opcjonalny — wzorzec zastanych jobów). */
type PosthogClient = {
  capture(args: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
  }): void
}

/**
 * Cienki wrapper kontenerowy (D2): adaptuje opcjonalnego PostHoga do portu
 * metryki. Brak PostHoga = brak metryki, ale NIE brak sygnału — liczniki są
 * też w logu podsumowującym.
 */
export function createPosthogSweepMetrics(
  posthog: PosthogClient | null,
): SweepMetricsPort | undefined {
  if (!posthog) return undefined
  return {
    capture(event, properties) {
      posthog.capture({ distinctId: SCHEDULE_NAME, event, properties })
    },
  }
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
      metrics: createPosthogSweepMetrics(
        resolveOptional<PosthogClient>(container, "posthog"),
      ),
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
