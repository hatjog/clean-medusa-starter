import { createHash, randomUUID } from "node:crypto";

import {
  MessagingProviderError,
  MessagingValidationError,
  UnsupportedChannelError,
  UnsupportedProviderError,
} from "./errors";
import type { ICommunicationFlowFlagResolver } from "./feature-flag-resolver";
import type {
  CommunicationKpiSourceEvent,
  CommunicationKpiSourceEventType,
  FlowKpiTelemetryHook,
} from "./flow-kpi-telemetry";
import {
  DEFAULT_BARRIER_AMBIGUOUS_WINDOW_MS,
  DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS,
  MESSAGING_BARRIER_UNAVAILABLE,
  type BarrierClaim,
  type DispatchIdempotencyBarrier,
} from "./idempotency-barrier";
import type { IMessagingProvider } from "./provider";
import type {
  Channel,
  NotificationAuditEnvelope,
  NotificationDeliveryEvent,
  NotificationDeliveryEventType,
  NotificationDispatch,
  NotificationDispatchStatus,
  NotificationIntent,
  NotificationProvider,
} from "./types";

export interface MessagingGateway {
  send(intent: NotificationIntent): Promise<NotificationDispatch>;
}

// H1: kontekst korelacji dispatch → KPI (flow_id/market/locale/recipient_hash),
// uchwycony przy send() i odtwarzany przy normalizowanym zdarzeniu delivery/engagement.
export interface DispatchKpiContext {
  flow_id: string;
  market: string;
  locale: string;
  recipient_hash?: string;
  dispatch_time?: string;
}

/**
 * Kod zwracany, gdy bariera stwierdziła, że TEN SAM klucz jest właśnie
 * obsługiwany przez inny proces (zajęcie `in_flight` bez rozstrzygnięcia).
 *
 * To NIE jest „nie udało się wysłać" — to jest „ktoś inny wysyła to teraz i
 * drugi mail byłby duplikatem". Wołający ma ponowić później; na ścieżce
 * zakupowej dogania to reconciliation sweep.
 */
export const MESSAGING_DISPATCH_IN_FLIGHT = "MESSAGING_DISPATCH_IN_FLIGHT";

/**
 * KOMPLET kodów wysyłki pochodzących od samej bariery — czyli takich, których
 * przyczyna NIE jest odrzuceniem przez providera i NIE ustępuje przez udział
 * konkretnego wiersza dostawy.
 *
 * ── Po co ta lista istnieje (R-4.1-H2) ────────────────────────────────────
 * Story 4.1 wprowadziła dwa NOWE stany porażki wysyłki i nie dopisała ich do
 * klasyfikacji awarii globalnych reconciliation sweepa. Zmierzona konsekwencja:
 * `SWEEP_MAX_ATTEMPT_COUNT (5) × cadence (15 min) = 75 min` i wiersz ledgera
 * zostaje wykluczony ze skanu NA STAŁE — naprawa połączenia z bazą przestaje
 * pomagać, a mail wymaga ręcznego `UPDATE` na produkcyjnej bazie.
 *
 * Oba kody spełniają definicję awarii globalnej z `SWEEP_GLOBAL_FAILURE_ERROR_CODES`
 * („stan środowiska dotyczący wszystkich wierszy naraz, ustępujący bez ich udziału"):
 *
 *  * {@link MESSAGING_BARRIER_UNAVAILABLE} — kontener nie oddał połączenia
 *    z bazą. Dotyczy z definicji WSZYSTKICH wierszy i ustępuje po naprawie
 *    połączenia. Skoro bariery nie było, to nic nie poszło do providera, więc
 *    ponowienie jest legalne i MUSI wysłać.
 *  * {@link MESSAGING_DISPATCH_IN_FLIGHT} — inna instancja obsługuje właśnie
 *    ten klucz. Stan PRZEJŚCIOWY: ustępuje sam po zamknięciu tamtego przebiegu
 *    albo po wygaśnięciu okna `in_flight` (15 min), bez udziału tego wiersza.
 *    Zużywanie na niego budżetu prób parkowałoby wiersz za cudzą pracę.
 *
 * Sweep SPREADUJE tę listę zamiast powtarzać kody, więc nowy kod bariery
 * dodany tutaj jest sklasyfikowany od razu. Kontrola, która PĘKA, gdy pojawia
 * się kod bariery spoza tej listy, siedzi w
 * `packages/api/src/__tests__/lib/messaging-dispatch-barrier.unit.spec.ts`.
 */
export const MESSAGING_BARRIER_TRANSIENT_ERROR_CODES: readonly string[] = [
  MESSAGING_BARRIER_UNAVAILABLE,
  MESSAGING_DISPATCH_IN_FLIGHT,
];

const SUPPORTED_CHANNELS: ReadonlySet<Channel> = new Set([
  "email",
  "sms",
  "push",
]);

export type MessagingProviderRegistry =
  | Map<string, IMessagingProvider>
  | Partial<Record<string, IMessagingProvider>>;

/** Minimalny odbiorca zdarzeń diagnostycznych — bez zależności od loggera Medusy. */
export interface MessagingGatewayLogger {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface MessagingGatewayOptions {
  /**
   * TRWAŁA bariera idempotencji (Story 4.1, AD-23). WYMAGANA — nie ma wariantu
   * „gateway bez bariery": brak nośnika oznaczałby cichą wysyłkę bez ochrony,
   * czyli dokładnie stan, który ta story zamyka. Wołający, który nie ma
   * połączenia z bazą, wstrzykuje barierę ODMAWIAJĄCĄ (patrz
   * `unavailableDispatchBarrier` w `packages/api`), a nie `undefined`.
   */
  barrier: DispatchIdempotencyBarrier;
  flagResolver?: ICommunicationFlowFlagResolver;
  // H1 (5-9): opcjonalny hook telemetryczny KPI. Gdy wstrzyknięty (loader Medusa
  // wiąże go przez createFlowKpiTelemetryHook z approvalLookup z 5-8), gateway
  // realnie emituje KPI w lifecycle wysyłki — emitter nie jest martwym kodem.
  flowKpiTelemetry?: FlowKpiTelemetryHook;
  clock?: () => Date;
  uuid?: () => string;
  /**
   * Źródło TOKENU ZAJĘCIA bariery (R-4.1-M3). Świadomie ODRĘBNE od `uuid`:
   * `uuid` jest źródłem `dispatch_id` i identyfikatorów audytu, więc czerpanie
   * z niego tokenu przesuwałoby całą deterministyczną sekwencję wołającego —
   * czyli zmieniałoby obserwowalne `dispatch_id` bez związku z barierą.
   */
  claimToken?: () => string;
  /** Patrz `DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS`. */
  barrierInFlightWindowMs?: number;
  /** Patrz `DEFAULT_BARRIER_AMBIGUOUS_WINDOW_MS`. */
  barrierAmbiguousWindowMs?: number;
  logger?: MessagingGatewayLogger;
}

export class DefaultMessagingGateway implements MessagingGateway {
  // F-12: Map storage zamiast Object — żaden prototypowy klucz (`__proto__`, `constructor`)
  // nie pollutuje lookup; klucze pochodzą wprost z rejestracji providerów.
  private readonly providers: Map<string, IMessagingProvider>;
  private readonly clock: () => Date;
  private readonly uuid: () => string;
  /** Patrz `MessagingGatewayOptions.claimToken`. */
  private readonly claimToken: () => string;
  /**
   * Story 4.1: JEDYNY nośnik idempotencji wysyłki. Zastąpił mapę
   * `idempotencyCache` w pamięci procesu — nie stoi obok niej. Wariant „mapa
   * zostaje jako cache przed barierą" jest odrzucony wprost przez AD-23
   * („druga, słabsza kopia po skutku jest do usunięcia, nie migracji").
   */
  private readonly barrier: DispatchIdempotencyBarrier;
  private readonly barrierInFlightWindowMs: number;
  private readonly barrierAmbiguousWindowMs: number;
  private readonly logger?: MessagingGatewayLogger;
  private readonly flagResolver?: ICommunicationFlowFlagResolver;
  private readonly flowKpiTelemetry?: FlowKpiTelemetryHook;

  /**
   * Story 4.1 usunęła sygnaturę POZYCYJNĄ (legacy Story 5.1). Powód nie jest
   * kosmetyczny: jej argumenty 5 i 6 nazywały się `idempotencyTtlMs` i
   * `maxCacheSize` — czyli parametry MAPY, której już nie ma. Zachowanie ich
   * jako ignorowanych dawałoby call-site, który wygląda na konfigurujący
   * barierę, a nie konfiguruje niczego.
   */
  constructor(
    providers: MessagingProviderRegistry,
    private readonly defaultProvider: NotificationProvider,
    options: MessagingGatewayOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.uuid = options.uuid ?? (() => randomUUID());
    this.claimToken = options.claimToken ?? (() => randomUUID());
    this.barrier = options.barrier;
    this.barrierInFlightWindowMs =
      options.barrierInFlightWindowMs ?? DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS;
    this.barrierAmbiguousWindowMs =
      options.barrierAmbiguousWindowMs ?? DEFAULT_BARRIER_AMBIGUOUS_WINDOW_MS;
    this.logger = options.logger;
    this.flagResolver = options.flagResolver;
    this.flowKpiTelemetry = options.flowKpiTelemetry;
    this.providers =
      providers instanceof Map
        ? new Map(providers)
        : new Map(
            Object.entries(providers).filter(
              (entry): entry is [string, IMessagingProvider] =>
                entry[1] !== undefined,
            ),
          );
  }

  async send(intent: NotificationIntent): Promise<NotificationDispatch> {
    this.validateIntent(intent);

    // F-01: gate ZAWSZE eval przed cache lookup — config flag może się zmienić
    // pomiędzy dwoma send-ami (operator flipuje enabled OFF→ON); gated denial
    // NIE jest cache'owany, żeby kolejny send dostał świeży resolve i flow ruszył.
    const gatedDispatch = this.applyFeatureFlagGate(intent);
    if (gatedDispatch) {
      return gatedDispatch;
    }

    // Rozwiązanie providera stoi PRZED zajęciem bariery świadomie: to czysty
    // lookup w mapie, bez skutku ubocznego, a rzucenie PO zajęciu blokowałoby
    // klucz na całe okno `in_flight` za coś, co nawet nie dotknęło providera.
    const provider = this.providers.get(this.defaultProvider);
    if (!provider) {
      throw new UnsupportedProviderError(
        `Messaging provider '${this.defaultProvider}' is not registered`,
        {
          error_code: "MESSAGING_PROVIDER_UNSUPPORTED",
          audit_event: this.createAuditEvent({
            intent,
            provider: this.defaultProvider,
            status: "failed",
            dispatch_id: this.uuid(),
            error_code: "MESSAGING_PROVIDER_UNSUPPORTED",
            error_message: `Provider '${this.defaultProvider}' is not registered`,
          }),
        },
      );
    }

    // ── BARIERA: jedna operacja atomowa, PRZED skutkiem (AD-23) ─────────────
    // Werdykt pochodzi z wyniku pojedynczego stwierdzenia po stronie magazynu
    // trwałego, a nie z odczytu porównanego w kodzie. Wszystko, co następuje
    // niżej, dzieje się WYŁĄCZNIE po zajęciu klucza.
    const barrierKey = buildBarrierKey(intent);

    // R-4.1-H2 / R-4.1-L1 — awaria SAMEJ bariery musi dojechać do ledgera jako
    // WYNIK z kodem, a nie jako surowy wyjątek. Gdy `claim()` leciało poza
    // blokiem `try`, `BarrierUnavailableError` propagował na zewnątrz, do
    // wiersza dostawy nie trafiał żaden `error_code`, a
    // `isGlobalFailureErrorCode(null)` zwraca `false` — więc ścieżka „naprawa
    // infrastruktury → odparkowanie wiersza" nie istniała w ogóle.
    // Token TEGO przebiegu (R-4.1-M3). Generuje go WOŁAJĄCY i tylko on go zna,
    // więc `settle`/`release` trafiają wyłącznie we własne zajęcie. Bariera go
    // nie oddaje z powrotem — pole, którego nikt nie czyta, byłoby drugą
    // deklaracją bez konsumenta.
    const claimToken = this.claimToken();

    let claim: BarrierClaim;
    try {
      claim = await this.barrier.claim({
        barrier_key: barrierKey,
        now: this.clock(),
        in_flight_window_ms: this.barrierInFlightWindowMs,
        claim_token: claimToken,
      });
    } catch (error) {
      if (error instanceof MessagingProviderError) {
        return await this.barrierUnavailableDispatch(
          intent,
          barrierKey,
          claimToken,
          error,
        );
      }
      throw error;
    }

    if (claim.outcome === "blocked") {
      if (claim.dispatch) {
        // Poprzedni przebieg się rozstrzygnął — ponowienie dostaje TEN SAM
        // wynik, bez dotykania providera.
        return claim.dispatch;
      }
      // Zajęcie bez rozstrzygnięcia = ktoś inny (inna instancja) jest w locie.
      // NIE wysyłamy: to jest ten przypadek, dla którego bariera istnieje.
      return this.inFlightDispatch(intent, barrierKey);
    }

    try {
      const providerResponse = await provider.send(intent);
      const dispatch: NotificationDispatch = {
        dispatch_id: providerResponse.dispatch_id,
        provider: provider.key,
        status: providerResponse.status,
        provider_message_id: providerResponse.provider_message_id,
        sent_at: providerResponse.sent_at,
        audit_event: this.createAuditEvent({
          intent,
          provider: provider.key,
          status: providerResponse.status,
          dispatch_id: providerResponse.dispatch_id,
        }),
      };

      // Sukces: bariera zostaje ZAMKNIĘTA BEZTERMINOWO (`expires_at = null`).
      // To jest ta sama semantyka, którą deklaruje migracja wiersza skutku
      // `1778933000000` („NIE ma TTL i nie wolno go czyścić dla wierszy
      // sent/delivered — usunięcie = ryzyko duplikatu maila"). Okno dotyczy
      // WYŁĄCZNIE stanu niejednoznacznego, nie dostawy, która się udała.
      await this.settleBarrier(barrierKey, claimToken, dispatch, null);
      this.emitDispatchKpi(dispatch);

      return dispatch;
    } catch (error) {
      if (error instanceof MessagingProviderError) {
        // R2-M1: provider error (np. timeout-after-send) jest niejednoznaczny —
        // wiadomość mogła zostać faktycznie wysłana. Cache'ujemy failed dispatch
        // pod tym samym idempotency cache key, żeby retry z tym samym
        // idempotency_key NIE re-inwokował providera (ryzyko duplikatu), tylko
        // zwrócił deterministyczny ten sam wynik. dispatch_id jest stabilnie
        // wyprowadzony z cache key (a nie losowy uuid), więc jest powtarzalny
        // nawet gdyby cache wygasł i provider zwrócił ten sam błąd ponownie.
        const dispatchId = deriveFailedDispatchId(barrierKey);
        const failedDispatch: NotificationDispatch = {
          dispatch_id: dispatchId,
          provider: provider.key,
          status: "failed",
          audit_event: this.createAuditEvent({
            intent,
            provider: provider.key,
            status: "failed",
            dispatch_id: dispatchId,
            error_code: error.error_code,
            error_message: error.message,
          }),
        };

        // R-2.2-M2 / Story 4.1 AC3 — klasyfikacja PRZEŻYWA przeniesienie na
        // warstwę trwałą i ma DOKŁADNIE JEDNO źródło prawdy: flagę `preflight`
        // na `MessagingProviderError`. Warstwa trwała nie zna i nie ma prawa
        // znać żadnej listy kodów błędów — druga lista rozjechałaby się przy
        // pierwszym nowym kodzie.
        //
        //  * pre-flight fail (BREVO_TEMPLATE_NOT_CONFIGURED,
        //    BREVO_SENDER_NOT_CONFIGURED, BREVO_API_KEY_NOT_CONFIGURED,
        //    walidacja payloadu) — JEDNOZNACZNY: nic nie wyszło do providera.
        //    Bariera jest ZWALNIANA, więc po uzupełnieniu konfiguracji to samo
        //    zdarzenie realnie wysyła mail. To jest główny scenariusz wyjścia
        //    ze stanu „rejestr pusty" i nie wolno go zablokować oknem.
        //  * każdy inny fail (w tym timeout-after-send i KOD NIEZNANY) —
        //    NIEJEDNOZNACZNY: wiadomość mogła pójść. Bariera zostaje zamknięta
        //    na okno, więc ponowienie NIE woła providera. Domyślna wartość
        //    `preflight` to `false` (errors.ts), więc nierozpoznany błąd trafia
        //    tu z DEFINICJI, a nie przez przypadek: nieznane traktujemy jak
        //    „mogło pójść", bo pomyłka w tę stronę kosztuje opóźniony mail,
        //    a w drugą — drugi mail do klientki.
        if (error.preflight) {
          await this.releaseBarrier(barrierKey, claimToken);
        } else {
          await this.settleBarrier(
            barrierKey,
            claimToken,
            failedDispatch,
            new Date(this.clock().getTime() + this.barrierAmbiguousWindowMs),
          );
        }

        return failedDispatch;
      }

      // Błąd SPOZA kontraktu messagingu (np. awaria sieci rzucona surowo).
      // Świadomie NIE zwalniamy bariery: skoro nie wiemy, na jakim etapie
      // poleciał, musimy założyć, że mógł polecieć PO wysyłce. Zajęcie
      // `in_flight` wygasa samo po `barrierInFlightWindowMs`, więc ponowienie
      // jest możliwe — tylko nie natychmiast.
      throw error;
    }
  }

  /**
   * Wynik dla przypadku „inna instancja wysyła to teraz".
   *
   * Świadomie jest to `failed`, a nie cichy `queued`: wołający (wrapper
   * notification-brevo) zamienia `failed` na głośny błąd, więc przypadek jest
   * WIDOCZNY w logu i w ledgerze zamiast wyglądać jak udana wysyłka, która
   * nigdy nie nastąpiła.
   */
  private inFlightDispatch(
    intent: NotificationIntent,
    barrierKey: string,
  ): NotificationDispatch {
    const dispatchId = deriveFailedDispatchId(barrierKey);
    return {
      dispatch_id: dispatchId,
      provider: this.defaultProvider,
      status: "failed",
      audit_event: this.createAuditEvent({
        intent,
        provider: this.defaultProvider,
        status: "failed",
        dispatch_id: dispatchId,
        error_code: MESSAGING_DISPATCH_IN_FLIGHT,
        error_message:
          "Ta sama wysyłka jest właśnie obsługiwana przez inny proces — " +
          "drugi mail byłby duplikatem",
      }),
    };
  }

  /**
   * Wynik dla przypadku „nośnik bariery odmówił / nie odpowiedział".
   *
   * Świadomie jest to `failed` Z KODEM, a nie surowy wyjątek: kod jedzie do
   * wiersza dostawy, a `isGlobalFailureErrorCode` rozpoznaje go jako awarię
   * globalną (patrz {@link MESSAGING_BARRIER_TRANSIENT_ERROR_CODES}), więc
   * próba wraca do budżetu i naprawa połączenia realnie odparkowuje wiersz.
   *
   * ── Tu i TYLKO tu `preflight` zmienia zachowanie (R-4.1-L1) ──────────────
   * Flaga nie jest ozdobą docstringa — rozstrzyga, czy po nieudanym `claim`
   * trzeba jeszcze posprzątać:
   *
   *  * `preflight === true` (`BarrierUnavailableError`) — stwierdzenie NA PEWNO
   *    nie doszło do bazy, więc nie ma czego zwalniać. Zwolnienie byłoby tu
   *    drugim wywołaniem do nośnika, który właśnie odmówił.
   *  * `preflight === false` — `claim` MÓGŁ wejść, a błąd polecieć po nim
   *    (np. zerwane połączenie po `INSERT`). Zostawione zajęcie blokowałoby
   *    ponowienie przez całe okno `in_flight`, więc próbujemy je zwolnić;
   *    `releaseBarrier` jest z definicji nierzucające.
   */
  private async barrierUnavailableDispatch(
    intent: NotificationIntent,
    barrierKey: string,
    claimToken: string,
    error: MessagingProviderError,
  ): Promise<NotificationDispatch> {
    if (!error.preflight) {
      await this.releaseBarrier(barrierKey, claimToken);
    }

    const dispatchId = deriveFailedDispatchId(barrierKey);
    const errorCode = error.error_code || MESSAGING_BARRIER_UNAVAILABLE;

    this.logger?.error?.(
      "[messaging] bariera niedostępna — wysyłka wstrzymana, żeby nie pójść " +
        "bez ochrony przed duplikatem",
      {
        error_code: errorCode,
        dispatch_id: dispatchId,
        preflight: error.preflight,
      },
    );

    return {
      dispatch_id: dispatchId,
      provider: this.defaultProvider,
      status: "failed",
      audit_event: this.createAuditEvent({
        intent,
        provider: this.defaultProvider,
        status: "failed",
        dispatch_id: dispatchId,
        error_code: errorCode,
        error_message: error.message,
      }),
    };
  }

  /**
   * Domknięcie bariery. Awaria magazynu NIE unieważnia wyniku wysyłki: mail
   * albo poszedł, albo nie, i to jest już rozstrzygnięte. Podnoszenie tu
   * wyjątku zamieniłoby udaną wysyłkę w błąd, a wołający ponowiłby ją.
   *
   * Ryzyko rezydualne jest NAZWANE (ADR-196 §D6): niedomknięte zajęcie wygasa
   * po `barrierInFlightWindowMs`, więc po tym oknie ponowienie mogłoby wysłać
   * drugi mail. Dlatego to jest `error`, a nie `warn` — ma budzić.
   */
  private async settleBarrier(
    barrierKey: string,
    claimToken: string,
    dispatch: NotificationDispatch,
    expiresAt: Date | null,
  ): Promise<void> {
    try {
      await this.barrier.settle({
        barrier_key: barrierKey,
        claim_token: claimToken,
        dispatch,
        expires_at: expiresAt,
      });
    } catch (error) {
      this.logger?.error?.(
        "[messaging] MESSAGING_BARRIER_SETTLE_FAILED — zajęcie bariery nie zostało " +
          "domknięte; wygaśnie po oknie in-flight i dopuści ponowienie",
        {
          error_code: "MESSAGING_BARRIER_SETTLE_FAILED",
          dispatch_id: dispatch.dispatch_id,
          dispatch_status: dispatch.status,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Zwolnienie bariery po porażce ROZSTRZYGNIĘTEJ PRZED WYSYŁKĄ.
   *
   * Awaria zwolnienia jest mniej groźna niż awaria domknięcia (skutkuje
   * opóźnieniem ponowienia o okno `in_flight`, nigdy duplikatem), ale nadal
   * musi być widoczna — cicha byłaby nieodróżnialna od poprawnego zwolnienia.
   */
  private async releaseBarrier(
    barrierKey: string,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.barrier.release({
        barrier_key: barrierKey,
        claim_token: claimToken,
      });
    } catch (error) {
      this.logger?.warn?.(
        "[messaging] MESSAGING_BARRIER_RELEASE_FAILED — ponowienie po naprawie " +
          "konfiguracji poczeka do końca okna in-flight",
        {
          error_code: "MESSAGING_BARRIER_RELEASE_FAILED",
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private validateIntent(intent: NotificationIntent): void {
    if (!SUPPORTED_CHANNELS.has(intent.channel as Channel)) {
      throw this.validationError(
        intent,
        "MESSAGING_CHANNEL_INVALID",
        `Channel '${intent.channel}' is not a recognized value (expected one of: email, sms, push)`,
      );
    }

    if (intent.channel !== "email") {
      throw new UnsupportedChannelError(
        `Messaging channel '${intent.channel}' is not supported in v1.10.0`,
        {
          error_code: "MESSAGING_CHANNEL_UNSUPPORTED",
          audit_event: this.createAuditEvent({
            intent,
            provider: this.defaultProvider,
            status: "failed",
            dispatch_id: this.uuid(),
            error_code: "MESSAGING_CHANNEL_UNSUPPORTED",
            error_message: `Channel '${intent.channel}' is not supported in v1.10.0`,
          }),
        },
      );
    }

    if (!intent.recipient.email?.trim()) {
      throw this.validationError(
        intent,
        "MESSAGING_RECIPIENT_EMAIL_REQUIRED",
        "Email recipient is required for email channel",
      );
    }

    if (!intent.recipient.market_id?.trim()) {
      throw this.validationError(
        intent,
        "MESSAGING_MARKET_ID_REQUIRED",
        "Recipient market_id is required",
      );
    }

    if (!intent.idempotency_key.trim()) {
      throw this.validationError(
        intent,
        "MESSAGING_IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency key is required",
      );
    }
  }

  private validationError(
    intent: NotificationIntent,
    errorCode: string,
    message: string,
  ): MessagingValidationError {
    return new MessagingValidationError(message, {
      error_code: errorCode,
      audit_event: this.createAuditEvent({
        intent,
        provider: this.defaultProvider,
        status: "failed",
        dispatch_id: this.uuid(),
        error_code: errorCode,
        error_message: message,
      }),
    });
  }

  /**
   * H1 (AC1): realny konsument znormalizowanego strumienia delivery/engagement
   * (Story 5.5). Wołany przez subscriber webhooka Brevo po normalizacji
   * zdarzenia; mapuje typ zdarzenia → KPI source event i emituje przez hook
   * telemetryczny.
   *
   * ── Story 4.1: `context` jest WYMAGANY, a nie odtwarzany z mapy ───────────
   * Do v1.14.0 kontekst dało się pominąć, a gateway odtwarzał go z mapy
   * `dispatchContext` w pamięci procesu. Ta mapa ZNIKŁA i NIE została zastąpiona
   * tabelą — zmierzony zbiór wywołujących `recordDeliveryEvent` poza plikiem
   * definicji zawierał WYŁĄCZNIE `__tests__/gateway.test.ts`, bo endpoint
   * webhooka jest dziś zaślepką. Utrwalenie mechanizmu, którego produkcja nie
   * woła, byłoby przeniesieniem martwego mechanizmu, tylko droższym (AD-23).
   *
   * Nośnik korelacji dla Story 4.2 jest więc NAZWANY, nie domyślny: jest nim
   * WIERSZ SKUTKU `voucher_delivery_dispatch`, który niesie już `flow_id`,
   * `market_id`, `locale`, `recipient_hash` i `sent_at` (migracje
   * `1778933000000`+). Subscriber webhooka odczyta kontekst stamtąd — po
   * `provider_message_id` / `dispatch_id` — i poda go TUTAJ jawnie. Wymagany
   * argument sprawia, że 4.2 nie może przeoczyć tego kroku po cichu.
   */
  recordDeliveryEvent(
    event: NotificationDeliveryEvent,
    context: DispatchKpiContext,
  ): ReturnType<FlowKpiTelemetryHook["emit"]> | null {
    if (!this.flowKpiTelemetry) return null;

    const kpiType = mapDeliveryEventType(event.event_type);
    if (!kpiType) return null;

    const resolved = context;

    const sourceEvent: CommunicationKpiSourceEvent = {
      source: "normalized_event_store",
      event_id: event.provider_event_id,
      event_type: kpiType,
      occurred_at: event.occurred_at,
      flow_id: resolved.flow_id,
      market: resolved.market,
      locale: resolved.locale,
      recipient_hash: resolved.recipient_hash,
      dispatch_time: resolved.dispatch_time,
      provider_timestamp: event.occurred_at,
      idempotency_key: `${event.dispatch_id}:${event.provider_event_id}`,
      provider: event.provider,
    };

    return this.flowKpiTelemetry.emit(sourceEvent);
  }

  private emitDispatchKpi(dispatch: NotificationDispatch): void {
    if (!this.flowKpiTelemetry) return;
    const kpiType = mapDispatchStatus(dispatch.status);
    if (!kpiType) return;

    const audit = dispatch.audit_event;
    const sourceEvent: CommunicationKpiSourceEvent = {
      source: "delivery_audit_envelope",
      event_id: audit.dispatch_id,
      event_type: kpiType,
      occurred_at: audit.occurred_at,
      flow_id: audit.flow_id,
      market: audit.market_id,
      locale: audit.locale,
      recipient_hash: audit.hashed_recipient,
      dispatch_time: dispatch.sent_at ?? audit.occurred_at,
      provider_timestamp: dispatch.sent_at ?? audit.occurred_at,
      idempotency_key: audit.idempotency_key,
      provider: audit.provider,
    };

    this.flowKpiTelemetry.emit(sourceEvent);
  }

  private createAuditEvent(input: {
    intent: NotificationIntent;
    provider: NotificationProvider;
    status: NotificationDispatchStatus;
    dispatch_id: string;
    error_code?: string;
    error_message?: string;
    gate_source?: "feature_flag";
  }): NotificationAuditEnvelope {
    return {
      audit_id: this.uuid(),
      event_type: "notification.dispatch",
      status: input.status,
      dispatch_id: input.dispatch_id,
      // input.provider is already NotificationProvider ("brevo"|"resend") which
      // satisfies the narrowed AuditEnvelope<..., NotificationProvider> constraint
      // directly — no runtime conversion needed (L-2 fix).
      provider: input.provider,
      flow_id: input.intent.flow_id,
      template_key: input.intent.template_key,
      channel: input.intent.channel,
      market_id: input.intent.recipient.market_id,
      locale: input.intent.locale,
      consent_basis: input.intent.consent_basis,
      idempotency_key: input.intent.idempotency_key,
      hashed_recipient: hashRecipient(input.intent),
      occurred_at: this.clock().toISOString(),
      error_code: input.error_code,
      error_message: input.error_message,
      gate_source: input.gate_source,
    };
  }

  private applyFeatureFlagGate(
    intent: NotificationIntent,
  ): NotificationDispatch | undefined {
    if (!this.flagResolver) {
      return undefined;
    }

    const flagState = this.flagResolver.resolve({
      flow_id: intent.flow_id,
      market_id: intent.recipient.market_id,
    });

    if (flagState.enabled) {
      return undefined;
    }

    // F-01: gated denial NIE jest cache'owany — operator flip OFF→ON musi natychmiast
    // odblokować flow bez czekania na TTL idempotency cache. Tradeoff: kolejne retry
    // dla disabled flow generują nowy dispatch_id, ale to akceptowalne dla denial path
    // (consumer i tak nie dostarcza wiadomości; idempotency invariant Story 5.1 zachowany
    // dla success/queued dispatchy).
    const dispatchId = this.uuid();
    return {
      dispatch_id: dispatchId,
      provider: this.defaultProvider,
      status: "failed",
      audit_event: this.createAuditEvent({
        intent,
        provider: this.defaultProvider,
        status: "failed",
        dispatch_id: dispatchId,
        error_code: "FLOW_DISABLED",
        error_message: `Communication flow '${intent.flow_id}' is disabled for market '${intent.recipient.market_id}'`,
        gate_source: "feature_flag",
      }),
    };
  }
}

/**
 * Klucz bariery: `market_id | flow_id | channel | idempotency_key`.
 *
 * F-08: człony rynku, flow i kanału chronią przed cross-tenant kolizją surowego
 * `idempotency_key` pochodzącego z różnych rynków i flow.
 *
 * Story 4.1: ta sama konstrukcja co dawny klucz mapy — zmienia się NOŚNIK, nie
 * tożsamość wysyłki. Dzięki temu przeniesienie na warstwę trwałą nie zmienia
 * tego, CO jest uznawane za „tę samą wysyłkę", tylko gdzie jest zapamiętane.
 */
export function buildBarrierKey(intent: NotificationIntent): string {
  return [
    intent.recipient.market_id,
    intent.flow_id,
    intent.channel,
    intent.idempotency_key,
  ].join("|");
}

// R2-M1: deterministyczny dispatch_id dla failed dispatch wyprowadzony z klucza bariery,
// żeby retry tego samego intentu (po wygaśnięciu cache lub w nowym procesie) dał
// powtarzalny identyfikator zamiast losowego uuid — eliminuje niedeterminizm
// i ułatwia korelację duplikatów w audicie.
function deriveFailedDispatchId(barrierKey: string): string {
  const digest = createHash("sha256").update(barrierKey).digest("hex");
  // Format jako UUID-podobny (8-4-4-4-12) z deterministycznego hasha.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

// H1 / R2-M2: dispatch lifecycle jest JEDYNYM autorytatywnym źródłem KPI `sent`
// (zasila denominator delivered_rate). NIE emituje `delivered` z czasu dispatchu —
// nawet gdy provider zwróci synchronicznie status "delivered", liczymy go tylko jako
// `sent`, bo autorytatywnym źródłem `delivered`/`clicked` jest znormalizowane
// zdarzenie webhooka (recordDeliveryEvent / mapDeliveryEventType). Bez tego ta sama
// logiczna dostawa byłaby liczona dwa razy w dwóch różnych namespace'ach
// idempotency key (dispatch audit envelope vs normalized event store) i dedupe
// flow-KPI by jej nie scalił → inflacja delivered_rate.
// R2-L2: `queued` jest świadomie mapowany na `sent` — w modelu KPI v1.10.0 nie ma
// osobnego "enqueued" eventu; wystawienie do providera (queued|sent) liczymy jako
// jedno zdarzenie "sent" zasilające denominator. failed nie emituje KPI (brak dostawy).
function mapDispatchStatus(
  status: NotificationDispatchStatus,
): CommunicationKpiSourceEventType | null {
  switch (status) {
    case "queued":
    case "sent":
    case "delivered":
      return "sent";
    default:
      return null;
  }
}

// H1: znormalizowane zdarzenie engagement (webhook) → KPI source event_type.
// opened/odbicia/spam nie mapują się na żaden z 5 KPI w v1.10.0.
//
// ADR-192: ten `switch` był dotąd domknięty `default: return null` — czyli
// catch-allem. Po rozszerzeniu dziedziny klas (FR-9d) catch-all zostaje usunięty
// i każda klasa jest rozstrzygnięta JAWNIE, a `assertNever` sprawia, że dodanie
// nowej klasy bez decyzji tutaj NIE KOMPILUJE SIĘ. Klasy zwracające `null` są
// świadomą decyzją "brak odpowiadającego KPI w v1.10.0", nie przeoczeniem.
function mapDeliveryEventType(
  type: NotificationDeliveryEventType,
): CommunicationKpiSourceEventType | null {
  switch (type) {
    case "delivered":
      return "delivered";
    case "clicked":
      return "clicked";
    case "unsubscribed":
      return "unsubscribed";
    case "opened":
    case "bounced_permanent":
    case "bounced_transient":
    case "blocked":
    case "invalid_address":
    case "deferred":
    case "complaint":
    case "failed":
      return null;
    default:
      return assertNeverDeliveryEventType(type);
  }
}

function assertNeverDeliveryEventType(value: never): never {
  throw new Error(
    `mapDeliveryEventType: nieobsłużona klasa zdarzenia dostawy: ${String(value)}`,
  );
}

function hashRecipient(intent: NotificationIntent): string {
  const recipient = intent.recipient.email ?? intent.recipient.phone ?? "";
  return createHash("sha256")
    .update(`${intent.channel}:${recipient.toLowerCase()}`)
    .digest("hex");
}
