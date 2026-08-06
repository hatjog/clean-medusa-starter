/**
 * Story v160-cleanup-15f — AC1 fix.
 *
 * In-process ring-buffer aggregator for request log samples. Lightweight
 * primitive that the cohort-metrics-aggregator consumes to produce real
 * p95 latency + 5xx error-rate signals (replacing the prior all-`unknown`
 * placeholder).
 *
 * Design constraints:
 *   - Bounded memory (default 10k samples, ~3 hours at typical traffic).
 *   - Lock-free push (single-writer-per-sample assumption — Node.js
 *     single-threaded request handlers; no atomicity issues for primitives).
 *   - O(n) percentile computation; n bounded → O(1) effective.
 *
 * Production note (v1.7.0): this in-process aggregator scales to a single
 * Node instance. Multi-instance deployments need a metrics backend
 * (Prometheus push gateway / OpenTelemetry collector). The tradeoff is
 * acceptable for v1.6.0 because Phase B SMOKE GATE runs against a single
 * staging instance pre-flag-flip.
 */

export type RequestSample = {
  /** Unix epoch ms */
  ts: number
  /** Wall-clock duration in milliseconds */
  duration_ms: number
  /** HTTP status code */
  status_code: number
  /** Coarse cohort tag (route group); used for filtering. */
  cohort?: string
}

/**
 * Kohorta metryki odmowy scopingu katalogu (Story 2.3, NFR-2).
 *
 * Mieszka TUTAJ, a nie w `api/middlewares.ts`, bo to ten moduł musi wiedzieć,
 * że ta kohorta NIE JEST ruchem katalogowym — inaczej wiedza o wykluczeniu
 * leżałaby po stronie producenta próbki, a konsument (`computeCohortMetrics`)
 * i tak by ją policzył.
 */
export const MARKET_SCOPE_DENIED_COHORT = "market-scope-denied"

/**
 * Kohorty SYNTETYCZNE — próbki dopisywane przez mechanizmy domenowe, a nie
 * przez `requestLogMetricsMiddleware`, który mierzy realne żądanie HTTP
 * (kohorta = ścieżka trasy).
 *
 * Story 2.3 review-fix HIGH-1: `computeCohortMetrics` woła `computeRangeStats`
 * BEZ kohorty, więc do tej pory każda taka próbka wchodziła do wyliczeń
 * WSZYSTKICH KPI. Skutki były zmierzalne i szkodliwe: odmowa `403` była
 * liczona DWA razy (raz przez `requestLogMetricsMiddleware` na `res.finish`,
 * raz przez `denyMarketScope`), co zawyżało mianownik `conversion`, a jej
 * `duration_ms: 0` wstrzykiwało zera w ogon próbek i ZANIŻAŁO `p95_latency_ms`
 * — czyli maskowało regresję latencji dokładnie wtedy, gdy katalog masowo
 * odmawia.
 *
 * Wykluczenie zapada przy odczycie BEZ jawnej kohorty. Odczyt Z jawną kohortą
 * (`computeRangeStats(since, now, MARKET_SCOPE_DENIED_COHORT)`) nadal zwraca
 * te próbki — po to one są.
 */
export const NON_TRAFFIC_COHORTS: ReadonlySet<string> = new Set([
  MARKET_SCOPE_DENIED_COHORT,
])

const DEFAULT_CAPACITY = 10_000

class RingBuffer {
  private buffer: RequestSample[] = []
  private head = 0
  private size = 0
  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  push(sample: RequestSample): void {
    if (this.size < this.capacity) {
      this.buffer.push(sample)
      this.size++
      return
    }
    this.buffer[this.head] = sample
    this.head = (this.head + 1) % this.capacity
  }

  /** Return samples within [sinceMs, nowMs]. Iterates full buffer. */
  range(sinceMs: number, nowMs: number = Date.now()): RequestSample[] {
    return this.buffer.filter((s) => s.ts >= sinceMs && s.ts <= nowMs)
  }

  reset(): void {
    this.buffer = []
    this.head = 0
    this.size = 0
  }

  get length(): number {
    return this.size
  }
}

const _aggregator = new RingBuffer()

/** Record a request sample. Called by middleware after response.send. */
export function recordRequest(sample: RequestSample): void {
  _aggregator.push(sample)
}

export type WindowStats = {
  sample_size: number
  p95_latency_ms: number | null
  error_rate_5xx_pct: number | null
  window_start_ms: number
  window_end_ms: number
}

export function computeRangeStats(
  sinceMs: number,
  nowMs: number,
  cohort?: string,
): WindowStats {
  let samples = _aggregator.range(sinceMs, nowMs)
  if (cohort) {
    samples = samples.filter((s) => s.cohort === cohort)
  } else {
    // Story 2.3 review-fix HIGH-1: odczyt bez jawnej kohorty jest odczytem
    // RUCHU. Kohorty syntetyczne muszą z niego wypaść, bo inaczej licznik
    // zdarzenia domenowego udaje wizytę i psuje `conversion` oraz `p95`.
    samples = samples.filter(
      (s) => !(s.cohort !== undefined && NON_TRAFFIC_COHORTS.has(s.cohort)),
    )
  }
  if (samples.length === 0) {
    return {
      sample_size: 0,
      p95_latency_ms: null,
      error_rate_5xx_pct: null,
      window_start_ms: sinceMs,
      window_end_ms: nowMs,
    }
  }
  const durations = samples.map((s) => s.duration_ms).sort((a, b) => a - b)
  const p95Index = Math.min(
    durations.length - 1,
    Math.floor(durations.length * 0.95),
  )
  const fiveXX = samples.filter((s) => s.status_code >= 500).length
  return {
    sample_size: samples.length,
    p95_latency_ms: durations[p95Index] ?? null,
    error_rate_5xx_pct: (fiveXX / samples.length) * 100,
    window_start_ms: sinceMs,
    window_end_ms: nowMs,
  }
}

/**
 * Compute p95 latency + 5xx error-rate over a time window.
 * Returns nulls when sample_size === 0 (caller maps to `unknown` status).
 */
export function computeWindowStats(
  windowMs: number,
  cohort?: string,
  nowMs: number = Date.now(),
): WindowStats {
  const sinceMs = nowMs - windowMs
  return computeRangeStats(sinceMs, nowMs, cohort)
}

/** Test helper — clear the in-process buffer. */
export function _resetForTest(): void {
  _aggregator.reset()
}

/** Diagnostic — current buffer fill. */
export function _bufferSize(): number {
  return _aggregator.length
}
