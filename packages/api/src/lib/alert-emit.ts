/**
 * alert-emit.ts — Structured alert emitter with in-memory ring buffer (cleanup-15a re-land).
 *
 * v1.6.0: Emits structured JSON via Medusa logger (warn level) and stores in a
 * fixed-size in-memory ring buffer (last 1000 events). The ring buffer is
 * accessible via `getRingBuffer()` for test assertions and the
 * `/admin/operator/alerting` endpoint (Story 8.5).
 *
 * v1.7.0 planned: Wire-up to Slack/PagerDuty webhook. Ring buffer will also
 * persist to DB for cross-process replay.
 *
 * Security: This module never includes raw request bodies in the alert payload —
 * callers pass structured `context` objects explicitly.
 *
 * @module lib/alert-emit
 */

export type AlertSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL"

export interface StructuredAlertPayload {
  severity: AlertSeverity
  code: string
  message: string
  context?: Record<string, unknown>
}

export interface StructuredAlertEntry extends StructuredAlertPayload {
  timestamp: string
  id: string
}

type LoggerLike = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
  error?: (message: string, meta?: Record<string, unknown>) => void
  info?: (message: string, meta?: Record<string, unknown>) => void
}

const RING_BUFFER_MAX_SIZE = 1000

// In-memory ring buffer — fixed size, evicts oldest on overflow.
const _ringBuffer: StructuredAlertEntry[] = []
let _bufferHead = 0
let _bufferCount = 0

// Replaceable logger for testing
let _logger: LoggerLike = console

/**
 * injectLogger — inject a Medusa logger (or test mock) for output.
 * Called once at server startup; defaults to console.
 */
export function injectLogger(logger: LoggerLike): void {
  _logger = logger
}

/**
 * _resetRingBuffer — FOR TESTING ONLY. Clears the ring buffer state.
 * Not exported from the module namespace in production usage.
 */
export function _resetRingBuffer(): void {
  _ringBuffer.length = 0
  _bufferHead = 0
  _bufferCount = 0
}

/**
 * emitStructuredAlert — emit a structured alert.
 *
 * Stores the alert in the ring buffer AND logs it via the injected logger.
 * Synchronous (no await) — callers should not block on this.
 */
export function emitStructuredAlert(payload: StructuredAlertPayload): void {
  const entry: StructuredAlertEntry = {
    ...payload,
    timestamp: new Date().toISOString(),
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  }

  // Ring buffer write — pre-allocate slot or push
  if (_bufferCount < RING_BUFFER_MAX_SIZE) {
    _ringBuffer.push(entry)
    _bufferCount++
  } else {
    _ringBuffer[_bufferHead] = entry
    _bufferHead = (_bufferHead + 1) % RING_BUFFER_MAX_SIZE
  }

  // Structured log output
  const logMeta: Record<string, unknown> = {
    alert_id: entry.id,
    code: entry.code,
    severity: entry.severity,
    timestamp: entry.timestamp,
    ...entry.context,
  }

  if (entry.severity === "CRITICAL" || entry.severity === "ERROR") {
    _logger.error?.(`[alert] ${entry.code}: ${entry.message}`, logMeta)
  } else if (entry.severity === "WARN") {
    _logger.warn?.(`[alert] ${entry.code}: ${entry.message}`, logMeta)
  } else {
    _logger.info?.(`[alert] ${entry.code}: ${entry.message}`, logMeta)
  }
}

/**
 * getRingBuffer — return a snapshot of the ring buffer in chronological order.
 * Returns at most 100 most recent events (AC1 spec: "last 100 events accessible
 * to tests + /admin/operator/alerting").
 */
export function getRingBuffer(limit = 100): StructuredAlertEntry[] {
  const cappedLimit = Math.min(limit, RING_BUFFER_MAX_SIZE)
  // Return the ring buffer contents in chronological order
  const all = _ringBuffer.slice()
  // The oldest entry may be at _bufferHead if buffer is full
  if (_bufferCount < RING_BUFFER_MAX_SIZE) {
    // Buffer not yet full — entries are in insertion order
    return all.slice(-cappedLimit)
  }
  // Buffer full — reorder: from _bufferHead to end + from start to _bufferHead
  const ordered = [
    ..._ringBuffer.slice(_bufferHead),
    ..._ringBuffer.slice(0, _bufferHead),
  ]
  return ordered.slice(-cappedLimit)
}
