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
  DISPATCH_UNRESOLVED_RETRY_WINDOW_MS,
  MESSAGING_BARRIER_RECLAIM_UNRESOLVED,
  MESSAGING_BARRIER_TRANSIENT_ERROR_CODES,
  buildBarrierKey,
  buildDispatchIdentityTag,
  normalizeRecipientEmail,
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
  /**
   * Skrzynki PO STRONIE DOSTAWCY — jedna lista na adres.
   *
   * R-4.5-M1: atrapa MUSI odwzorować serwerowy filtr `email`, bo on jest
   * u dostawcy OBOWIĄZKOWY (bez niego `400 missing_parameter`). Atrapa, która
   * dopasowywała wyłącznie po tożsamości i adres IGNOROWAŁA, była SŁABSZA niż
   * kontrakt, który odwzorowuje — i dlatego przepuszczała przypadek, w którym
   * produkcyjny adapter odpowiadał `not_found` tam, gdzie suita mówiła
   * `confirmed_sent`.
   */
  const providerInbox: Array<{ identity: string; email: string }> = [];
  const lookups: ProviderDispatchLookup[] = [];
  let lookupOutcome: "answer" | "throw" = "answer";

  const provider: IMessagingProvider & {
    sentToProvider: string[];
    lookups: ProviderDispatchLookup[];
    failLookups(): void;
    healLookups(): void;
  } = {
    key: "brevo",
    sentToProvider,
    lookups,
    failLookups() {
      lookupOutcome = "throw";
    },
    healLookups() {
      lookupOutcome = "answer";
    },
    async send(intent: NotificationIntent) {
      // Tożsamość jedzie do „dostawcy" tak samo, jak realnie jedzie w polu
      // `tags` payloadu Brevo — wyprowadzona z klucza bariery ORAZ adresu,
      // więc znana PRZED wysyłką.
      const email = intent.recipient.email as string;
      const identity = buildDispatchIdentityTag(buildBarrierKey(intent), email);
      sentToProvider.push(identity);
      providerInbox.push({ identity, email: normalizeRecipientEmail(email) });
      return {
        dispatch_id: `provider-dispatch-${sentToProvider.length}`,
        status: "queued" as const,
        provider_message_id: `brevo-message-${sentToProvider.length}`,
        sent_at: T0.toISOString(),
      };
    },
  };

  if (options.resolves !== false) {
    // R-4.5-M3: konwersja przez `unknown` — patrz `gateway.test.ts`.
    (provider as unknown as Record<string, unknown>).resolveDispatched = async (
      lookup: ProviderDispatchLookup,
    ): Promise<ProviderDispatchResolution> => {
      lookups.push(lookup);
      if (lookupOutcome === "throw") {
        throw new Error("dostawca odmówił odczytu (HTTP 429)");
      }
      // Odwzorowanie ODCZYTU u dostawcy: filtr `email` po stronie SERWERA
      // (obowiązkowy), a dopasowanie tożsamości — jak w adapterze — po stronie
      // KLIENTA, bo serwerowy filtr tagów jest zmierzonym no-opem.
      const visible = providerInbox.filter(
        (row) => row.email === normalizeRecipientEmail(lookup.recipient_email),
      );
      const found = visible.some((row) => row.identity === lookup.dispatch_identity);
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

    it("ZMIERZONA GRANICA (R-4.5-M1): inny ODBIORCA = inna TOŻSAMOŚĆ, więc mail do niego wychodzi", async () => {
      // Ten przypadek zapisuje stan świata ZMIERZONY, a nie życzony.
      //
      // Klucz bariery pochodzi ze Story 4.1 i brzmi
      // `market_id|flow_id|channel|idempotency_key` — adresu w nim NIE MA.
      // Tożsamość u dostawcy adres jednak OBEJMUJE, i to nie jest nasz wybór:
      // odczyt `GET /v3/smtp/emails` ma filtr `email` OBOWIĄZKOWY, więc dostawca
      // odpowiada zawsze o JEDNEJ skrzynce.
      //
      // Poprzednia wersja tego przypadku twierdziła coś przeciwnego („inny
      // odbiorca jest zatrzymywany") i przechodziła WYŁĄCZNIE dlatego, że atrapa
      // ignorowała `recipient_email`. Na produkcyjnym adapterze zmierzony wynik
      // brzmiał `not_found` — czyli mail i tak wychodził. Suita mówiła jedno,
      // produkcja robiła drugie.
      //
      // Duplikatem jest drugi mail do TEJ SAMEJ klientki; wysyłka pod inny adres
      // nim nie jest, więc ten wynik jest poprawny — ważne, że jest ZAPISANY.
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      await processDiesAfterSend(provider, barrier, makeIntent(), T0);

      const inny = makeIntent({
        recipient: { email: "inna@example.com", market_id: "pl" },
      });
      const gateway = makeGateway(provider, barrier, () => T_AFTER);
      await gateway.send(inny);

      // Klucz bariery jest TEN SAM…
      expect(buildBarrierKey(inny)).toBe(buildBarrierKey(makeIntent()));
      // …a tożsamość u dostawcy INNA, bo dostawca umie odpowiedzieć tylko
      // o konkretnej skrzynce.
      expect(
        buildDispatchIdentityTag(buildBarrierKey(inny), "inna@example.com"),
      ).not.toBe(
        buildDispatchIdentityTag(buildBarrierKey(makeIntent()), "buyer@example.com"),
      );
      expect(provider.sentToProvider).toHaveLength(2);
    });

    it("KONTROLA: ta sama klientka, adres zapisany INACZEJ (spacje, wielkość liter) — to WCIĄŻ ta sama tożsamość", async () => {
      // Normalizacja żyje w JEDNYM miejscu (`normalizeRecipientEmail`). Gdyby
      // wysyłka i odczyt normalizowały osobno, różnica jednej spacji dałaby
      // `not_found` — czyli DRUGI mail do tej samej klientki.
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      await processDiesAfterSend(provider, barrier, makeIntent(), T0);

      const gateway = makeGateway(provider, barrier, () => T_AFTER);
      const dispatch = await gateway.send(
        makeIntent({ recipient: { email: "  Buyer@Example.COM ", market_id: "pl" } }),
      );

      expect(provider.sentToProvider).toHaveLength(1);
      expect(dispatch.status).toBe("sent");
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
        buildDispatchIdentityTag(buildBarrierKey(intent), "buyer@example.com"),
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

    it("R-4.5-H1: po odmowie KOLEJNE ponowienie NADAL nie wysyła drugiego maila", async () => {
      // To jest kontrola, która PĘKAŁA na kodzie sprzed poprawki (zmierzone:
      // dwie te same tożsamości u dostawcy). Ścieżka jest zaprojektowana, nie
      // hipotetyczna: kod odmowy jest w `MESSAGING_BARRIER_TRANSIENT_ERROR_CODES`,
      // więc sweep po ten wiersz WRACA.
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      // 1. przebieg A wysyła i ginie przed domknięciem.
      await processDiesAfterSend(provider, barrier, intent, T0);
      expect(provider.sentToProvider).toHaveLength(1);

      // 2. przebieg B przejmuje zajęcie, odczyt u dostawcy zawodzi → ODMOWA.
      provider.failLookups();
      const denied = await makeGateway(provider, barrier, () => T_AFTER).send(intent);
      expect(denied.audit_event.error_code).toBe(MESSAGING_BARRIER_RECLAIM_UNRESOLVED);

      // 3. przebieg C wraca ze sweepem, gdy odczyt JUŻ DZIAŁA.
      provider.healLookups();
      const T_SWEEP = new Date(
        T_AFTER.getTime() + DISPATCH_UNRESOLVED_RETRY_WINDOW_MS + 1,
      );
      const resolved = await makeGateway(provider, barrier, () => T_SWEEP).send(intent);

      // NADAL jeden mail. Sygnał `claim_count` przeżył odmowę, więc przebieg C
      // zapytał dostawcę zamiast wysłać w ciemno.
      expect(provider.sentToProvider).toHaveLength(1);
      expect(resolved.status).toBe("sent");
    });

    it("odmowa NIE KASUJE wiersza bariery — nośnik sygnału `claim_count` przeżywa", async () => {
      // Kontrola bezpośrednio na nośniku: to jego skasowanie było przyczyną
      // R-4.5-H1, a nie skutek uboczny. Poprzednia wersja tej suity asertowała
      // dokładnie ODWROTNY warunek (`…has(key)).toBe(false)`) i przez to
      // utrwalała defekt jako własność zamierzoną.
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      provider.failLookups();
      await makeGateway(provider, barrier, () => T_AFTER).send(intent);

      expect(barrier.rows.has(buildBarrierKey(intent))).toBe(true);
      expect(barrier.rows.get(buildBarrierKey(intent))?.claim_count).toBeGreaterThan(1);
    });

    it("okno po odmowie jest KRÓTKIE — ponowienie w jego trakcie dostaje ten sam werdykt, nie blokadę na 8 dni", async () => {
      const provider = makeProvider();
      const barrier = new SharedDispatchBarrier();
      const intent = makeIntent();

      await processDiesAfterSend(provider, barrier, intent, T0);
      provider.failLookups();
      await makeGateway(provider, barrier, () => T_AFTER).send(intent);

      // WEWNĄTRZ okna: deterministycznie ten sam wynik, zero wysyłki.
      const inside = new Date(
        T_AFTER.getTime() + DISPATCH_UNRESOLVED_RETRY_WINDOW_MS - 1,
      );
      const replay = await makeGateway(provider, barrier, () => inside).send(intent);
      expect(replay.audit_event.error_code).toBe(MESSAGING_BARRIER_RECLAIM_UNRESOLVED);
      expect(provider.sentToProvider).toHaveLength(1);

      // Okno jest cadence'em sweepa, NIE horyzontem ponowień — dostawa nie może
      // stać osiem dni za awarię odczytu, która minęła po minucie.
      expect(DISPATCH_UNRESOLVED_RETRY_WINDOW_MS).toBeLessThan(
        DISPATCH_RESOLUTION_LOOKBACK_MS,
      );
    });
  });

  describe("tożsamość wysyłki", () => {
    it("jest znana PRZED wysyłką i odtwarzalna z samego intentu", () => {
      const intent = makeIntent();
      const first = buildDispatchIdentityTag(buildBarrierKey(intent), "buyer@example.com");
      const second = buildDispatchIdentityTag(
        buildBarrierKey(makeIntent()),
        "buyer@example.com",
      );
      expect(first).toBe(second);
    });

    it("NIE zawiera przecinka ani danych odbiorcy", () => {
      const tag = buildDispatchIdentityTag(
        buildBarrierKey(makeIntent()),
        "buyer@example.com",
      );
      // Przecinek: po stronie dostawcy tag bywa po nim rozbijany (zmierzone).
      expect(tag).not.toContain(",");
      // Adres WCHODZI do skrótu, ale NIE WYCHODZI z niego — SHA-256 jest
      // jednokierunkowy, więc tag nadal nie niesie danych osobowych do dostawcy.
      expect(tag).not.toContain("buyer@example.com");
      expect(tag).not.toContain("idem-okno-1");
      expect(tag).toMatch(/^gpd[0-9a-f]{32}$/);
    });

    it("różne zdarzenia dają różne tożsamości", () => {
      expect(
        buildDispatchIdentityTag(buildBarrierKey(makeIntent()), "buyer@example.com"),
      ).not.toBe(
        buildDispatchIdentityTag(
          buildBarrierKey(makeIntent({ idempotency_key: "inny" })),
          "buyer@example.com",
        ),
      );
    });

    it("różny ODBIORCA daje różną tożsamość, a różnica w zapisie adresu — NIE (R-4.5-M1)", () => {
      const key = buildBarrierKey(makeIntent());
      expect(buildDispatchIdentityTag(key, "buyer@example.com")).not.toBe(
        buildDispatchIdentityTag(key, "inna@example.com"),
      );
      expect(buildDispatchIdentityTag(key, "  Buyer@Example.COM ")).toBe(
        buildDispatchIdentityTag(key, "buyer@example.com"),
      );
    });
  });
});
