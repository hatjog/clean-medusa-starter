/**
 * dlq.ts — Dead-Letter-Queue classifier for MoR runtime evaluation failures.
 *
 * @see D-71 — Per-Attempt Strict Timeout Pattern + two-tier DLQ classifier
 * @see _bmad-output/planning-artifacts/architecture.md §D-71 (retry semantics)
 *
 * Failure-mode taxonomy (FM-71-RT-1..10 + FM-71-DLQ-1..2):
 *
 *  Two-tier classification:
 *   - `dlq_pending_ops_review` — genuine evaluator failure (DB constraint,
 *     missing config, vendor-side issue). Requires human triage.
 *   - `dlq_pending_retry`      — Postgres maintenance signal (deadlock,
 *     serialization failure, lock_not_available). Auto-replayed during
 *     maintenance windows.
 *
 * Transient (caller retries inline):
 *   - 40001 serialization_failure (within retry budget)
 *   - 40P01 deadlock_detected (within retry budget)
 *   - 57P03 cannot_connect_now (within retry budget)
 *   - 53300 too_many_connections (within retry budget)
 *   - timeout (per-attempt 1s strict)
 *
 * Terminal → DLQ:
 *   - 23xxx integrity violation (FK, unique, check)
 *   - 22xxx data exception (range, not-null, format)
 *   - 42xxx syntax / access rule violation (missing relation, perm denied)
 *   - 28xxx invalid_authorization
 *   - any non-PG error (eg. bad config, contract violation)
 */

/** Two-tier DLQ tier classification. */
export type DlqTier =
  | "dlq_pending_ops_review"
  | "dlq_pending_retry"
  | "transient"

/** Failure-mode short codes — mirrored in `mor.policy.dlq.classified` event. */
export type FailureModeCode =
  | "FM-71-RT-1" // 40001 serialization_failure
  | "FM-71-RT-2" // 40P01 deadlock_detected
  | "FM-71-RT-3" // 57P03 cannot_connect_now
  | "FM-71-RT-4" // 53300 too_many_connections
  | "FM-71-RT-5" // per-attempt timeout
  | "FM-71-RT-6" // 55P03 lock_not_available
  | "FM-71-RT-7" // 08000 connection_exception (transient)
  | "FM-71-RT-8" // 57014 query_canceled (eg. statement_timeout)
  | "FM-71-RT-9" // 23xxx integrity violation
  | "FM-71-RT-10" // 22xxx data exception
  | "FM-71-DLQ-1" // 42xxx syntax / access rule violation
  | "FM-71-DLQ-2" // unclassified non-PG error

export interface DlqClassification {
  tier: DlqTier
  failure_mode: FailureModeCode
  /** Whether the orchestrator should retry inline (within 3-attempt budget). */
  is_retryable: boolean
  /** PG SQLSTATE if available; `null` for non-PG errors. */
  sqlstate: string | null
  /** Free-text reason for ops triage. */
  reason: string
}

/** Retryable PG SQLSTATEs (Postgres maintenance signal — `dlq_pending_retry`). */
const PG_TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "55P03", // lock_not_available
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "57014", // query_canceled
])

/** Terminal PG SQLSTATE classes (always DLQ → ops review). */
const PG_TERMINAL_CLASS_PREFIXES = ["23", "22", "42", "28", "44"]

interface PgErrorLike {
  code?: string
  routine?: string
  message?: string
}

/**
 * extractSqlstate — best-effort SQLSTATE extraction from heterogeneous error
 * shapes (pg.DatabaseError, MikroORM wrapper, raw Error).
 */
export function extractSqlstate(err: unknown): string | null {
  if (err === null || typeof err !== "object") {
    return null
  }
  const candidate = err as PgErrorLike & { cause?: unknown; original?: unknown }
  if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
    return candidate.code
  }
  // Many ORMs wrap the original PG error.
  if (candidate.cause) {
    const nested = extractSqlstate(candidate.cause)
    if (nested) {
      return nested
    }
  }
  if (candidate.original) {
    return extractSqlstate(candidate.original)
  }
  return null
}

/**
 * isTimeoutError — detect per-attempt timeout (FM-71-RT-5).
 */
function isTimeoutError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false
  }
  const message = String((err as Error).message ?? "").toLowerCase()
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    (err as { code?: string }).code === "ETIMEDOUT"
  )
}

/**
 * classifyFailure — map any thrown value to a {@link DlqClassification}.
 *
 * The classifier is total: every input produces a tier + failure_mode.
 *
 * - Transient PG signals + timeout = `tier:'transient'` (caller retries inline
 *   within the 3-attempt budget). After exhaustion, the orchestrator promotes
 *   the last classification to `dlq_pending_retry` for auto-replay.
 * - Terminal PG signals = `dlq_pending_ops_review` (no auto-replay).
 * - Unknown / non-PG = `dlq_pending_ops_review` (operator must investigate).
 */
export function classifyFailure(err: unknown): DlqClassification {
  const sqlstate = extractSqlstate(err)
  const errMessage = err instanceof Error ? err.message : String(err)

  if (isTimeoutError(err)) {
    return {
      tier: "transient",
      failure_mode: "FM-71-RT-5",
      is_retryable: true,
      sqlstate,
      reason: `per-attempt timeout: ${errMessage}`,
    }
  }

  if (sqlstate && PG_TRANSIENT_SQLSTATES.has(sqlstate)) {
    const failureMode = sqlstateToFailureMode(sqlstate)
    return {
      tier: "transient",
      failure_mode: failureMode,
      is_retryable: true,
      sqlstate,
      reason: `transient PG signal ${sqlstate}: ${errMessage}`,
    }
  }

  if (sqlstate) {
    const classPrefix = sqlstate.slice(0, 2)
    if (PG_TERMINAL_CLASS_PREFIXES.includes(classPrefix)) {
      return {
        tier: "dlq_pending_ops_review",
        failure_mode: terminalSqlstateToFailureMode(sqlstate),
        is_retryable: false,
        sqlstate,
        reason: `terminal PG class ${classPrefix} (${sqlstate}): ${errMessage}`,
      }
    }
    // Other PG class — conservative: ops review.
    return {
      tier: "dlq_pending_ops_review",
      failure_mode: "FM-71-DLQ-1",
      is_retryable: false,
      sqlstate,
      reason: `unclassified PG SQLSTATE ${sqlstate}: ${errMessage}`,
    }
  }

  return {
    tier: "dlq_pending_ops_review",
    failure_mode: "FM-71-DLQ-2",
    is_retryable: false,
    sqlstate: null,
    reason: `non-PG error: ${errMessage}`,
  }
}

/**
 * promoteExhaustedRetry — after the 3-attempt budget is exhausted, transient
 * classifications graduate to `dlq_pending_retry` for maintenance-window
 * auto-replay.
 */
export function promoteExhaustedRetry(
  classification: DlqClassification
): DlqClassification {
  if (classification.tier === "transient") {
    return {
      ...classification,
      tier: "dlq_pending_retry",
      is_retryable: false,
      reason: `retry budget exhausted; ${classification.reason}`,
    }
  }
  return classification
}

function sqlstateToFailureMode(sqlstate: string): FailureModeCode {
  switch (sqlstate) {
    case "40001":
      return "FM-71-RT-1"
    case "40P01":
      return "FM-71-RT-2"
    case "57P03":
      return "FM-71-RT-3"
    case "53300":
      return "FM-71-RT-4"
    case "55P03":
      return "FM-71-RT-6"
    case "08000":
    case "08003":
    case "08006":
      return "FM-71-RT-7"
    case "57014":
      return "FM-71-RT-8"
    default:
      return "FM-71-RT-7"
  }
}

function terminalSqlstateToFailureMode(sqlstate: string): FailureModeCode {
  const prefix = sqlstate.slice(0, 2)
  if (prefix === "23") return "FM-71-RT-9"
  if (prefix === "22") return "FM-71-RT-10"
  return "FM-71-DLQ-1"
}
