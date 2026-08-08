/**
 * Okno WYSYŁKA ↔ POTWIERDZENIE — kontrole wykonaniem.
 *
 * v1.15.0 Story 4.5 (FR-9f, NFR-1, NFR-4, AD-23).
 *
 * ── Czego ta suita NIE robi ────────────────────────────────────────────────
 * Nie sprawdza, czy mechanizm ISTNIEJE. Każdy przypadek tutaj ma pokazać, że
 * mechanizm ODPALIŁ — i każdy ma parę w postaci przebiegu na topologii SPRZED
 * zmiany, który daje wynik PRZECIWNY. Test przechodzący w obu stanach świata
 * nie mierzy niczego.
 *
 * ── Dlaczego martwy proces jest tu odtwarzany RĘCZNIE ──────────────────────
 * Bo chroniony scenariusz to NIE „`settle` rzucił wyjątkiem". To „proces
 * przestał istnieć między `provider.send` a `settleBarrier`": bez wykonania
 * bloku `catch`, bez wpisu do logu, bez niczego. Dowód oparty na wykonaniu
 * `catch` albo na obecności loga mierzyłby łatwiejszy wariant i przepuszczał
 * trudniejszy. Dlatego wariant (ii) odtwarza STAN, jaki martwy przebieg
 * zostawia po sobie — zajęcie `in_flight` plus realne dotknięcie providera —
 * a nie ścieżkę, którą do niego doszedł.
 *
 * ── Zegar jest WSTRZYKNIĘTY ────────────────────────────────────────────────
 * Żadnego `sleep`, żadnego zegara ściennego i — co istotniejsze — ŻADNEGO
 * procesu sprzątającego w którymkolwiek przebiegu. Werdykt bariery ma pochodzić
 * z predykatu operacji, więc suita, która musiałaby coś posprzątać, dowodziłaby
 * czegoś przeciwnego.
 */
import {
  DefaultMessagingGateway,
  DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS,
  DISPATCH_RESOLUTION_LOOKBACK_MS,
  MESSAGING_BARRIER_RECLAIM_UNRESOLVED,
  MESSAGING_BARRIER_TRANSIENT_ERROR_CODES,
  buildBarrierKey,
  buildDispatchIdentityTag,
} from "../index";
import type {
  IMessagingProvider,
  NotificationIntent,
  ProviderDispatchLookup,
  ProviderDispatchResolution,
} from "../index";
import { SharedDispatchBarrier } from "./support/shared-barrier";

const T0 = new Date("2026-08-08T12:00:00.000Z");
/** Chwila PO wygaśnięciu okna `in_flight` — tam, gdzie zaczyna się ryzyko. */
const T_AFTER = new Date(T0.getTime() + DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS + 1);

function makeIntent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: "voucher_delivery_recipient_email",
    recipient: { email: "buyer@example.com", market_id: "pl" },
    variables: { voucher_code: "ABC-123" },
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-okno-1",
    ...overrides,
  };
}

/**
 * Provider z licznikiem realnych wysyłek ORAZ z rejestrem wiadomości „po
 * stronie dostawcy".
 *
 * `sentToProvider` jest tu odpowiednikiem skrzynki klientki: rośnie WYŁĄCZNIE
 * wtedy, gdy mail faktycznie wyszedł. To jest liczba, którą wszystkie
 * przypadki poniżej mierzą — nie liczba wywołań bariery, nie liczba logów.
 */
function makeProvider(options: { resolves?: boolean } = {}) {
  const sentToProvider: string[] = [];
  const lookups: ProviderDispatchLookup[] = [];
  let lookupOutcome: "answer" | "throw" = "answer";

  const provider: IMessagingProvider & {
    sentToProvider: string[];
    lookups: ProviderDispatchLookup[];
    failLookups(): void;
  } = {
    key: "brevo",
    sentToProvider,
    lookups,
    failLookups() {
      lookupOutcome = "throw";
    },
    async send(intent: NotificationIntent) {
      // Tożsamość jedzie do „dostawcy" tak samo, jak realnie jedzie w polu
      // `tags` payloadu Brevo — wyprowadzona z klucza bariery, więc znana
      // PRZED wysyłką.
      sentToProvider.push(buildDispatchIdentityTag(buildBarrierKey(intent)));
      return {
        dispatch_id: `provider-dispatch-${sentToProvider.length}`,
        status: "queued" as const,
        provider_message_id: `brevo-message-${sentToProvider.length}`,
        sent_at: T0.toISOString(),
      };
    },
  };

  if (options.resolves !== false) {
    (provider as Record<string, unknown>).resolveDispatched = async (
      lookup: ProviderDispatchLookup,
    ): Promise<ProviderDispatchResolution> => {
      lookups.push(lookup);
      if (lookupOutcome === "throw") {
        throw new Error("dostawca odmówił odczytu (HTTP 429)");
      }
      // Odwzorowanie ODCZYTU u dostawcy: okno + dopasowanie tożsamości.
      // Dopasowanie jest tu — jak w adapterze — PO STRONIE KLIENTA, bo
      // serwerowy filtr tagów jest zmierzonym no-opem.
      const found = sentToProvider.includes(lookup.dispatch_identity);
      return found
        ? { outcome: "confirmed_sent", provider_message_id: "brevo-message-1" }
        : { outcome: "not_found" };
    };
  }

  return provider;
}

function makeGateway(
  provider: IMessagingProvider,
  barrier: SharedDispatchBarrier,
  clock: () => Date,
) {
  return new DefaultMessagingGateway({ brevo: provider }, "brevo", {
    barrier,
    clock,
  });
}

/**
 * ŚMIERĆ PROCESU odtworzona przez STAN, nie przez ścieżkę.
 *
 * Robi dokładnie to, co zdążył zrobić martwy przebieg: zajął barierę i zawołał
 * providera. Nie robi nic z tego, czego NIE zdążył: nie domyka bariery, nie
 * wykonuje `catch`, nie loguje. Po powrocie z tej funkcji świat wygląda tak,
 * jak po `kill -9` między dwiema liniami gatewaya.
 */
async function processDiesAfterSend(
  provider: IMessagingProvider,
  barrier: SharedDispatchBarrier,
  intent: NotificationIntent,
  now: Date,
): Promise<void> {
  const barrierKey = buildBarrierKey(intent);
  const claim = await barrier.claim({
    barrier_key: barrierKey,
    now,
    in_flight_window_ms: DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS,
    claim_token: "token-martwego-przebiegu",
  });
  expect(claim.outcome).toBe("claimed");
  await provider.send(intent);
  // …i tu proces przestaje istnieć.
}

describe("Story 4.5 — okno między wysyłką a potwierdzeniem", () => {
  describe("wariant (ii): proces GINIE po `provider.send`, przed domknięciem", () => {
    it("ponowienie PO wygaśnięciu okna `in_flight` NIE wysyła drugiego maila", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      expect(provider.sentToProvider).toHaveLength(1);

      // Ponowienie w NOWYM procesie, po wygaśnięciu okna — czyli dokładnie
      // wtedy, gdy zajęcie staje się przejmowalne i sweep ma prawo wrócić.
      const gateway = makeGateway(provider, barrier, () => T_AFTER);
      const dispatch = await gateway.send(intent);

      expect(provider.sentToProvider).toHaveLength(1);
      expect(dispatch.status).toBe("sent");
      expect(dispatch.provider_message_id).toBe("brevo-message-1");
    });

    it("KONTROLA KONTROLI: na topologii SPRZED zmiany ten sam przebieg daje DWA maile", async () => {
      // Jedyna różnica: bariera nie raportuje, że zajęcie zostało PRZEJĘTE
      // (`claim_count` zawsze `1`) — czyli stan świata sprzed Story 4.5.
      // Gateway nie ma wtedy sygnału, żeby zapytać dostawcę, i wysyła w ciemno.
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const preStory45 = Object.assign(
        Object.create(Object.getPrototypeOf(barrier) as object) as SharedDispatchBarrier,
        barrier,
        {
          claim: async (input: Parameters<SharedDispatchBarrier["claim"]>[0]) => {
            const claim = await SharedDispatchBarrier.prototype.claim.call(barrier, input);
            return { ...claim, claim_count: 1 };
          },
        },
      );
      const intent = makeIntent();

      await processDiesAfterSend(provider, preStory45, intent, T0);
      const gateway = makeGateway(provider, preStory45, () => T_AFTER);
      await gateway.send(intent);

      // DWA maile do klientki. To jest defekt, który ta story zamyka —
      // i dowód, że przypadek wyżej mierzy właśnie jego brak.
      expect(provider.sentToProvider).toHaveLength(2);
    });
  });

  describe("wariant (i): `settle` RZUCA (ścieżka MESSAGING_BARRIER_SETTLE_FAILED)", () => {
    it("ponowienie po wygaśnięciu okna NIE wysyła drugiego maila", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      // Domknięcie zawodzi RAZ — gateway je połyka (celowo: mail już poszedł,
      // rzucenie zamieniłoby sukces w błąd). Zajęcie zostaje `in_flight`.
      const realSettle = barrier.settle.bind(barrier);
      let settleCalls = 0;
      barrier.settle = async (input) => {
        settleCalls += 1;
        if (settleCalls === 1) {
          throw new Error("magazyn bariery odmówił domknięcia");
        }
        return realSettle(input);
      };

      const first = makeGateway(provider, barrier, () => T0);
      await first.send(intent);
      expect(provider.sentToProvider).toHaveLength(1);

      const second = makeGateway(provider, barrier, () => T_AFTER);
      const dispatch = await second.send(intent);

      expect(provider.sentToProvider).toHaveLength(1);
      expect(dispatch.status).toBe("sent");
    });
  });

  describe("KONTROLA DODATNIA — mechanizm nie skleja dwóch LEGALNYCH wysyłek", () => {
    it("inne zdarzenie (inne uprawnienie) przechodzi normalnie", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();

      await processDiesAfterSend(provider, barrier, makeIntent(), T0);

      // Inny `idempotency_key` = inny klucz bariery = INNA tożsamość u dostawcy.
      const other = makeIntent({ idempotency_key: "idem-okno-2" });
      const gateway = makeGateway(provider, barrier, () => T_AFTER);
      const dispatch = await gateway.send(other);

      expect(provider.sentToProvider).toHaveLength(2);
      expect(dispatch.status).toBe("queued");
    });

    it("inny przepływ (`flow_id`) też przechodzi", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      await processDiesAfterSend(provider, barrier, makeIntent(), T0);

      const gateway = makeGateway(provider, barrier, () => T_AFTER);
      await gateway.send(makeIntent({ flow_id: "voucher_handoff_link" }));

      expect(provider.sentToProvider).toHaveLength(2);
    });

    it("ZMIERZONA GRANICA: sam inny ODBIORCA nie tworzy nowego zdarzenia", async () => {
      // Kontrakt klucza bariery pochodzi ze Story 4.1 i brzmi
      // `market_id|flow_id|channel|idempotency_key` — adresu odbiorcy w nim NIE MA.
      // Ten przypadek istnieje, żeby ta granica była ZAPISANA, a nie odkrywana
      // przy pierwszym zgłoszeniu: zmiana samego adresu przy tym samym
      // `idempotency_key` to dla systemu TA SAMA wysyłka, więc rozstrzyganie po
      // stronie dostawcy słusznie ją zatrzymuje. Call-site, który chce wysłać do
      // kogoś innego, MUSI podać inny `idempotency_key`.
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      await processDiesAfterSend(provider, barrier, makeIntent(), T0);

      const gateway = makeGateway(provider, barrier, () => T_AFTER);
      await gateway.send(
        makeIntent({ recipient: { email: "inna@example.com", market_id: "pl" } }),
      );

      expect(buildBarrierKey(makeIntent())).toBe(
        buildBarrierKey(
          makeIntent({ recipient: { email: "inna@example.com", market_id: "pl" } }),
        ),
      );
      expect(provider.sentToProvider).toHaveLength(1);
    });
  });

  describe("AC3 — oba brzegi okna, zegar wstrzyknięty, ZERO sprzątania", () => {
    it("WEWNĄTRZ okna `in_flight` ponowienie nie woła providera ANI dostawcy", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);

      const inside = new Date(T0.getTime() + DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS - 1);
      const gateway = makeGateway(provider, barrier, () => inside);
      const dispatch = await gateway.send(intent);

      expect(provider.sentToProvider).toHaveLength(1);
      // Wewnątrz okna rozstrzyga sama bariera — pytanie do dostawcy byłoby
      // wywołaniem HTTP bez wpływu na werdykt.
      expect(provider.lookups).toHaveLength(0);
      expect(dispatch.audit_event.error_code).toBe("MESSAGING_DISPATCH_IN_FLIGHT");
    });

    it("PO wygaśnięciu okna pytanie leci do dostawcy z oknem w PREDYKACIE zapytania", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      await makeGateway(provider, barrier, () => T_AFTER).send(intent);

      expect(provider.lookups).toHaveLength(1);
      const lookup = provider.lookups[0];
      // Dolny brzeg okna JEDZIE DO DOSTAWCY jako parametr tego samego zapytania,
      // które rozstrzyga barierę. Nie ma go w żadnym cronie ani filtrze po odczycie.
      expect(lookup.now.getTime() - lookup.sent_after.getTime()).toBe(
        DISPATCH_RESOLUTION_LOOKBACK_MS,
      );
      expect(lookup.dispatch_identity).toBe(
        buildDispatchIdentityTag(buildBarrierKey(intent)),
      );
      expect(lookup.recipient_email).toBe("buyer@example.com");
    });

    it("BEZTERMINOWOŚĆ: po potwierdzeniu dostawca NIE jest pytany po raz drugi, choćby za rok", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      await makeGateway(provider, barrier, () => T_AFTER).send(intent);
      expect(provider.lookups).toHaveLength(1);

      // Rok później. Gdyby potwierdzenie zapisało się z OKNEM zamiast
      // bezterminowo, ten przebieg przejąłby zajęcie i wysłał drugi mail.
      const rokPozniej = new Date(T0.getTime() + 365 * 24 * 60 * 60 * 1000);
      const dispatch = await makeGateway(provider, barrier, () => rokPozniej).send(intent);

      expect(provider.sentToProvider).toHaveLength(1);
      expect(provider.lookups).toHaveLength(1);
      expect(dispatch.status).toBe("sent");
    });
  });

  describe("AC2 — awaria SAMEGO mechanizmu jest głośna i klasyfikowana", () => {
    it("odczyt u dostawcy zawodzi ⇒ ODMOWA z kodem, NIE wysyłka w ciemno", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();
      const errors: string[] = [];

      await processDiesAfterSend(provider, barrier, intent, T0);
      provider.failLookups();

      const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
        barrier,
        clock: () => T_AFTER,
        logger: { error: (message: string) => errors.push(message) },
      });
      const dispatch = await gateway.send(intent);

      expect(provider.sentToProvider).toHaveLength(1);
      expect(dispatch.status).toBe("failed");
      expect(dispatch.audit_event.error_code).toBe(MESSAGING_BARRIER_RECLAIM_UNRESOLVED);
      expect(errors.join("\n")).toContain(MESSAGING_BARRIER_RECLAIM_UNRESOLVED);
    });

    it("provider BEZ zdolności rozstrzygania dostaje ODMOWĘ, nie cichą zgodę", async () => {
      const provider = makeProvider({ resolves: false });
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      const dispatch = await makeGateway(provider, barrier, () => T_AFTER).send(intent);

      expect(provider.sentToProvider).toHaveLength(1);
      expect(dispatch.audit_event.error_code).toBe(MESSAGING_BARRIER_RECLAIM_UNRESOLVED);
    });

    it("nowy kod jest w KOMPLECIE kodów bariery (klasyfikacja sweepa, R-4.1-H2)", () => {
      expect(MESSAGING_BARRIER_TRANSIENT_ERROR_CODES).toContain(
        MESSAGING_BARRIER_RECLAIM_UNRESOLVED,
      );
    });

    it("po odmowie zajęcie jest ZWOLNIONE — ponowienie po naprawie odczytu rozstrzyga", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      provider.failLookups();
      await makeGateway(provider, barrier, () => T_AFTER).send(intent);

      // Zajęcie nie zostało po odmowie — inaczej ponowienie odbijałoby się
      // od niego przez kolejne 15 minut za awarię, która już minęła.
      expect(barrier.rows.has(buildBarrierKey(intent))).toBe(false);
    });
  });

  describe("tożsamość wysyłki", () => {
    it("jest znana PRZED wysyłką i odtwarzalna z samego intentu", () => {
      const intent = makeIntent();
      const first = buildDispatchIdentityTag(buildBarrierKey(intent));
      const second = buildDispatchIdentityTag(buildBarrierKey(makeIntent()));
      expect(first).toBe(second);
    });

    it("NIE zawiera przecinka ani danych odbiorcy", () => {
      const tag = buildDispatchIdentityTag(buildBarrierKey(makeIntent()));
      // Przecinek: po stronie dostawcy tag bywa po nim rozbijany (zmierzone).
      expect(tag).not.toContain(",");
      expect(tag).not.toContain("buyer@example.com");
      expect(tag).not.toContain("idem-okno-1");
      expect(tag).toMatch(/^gpd[0-9a-f]{32}$/);
    });

    it("różne zdarzenia dają różne tożsamości", () => {
      expect(buildDispatchIdentityTag(buildBarrierKey(makeIntent()))).not.toBe(
        buildDispatchIdentityTag(
          buildBarrierKey(makeIntent({ idempotency_key: "inny" })),
        ),
      );
    });
  });
});
