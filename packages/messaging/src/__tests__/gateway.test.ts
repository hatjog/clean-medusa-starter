/**
 * Suita gatewaya messagingu.
 *
 * v1.15.0 Story 4.1 przeniosła barierę idempotencji z mapy w pamięci procesu
 * (`idempotencyCache`) do TRWAŁEGO nośnika za portem `DispatchIdempotencyBarrier`.
 * Konsekwencje dla tej suity, żeby nie czytać jej jak „kosmetyka":
 *
 *  * Znikły przypadki mierzące MECHANIKĘ MAPY (eviction po `maxCacheSize`, lazy
 *    `pruneExpired`). Nie mają czego mierzyć — nie ma mapy. W ich miejsce weszły
 *    przypadki mierzące PREDYKAT OKNA na barierze.
 *  * Sukces zamyka barierę BEZTERMINOWO (`expires_at = null`), więc dawny
 *    przypadek „odświeża provider call po wygaśnięciu cache" jest teraz WPROST
 *    ODWRÓCONY: po dowolnym upływie czasu ponowienie udanej wysyłki NIE woła
 *    providera. Okno dotyczy wyłącznie porażki NIEJEDNOZNACZNEJ.
 *  * `recordDeliveryEvent` wymaga jawnego kontekstu — mapa korelacji zniknęła
 *    bez zastąpienia (patrz docstring metody).
 */
import {
  DefaultMessagingGateway,
  DEFAULT_BARRIER_AMBIGUOUS_WINDOW_MS,
  MESSAGING_BARRIER_UNAVAILABLE,
  MESSAGING_DISPATCH_IN_FLIGHT,
  MessagingProviderError,
  MessagingValidationError,
  UnsupportedChannelError,
  UnsupportedProviderError,
} from "../index";
import type {
  CommunicationKpiSourceEvent,
  DispatchKpiContext,
  FlowKpiEmissionResult,
  FlowKpiTelemetryHook,
  IMessagingProvider,
  MessagingProviderRegistry,
  NotificationDeliveryEvent,
  NotificationIntent,
  NotificationProvider,
} from "../index";
import { SharedDispatchBarrier } from "./support/shared-barrier";

const fixedNow = new Date("2026-05-26T12:00:00.000Z");

function makeIntent(
  overrides: Partial<NotificationIntent> = {},
): NotificationIntent {
  const base: NotificationIntent = {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: "voucher_delivery_recipient_email",
    recipient: {
      email: "buyer@example.com",
      market_id: "pl",
    },
    variables: {
      voucher_code: "ABC-123",
    },
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-1",
  };

  return {
    ...base,
    ...overrides,
    recipient: {
      ...base.recipient,
      ...overrides.recipient,
    },
  };
}

function makeUuid(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `uuid-${index}`;
}

function makeProvider(): IMessagingProvider {
  return {
    key: "brevo",
    send: jest.fn().mockResolvedValue({
      dispatch_id: "provider-dispatch-1",
      status: "queued",
      provider_message_id: "brevo-message-1",
      sent_at: fixedNow.toISOString(),
    }),
  };
}

/**
 * Buduje gateway z BARIERĄ — bo bez niej nie da się go zbudować (typ wymaga).
 * Domyślnie każdy gateway dostaje własną, świeżą barierę; przypadki
 * cross-instance podają WSPÓLNĄ jawnie.
 */
function makeGateway(options: {
  providers?: MessagingProviderRegistry;
  defaultProvider?: NotificationProvider;
  clock?: () => Date;
  uuid?: string[];
  barrier?: SharedDispatchBarrier;
  flowKpiTelemetry?: FlowKpiTelemetryHook;
  barrierAmbiguousWindowMs?: number;
  barrierInFlightWindowMs?: number;
}): DefaultMessagingGateway {
  return new DefaultMessagingGateway(
    options.providers ?? { brevo: makeProvider() },
    options.defaultProvider ?? "brevo",
    {
      barrier: options.barrier ?? new SharedDispatchBarrier(),
      clock: options.clock ?? (() => fixedNow),
      uuid: makeUuid(options.uuid ?? []),
      flowKpiTelemetry: options.flowKpiTelemetry,
      barrierAmbiguousWindowMs: options.barrierAmbiguousWindowMs,
      barrierInFlightWindowMs: options.barrierInFlightWindowMs,
    },
  );
}

function makeRecordingHook(sink: CommunicationKpiSourceEvent[]): FlowKpiTelemetryHook {
  return {
    emit: (event: CommunicationKpiSourceEvent): FlowKpiEmissionResult => {
      sink.push(event);
      return {
        emitted: [],
        skipped_duplicate: [],
        not_emitted: [],
        gated: false,
        flow_registry_status: "approved",
        missing_roles: [],
      };
    },
  };
}

const KPI_CONTEXT: DispatchKpiContext = {
  flow_id: "voucher_delivery_recipient",
  market: "pl",
  locale: "pl-PL",
  recipient_hash: "deadbeef",
  dispatch_time: fixedNow.toISOString(),
};

describe("DefaultMessagingGateway", () => {
  it("deleguje send do domyślnego providera i zwraca audit envelope success", async () => {
    const provider = makeProvider();
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["audit-1"],
    });

    const dispatch = await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send).toHaveBeenCalledWith(makeIntent());
    expect(dispatch).toMatchObject({
      dispatch_id: "provider-dispatch-1",
      provider: "brevo",
      status: "queued",
      provider_message_id: "brevo-message-1",
      sent_at: fixedNow.toISOString(),
      audit_event: {
        audit_id: "audit-1",
        event_type: "notification.dispatch",
        status: "queued",
        dispatch_id: "provider-dispatch-1",
        provider: "brevo",
        flow_id: "voucher_delivery_recipient",
        template_key: "voucher_delivery_recipient_email",
        market_id: "pl",
        locale: "pl-PL",
        consent_basis: "transactional_critical",
        idempotency_key: "idem-1",
        occurred_at: fixedNow.toISOString(),
      },
    });
    expect(dispatch.audit_event.hashed_recipient).toHaveLength(64);
    expect(dispatch.audit_event.hashed_recipient).not.toContain("buyer@example.com");
  });

  it("zwraca failed dispatch z audit envelope przy błędzie providera", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValueOnce(
      new MessagingProviderError("Brevo rejected payload", {
        error_code: "invalid_parameter",
      }),
    );
    const gateway = makeGateway({
      providers: { brevo: provider },
      // R2-M1: dispatch_id failed dispatchu jest deterministycznie wyprowadzony
      // z klucza bariery (nie z sekwencji uuid); pierwszy uuid zasila audit_id.
      uuid: ["audit-failed-1"],
    });

    const dispatch = await gateway.send(makeIntent());

    expect(dispatch).toMatchObject({
      provider: "brevo",
      status: "failed",
      audit_event: {
        audit_id: "audit-failed-1",
        status: "failed",
        error_code: "invalid_parameter",
        error_message: "Brevo rejected payload",
      },
    });
    // Deterministyczny, UUID-podobny kształt z hasha klucza bariery.
    expect(dispatch.dispatch_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("AC3: porażka NIEJEDNOZNACZNA zamyka barierę — ponowienie NIE woła providera", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValue(
      new MessagingProviderError("Brevo timeout after send", {
        error_code: "BREVO_TIMEOUT",
      }),
    );
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["audit-failed-1", "audit-failed-2"],
    });

    const first = await gateway.send(makeIntent());
    const second = await gateway.send(makeIntent());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.status).toBe("failed");
  });

  it("AC3: porażka ROZSTRZYGNIĘTA PRZED WYSYŁKĄ zwalnia barierę — ponowienie WYSYŁA", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValueOnce(
      new MessagingProviderError("Brevo template not configured", {
        error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
        preflight: true,
      }),
    );
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["audit-preflight-1", "audit-preflight-2"],
    });

    const first = await gateway.send(makeIntent());
    expect(first.status).toBe("failed");
    expect(first.audit_event.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED");

    // Drugie wywołanie (operator uzupełnił rejestr) MUSI trafić do providera.
    const second = await gateway.send(makeIntent());
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(second.status).toBe("queued");
  });

  it("AC3: KOD NIEZNANY jest traktowany jak niejednoznaczny — bariera zostaje zamknięta", async () => {
    // Zachowanie ZDEFINIOWANE, nie przypadkowe: `preflight` domyślnie `false`
    // (errors.ts), więc nierozpoznany błąd trafia do gałęzi „mogło pójść".
    // Pomyłka w tę stronę kosztuje opóźniony mail; w drugą — drugi mail.
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValue(
      new MessagingProviderError("Kod, którego nikt jeszcze nie widział", {
        error_code: "BREVO_SOMETHING_ENTIRELY_NEW",
      }),
    );
    const gateway = makeGateway({ providers: { brevo: provider } });

    await gateway.send(makeIntent());
    await gateway.send(makeIntent());

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("rzuca MessagingValidationError z audit envelope dla braku odbiorcy", async () => {
    const gateway = makeGateway({
      uuid: ["validation-dispatch-1", "audit-validation-1"],
    });

    await expect(
      gateway.send(makeIntent({ recipient: { email: "", market_id: "pl" } })),
    ).rejects.toBeInstanceOf(MessagingValidationError);

    try {
      await gateway.send(makeIntent({ recipient: { email: "", market_id: "pl" } }));
    } catch (error) {
      const typed = error as MessagingValidationError;
      expect(typed.error_code).toBe("MESSAGING_RECIPIENT_EMAIL_REQUIRED");
      expect(typed.audit_event).toMatchObject({
        status: "failed",
        error_code: "MESSAGING_RECIPIENT_EMAIL_REQUIRED",
      });
    }
  });

  it("rzuca MessagingValidationError dla braku market_id", async () => {
    const gateway = makeGateway({
      uuid: ["validation-dispatch-1", "audit-validation-1"],
    });

    await expect(
      gateway.send(makeIntent({ recipient: { email: "buyer@example.com", market_id: "" } })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_MARKET_ID_REQUIRED",
    });
  });

  it("rzuca MessagingValidationError dla pustego idempotency_key", async () => {
    const gateway = makeGateway({
      uuid: ["validation-dispatch-1", "audit-validation-1"],
    });

    await expect(
      gateway.send(makeIntent({ idempotency_key: "   " })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_IDEMPOTENCY_KEY_REQUIRED",
    });
  });

  it("rzuca MessagingValidationError dla nierozpoznanego kanału", async () => {
    const gateway = makeGateway({
      uuid: ["invalid-dispatch-1", "audit-invalid-1"],
    });

    await expect(
      gateway.send(makeIntent({ channel: "webhook" as never })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_CHANNEL_INVALID",
    });
  });

  it("normalizuje adres do hasha niezależnie od wielkości liter", async () => {
    const provider = makeProvider();
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["a1", "a2", "a3", "a4"],
    });

    const first = await gateway.send(
      makeIntent({
        recipient: { email: "Buyer@Example.com", market_id: "pl" },
        idempotency_key: "hash-1",
      }),
    );
    const second = await gateway.send(
      makeIntent({
        recipient: { email: "buyer@example.com", market_id: "pl" },
        idempotency_key: "hash-2",
      }),
    );

    expect(first.audit_event.hashed_recipient).toBe(
      second.audit_event.hashed_recipient,
    );
  });

  it("propaguje consent_basis marketing do audit envelope", async () => {
    const provider = makeProvider();
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["marketing-audit-1"],
    });

    const dispatch = await gateway.send(
      makeIntent({ consent_basis: "marketing" }),
    );

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(dispatch.audit_event.consent_basis).toBe("marketing");
  });

  it("AC4: OBA BRZEGI okna dla porażki niejednoznacznej — bez udziału sprzątacza", async () => {
    // Czas jest STEROWANY (wstrzyknięty zegar), nie odmierzany zegarem ściennym.
    // Żaden proces sprzątający nie istnieje w tej suicie i nie odpala się między
    // brzegami — wygasanie realizuje WYŁĄCZNIE predykat operacji `claim`.
    let now = fixedNow;
    const windowMs = 60_000;
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValue(
      new MessagingProviderError("timeout-after-send", { error_code: "BREVO_TIMEOUT" }),
    );
    const gateway = makeGateway({
      providers: { brevo: provider },
      clock: () => now,
      barrierAmbiguousWindowMs: windowMs,
    });

    await gateway.send(makeIntent());
    expect(sendMock).toHaveBeenCalledTimes(1);

    // WEWNĄTRZ okna (o milisekundę przed końcem) — bariera nadal blokuje.
    now = new Date(fixedNow.getTime() + windowMs - 1);
    await gateway.send(makeIntent());
    expect(sendMock).toHaveBeenCalledTimes(1);

    // PO wygaśnięciu okna — bariera przepuszcza, provider jest wołany ponownie.
    now = new Date(fixedNow.getTime() + windowMs);
    await gateway.send(makeIntent());
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("AC4: SUKCES zamyka barierę BEZTERMINOWO — okno go nie dotyczy", async () => {
    // Kontrola rozróżnienia dwóch semantyk (AC4): `sent` nie ma TTL, bo
    // skasowanie takiego wpisu to ryzyko drugiego maila. Skok o 100× okno
    // niejednoznaczności NIE otwiera bariery.
    let now = fixedNow;
    const provider = makeProvider();
    const gateway = makeGateway({
      providers: { brevo: provider },
      clock: () => now,
    });

    await gateway.send(makeIntent());
    now = new Date(fixedNow.getTime() + 100 * DEFAULT_BARRIER_AMBIGUOUS_WINDOW_MS);
    await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("klucz bariery blokuje cross-market kolizję dla tego samego idempotency_key", async () => {
    // F-08: dwie intencje z różnym market_id ale samym idempotency_key dostają RÓŻNE dispatch_id.
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock
      .mockResolvedValueOnce({
        dispatch_id: "pl-dispatch",
        status: "queued",
      })
      .mockResolvedValueOnce({
        dispatch_id: "de-dispatch",
        status: "queued",
      });
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["a1", "a2", "a3", "a4"],
    });

    const plDispatch = await gateway.send(
      makeIntent({
        recipient: { email: "pl@example.com", market_id: "pl" },
        idempotency_key: "shared-key",
      }),
    );
    const deDispatch = await gateway.send(
      makeIntent({
        recipient: { email: "de@example.com", market_id: "de" },
        idempotency_key: "shared-key",
        locale: "de-DE",
      }),
    );

    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(plDispatch.dispatch_id).toBe("pl-dispatch");
    expect(deDispatch.dispatch_id).toBe("de-dispatch");
    expect(plDispatch.dispatch_id).not.toBe(deDispatch.dispatch_id);
  });

  it("blokuje sms i push jako unsupported channel w v1.10.0", async () => {
    const gateway = makeGateway({
      uuid: ["sms-dispatch", "sms-audit", "push-dispatch", "push-audit"],
    });

    await expect(
      gateway.send(
        makeIntent({
          channel: "sms",
          recipient: { phone: "+48123456789", market_id: "pl" },
        }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedChannelError);

    await expect(
      gateway.send(makeIntent({ channel: "push" })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_CHANNEL_UNSUPPORTED",
    });
  });

  it("AC1: dwa żądania o tym samym kluczu = DOKŁADNIE JEDNO wywołanie providera", async () => {
    const provider = makeProvider();
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["audit-1"],
    });

    const first = await gateway.send(makeIntent());
    const second = await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.dispatch_id).toBe("provider-dispatch-1");
  });

  it("AC1: bariera stoi PRZED skutkiem — zajęcie jest widoczne, zanim provider odpowie", async () => {
    // Pomiar KOLEJNOŚCI, nie deklaracji: w chwili, gdy provider jest w środku
    // swojego `send`, wpis bariery JUŻ istnieje. Gdyby bariera stała po skutku
    // (jak stary `cacheDispatch`), ten odczyt zwróciłby pustkę.
    const barrier = new SharedDispatchBarrier();
    let rowsSeenInsideProvider = -1;
    const provider: IMessagingProvider = {
      key: "brevo",
      send: jest.fn().mockImplementation(async () => {
        rowsSeenInsideProvider = barrier.rows.size;
        return { dispatch_id: "d-1", status: "queued" };
      }),
    };
    const gateway = makeGateway({ providers: { brevo: provider }, barrier });

    await gateway.send(makeIntent());

    expect(rowsSeenInsideProvider).toBe(1);
  });

  it("AC5 (negatywna): DWIE INSTANCJE, jedna baza — jedno wywołanie providera", async () => {
    // Dwa ODRĘBNE gatewaye (dwa zestawy obiektów) wskazujące na JEDNĄ barierę.
    // To NIE jest dwukrotne wywołanie tego samego obiektu — i ta różnica jest
    // przedmiotem pomiaru.
    const barrier = new SharedDispatchBarrier();
    const providerA = makeProvider();
    const providerB = makeProvider();
    const instanceA = makeGateway({ providers: { brevo: providerA }, barrier });
    const instanceB = makeGateway({ providers: { brevo: providerB }, barrier });

    await instanceA.send(makeIntent());
    await instanceB.send(makeIntent());

    const totalProviderCalls =
      (providerA.send as jest.Mock).mock.calls.length +
      (providerB.send as jest.Mock).mock.calls.length;
    expect(totalProviderCalls).toBe(1);
  });

  it("AC5 (KONTROLA KONTROLI): przy stanie PER INSTANCJA ten sam scenariusz daje DWA maile", async () => {
    // Gdyby ten przypadek przechodził, poprzedni nie mierzyłby cross-instance.
    const providerA = makeProvider();
    const providerB = makeProvider();
    const instanceA = makeGateway({
      providers: { brevo: providerA },
      barrier: new SharedDispatchBarrier(),
    });
    const instanceB = makeGateway({
      providers: { brevo: providerB },
      barrier: new SharedDispatchBarrier(),
    });

    await instanceA.send(makeIntent());
    await instanceB.send(makeIntent());

    const totalProviderCalls =
      (providerA.send as jest.Mock).mock.calls.length +
      (providerB.send as jest.Mock).mock.calls.length;
    expect(totalProviderCalls).toBe(2);
  });

  it("AC5 (dodatnia): RÓŻNE zdarzenia przechodzą na OBU instancjach", async () => {
    // Bariera nie tylko odmawia — musi też przepuszczać. Sklejenie dwóch
    // legalnych wysyłek w jedną jest defektem tej samej wagi co duplikat.
    const barrier = new SharedDispatchBarrier();
    const providerA = makeProvider();
    const providerB = makeProvider();
    const instanceA = makeGateway({ providers: { brevo: providerA }, barrier });
    const instanceB = makeGateway({ providers: { brevo: providerB }, barrier });

    await instanceA.send(makeIntent({ idempotency_key: "entitlement-1" }));
    await instanceB.send(makeIntent({ idempotency_key: "entitlement-2" }));
    await instanceB.send(
      makeIntent({
        idempotency_key: "entitlement-1",
        template_key: "voucher_appointment_confirmation",
        flow_id: "voucher_appointment",
      }),
    );

    expect((providerA.send as jest.Mock).mock.calls).toHaveLength(1);
    expect((providerB.send as jest.Mock).mock.calls).toHaveLength(2);
  });

  it("AC1: zajęcie BEZ rozstrzygnięcia (inna instancja w locie) NIE wysyła drugiego maila", async () => {
    const barrier = new SharedDispatchBarrier();
    const providerB = makeProvider();
    const instanceB = makeGateway({ providers: { brevo: providerB }, barrier });

    // Instancja A zajęła klucz i jeszcze nie wróciła od providera.
    await barrier.claim({
      barrier_key: "pl|voucher_delivery_recipient|email|idem-1",
      now: fixedNow,
      in_flight_window_ms: 15 * 60 * 1000,
      claim_token: "tok-1",
    });

    const dispatch = await instanceB.send(makeIntent());

    expect(providerB.send).not.toHaveBeenCalled();
    expect(dispatch.status).toBe("failed");
    expect(dispatch.audit_event.error_code).toBe(MESSAGING_DISPATCH_IN_FLIGHT);
  });

  describe("R-4.1-H2/L1 — odmowa BARIERY dojeżdża do koperty jako wynik z kodem", () => {
    /** Bariera, która ODMAWIA — odwzorowuje `unavailableDispatchBarrier`. */
    function denyingBarrier(preflight: boolean) {
      const deny = async (): Promise<never> => {
        throw new MessagingProviderError("nośnik bariery niedostępny", {
          error_code: MESSAGING_BARRIER_UNAVAILABLE,
          preflight,
        });
      };
      const released: string[] = [];
      return {
        released,
        barrier: {
          claim: deny,
          settle: deny,
          release: async (input: { barrier_key: string }) => {
            released.push(input.barrier_key);
          },
        },
      };
    }

    it("NIE propaguje surowego wyjątku: zwraca `failed` z `MESSAGING_BARRIER_UNAVAILABLE`", async () => {
      // Przed fixem `claim()` stało POZA blokiem `try`, więc wyjątek leciał
      // surowo, do ledgera nie trafiał ŻADEN kod, a `isGlobalFailureErrorCode(null)`
      // zwraca `false` — ścieżka „naprawa infrastruktury → odparkowanie wiersza"
      // nie istniała w ogóle.
      const provider = makeProvider();
      const { barrier } = denyingBarrier(true);
      const gateway = makeGateway({ providers: { brevo: provider }, barrier });

      const dispatch = await gateway.send(makeIntent());

      expect(dispatch.status).toBe("failed");
      expect(dispatch.audit_event.error_code).toBe(MESSAGING_BARRIER_UNAVAILABLE);
      // Najważniejsze: bariery nie było, więc provider NIE został zawołany.
      expect(provider.send).not.toHaveBeenCalled();
    });

    it("`preflight: true` NIE zwalnia zajęcia (nic nie weszło do bazy)", async () => {
      const { barrier, released } = denyingBarrier(true);
      const gateway = makeGateway({ providers: { brevo: makeProvider() }, barrier });

      await gateway.send(makeIntent());

      expect(released).toEqual([]);
    });

    it("`preflight: false` ZWALNIA zajęcie — `claim` mógł wejść przed błędem", async () => {
      // To jest REALNY konsument flagi: bez zwolnienia zostawione zajęcie
      // blokowałoby ponowienie przez całe okno in-flight (15 min).
      const { barrier, released } = denyingBarrier(false);
      const gateway = makeGateway({ providers: { brevo: makeProvider() }, barrier });

      await gateway.send(makeIntent());

      expect(released).toHaveLength(1);
    });
  });

  it("przepuszcza nieoczekiwany błąd spoza portu providera", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValueOnce(new Error("unexpected"));
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["audit-1"],
    });

    await expect(gateway.send(makeIntent())).rejects.toThrow("unexpected");
  });

  it("H1: emituje KPI source event (sent) w lifecycle send() przez wstrzyknięty hook", async () => {
    const emitted: CommunicationKpiSourceEvent[] = [];
    const provider = makeProvider();
    const gateway = makeGateway({
      providers: { brevo: provider },
      uuid: ["audit-1"],
      flowKpiTelemetry: makeRecordingHook(emitted),
    });

    await gateway.send(makeIntent());

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      source: "delivery_audit_envelope",
      event_type: "sent",
      flow_id: "voucher_delivery_recipient",
      market: "pl",
      locale: "pl-PL",
    });
  });

  it("H1: recordDeliveryEvent koreluje zdarzenie z JAWNIE PODANYM kontekstem → KPI", async () => {
    const emitted: CommunicationKpiSourceEvent[] = [];
    const gateway = makeGateway({
      uuid: ["audit-1"],
      flowKpiTelemetry: makeRecordingHook(emitted),
    });

    const deliveryEvent: NotificationDeliveryEvent = {
      dispatch_id: "provider-dispatch-1",
      provider: "brevo",
      event_type: "delivered",
      occurred_at: fixedNow.toISOString(),
      provider_event_id: "brevo-event-1",
    };

    const result = gateway.recordDeliveryEvent(deliveryEvent, KPI_CONTEXT);

    expect(result).not.toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      source: "normalized_event_store",
      event_type: "delivered",
      flow_id: "voucher_delivery_recipient",
      market: "pl",
    });
  });

  it("H1: recordDeliveryEvent degraduje kontrolowanie dla typu spoza modelu KPI", () => {
    const emitted: CommunicationKpiSourceEvent[] = [];
    const gateway = makeGateway({
      uuid: ["audit-1"],
      flowKpiTelemetry: makeRecordingHook(emitted),
    });

    const result = gateway.recordDeliveryEvent(
      {
        dispatch_id: "d-1",
        provider: "brevo",
        event_type: "opened",
        occurred_at: fixedNow.toISOString(),
        provider_event_id: "evt-x",
      },
      KPI_CONTEXT,
    );

    expect(result).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it("rzuca UnsupportedProviderError PRZED zajęciem bariery", async () => {
    // Rzucenie PO zajęciu blokowałoby klucz na całe okno in-flight za coś, co
    // nawet nie dotknęło providera — dlatego kolejność jest mierzona.
    const barrier = new SharedDispatchBarrier();
    const gateway = makeGateway({
      providers: {},
      defaultProvider: "resend",
      barrier,
      uuid: ["unsupported-dispatch-1", "audit-unsupported-1"],
    });

    await expect(gateway.send(makeIntent())).rejects.toBeInstanceOf(
      UnsupportedProviderError,
    );
    expect(barrier.claims).toBe(0);
    expect(barrier.rows.size).toBe(0);

    try {
      await gateway.send(makeIntent());
    } catch (error) {
      const typed = error as UnsupportedProviderError;
      expect(typed.error_code).toBe("MESSAGING_PROVIDER_UNSUPPORTED");
      expect(typed.audit_event).toMatchObject({
        provider: "resend",
        status: "failed",
        error_code: "MESSAGING_PROVIDER_UNSUPPORTED",
      });
    }
  });
});
