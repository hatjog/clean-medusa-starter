/**
 * Rozstrzyganie po stronie dostawcy — adapter Brevo.
 *
 * v1.15.0 Story 4.5 (FR-9f, NFR-1, AD-23).
 *
 * Każdy przypadek tutaj odwzorowuje kształt ZMIERZONY na realnym koncie
 * 2026-08-08 (`implementation-artifacts/evidence/4-5/pomiar-zdolnosci-dostawcy.md`),
 * a nie kształt przepisany z dokumentacji. Najważniejszy z nich — no-op
 * serwerowego filtra `tags` — jest pułapką, w którą łatwo wpaść i której nie
 * widać po zielonych testach, bo wpadnięcie w nią blokuje WSZYSTKIE wysyłki,
 * czyli nie produkuje ani jednego duplikatu.
 */
import { BrevoAdapter } from "../providers/brevo-adapter";
import type {
  BrevoTransactionalMessage,
  BrevoTransactionalMessageQuery,
  IBrevoClient,
} from "../providers/brevo-client";
import { buildBarrierKey } from "../gateway";
import { buildDispatchIdentityTag } from "../provider-dispatch-resolution";
import type { NotificationIntent } from "../types";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function makeIntent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: "voucher_purchase_confirmation",
    recipient: { email: "buyer@example.com", market_id: "bonbeauty" },
    variables: { voucher_code: "ABC-123" },
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-1",
    ...overrides,
  };
}

const ADAPTER_OPTIONS = {
  senders: { bonbeauty: { email: "no-reply@bonbeauty.pl", name: "BonBeauty" } },
  templates: { voucher_purchase_confirmation: 4 },
};

function makeClient(
  rows: BrevoTransactionalMessage[] | Error,
): IBrevoClient & { queries: BrevoTransactionalMessageQuery[] } {
  const queries: BrevoTransactionalMessageQuery[] = [];
  return {
    queries,
    async sendTransacEmail() {
      return { messageId: "<brevo-1@smtp-relay.mailin.fr>" };
    },
    async findTransactionalMessages(query) {
      queries.push(query);
      if (rows instanceof Error) {
        throw rows;
      }
      return rows;
    },
  };
}

describe("BrevoAdapter — nośnik tożsamości w payloadzie", () => {
  it("tożsamość jedzie w polu `tags` w BODY (jedyny zmierzony nośnik, który dojeżdża)", () => {
    const intent = makeIntent();
    const payload = new BrevoAdapter(makeClient([]), ADAPTER_OPTIONS).toBrevoPayload(
      intent,
    );

    expect(payload.tags).toEqual([
      buildDispatchIdentityTag(buildBarrierKey(intent), "buyer@example.com"),
    ]);
  });

  it("`X-Mailin-Tag` NIE jest nośnikiem tożsamości — ten sam dla każdej wysyłki szablonu", () => {
    // Zmierzone: dla wysyłek przez `templateId` ten nagłówek w ogóle nie
    // dojeżdża do dostawcy. Nawet gdyby dojeżdżał, jego wartość jest wspólna
    // dla wszystkich maili tego szablonu na tym rynku, więc do pytania
    // „czy poszedł TEN konkretny" nie nadaje się z definicji.
    const adapter = new BrevoAdapter(makeClient([]), ADAPTER_OPTIONS);
    const a = adapter.toBrevoPayload(makeIntent());
    const b = adapter.toBrevoPayload(makeIntent({ idempotency_key: "idem-2" }));

    expect(a.headers["X-Mailin-Tag"]).toBe(b.headers["X-Mailin-Tag"]);
    expect(a.tags).not.toEqual(b.tags);
  });

  it("wartość tagu nie zawiera przecinka (dostawca rozbija po nim tagi)", () => {
    const payload = new BrevoAdapter(makeClient([]), ADAPTER_OPTIONS).toBrevoPayload(
      makeIntent({ idempotency_key: "zamowienie,25" }),
    );
    expect(payload.tags?.[0]).not.toContain(",");
  });
});

describe("BrevoAdapter.resolveDispatched", () => {
  const intent = makeIntent();
  const identity = buildDispatchIdentityTag(buildBarrierKey(intent), "buyer@example.com");
  const lookup = {
    dispatch_identity: identity,
    recipient_email: "buyer@example.com",
    template_key: "voucher_purchase_confirmation",
    sent_after: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
    now: NOW,
  };

  it("POTWIERDZA, gdy w oknie jest wiersz z NASZĄ tożsamością", async () => {
    const client = makeClient([
      {
        messageId: "<202608080824.88086730917@smtp-relay.mailin.fr>",
        date: "2026-08-08T10:24:09.018+02:00",
        tags: [identity],
      },
    ]);
    const resolution = await new BrevoAdapter(client, ADAPTER_OPTIONS).resolveDispatched(
      lookup,
    );

    expect(resolution).toEqual({
      outcome: "confirmed_sent",
      provider_message_id: "<202608080824.88086730917@smtp-relay.mailin.fr>",
      sent_at: "2026-08-08T10:24:09.018+02:00",
    });
  });

  it("NIE MYLI SIĘ, gdy dostawca odda WSZYSTKIE wiersze (zmierzony no-op filtra `tags`)", async () => {
    // To jest kontrola tej konkretnej pułapki: serwer zwraca komplet, w tym
    // wiersze CUDZE i wiersz z tagiem SZABLONU. Gdyby adapter ufał serwerowemu
    // filtrowi, uznałby to za potwierdzenie i zablokował legalną wysyłkę —
    // a suita mierząca „czy powstał duplikat" świeciłaby na zielono.
    const client = makeClient([
      { messageId: "<obcy-1>", tags: ["bonbeauty,gp,v1.7.0,transactional"] },
      { messageId: "<obcy-2>", tags: [buildDispatchIdentityTag("inny|klucz|email|x", "ktos@example.com")] },
      { messageId: "<obcy-3>" },
    ]);
    const resolution = await new BrevoAdapter(client, ADAPTER_OPTIONS).resolveDispatched(
      lookup,
    );

    expect(resolution).toEqual({ outcome: "not_found" });
  });

  it("zleca serwerowi WYŁĄCZNIE predykaty zmierzone jako działające", async () => {
    const client = makeClient([]);
    await new BrevoAdapter(client, ADAPTER_OPTIONS).resolveDispatched(lookup);

    expect(client.queries).toHaveLength(1);
    // R-4.5-M3: `as Record<string, unknown>` na tym typie jest konwersją
    // NIEDOZWOLONĄ (TS2352) — przejście przez `unknown` jest jawnym
    // stwierdzeniem „patrzę na ten obiekt jak na worek pól", a nie obejściem.
    const query = client.queries[0] as unknown as Record<string, unknown>;
    expect(query.email).toBe("buyer@example.com");
    expect(query.templateId).toBe(4);
    expect(query.startDate).toEqual(lookup.sent_after);
    expect(query.endDate).toEqual(NOW);
    // Serwerowy filtr tagów jest no-opem — nie wolno go nawet wysłać, bo
    // sugerowałby czytającemu, że coś zawęża.
    expect(query.tags).toBeUndefined();
  });

  it("awaria odczytu daje `unknown`, NIGDY `not_found`", async () => {
    const client = makeClient(
      Object.assign(new Error("rate limited"), { status: 429, body: { code: "too_many_requests" } }),
    );
    const resolution = await new BrevoAdapter(client, ADAPTER_OPTIONS).resolveDispatched(
      lookup,
    );

    expect(resolution.outcome).toBe("unknown");
    expect(resolution.outcome === "unknown" && resolution.reason).toContain("429");
  });

  it("klient BEZ zdolności odczytu daje `unknown`, nie cichą zgodę", async () => {
    const blind: IBrevoClient = {
      async sendTransacEmail() {
        return {};
      },
    };
    const resolution = await new BrevoAdapter(blind, ADAPTER_OPTIONS).resolveDispatched(
      lookup,
    );
    expect(resolution.outcome).toBe("unknown");
  });

  it("R-4.5-M1: ten sam klucz bariery, INNY odbiorca ⇒ tożsamość jest INNA, więc pytamy o właściwą skrzynkę", async () => {
    // Reprodukcja finding-u: serwerowy filtr `email` jest OBOWIĄZKOWY, więc
    // zapytanie o tożsamość wyprowadzoną z samego klucza bariery szukałoby jej
    // w CUDZEJ skrzynce i wracało `not_found` — czyli zgodą na wysyłkę.
    const innyOdbiorca = makeIntent({
      recipient: { email: "inna@example.com", market_id: "bonbeauty" },
    });
    expect(buildBarrierKey(innyOdbiorca)).toBe(buildBarrierKey(intent));
    expect(
      buildDispatchIdentityTag(buildBarrierKey(innyOdbiorca), "inna@example.com"),
    ).not.toBe(identity);

    // Wysyłka i odczyt wyprowadzają TĘ SAMĄ wartość dla tego samego adresu —
    // to jest własność, na której stoi całe rozstrzyganie.
    const payload = new BrevoAdapter(makeClient([]), ADAPTER_OPTIONS).toBrevoPayload(
      innyOdbiorca,
    );
    const client = makeClient([{ messageId: "<x>", tags: payload.tags }]);
    const resolution = await new BrevoAdapter(client, ADAPTER_OPTIONS).resolveDispatched({
      ...lookup,
      recipient_email: "inna@example.com",
      dispatch_identity: buildDispatchIdentityTag(
        buildBarrierKey(innyOdbiorca),
        "inna@example.com",
      ),
    });
    expect(resolution.outcome).toBe("confirmed_sent");
  });

  it("R-4.5-M2: NIEWYCZERPANE okno odczytu daje `unknown`, nie `not_found`", async () => {
    // Klient rzuca, gdy stronicowanie nie doszło do końca okna. Adapter NIE MA
    // prawa zamienić tego w „nie ma" — odpowiedź jest niepełna, nie przecząca.
    const client = makeClient(
      Object.assign(new Error("okno nie wyczerpane"), {
        status: 200,
        body: { code: "BREVO_LOOKUP_WINDOW_TRUNCATED" },
      }),
    );
    const resolution = await new BrevoAdapter(client, ADAPTER_OPTIONS).resolveDispatched(
      lookup,
    );
    expect(resolution.outcome).toBe("unknown");
  });
});
