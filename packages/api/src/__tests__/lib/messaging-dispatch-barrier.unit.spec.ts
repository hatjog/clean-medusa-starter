/**
 * v1.15.0 Story 4.1 — TRWAŁA bariera idempotencji wysyłki: kontrole, które
 * PĘKAJĄ po zepsuciu mechanizmu (AC1, AC2, AC3, AC4).
 *
 * Ta suita mierzy trzy rzeczy, których atrapa bariery zmierzyć nie może:
 *  1. KSZTAŁT stwierdzenia wysyłanego do bazy (jedno, bez poprzedzającego
 *     `SELECT`, z oknem w predykacie) — na atrapie sterownika, która zapisuje
 *     SQL zamiast go wykonywać;
 *  2. PARITY okien z horyzontem ponowień sweepa — pęka, gdy którakolwiek
 *     stała zmieni się osobno;
 *  3. BRAK drugiej listy kodów błędów w warstwie trwałej (AC3) — pęka, gdy
 *     ktoś ją tam dopisze.
 *
 * Sam SQL jest dowiedziony PRZEBIEGIEM na realnym Postgresie:
 * `src/__tests__/integration/messaging-dispatch-barrier-pg.integration.test.ts`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  isGlobalFailureErrorCode,
  SWEEP_ENTITLEMENT_GRACE_MS,
  SWEEP_GAP_LOOKBACK_MS,
  SWEEP_MAX_ATTEMPT_COUNT,
} from "../../jobs/voucher-delivery-reconciliation-sweep"
import {
  MESSAGING_BARRIER_TRANSIENT_ERROR_CODES,
  MESSAGING_BARRIER_UNAVAILABLE,
  MessagingProviderError,
} from "@gp/messaging"

import {
  BARRIER_AMBIGUOUS_WINDOW_MS,
  BARRIER_IN_FLIGHT_WINDOW_MS,
  BarrierUnavailableError,
  MESSAGING_DISPATCH_BARRIER_TABLE,
  PgDispatchIdempotencyBarrier,
  purgeExpiredDispatchBarrierRows,
  unavailableDispatchBarrier,
} from "../../lib/messaging-dispatch-barrier"
import { STALE_QUEUED_THRESHOLD_MS } from "../../subscribers/voucher-purchase-delivery"
import {
  runInSystemMarketContext,
  SystemMarketContextError,
} from "../../lib/system-market-context"

const T0 = new Date("2026-08-06T09:00:00.000Z")

/** Sterownik-atrapa: ZAPISUJE stwierdzenia zamiast je wykonywać. */
class RecordingDb {
  readonly statements: Array<{ sql: string; bindings: readonly unknown[] }> = []
  private nextResult: unknown = { rows: [] }

  willReturn(result: unknown): void {
    this.nextResult = result
  }

  raw = async (sql: string, bindings: readonly unknown[] = []): Promise<unknown> => {
    this.statements.push({ sql, bindings })
    return this.nextResult
  }
}

const dispatchFixture = {
  dispatch_id: "d-1",
  provider: "brevo" as const,
  status: "sent" as const,
  audit_event: { dispatch_id: "d-1" },
}

describe("AC1 — bariera jest JEDNYM stwierdzeniem, bez poprzedzającego SELECT-a", () => {
  it("zajęcie wolnego klucza wysyła DOKŁADNIE JEDNO stwierdzenie", async () => {
    const db = new RecordingDb()
    db.willReturn({ rows: [{ barrier_key: "k" }] })

    const result = await new PgDispatchIdempotencyBarrier(db).claim({
      barrier_key: "pl|flow|email|idem-1",
      now: T0,
      in_flight_window_ms: BARRIER_IN_FLIGHT_WINDOW_MS,
      claim_token: "tok-1",
    })

    expect(result.outcome).toBe("claimed")
    expect(db.statements).toHaveLength(1)
    const [{ sql }] = db.statements
    expect(sql).toMatch(/INSERT INTO messaging_dispatch_barrier/)
    expect(sql).toMatch(/ON CONFLICT \(barrier_key\) DO UPDATE/)
    expect(sql).toMatch(/RETURNING barrier_key/)
    // Zero odczytu PRZED werdyktem — to jest cała różnica między barierą
    // a sekwencją „odczyt → operacja → zapis" (AD-23).
    expect(sql).not.toMatch(/\bSELECT\b/i)
  })

  it("werdykt pochodzi z LICZBY WIERSZY, nie z porównania w kodzie", async () => {
    const db = new RecordingDb()
    db.willReturn({ rows: [] })

    const result = await new PgDispatchIdempotencyBarrier(db).claim({
      barrier_key: "pl|flow|email|idem-1",
      now: T0,
      in_flight_window_ms: BARRIER_IN_FLIGHT_WINDOW_MS,
      claim_token: "tok-1",
    })

    expect(result.outcome).toBe("blocked")
    // Odczyt wyniku poprzedniego przebiegu następuje DOPIERO PO werdykcie.
    expect(db.statements).toHaveLength(2)
    expect(db.statements[1].sql).toMatch(/SELECT dispatch FROM/)
  })
})

describe("AC4 — okno jest w PREDYKACIE operacji, a bezterminowość we WŁASNOŚCI DANYCH", () => {
  it("predykat `DO UPDATE` niesie oba warunki okna", async () => {
    const db = new RecordingDb()
    db.willReturn({ rows: [{ barrier_key: "k" }] })

    await new PgDispatchIdempotencyBarrier(db).claim({
      barrier_key: "pl|flow|email|idem-1",
      now: T0,
      in_flight_window_ms: 60_000,
      claim_token: "tok-1",
    })

    const { sql, bindings } = db.statements[0]
    // Wygasanie realizuje WHERE na DO UPDATE — nie cron, nie filtr w kodzie.
    expect(sql).toMatch(
      /WHERE messaging_dispatch_barrier\.expires_at IS NOT NULL\s+AND messaging_dispatch_barrier\.expires_at <= /,
    )
    // `expires_at` zajęcia = now + okno in-flight, liczone zegarem WOŁAJĄCEGO.
    expect(bindings).toContain(new Date(T0.getTime() + 60_000).toISOString())
    expect(bindings).toContain(T0.toISOString())
  })

  it("sukces zapisuje `expires_at = NULL` (BEZTERMINOWO), porażka — datę", async () => {
    const db = new RecordingDb()
    const barrier = new PgDispatchIdempotencyBarrier(db)

    await barrier.settle({
      barrier_key: "k",
      claim_token: "tok-1",
      dispatch: dispatchFixture as never,
      expires_at: null,
    })
    expect(db.statements[0].bindings[1]).toBeNull()

    const expiresAt = new Date(T0.getTime() + BARRIER_AMBIGUOUS_WINDOW_MS)
    await barrier.settle({
      barrier_key: "k",
      claim_token: "tok-1",
      dispatch: dispatchFixture as never,
      expires_at: expiresAt,
    })
    expect(db.statements[1].bindings[1]).toBe(expiresAt.toISOString())
  })

  it("zwolnienie kasuje WYŁĄCZNIE własne, niedomknięte zajęcie", async () => {
    // Bez guardu `state = 'in_flight'` opóźniona porażka pre-flight z jednego
    // przebiegu skasowałaby ROZSTRZYGNIĘTĄ barierę innego — czyli otworzyła
    // drogę drugiemu mailowi.
    const db = new RecordingDb()
    await new PgDispatchIdempotencyBarrier(db).release({ barrier_key: "k", claim_token: "tok-1" })

    expect(db.statements[0].sql).toMatch(/DELETE FROM messaging_dispatch_barrier/)
    expect(db.statements[0].sql).toMatch(/AND state = 'in_flight'/)
  })
})

describe("AC4 — okna są WYPROWADZONE z horyzontu ponowień, nie przepisane", () => {
  it("okno in-flight == próg porzuconej rezerwacji ledgera (jedna definicja)", () => {
    // Ta kontrola PĘKA, gdy którakolwiek ze stałych zmieni się osobno —
    // czyli dokładnie wtedy, gdy powstałaby druga, rozjeżdżalna definicja
    // „od kiedy uznajemy, że proces już nie wróci".
    expect(BARRIER_IN_FLIGHT_WINDOW_MS).toBe(STALE_QUEUED_THRESHOLD_MS)
  })

  it("okno niejednoznaczności POKRYWA cały horyzont ponowień sweepa", () => {
    const sweepCadenceMs = 15 * 60 * 1000
    const retryHorizonMs =
      SWEEP_GAP_LOOKBACK_MS +
      SWEEP_ENTITLEMENT_GRACE_MS +
      SWEEP_MAX_ATTEMPT_COUNT * sweepCadenceMs

    // Okno KRÓTSZE od horyzontu = sweep wraca po dostawie, której nie umiemy
    // rozstrzygnąć, a bariera już nie blokuje → DRUGI MAIL.
    expect(BARRIER_AMBIGUOUS_WINDOW_MS).toBeGreaterThanOrEqual(retryHorizonMs)

    // I jawnie: 24 h ze starej mapy tego horyzontu NIE pokrywa. Ta linia jest
    // powodem, dla którego wartość nie została przepisana (AC4).
    expect(24 * 60 * 60 * 1000).toBeLessThan(retryHorizonMs)
  })
})

describe("AC3 — klasyfikacja porażek ma JEDNO źródło prawdy", () => {
  it("warstwa trwała NIE zna żadnej listy kodów błędów providera", () => {
    // Kontrola strukturalna, która PĘKA po dopisaniu drugiej listy: klasyfikacja
    // „rozstrzygnięta przed wysyłką vs niejednoznaczna" żyje WYŁĄCZNIE na fladze
    // `MessagingProviderError.preflight`. Druga lista rozjechałaby się przy
    // pierwszym nowym kodzie — to jest klasa defektu, którą ta story zamyka.
    const source = readFileSync(
      path.join(__dirname, "../../lib/messaging-dispatch-barrier/index.ts"),
      "utf8",
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

    for (const forbidden of [
      "BREVO_TEMPLATE_NOT_CONFIGURED",
      "BREVO_SENDER_NOT_CONFIGURED",
      "BREVO_API_KEY_NOT_CONFIGURED",
      "BREVO_TIMEOUT",
    ]) {
      expect(code).not.toContain(forbidden)
    }
  })
})

describe("AC1 — brak nośnika bariery jest ODMOWĄ, nie cichą wysyłką", () => {
  it("bariera odmawiająca rzuca i raportuje klucz, zamiast przepuścić", async () => {
    const denied: string[] = []
    const barrier = unavailableDispatchBarrier((key) => denied.push(key))

    await expect(
      barrier.claim({ barrier_key: "pl|flow|email|k", now: T0, in_flight_window_ms: 1, claim_token: "tok-1" }),
    ).rejects.toBeInstanceOf(BarrierUnavailableError)
    expect(denied).toEqual(["pl|flow|email|k"])
  })

  it("odmowa jest klasyfikowana jako PRE-FLIGHT (ponowienie jest legalne)", async () => {
    let error: BarrierUnavailableError | null = null
    try {
      await unavailableDispatchBarrier().claim({
        barrier_key: "k",
        now: T0,
        in_flight_window_ms: 1,
        claim_token: "tok-1",
      })
    } catch (err) {
      error = err as BarrierUnavailableError
    }

    expect(error).toBeInstanceOf(BarrierUnavailableError)
    expect(error?.preflight).toBe(true)
    expect(error?.error_code).toBe("MESSAGING_BARRIER_UNAVAILABLE")
  })
})

describe("AD-21 — sprzątanie jest HIGIENĄ i konsumuje nośnik kontekstu rynku", () => {
  it("poza kontekstem rynku ODMAWIA przed jakąkolwiek wysyłką do bazy", async () => {
    const db = new RecordingDb()

    await expect(purgeExpiredDispatchBarrierRows(db, T0)).rejects.toBeInstanceOf(
      SystemMarketContextError,
    )
    // Zero wysyłek jest MIERZALNE — odmowa następuje przed dotknięciem bazy.
    expect(db.statements).toHaveLength(0)
  })

  it("w kontekście rynku kasuje WYŁĄCZNIE wygasłe wiersze tego rynku", async () => {
    const db = new RecordingDb()

    await runInSystemMarketContext(
      { markets: ["bonbeauty"], origin: { surface: "job", name: "test" } },
      async () => purgeExpiredDispatchBarrierRows(db, T0),
    )

    const { sql, bindings } = db.statements[0]
    expect(sql).toMatch(/DELETE FROM messaging_dispatch_barrier/)
    // Wiersze BEZTERMINOWE (`expires_at IS NULL`) to dostawy, które POSZŁY —
    // ich skasowanie produkowałoby duplikat maila.
    expect(sql).toMatch(/WHERE expires_at IS NOT NULL/)
    // Zawężenie po `split_part`, nie po `LIKE`: `%`/`_` w identyfikatorze rynku
    // zamieniłyby je w dopasowanie szersze niż deklaracja kontekstu.
    expect(sql).toMatch(/split_part\(barrier_key, '\|', 1\) = /)
    expect(sql).not.toMatch(/LIKE/i)
    expect(bindings).toEqual([T0.toISOString(), "bonbeauty"])
  })
})

describe("nazwa tabeli jest JEDNĄ stałą po obu stronach", () => {
  it("lib i migracja mówią o tej samej tabeli", () => {
    const migration = readFileSync(
      path.join(
        __dirname,
        "../../modules/voucher/migrations/1779002000000_create_messaging_dispatch_barrier.ts",
      ),
      "utf8",
    )
    expect(MESSAGING_DISPATCH_BARRIER_TABLE).toBe("messaging_dispatch_barrier")
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${MESSAGING_DISPATCH_BARRIER_TABLE}`)
    expect(migration).toContain("barrier_key text PRIMARY KEY")
  })
})

// ─── Runda fixów cyklu 1 ────────────────────────────────────────────────────

describe("R-4.1-H2 — kody bariery są SKLASYFIKOWANE w sweepie, a nie parkują wiersz", () => {
  it("KAŻDY kod bariery jest awarią GLOBALNĄ (próba wraca do budżetu)", () => {
    // Bez tej klasyfikacji przejściowa awaria nośnika bariery zużywała
    // SWEEP_MAX_ATTEMPT_COUNT (5) × 15 min = 75 min budżetu, po czym wiersz
    // ledgera był wykluczony ze skanu NA STAŁE — naprawa połączenia z bazą
    // przestawała pomagać, a mail wymagał ręcznego UPDATE na produkcji.
    expect(MESSAGING_BARRIER_TRANSIENT_ERROR_CODES.length).toBeGreaterThan(0)
    for (const code of MESSAGING_BARRIER_TRANSIENT_ERROR_CODES) {
      expect(isGlobalFailureErrorCode(code)).toBe(true)
    }
  })

  it("oba znane kody bariery SĄ na tej liście — nowy kod bez klasyfikacji PĘKA tutaj", () => {
    // Kontrola strukturalna: skanuje ŹRÓDŁO gatewaya i liba bariery po kodach
    // kształtu `MESSAGING_(BARRIER|DISPATCH)_*` i wymaga, żeby każdy był albo
    // sklasyfikowany, albo jawnie wymieniony jako kod WYŁĄCZNIE logowy.
    // Dzięki temu trzeci kod bariery nie wejdzie na falę niesklasyfikowany —
    // dokładnie tak, jak weszły dwa pierwsze.
    const sources = [
      path.join(__dirname, "../../../../messaging/src/gateway.ts"),
      path.join(__dirname, "../../lib/messaging-dispatch-barrier/index.ts"),
    ].map((p) => readFileSync(p, "utf8"))

    const found = new Set<string>()
    for (const source of sources) {
      for (const match of source.matchAll(/"(MESSAGING_(?:BARRIER|DISPATCH)_[A-Z0-9_]+)"/g)) {
        found.add(match[1])
      }
    }

    /**
     * Kody WYŁĄCZNIE diagnostyczne: trafiają do logu, nigdy na
     * `dispatch.audit_event.error_code`, więc sweep nie ma ich jak zobaczyć.
     * Gdyby któryś zaczął trafiać na dispatch, wymaga klasyfikacji jak reszta.
     */
    const LOG_ONLY = new Set([
      "MESSAGING_BARRIER_SETTLE_FAILED",
      "MESSAGING_BARRIER_RELEASE_FAILED",
    ])

    const unclassified = [...found].filter(
      (code) => !LOG_ONLY.has(code) && !isGlobalFailureErrorCode(code),
    )
    expect(unclassified).toEqual([])
    // Kontrola kontroli: skan realnie coś znalazł (inaczej pusty wynik udawałby zieleń).
    expect(found.size).toBeGreaterThanOrEqual(3)
  })
})

describe("R-4.1-L1 — `preflight` bariery ma KONSUMENTA, a nie tylko docstring", () => {
  it("`BarrierUnavailableError` JEST `MessagingProviderError` — inaczej gateway go nie widzi", () => {
    // Gateway rozstrzyga klasyfikację wyłącznie w gałęzi
    // `error instanceof MessagingProviderError`. Dopóki ta klasa dziedziczyła
    // po gołym `Error`, flaga `preflight` nie miała ani jednego czytelnika
    // w kodzie produkcyjnym, a kod błędu nie docierał do wiersza dostawy.
    const error = new BarrierUnavailableError()
    expect(error).toBeInstanceOf(MessagingProviderError)
    expect(error.preflight).toBe(true)
    expect(error.error_code).toBe(MESSAGING_BARRIER_UNAVAILABLE)
  })
})

describe("R-4.1-M3 — domknięcie i zwolnienie dotykają WYŁĄCZNIE własnego zajęcia", () => {
  it("`claim` zapisuje token TEGO przebiegu na obu gałęziach stwierdzenia", async () => {
    const db = new RecordingDb()
    db.willReturn({ rows: [{ barrier_key: "k" }] })

    await new PgDispatchIdempotencyBarrier(db).claim({
      barrier_key: "pl|flow|email|idem-1",
      now: T0,
      in_flight_window_ms: BARRIER_IN_FLIGHT_WINDOW_MS,
      claim_token: "tok-A",
    })

    const { sql, bindings } = db.statements[0]
    expect(sql).toMatch(/claim_token = EXCLUDED\.claim_token/)
    expect(bindings).toContain("tok-A")
  })

  it("`settle` niesie token w `WHERE` — spóźnione domknięcie nie nadpisze cudzego", async () => {
    // Scenariusz bez tego warunku: A wisi dłużej niż okno, B przejmuje zajęcie
    // i wysyła, a spóźnione `settle` procesu A nadpisuje rozstrzygnięcie B —
    // łącznie z zamianą bariery BEZTERMINOWEJ na okno 8 dni.
    const db = new RecordingDb()
    await new PgDispatchIdempotencyBarrier(db).settle({
      barrier_key: "k",
      claim_token: "tok-A",
      dispatch: dispatchFixture as never,
      expires_at: null,
    })

    const { sql, bindings } = db.statements[0]
    expect(sql).toMatch(/AND claim_token = /)
    expect(bindings).toContain("tok-A")
  })

  it("`release` wymaga OBU warunków: własnego tokenu ORAZ stanu `in_flight`", async () => {
    // Sam `state` nie odróżniał zajęcia WŁASNEGO od PRZEJĘTEGO: po wygaśnięciu
    // okna wiersz jest znowu `in_flight`, więc spóźniony `release` kasował
    // cudze zajęcie w locie i otwierał drogę trzeciemu przebiegowi (drugi mail).
    const db = new RecordingDb()
    await new PgDispatchIdempotencyBarrier(db).release({
      barrier_key: "k",
      claim_token: "tok-A",
    })

    const { sql, bindings } = db.statements[0]
    expect(sql).toMatch(/DELETE FROM messaging_dispatch_barrier/)
    expect(sql).toMatch(/AND claim_token = /)
    expect(sql).toMatch(/AND state = 'in_flight'/)
    expect(bindings).toContain("tok-A")
  })

  it("migracja zakłada kolumnę `claim_token` — bez niej warunki wyżej nie mają na czym stanąć", () => {
    const migration = readFileSync(
      path.join(
        __dirname,
        "../../modules/voucher/migrations/1779002000000_create_messaging_dispatch_barrier.ts",
      ),
      "utf8",
    )
    expect(migration).toContain("claim_token text NOT NULL")
  })
})
