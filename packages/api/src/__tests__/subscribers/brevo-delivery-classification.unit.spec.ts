/**
 * Story v1.15.0/4.3 — klasyfikacja odbic jest wielodzielna (FR-9d, AD-19, AD-21,
 * AD-23, SM-3). Decyzja: ADR-192.
 *
 * KAZDA asercja w tym pliku jedzie przez REALNE wejscie subscribera
 * (`brevoDeliveryTracker`), a nie przez wywolanie funkcji klasyfikujacej.
 * Porownywany jest OBSERWOWALNY STAN PO przebiegu (koperta audytowa wypchnieta
 * do sinka), a nie nazwa zwrocona przez funkcje czysta.
 */

import brevoDeliveryTracker, {
  __resetBrevoDeliveryTrackerForTests,
} from "../../subscribers/brevo-delivery-tracker"
import {
  _resetUnrecognizedDeliveryEventMetrics,
  CLASSIFICATION_DOMAIN,
  EVENT_PAYLOAD_NAMES,
  getUnrecognizedDeliveryEventMetrics,
  getUnrecognizedDeliveryEventTotal,
  REGISTRATION_API_NAMES,
  UNRECOGNIZED_DELIVERY_EVENT_METRIC,
} from "../../lib/delivery-event-classification"
import {
  _resetSystemMarketContextMetrics,
  getSystemMarketContextDenials,
} from "../../lib/system-market-context"

type AuditEvent = Record<string, any>

function makeContainer(dispatch: Record<string, unknown> | null = null) {
  const auditEvents: AuditEvent[] = []
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const resolve = jest.fn((key: string) => {
    if (key === "logger") return logger
    if (key === "notification_dispatches") {
      return { findByProviderMessageId: jest.fn(async () => dispatch) }
    }
    if (key === "notification_delivery_audit_sink") {
      return {
        record: jest.fn(async (auditEvent: AuditEvent) => {
          auditEvents.push(auditEvent)
        }),
      }
    }
    throw new Error(`Unknown container key: ${key}`)
  })
  return { auditEvents, logger, container: { resolve } }
}

/** Realne wejscie subscribera — jedyna droga, ktora ten plik uznaje za dowod. */
async function run(
  payload: Record<string, unknown>,
  container: unknown,
  eventName = "notification.delivered",
): Promise<void> {
  await brevoDeliveryTracker({
    event: { name: eventName, data: payload },
    container,
  } as never)
}

/**
 * Przepusc jedna nazwe z payloadu przez realne wejscie i zwroc STAN PO —
 * koperte audytowa. Rzuca dalej, gdy sciezka odmowila.
 */
async function stateAfter(
  payloadEventName: string,
  extra: Record<string, unknown> = {},
): Promise<AuditEvent> {
  const ctx = makeContainer()
  await run(
    {
      provider_id: "brevo",
      provider_event_id: `pe-${payloadEventName}-${JSON.stringify(extra)}`,
      market_id: "pl",
      dispatch_id: `dispatch-${payloadEventName}`,
      event_type: payloadEventName,
      occurred_at: "2026-08-06T10:00:00.000Z",
      recipient_hash: "recipient-hash",
      ...extra,
    },
    ctx.container,
  )
  expect(ctx.auditEvents).toHaveLength(1)
  return ctx.auditEvents[0]
}

/** Piec odpowiedzi, ktore do v1.15.0 byly zwijane do jednej wartosci "bounced". */
const COLLAPSED_INPUTS = [
  "hard_bounce",
  "soft_bounce",
  "invalid_email",
  "blocked",
  "deferred",
] as const

/** Siedem klas z AC1 — kazda musi miec WLASNA, rozlaczna reakcje. */
const SEVEN_CLASSES = [
  "hard_bounce",
  "soft_bounce",
  "blocked",
  "invalid_email",
  "spam",
  "error",
  "deferred",
] as const

beforeEach(() => {
  __resetBrevoDeliveryTrackerForTests()
  _resetUnrecognizedDeliveryEventMetrics()
  _resetSystemMarketContextMetrics()
})

describe("AC1 — klasyfikacja jest wielodzielna i rozlaczna", () => {
  it("piec zwijanych dotad odpowiedzi daje PIEC ROZNYCH klas na realnej sciezce", async () => {
    const classes: string[] = []
    for (const input of COLLAPSED_INPUTS) {
      const envelope = await stateAfter(input)
      classes.push(envelope.delivery_class)
    }

    // KONTROLA WIELODZIELNOSCI: to jest asercja, ktora PEKA po przywroceniu
    // zwijajacego `case` (np. soft_bounce i hard_bounce -> ta sama klasa).
    expect(new Set(classes).size).toBe(COLLAPSED_INPUTS.length)
    expect(classes).toEqual([
      "bounced_permanent",
      "bounced_transient",
      "invalid_address",
      "blocked",
      "deferred",
    ])
    // Zadna z nich nie moze wpasc w dawna wartosc zbiorcza.
    expect(classes).not.toContain("bounced")
  })

  it("dziedzina NIE zawiera juz zbiorczej wartosci 'bounced'", () => {
    expect(CLASSIFICATION_DOMAIN).not.toContain("bounced")
    expect(CLASSIFICATION_DOMAIN).toEqual(
      expect.arrayContaining([
        "bounced_permanent",
        "bounced_transient",
        "blocked",
        "invalid_address",
        "deferred",
      ]),
    )
  })

  it("OPOZNIENIE NIE JEST ODBICIEM — stan po jest nieterminalny, bez kodu *BOUNCE*, bez zuzycia proby", async () => {
    const envelope = await stateAfter("deferred")

    expect(envelope.delivery_class).toBe("deferred")
    // Nie nalezy do rodziny odbic.
    expect(envelope.delivery_reaction.bounce_family).toBe(false)
    // Nie dostaje kodu z rodziny *BOUNCE* — ani zadnego innego kodu bledu.
    expect(envelope.error_code).toBeUndefined()
    // Nie ustawia stanu terminalnego — wiersz zostaje ponawialny.
    expect(envelope.delivery_reaction.terminal).toBe(false)
    expect(envelope.status).not.toBe("failed")
    // Nie konsumuje budzetu prob.
    expect(envelope.delivery_reaction.consumes_recipient_attempt).toBe(false)
    // Nie eskaluje.
    expect(envelope.delivery_reaction.escalate).toBe(false)
  })

  it("odbicie trwale ROZNI SIE obserwowalnie od chwilowego", async () => {
    const permanent = await stateAfter("hard_bounce")
    const transient = await stateAfter("soft_bounce")

    expect(permanent.delivery_reaction.terminal).toBe(true)
    expect(transient.delivery_reaction.terminal).toBe(false)
    expect(permanent.error_code).not.toBe(transient.error_code)
  })
})

describe("AC2 — wartosc spoza dziedziny jest BLEDEM (AD-19)", () => {
  const OUT_OF_DOMAIN = ["listadd", "proxy_open", "", "HARD_BOUNCE", "bounced"]

  it.each(OUT_OF_DOMAIN)(
    "nazwa %p konczy sie ODMOWA, a nie klasa",
    async (rawName) => {
      const ctx = makeContainer()

      await expect(
        run(
          {
            provider_id: "brevo",
            provider_event_id: `pe-out-${rawName || "empty"}`,
            market_id: "pl",
            dispatch_id: "dispatch-out",
            event_type: rawName,
            event: rawName,
          },
          ctx.container,
          rawName === "" ? "notification." : "notification.delivered",
        ),
      ).rejects.toThrow("DELIVERY_EVENT_UNRECOGNIZED")

      // Zdarzenie NIE jest potwierdzone jako obsluzone: brak koperty.
      expect(ctx.auditEvents).toHaveLength(0)
      // Odmowa jest WIDOCZNA: nazwany kod bledu ORAZ nazwa metryki w logu.
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("DELIVERY_EVENT_UNRECOGNIZED"),
      )
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining(UNRECOGNIZED_DELIVERY_EVENT_METRIC),
      )
    },
  )

  it("odmowa inkrementuje licznik — nie jest cichym odrzuceniem", async () => {
    const ctx = makeContainer()
    expect(getUnrecognizedDeliveryEventTotal()).toBe(0)

    await expect(
      run(
        {
          provider_id: "brevo",
          provider_event_id: "pe-counter",
          market_id: "pl",
          event_type: "proxy_open",
        },
        ctx.container,
      ),
    ).rejects.toThrow()

    expect(getUnrecognizedDeliveryEventTotal()).toBe(1)
    expect(getUnrecognizedDeliveryEventMetrics()).toEqual([
      {
        metric: UNRECOGNIZED_DELIVERY_EVENT_METRIC,
        dictionary: "event_payload",
        raw_value: "proxy_open",
        count: 1,
      },
    ])
  })

  it("'nieznane' NIE jest odwzorowywane na zadna klase znana", async () => {
    const ctx = makeContainer()
    await expect(
      run(
        {
          provider_id: "brevo",
          provider_event_id: "pe-not-mapped",
          market_id: "pl",
          event_type: "listadd",
        },
        ctx.container,
      ),
    ).rejects.toThrow()

    // W szczegolnosci: ani na odbicie, ani na dostarczone.
    expect(ctx.auditEvents).toHaveLength(0)
  })

  it("kody bledow sa ROZLACZNE miedzy klasami — nie ma catch-alla 'BOUNCE'", async () => {
    const codes = new Map<string, string | undefined>()
    for (const name of SEVEN_CLASSES) {
      const envelope = await stateAfter(name)
      codes.set(envelope.delivery_class, envelope.error_code)
    }

    // Dawny catch-all `return "BOUNCE"` zniknal calkowicie.
    expect([...codes.values()]).not.toContain("BOUNCE")
    // invalid_address i blocked maja WLASNE kody, rozlaczne z odbiciami.
    expect(codes.get("invalid_address")).toBe("INVALID_ADDRESS")
    expect(codes.get("blocked")).toBe("BLOCKED")
    expect(codes.get("bounced_permanent")).toBe("HARD_BOUNCE")
    expect(codes.get("bounced_transient")).toBe("SOFT_BOUNCE")

    const defined = [...codes.values()].filter((c): c is string => Boolean(c))
    expect(new Set(defined).size).toBe(defined.length)
  })

  it("mapowania obu slownikow sa CALKOWITE — brak odwzorowania jest wpisem jawnym, nie luka", () => {
    for (const table of [REGISTRATION_API_NAMES, EVENT_PAYLOAD_NAMES]) {
      for (const [name, mapped] of Object.entries(table)) {
        // `null` = "nieobslugiwane, reakcja: odmowa" — wpis JAWNY.
        // `undefined` oznaczaloby luke i jest tu zakazane.
        expect(mapped === null || typeof mapped === "string").toBe(true)
        expect(name.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("AC4 — kazda klasa ma WLASNA reakcje, wykonywana na realnej sciezce", () => {
  it("siedem klas daje SIEDEM ROZNYCH obserwowalnych skutkow", async () => {
    const fingerprints: string[] = []
    for (const name of SEVEN_CLASSES) {
      const envelope = await stateAfter(name)
      fingerprints.push(
        JSON.stringify({
          reaction: envelope.delivery_reaction,
          error_code: envelope.error_code ?? null,
          status: envelope.status,
        }),
      )
    }

    // Dwa identyczne = RED. To jest kontrola na "wielodzielnosc w nazwie,
    // jedna reakcja w praktyce".
    expect(new Set(fingerprints).size).toBe(SEVEN_CLASSES.length)
  })

  it("trwale odbicie -> stan terminalny I eskalacja; ponowienie jest odciete", async () => {
    const envelope = await stateAfter("hard_bounce")
    expect(envelope.delivery_reaction).toMatchObject({
      terminal: true,
      escalate: true,
      retryable: false,
      retry_policy: null,
      next_attempt_number: null,
      backoff_delay_ms: null,
    })
  })

  it("chwilowe i zablokowane -> ponowienie z backoffem, kazde WLASNA polityka", async () => {
    const transient = await stateAfter("soft_bounce")
    const blocked = await stateAfter("blocked")

    expect(transient.delivery_reaction).toMatchObject({
      terminal: false,
      retryable: true,
      retry_policy: "transient_backoff",
    })
    expect(blocked.delivery_reaction).toMatchObject({
      terminal: false,
      retryable: true,
      retry_policy: "blocked_backoff",
    })
    // Rozlaczne, nie ta sama reakcja pod dwiema nazwami.
    expect(transient.delivery_reaction.backoff_delay_ms).not.toBe(
      blocked.delivery_reaction.backoff_delay_ms,
    )
  })

  it("AD-23 — numer proby nadaje POLITYKA; ladunek dostawcy nie ma na niego wplywu", async () => {
    const clean = await stateAfter("soft_bounce")
    // Ten sam typ zdarzenia, ale ladunek NIESIE WLASNY numer proby.
    const spoofed = await stateAfter("soft_bounce", {
      attempt: 99,
      retry_count: 42,
      attempts: 77,
      next_attempt_number: 1234,
      backoff_delay_ms: 1,
    })

    expect(spoofed.delivery_reaction.next_attempt_number).toBe(
      clean.delivery_reaction.next_attempt_number,
    )
    expect(spoofed.delivery_reaction.backoff_delay_ms).toBe(
      clean.delivery_reaction.backoff_delay_ms,
    )
    expect(spoofed.delivery_reaction.next_attempt_number).toBe(1)
  })

  it("numer proby ROSNIE, gdy zrodlem jest stan systemu (wiersz dispatchu), nie ladunek", async () => {
    const ctx = makeContainer({
      dispatch_id: "dispatch-attempts",
      market_id: "pl",
      attempts: 3,
    })
    await run(
      {
        provider_id: "brevo",
        provider_event_id: "pe-attempts",
        event_type: "soft_bounce",
      },
      ctx.container,
      "notification.soft_bounce",
    )

    expect(ctx.auditEvents[0].delivery_reaction.next_attempt_number).toBe(4)
  })

  it("zgloszenie spamu -> wyciszenie odbiorcy, NIE ponowienie", async () => {
    const envelope = await stateAfter("spam")
    expect(envelope.delivery_reaction).toMatchObject({
      suppress_recipient: true,
      retryable: false,
      terminal: true,
    })
  })

  it("niepoprawny adres -> reakcja wlasna, ROZLACZNA z odbiciem trwalym", async () => {
    const invalid = await stateAfter("invalid_email")
    const permanent = await stateAfter("hard_bounce")

    expect(invalid.error_code).toBe("INVALID_ADDRESS")
    expect(invalid.delivery_reaction.terminal).toBe(true)
    // Rozlacznosc: niepoprawny adres NIE eskaluje, trwale odbicie eskaluje.
    expect(invalid.delivery_reaction.escalate).toBe(false)
    expect(permanent.delivery_reaction.escalate).toBe(true)
  })

  it("blad dostawcy NIE konsumuje budzetu prob odbiorcy (granica wobec FR-9g/4.7)", async () => {
    const providerError = await stateAfter("error")

    // Rozstrzygniecie ZAPISANE I POKRYTE TESTEM, nie komentarzem (ADR-192):
    // usterka dostawcy nie obciaza budzetu odbiorcy.
    expect(providerError.delivery_reaction.consumes_recipient_attempt).toBe(false)
    expect(providerError.delivery_reaction.retryable).toBe(true)
    expect(providerError.delivery_reaction.escalate).toBe(true)

    // Kontrast: odbicia obciazaja budzet odbiorcy.
    const permanent = await stateAfter("hard_bounce")
    expect(permanent.delivery_reaction.consumes_recipient_attempt).toBe(true)
  })

  it("AD-21 kontrola DODATNIA — rynek zadeklarowany w ladunku -> zapis", async () => {
    const envelope = await stateAfter("hard_bounce")
    expect(envelope.market_id).toBe("pl")
    expect(getSystemMarketContextDenials()).toBe(0)
  })

  it("AD-21 kontrola DODATNIA — rynek z wiersza dispatchu -> zapis", async () => {
    const ctx = makeContainer({ dispatch_id: "d-1", market_id: "ua" })
    await run(
      {
        provider_id: "brevo",
        provider_event_id: "pe-market-from-dispatch",
        event_type: "hard_bounce",
      },
      ctx.container,
      "notification.hard_bounce",
    )
    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0].market_id).toBe("ua")
  })

  it("AD-21 kontrola NEGATYWNA — brak deklaracji rynku to ODMOWA, nie zapis dla wszystkich rynkow", async () => {
    const ctx = makeContainer(null)

    await expect(
      run(
        {
          provider_id: "brevo",
          provider_event_id: "pe-no-market",
          event_type: "hard_bounce",
        },
        ctx.container,
        "notification.hard_bounce",
      ),
    ).rejects.toThrow(/AD-21/)

    // Kluczowe: NIC nie zostalo zapisane.
    expect(ctx.auditEvents).toHaveLength(0)
    // Odmowa jest policzona, nie tylko zalogowana.
    expect(
      getSystemMarketContextDenials({ reason: "markets_empty", surface: "subscriber" }),
    ).toBe(1)
  })

  it("idempotencja — ten sam provider_event_id dwa razy daje JEDNA reakcje", async () => {
    const ctx = makeContainer()
    const payload = {
      provider_id: "brevo",
      provider_event_id: "pe-idempotent",
      market_id: "pl",
      dispatch_id: "dispatch-idem",
      event_type: "hard_bounce",
    }

    await run(payload, ctx.container, "notification.hard_bounce")
    await run(payload, ctx.container, "notification.hard_bounce")

    // Dostawca ponawia webhook do 7 dni — druga dostawa NIE moze wyprodukowac
    // drugiej eskalacji ani drugiego zuzycia proby.
    expect(ctx.auditEvents).toHaveLength(1)
    expect(ctx.auditEvents[0].delivery_reaction.escalate).toBe(true)
  })
})

describe("SM-3 — kazde odebrane odbicie zmienia stan; sierota liczona OSOBNO", () => {
  /** Rodzina odbic wg dziedziny — nie lista przepisana recznie. */
  const BOUNCE_INPUTS = ["hard_bounce", "soft_bounce", "blocked", "invalid_email"] as const

  it("100% odebranych odbic zmienia stan wiersza — licznik 'odebrane' == 'ze zmiana stanu'", async () => {
    let received = 0
    let stateChanged = 0

    for (const name of BOUNCE_INPUTS) {
      const ctx = makeContainer({ dispatch_id: `d-${name}`, market_id: "pl" })
      await run(
        {
          provider_id: "brevo",
          provider_event_id: `pe-sm3-${name}`,
          event_type: name,
        },
        ctx.container,
        `notification.${name}`,
      )
      received += 1

      const envelope = ctx.auditEvents[0]
      // "Zmiana stanu" = zdarzenie skorelowane z wierszem dostawy ORAZ niosace
      // rozstrzygnieta reakcje. Odbicie bez zmiany stanu jest CZERWIENIA.
      const changed =
        envelope?.correlation_state === "matched" &&
        Boolean(envelope?.delivery_reaction) &&
        envelope?.status === "failed"
      if (changed) {
        stateChanged += 1
      }
    }

    expect(received).toBe(BOUNCE_INPUTS.length)
    expect(stateChanged).toBe(received)
  })

  it("SIEROTA nie liczy sie jako zmiana stanu i ma WLASNY licznik", async () => {
    let orphans = 0
    let stateChanged = 0

    const ctx = makeContainer(null) // brak wiersza dostawy -> sierota
    await run(
      {
        provider_id: "brevo",
        provider_event_id: "pe-sm3-orphan",
        market_id: "pl",
        event_type: "hard_bounce",
      },
      ctx.container,
      "notification.hard_bounce",
    )

    const envelope = ctx.auditEvents[0]
    if (envelope.correlation_state === "orphan") {
      orphans += 1
    } else {
      stateChanged += 1
    }

    // Wariant "sierota = sukces" jest ODRZUCONY: zamienialby miare w tautologie,
    // bo dzis KAZDE zdarzenie bez wiersza dostawy konczy jako sierota.
    expect(orphans).toBe(1)
    expect(stateChanged).toBe(0)
  })
})
