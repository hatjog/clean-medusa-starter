/**
 * Instrumentacja SCIEZKI GORACEJ realizacji vouchera — nosnik pomiaru NFR-11.
 * v1.15.0 Story 6.2 (AC1, AC3, AD-25, SM-1..SM-7).
 *
 * ── Co ta jednostka dostarcza, a czego NIE ────────────────────────────────
 * Dostarcza NOSNIK, nie werdykt (Z-7). Progi NFR-11 („skutecznosc > 98%",
 * „czas p95 < 20 s") sa przy jednym przejsciu end-to-end NIEMIERZALNE: nie ma
 * populacji, na ktorej liczy sie odsetek ani percentyl. Ta jednostka ma to
 * zapisac WPROST (`not_computable`), zamiast wyprodukowac liczbe wygladajaca
 * na pomiar. To jest lekcja, ktora to wydanie juz raz zaplacilo w Story 4.8:
 * bramka `sm2-delivery-window` policzyla histogram, sprawdzila jego spojnosc
 * wewnetrzna i NIE postawila progu na sklad proby — okno przeszlo jako `pass`
 * przy `address_count: 1`.
 *
 * ── Dlaczego TEN nosnik ───────────────────────────────────────────────────
 * `posthog-metrics-client` (klucz kontenera `posthog`, rejestrowany w
 * `loaders/posthog.ts`). Wybor NIE jest nowy — jest powtorzeniem rozstrzygniecia
 * Story 4.6, ktore odrzucilo `track.ts`/`posthog-canary.ts` z pomiarem: jego
 * `_client` nigdy nie jest ustawiany, emitery zaczynaja od `if (!_client) return`,
 * alerty sa tlumione ponizej proby 100, a `metric_name` to ZAMKNIETY enum
 * siedmiu metryk, ktorego rozszerzenie wymaga aneksu ADR. Czwarty nosnik nie
 * powstaje; ten sam projekt PostHoga zbiera juz `METRIC_GAP` i eskalacje 4.6.
 *
 * ── Dlaczego TRZY serie, a nie jedna ze wspolczynnikiem (AC1) ─────────────
 * Prog NFR-11 ma DWA czlony liczone na roznych populacjach: percentyl czasu
 * i odsetek skutecznosci. Jedna seria ze wspolczynnikiem nie pozwala policzyc
 * ani jednego, ani drugiego — i dokladnie tak powstaje liczba, ktora wyglada
 * na pomiar. Licznik prob i licznik sukcesow sa wiec OSOBNE.
 */
import { PII_FORBIDDEN_FIELDS } from "./track"

/** Sterownik nosnika — ten sam ksztalt co `EscalationSink` ze Story 4.6. */
export type RedemptionMetricsSink = {
  capture: (event: string, properties: Record<string, unknown>) => void
}

/** Przestrzen nazw zdarzen; jedna rodzina, trzy serie. */
export const REDEMPTION_ATTEMPT_EVENT = "gp.voucher_redemption.attempt" as const
export const REDEMPTION_SUCCESS_EVENT = "gp.voucher_redemption.success" as const
export const REDEMPTION_DURATION_EVENT = "gp.voucher_redemption.duration_ms" as const

/**
 * Prog populacji dla NFR-11 — TA SAMA liczba co okno SM-2 ze Story 4.8.
 * Nie dlatego, ze 30 jest magiczne, tylko dlatego, ze drugi prog na to samo
 * pytanie („czy proba wystarcza, zeby liczyc odsetek i percentyl") bylby drugim
 * zrodlem prawdy. Zmiana progu jest decyzja, nie szczegolem implementacji.
 */
export const NFR11_MIN_POPULATION = 30

/**
 * Bramka PII na NOSNIKU, nie przy jednym producencie (review-fix cyklu 1 w 4.6).
 * Bramka przy producencie chroni producenta; bramka na nosniku chroni nosnik.
 * Rzuca, nie strippuje — cicha redakcja zostawilaby producenta wysylajacego
 * dane wrazliwe i nikogo, kto o tym wie.
 */
export function withRedemptionPiiGuard<S extends RedemptionMetricsSink>(
  sink: S | null | undefined,
  origin: string,
): S | undefined {
  if (!sink) return undefined
  return {
    ...sink,
    capture(event: string, properties: Record<string, unknown>) {
      for (const key of Object.keys(properties)) {
        const lower = key.toLowerCase()
        for (const forbidden of PII_FORBIDDEN_FIELDS) {
          if (lower.includes(forbidden)) {
            throw new Error(
              `${origin}:${event}: metryka sciezki goracej nie moze niesc PII — ` +
                `pole '${key}' jest zakazane (wspolna lista PII_FORBIDDEN_FIELDS ` +
                `z lib/instrumentation/track.ts)`,
            )
          }
        }
      }
      sink.capture(event, properties)
    },
  }
}

/** Etykiety AD-25 towarzyszace kazdej serii. */
export type RedemptionMetricLabels = {
  request_id: string
  market_id: string
  env: string
  instance_id: string
  /** Zamaskowany — surowy identyfikator nie wychodzi z procesu. */
  actor_id: string
}

export type RedemptionOutcome = {
  /** `t1 - t0` w milisekundach; granica zdefiniowana przy wywolujacym. */
  duration_ms: number
  /** Czy zadanie doszlo do stanu terminalnego OZNACZAJACEGO realizacje. */
  succeeded: boolean
  /** Kod odmowy, gdy `succeeded === false`; nigdy tresc od uzytkownika. */
  refusal_code?: string | null
  http_status: number
}

/**
 * Emisja trzech serii. Zwraca `carrier_unavailable`, gdy nosnika nie ma —
 * brak nosnika NIE jest cichym sukcesem i nie jest tez wyjatkiem wywracajacym
 * sciezke pieniadza: realizacja vouchera nie moze sie nie udac dlatego, ze
 * telemetria jest niedostepna.
 */
export function emitRedemptionHotPathMetrics(args: {
  sink: RedemptionMetricsSink | null | undefined
  labels: RedemptionMetricLabels
  outcome: RedemptionOutcome
}): "emitted" | "carrier_unavailable" {
  const guarded = withRedemptionPiiGuard(args.sink, "redemption-hot-path")
  if (!guarded) return "carrier_unavailable"

  const base = {
    ...args.labels,
    http_status: args.outcome.http_status,
    outcome: args.outcome.succeeded ? "pass" : "fail",
  }

  // Licznik PROB — kazde zadanie, ktore doszlo do stanu terminalnego.
  guarded.capture(REDEMPTION_ATTEMPT_EVENT, {
    ...base,
    refusal_code: args.outcome.refusal_code ?? null,
  })

  // Licznik SUKCESOW — osobna seria, nie pole w poprzedniej.
  if (args.outcome.succeeded) {
    guarded.capture(REDEMPTION_SUCCESS_EVENT, { ...base })
  }

  // Czas realizacji — osobna seria, bo percentyl liczy sie na innej populacji
  // niz odsetek (zadanie odrzucone tez ma czas trwania).
  guarded.capture(REDEMPTION_DURATION_EVENT, {
    ...base,
    duration_ms: args.outcome.duration_ms,
  })

  return "emitted"
}

export type Nfr11Verdict = {
  window_status: "open" | "closed"
  n: number
  missing_to_threshold: number
  /** `pass` / `fail` DOPIERO przy domknietej probie; inaczej `not_computable`. */
  success_rate_verdict: "pass" | "fail" | "not_computable"
  duration_p95_verdict: "pass" | "fail" | "not_computable"
  success_rate: number | null
  duration_p95_ms: number | null
}

/**
 * Werdykt NFR-11 z populacji — w TYM SAMYM ksztalcie co `sm2_verdict` z 4.8
 * (`window_status` / `missing_to_*` / trzystanowy werdykt).
 *
 * Przy `n < NFR11_MIN_POPULATION` odsetek i percentyl sa NIEMIERZALNE i wynik
 * jest `not_computable` — nie `pass` i nie liczba udajaca percentyl.
 */
export function computeNfr11Verdict(
  samples: ReadonlyArray<{ duration_ms: number; succeeded: boolean }>,
  thresholds: { min_success_rate?: number; max_p95_ms?: number } = {},
): Nfr11Verdict {
  const minSuccessRate = thresholds.min_success_rate ?? 0.98
  const maxP95 = thresholds.max_p95_ms ?? 20_000
  const n = samples.length
  const closed = n >= NFR11_MIN_POPULATION

  if (!closed) {
    return {
      window_status: "open",
      n,
      missing_to_threshold: Math.max(NFR11_MIN_POPULATION - n, 0),
      success_rate_verdict: "not_computable",
      duration_p95_verdict: "not_computable",
      success_rate: null,
      duration_p95_ms: null,
    }
  }

  const successes = samples.filter((s) => s.succeeded).length
  const successRate = successes / n
  const sorted = [...samples].map((s) => s.duration_ms).sort((a, b) => a - b)
  // Percentyl metoda nearest-rank — jedna, nazwana metoda zamiast czterech
  // mozliwych interpretacji „p95".
  const p95 = sorted[Math.min(Math.ceil(0.95 * n) - 1, n - 1)]

  return {
    window_status: "closed",
    n,
    missing_to_threshold: 0,
    success_rate_verdict: successRate >= minSuccessRate ? "pass" : "fail",
    duration_p95_verdict: p95 < maxP95 ? "pass" : "fail",
    success_rate: successRate,
    duration_p95_ms: p95,
  }
}
