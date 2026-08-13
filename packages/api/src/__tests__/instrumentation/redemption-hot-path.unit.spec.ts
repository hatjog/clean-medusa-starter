/**
 * v1.15.0 Story 6.2 (AC1, AC3) — nosnik pomiaru sciezki goracej realizacji.
 *
 * Dwie rzeczy, ktore ten plik ma udowodnic wykonaniem:
 *  1. licznik prob i licznik sukcesow sa OSOBNYMI seriami (AC1),
 *  2. przy probie ponizej progu werdykt jest `not_computable`, a nie `pass`
 *     ani liczba udajaca percentyl (AC3) — z KONTROLA W OBIE STRONY.
 */
import { describe, expect, it } from "@jest/globals"

import {
  NFR11_MIN_POPULATION,
  REDEMPTION_ATTEMPT_EVENT,
  REDEMPTION_DURATION_EVENT,
  REDEMPTION_SUCCESS_EVENT,
  computeNfr11Verdict,
  createRedemptionPosthogSink,
  emitRedemptionHotPathMetrics,
  withRedemptionPiiGuard,
} from "../../lib/instrumentation/redemption-hot-path"
import type { PosthogCaptureClient } from "../../lib/instrumentation/posthog-metrics-client"

const LABELS = {
  request_id: "req_6_2",
  idempotency_key: "panel-unit-key-0001",
  market_id: "bonbeauty",
  env: "dev",
  instance_id: "gp-dev",
  actor_id: "0123456789abcdef",
}

const makeSink = () => {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = []
  return {
    events,
    capture: (event: string, properties: Record<string, unknown>) =>
      events.push({ event, properties }),
  }
}

describe("AC1 — dwa liczniki i czas jako OSOBNE serie", () => {
  it("udana realizacja emituje probe, sukces i czas", () => {
    const sink = makeSink()
    const result = emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: { duration_ms: 1234, succeeded: true, http_status: 200 },
    })

    expect(result).toBe("emitted")
    expect(sink.events.map((e) => e.event)).toEqual([
      REDEMPTION_ATTEMPT_EVENT,
      REDEMPTION_SUCCESS_EVENT,
      REDEMPTION_DURATION_EVENT,
    ])
  })

  it("odmowa emituje probe i czas, ale NIE sukces", () => {
    const sink = makeSink()
    emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: {
        duration_ms: 77,
        succeeded: false,
        http_status: 409,
        refusal_code: "already_redeemed",
      },
    })

    const names = sink.events.map((e) => e.event)
    expect(names).toContain(REDEMPTION_ATTEMPT_EVENT)
    expect(names).toContain(REDEMPTION_DURATION_EVENT)
    expect(names).not.toContain(REDEMPTION_SUCCESS_EVENT)
  })

  it("kazda seria niesie komplet etykiet AD-25", () => {
    const sink = makeSink()
    emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: { duration_ms: 10, succeeded: true, http_status: 200 },
    })

    for (const emitted of sink.events) {
      expect(emitted.properties.env).toBe("dev")
      expect(emitted.properties.instance_id).toBe("gp-dev")
      expect(emitted.properties.market_id).toBe("bonbeauty")
      expect(emitted.properties.request_id).toBe("req_6_2")
    }
  })

  it("brak nosnika jest NAZWANY, nie cichym sukcesem i nie wyjatkiem", () => {
    expect(
      emitRedemptionHotPathMetrics({
        sink: null,
        labels: LABELS,
        outcome: { duration_ms: 1, succeeded: true, http_status: 200 },
      }),
    ).toBe("carrier_unavailable")
  })

  // TA SAMA KLASA, DRUGI SLOT (`[B5-c3][correctness][LOW]`): mechanizm
  // chroniony, UZYCIE nie. Wszystkie pozostale kontrole bramki wolaja
  // `withRedemptionPiiGuard` BEZPOSREDNIO, wiec mutant zdejmujacy owiniecie
  // w `emitRedemptionHotPathMetrics` (`const guarded = args.sink ?? undefined`)
  // zostawial caly pakiet story zielony — a to jest JEDYNA droga, ktora chodzi
  // produkcja (trasa woła `emitRedemptionHotPathMetrics`, nie bramke).
  // Sterownikiem jest wiec funkcja emisji, nie bramka.
  it("emisja WOLA bramke: wartosc etykiety spoza ksztaltu nie dociera do nosnika", () => {
    const sink = makeSink()
    expect(() =>
      emitRedemptionHotPathMetrics({
        sink,
        labels: { ...LABELS, request_id: "jan.kowalski@example.com" },
        outcome: { duration_ms: 10, succeeded: true, http_status: 200 },
      }),
    ).toThrow(/request_id/)
    expect(sink.events).toHaveLength(0)
  })

  it("emisja WOLA bramke: zakazany KLUCZ nie dociera do nosnika", () => {
    const sink = makeSink()
    expect(() =>
      emitRedemptionHotPathMetrics({
        sink,
        labels: { ...LABELS, email: "a@b.c" } as never,
        outcome: { duration_ms: 10, succeeded: true, http_status: 200 },
      }),
    ).toThrow(/PII/)
    expect(sink.events).toHaveLength(0)
  })

  it("bramka PII siedzi na NOSNIKU i rzuca, nie strippuje", () => {
    const sink = makeSink()
    const guarded = withRedemptionPiiGuard(sink, "test")
    expect(() => guarded?.capture("x", { email: "a@b.c" })).toThrow(/PII/)
    expect(sink.events).toHaveLength(0)
  })

  // review cyklu 1, F-11 pkt 1: skan tylko po kluczach najwyzszego poziomu
  // przepuszczal zagniezdzone PII, choc komentarz obiecywal ochrone nosnika.
  it("bramka PII widzi klucz ZAGNIEZDZONY, nie tylko najwyzszego poziomu", () => {
    const sink = makeSink()
    const guarded = withRedemptionPiiGuard(sink, "test")
    expect(() =>
      guarded?.capture("x", { context: { customer: { email: "a@b.c" } } }),
    ).toThrow(/context\.customer\.email/)
    expect(sink.events).toHaveLength(0)
  })

  // review fali B5 `[B5][security][MEDIUM]`: `request_id` pochodzi od klienta
  // (naglowek HTTP), a bramka kluczy z definicji NIE patrzy na wartosci — wiec
  // adres e-mail w wartosci przechodzil na nosnik nietkniety.
  it("bramka odrzuca WARTOSC etykiety o zrodle klienckim spoza ksztaltu", () => {
    const sink = makeSink()
    const guarded = withRedemptionPiiGuard(sink, "test")
    expect(() =>
      guarded?.capture(REDEMPTION_ATTEMPT_EVENT, {
        ...LABELS,
        request_id: "jan.kowalski@example.com",
      }),
    ).toThrow(/request_id/)
    expect(sink.events).toHaveLength(0)
  })

  it("bramka wartosci obejmuje takze `idempotency_key`, a `null` przepuszcza", () => {
    const sink = makeSink()
    const guarded = withRedemptionPiiGuard(sink, "test")
    expect(() =>
      guarded?.capture(REDEMPTION_ATTEMPT_EVENT, {
        ...LABELS,
        idempotency_key: "+48 600 100 200",
      }),
    ).toThrow(/idempotency_key/)
    expect(() =>
      guarded?.capture(REDEMPTION_ATTEMPT_EVENT, {
        ...LABELS,
        idempotency_key: null,
      }),
    ).not.toThrow()
    expect(sink.events).toHaveLength(1)
  })

  // KONTROLA PRZECIWNA: bramka wartosci nie moze czerwienic poprawnej emisji —
  // inaczej „zawsze czerwona" jest nieodrozninalna od dzialajacej.
  it("KONTROLA: poprawne etykiety klienckie przechodza bramke wartosci", () => {
    const sink = makeSink()
    const guarded = withRedemptionPiiGuard(sink, "test")
    expect(() =>
      guarded?.capture(REDEMPTION_ATTEMPT_EVENT, { ...LABELS }),
    ).not.toThrow()
    expect(sink.events).toHaveLength(1)
  })

  // GRANICA BRAMKI, PRZYPIETA POMIAREM (review fali B5 cyklu 2, `[B5-c2][MEDIUM]`).
  //
  // Ten przypadek jest ZIELONY, kiedy dane osobowe PRZECHODZA — i to jest jego
  // cel. Bramka wartosci jest bramka ZBIORU ZNAKOW, nie bramka PII: odrzuca
  // `@`, spacje i `+`, wiec zatrzymuje e-mail zapisany kanonicznie i telefon
  // z prefiksem, ale `jan.kowalski` (imie i nazwisko) oraz `48600100200`
  // (MSISDN bez `+`) miesza sie w dozwolonym alfabecie i laduja na nosniku.
  //
  // Cykl 2 deklarowal ten finding jako domkniety, choc mechanizm jedynie zwezil
  // alfabet. Deklaracja nie moze byc szersza niz mechanizm, wiec granica jest
  // tu PRZYPIETA: kazde przyszle zwezenie bramki czerwieni ten przypadek
  // i zmusza autora do poprawienia deklaracji razem z kodem.
  //
  // Czlon rezydualny — czy wartosc korelacyjna sterowana przez wolajacego ma
  // w ogole trafiac na nosnik zewnetrzny, skoro kazde przeksztalcenie
  // odporne na PII (digest, HMAC) zrywa korelacje metryka→log wymagana przez
  // AD-25 — jest DEFEROWANY jako architektoniczny: ADR-211 / DW-15-182.
  it.each([
    ["imie i nazwisko", "jan.kowalski"],
    ["MSISDN bez prefiksu", "48600100200"],
    ["imie i nazwisko z sufiksem", "jan.kowalski_1"],
  ])(
    "GRANICA: bramka jest bramka ZBIORU ZNAKOW — %s PRZECHODZI (ADR-211/DW-15-182)",
    (_label, personalData) => {
      const sink = makeSink()
      const guarded = withRedemptionPiiGuard(sink, "test")
      expect(() =>
        guarded?.capture(REDEMPTION_ATTEMPT_EVENT, {
          ...LABELS,
          request_id: personalData,
        }),
      ).not.toThrow()
      expect(sink.events).toHaveLength(1)
      expect(sink.events[0]?.properties?.request_id).toBe(personalData)
    },
  )
})

describe("F-1 — adapter na ksztalt klienta z kontenera", () => {
  /** Atrapa o ksztalcie `PosthogCaptureClient` — TYM, ktory jest w kontenerze. */
  const makePosthogClient = () => {
    const calls: Array<{
      distinctId: string
      event: string
      properties?: Record<string, unknown>
    }> = []
    const client: PosthogCaptureClient = {
      capture: (args) => calls.push(args),
    }
    return { client, calls }
  }

  it("tlumaczy dwa argumenty portu na JEDEN obiekt z distinctId", () => {
    const { client, calls } = makePosthogClient()
    const sink = createRedemptionPosthogSink(client, "0123456789abcdef")

    emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: { duration_ms: 12, succeeded: true, http_status: 200 },
    })

    expect(calls.map((c) => c.event)).toEqual([
      REDEMPTION_ATTEMPT_EVENT,
      REDEMPTION_SUCCESS_EVENT,
      REDEMPTION_DURATION_EVENT,
    ])
    for (const call of calls) {
      expect(call.distinctId).toBe("0123456789abcdef")
      expect(call.properties?.env).toBe("dev")
      expect(call.properties?.instance_id).toBe("gp-dev")
    }
  })

  it("brak klienta w kontenerze daje null, nie atrape udajaca nosnik", () => {
    expect(createRedemptionPosthogSink(null, "x")).toBeNull()
    expect(createRedemptionPosthogSink(undefined, "x")).toBeNull()
  })

  // KONTROLA MUTANTA F-1: bez adaptera trasa wolalaby `client.capture(event,
  // properties)`, czyli string w miejsce obiektu komunikatu. Ten przypadek
  // pokazuje, ze taki mutant produkuje `event: undefined`, a nie serie.
  it("wywolanie klienta kontraktem PORTU produkuje event: undefined", () => {
    const { client, calls } = makePosthogClient()
    ;(client.capture as unknown as (e: string, p: Record<string, unknown>) => void)(
      REDEMPTION_ATTEMPT_EVENT,
      { env: "dev" },
    )
    expect(calls[0]?.event).toBeUndefined()
  })
})

describe("AC3 — prog bez populacji jest NIEMIERZALNY", () => {
  it("KONTROLA: N = 1 daje not_computable, nie pass i nie liczbe", () => {
    const v = computeNfr11Verdict([{ duration_ms: 1000, succeeded: true }])

    expect(v.window_status).toBe("open")
    expect(v.success_rate_verdict).toBe("not_computable")
    expect(v.duration_p95_verdict).toBe("not_computable")
    expect(v.success_rate).toBeNull()
    expect(v.duration_p95_ms).toBeNull()
    expect(v.missing_to_threshold).toBe(NFR11_MIN_POPULATION - 1)
  })

  it("KONTROLA PRZECIWNA: populacja progowa daje liczbe i werdykt", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, () => ({
      duration_ms: 1000,
      succeeded: true,
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.window_status).toBe("closed")
    expect(v.success_rate).toBe(1)
    expect(v.success_rate_verdict).toBe("pass")
    expect(v.duration_p95_ms).toBe(1000)
    expect(v.duration_p95_verdict).toBe("pass")
  })

  it("domknieta proba PONIZEJ progu skutecznosci daje fail, nie not_computable", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, (_, i) => ({
      duration_ms: 500,
      succeeded: i > 1, // 2/30 nieudane => 93,3% < 98%
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.window_status).toBe("closed")
    expect(v.success_rate_verdict).toBe("fail")
  })

  it("percentyl przekraczajacy prog czasu daje fail", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, (_, i) => ({
      duration_ms: i >= NFR11_MIN_POPULATION - 2 ? 30_000 : 100,
      succeeded: true,
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.duration_p95_ms).toBe(30_000)
    expect(v.duration_p95_verdict).toBe("fail")
  })
})

// review cyklu 1, F-6: czas i skutecznosc licza sie na ROZNYCH populacjach.
// Poprzednia wersja liczyla oba czlony z tej samej tablicy, wiec szybkie odmowy
// rozcienczaly percentyl realizacji.
describe("F-6 — dwie populacje, dwa okna", () => {
  it("szybkie odmowy NIE rozcienczaja p95 realizacji", () => {
    const succeededSamples = Array.from({ length: NFR11_MIN_POPULATION }, () => ({
      duration_ms: 25_000,
      succeeded: true,
    }))
    const refusals = Array.from({ length: 200 }, () => ({
      duration_ms: 3,
      succeeded: false,
    }))
    const v = computeNfr11Verdict([...succeededSamples, ...refusals])

    expect(v.duration_n).toBe(NFR11_MIN_POPULATION)
    expect(v.duration_p95_ms).toBe(25_000)
    // KONTROLA: na jednej populacji (230 probek, 200 po 3 ms) p95 wynioslby
    // 25 000 tylko przy 5% ogona — tu p95 calosci to 25 000 dopiero dlatego,
    // ze populacja jest wezsza. Werdykt widzi awarie zamiast ja rozcienczyc.
    expect(v.duration_p95_verdict).toBe("fail")
  })

  it("okno czasu domyka sie POZNIEJ niz okno skutecznosci", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, (_, i) => ({
      duration_ms: 100,
      succeeded: i < 10,
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.window_status).toBe("closed")
    expect(v.success_rate_verdict).toBe("fail")
    expect(v.duration_window_status).toBe("open")
    expect(v.duration_n).toBe(10)
    expect(v.duration_missing_to_threshold).toBe(NFR11_MIN_POPULATION - 10)
    expect(v.duration_p95_verdict).toBe("not_computable")
    expect(v.duration_p95_ms).toBeNull()
  })
})
