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
import type { PosthogCaptureClient } from "./posthog-metrics-client"

/** Sterownik nosnika — ten sam ksztalt co `EscalationSink` ze Story 4.6. */
export type RedemptionMetricsSink = {
  capture: (event: string, properties: Record<string, unknown>) => void
}

/**
 * ADAPTER portu na ksztalt SDK (review cyklu 1, F-1).
 *
 * Port `RedemptionMetricsSink` bierze DWA argumenty pozycyjne, a klient
 * zarejestrowany w kontenerze pod kluczem `posthog` (`PosthogCaptureClient`,
 * surowy `posthog-node`) bierze JEDEN obiekt z `distinctId`. Wolanie klienta
 * kontraktem portu wysylalo `event: undefined` albo rzucalo — czyli nosnik byl
 * w repo, ale na realnej trasie nie emitowal NICZEGO. Rzutowanie `as` bylo tym,
 * co uciszalo `tsc`; tutaj rzutowania nie ma i kompilator pilnuje ksztaltu.
 *
 * To jest ten sam adapter, ktory dziala juz w sweepie
 * (`createPosthogSweepMetrics`, `jobs/voucher-delivery-reconciliation-sweep.ts`).
 */
export function createRedemptionPosthogSink(
  client: PosthogCaptureClient | null | undefined,
  distinctId: string,
): RedemptionMetricsSink | null {
  if (!client || typeof client.capture !== "function") return null
  return {
    capture(event: string, properties: Record<string, unknown>) {
      client.capture({ distinctId, event, properties })
    },
  }
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
 *
 * Ta wartosc jest ZDUPLIKOWANA wzgledem `SM2_MIN_WINDOW_POPULATION`
 * w `_grow/tools/sm2_delivery_window.py` (inny jezyk, inny proces — importu nie
 * ma jak zrobic). Zeby duplikat nie byl „stala-lustrem bez bramki porownania"
 * (review cyklu 1, F-7), rozjazd wykrywa BRAMKA:
 *   `python3 _grow/tools/validate_nfr11_population_threshold_parity.py`
 * (exit 0 = zgodne, 2 = rozjazd, 3 = brak nosnika po ktorejs stronie).
 * Zmieniajac te liczbe, zmien obie strony — inaczej bramka czerwieni.
 */
export const NFR11_MIN_POPULATION = 30

/** Maksymalna glebokosc skanu PII; ladunek serii jest dzis plaski. */
const PII_SCAN_MAX_DEPTH = 4

/**
 * Skan kluczy w GLAB (review cyklu 1, F-11 pkt 1). Wersja pierwsza skanowala
 * wylacznie klucze najwyzszego poziomu, wiec `{ context: { email } }` mijalo
 * bramke bokiem — komentarz obiecywal mocniejsza gwarancje niz kod dawal.
 * Zwraca sciezke do pierwszego zakazanego klucza albo `null`.
 */
function findForbiddenKeyPath(
  value: unknown,
  path: string,
  depth: number,
): string | null {
  if (depth > PII_SCAN_MAX_DEPTH || value === null || typeof value !== "object") {
    return null
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findForbiddenKeyPath(item, `${path}[${index}]`, depth + 1)
      if (hit) return hit
    }
    return null
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    const here = path ? `${path}.${key}` : key
    for (const forbidden of PII_FORBIDDEN_FIELDS) {
      if (lower.includes(forbidden)) return here
    }
    const hit = findForbiddenKeyPath(nested, here, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * Bramka PII na NOSNIKU, nie przy jednym producencie (review-fix cyklu 1 w 4.6).
 * Bramka przy producencie chroni producenta; bramka na nosniku chroni nosnik.
 * Rzuca, nie strippuje — cicha redakcja zostawilaby producenta wysylajacego
 * dane wrazliwe i nikogo, kto o tym wie.
 *
 * Zwraca WASKI port, nie `S` (review cyklu 1, F-11 pkt 2): dla instancji klasy
 * — a taki jest klient `posthog-node` — spread kopiowal wylacznie wlasne pola
 * enumerowalne, wiec metody prototypu (`shutdown`, `flush`) znikaly, a typ
 * twierdzil, ze sa. Kontrakt zwracany jest teraz tym, co obiekt naprawde ma.
 *
 * Zakres bramki: KLUCZE (w glab). Wartosci nie sa skanowane swiadomie — skan
 * wartosci po regexie dalby falszywe trafienia na kodach odmowy i identyfikatorach,
 * a producent ladunku jest w tym samym repo.
 */
export function withRedemptionPiiGuard(
  sink: RedemptionMetricsSink | null | undefined,
  origin: string,
): RedemptionMetricsSink | undefined {
  if (!sink) return undefined
  return {
    capture(event: string, properties: Record<string, unknown>) {
      const forbiddenPath = findForbiddenKeyPath(properties, "", 0)
      if (forbiddenPath) {
        throw new Error(
          `${origin}:${event}: metryka sciezki goracej nie moze niesc PII — ` +
            `pole '${forbiddenPath}' jest zakazane (wspolna lista PII_FORBIDDEN_FIELDS ` +
            `z lib/instrumentation/track.ts)`,
        )
      }
      sink.capture(event, properties)
    },
  }
}

/** Etykiety AD-25 towarzyszace kazdej serii. */
export type RedemptionMetricLabels = {
  /**
   * Identyfikator ZADANIA z warstwy transportowej (ten sam, ktory idzie do
   * logow). Review cyklu 1 (F-10): wczesniej siedzial tu klucz idempotencji —
   * naglowek opcjonalny i sterowany przez klienta — wiec kazde wywolanie bez
   * niego dostawalo `request_id: "unknown"`, czyli etykiete o zerowej mocy
   * korelacyjnej dokladnie tam, gdzie AD-25 stawia ja po to, zeby dalo sie
   * zejsc z metryki do logu.
   */
  request_id: string
  /** Klucz idempotencji jako OSOBNA etykieta; `null`, gdy klient go nie podal. */
  idempotency_key: string | null
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
  /** Okno populacji SKUTECZNOSCI — caly ruch trasy. */
  window_status: "open" | "closed"
  n: number
  missing_to_threshold: number
  /**
   * Okno populacji CZASU — WYLACZNIE realizacje, ktore faktycznie zaszly.
   * Osobne, bo populacja jest inna i domyka sie w innym momencie (F-6).
   */
  duration_window_status: "open" | "closed"
  duration_n: number
  duration_missing_to_threshold: number
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
 *
 * ── DWIE populacje, nie jedna (review cyklu 1, F-6) ───────────────────────
 * Modul od poczatku argumentuje, ze czas i skutecznosc licza sie na roznych
 * populacjach — ale werdykt liczyl OBA czlony z tej samej tablicy. Skutek byl
 * mierzalny: szybkie odmowy (401/404 na walidacji kodu kosztuja milisekundy)
 * rozcienczaly percentyl, wiec `p95` calego ruchu mieszcil sie pod 20 s takze
 * wtedy, gdy p95 REALIZACJI, ktore faktycznie zaszly, byl wielokrotnie wyzszy.
 * To ten sam wzorzec co `AI-15-4.1` (prog na sklad proby, nie tylko na jej sume).
 *
 * ROZSTRZYGNIECIE: „czas realizacji" z NFR-11 liczy sie na podpopulacji
 * `succeeded === true`. Odmowa nie jest realizacja, wiec jej czas nie opisuje
 * czasu realizacji. Kazde okno ma WLASNY `window_status` i wlasne
 * `missing_to_threshold` — okno czasu domyka sie pozniej niz okno skutecznosci
 * i to jest wlasciwosc, nie usterka.
 */
export function computeNfr11Verdict(
  samples: ReadonlyArray<{ duration_ms: number; succeeded: boolean }>,
  thresholds: { min_success_rate?: number; max_p95_ms?: number } = {},
): Nfr11Verdict {
  const minSuccessRate = thresholds.min_success_rate ?? 0.98
  const maxP95 = thresholds.max_p95_ms ?? 20_000
  const n = samples.length
  const closed = n >= NFR11_MIN_POPULATION

  const durations = samples.filter((s) => s.succeeded).map((s) => s.duration_ms)
  const durationN = durations.length
  const durationClosed = durationN >= NFR11_MIN_POPULATION

  const successes = samples.filter((s) => s.succeeded).length
  const successRate = closed ? successes / n : null

  let p95: number | null = null
  if (durationClosed) {
    const sorted = [...durations].sort((a, b) => a - b)
    // Percentyl metoda nearest-rank — jedna, nazwana metoda zamiast czterech
    // mozliwych interpretacji „p95".
    p95 = sorted[Math.min(Math.ceil(0.95 * durationN) - 1, durationN - 1)]
  }

  return {
    window_status: closed ? "closed" : "open",
    n,
    missing_to_threshold: Math.max(NFR11_MIN_POPULATION - n, 0),
    duration_window_status: durationClosed ? "closed" : "open",
    duration_n: durationN,
    duration_missing_to_threshold: Math.max(NFR11_MIN_POPULATION - durationN, 0),
    success_rate_verdict:
      successRate === null
        ? "not_computable"
        : successRate >= minSuccessRate
          ? "pass"
          : "fail",
    duration_p95_verdict:
      p95 === null ? "not_computable" : p95 < maxP95 ? "pass" : "fail",
    success_rate: successRate,
    duration_p95_ms: p95,
  }
}
