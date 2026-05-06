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
