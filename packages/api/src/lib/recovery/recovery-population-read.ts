/**
 * recovery-population-read.ts — v1.16.0 Story 4.7 (FR-11, FR-12, FR-14, AD-31, AD-22, NFR-3).
 *
 * Jedno wejście odczytu trzech populacji wymagających człowieka:
 *   - compensation_failure    (`money_path_compensation_failure`, Story 4.2),
 *   - deferred_issuance_trace (`deferred_issuance_trace`, Story 4.4),
 *   - dlq_entry               (`mor_policy_dlq_entry`, Story 4.6).
 *
 * Każde zapytanie biegnie przez wstrzyknięty `query` — w runtime jest to
 * `queryUnderMarketContext` (rola `medusa_store`, GUC rynku i instancji
 * zweryfikowane przed zapytaniem). SQL NIE filtruje po rynku: zakres zawęża
 * wyłącznie polityka `market_isolation`. Wiersz spoza żądanego scope'u, który
 * mimo to wróciłby z bazy, jest odmową (`RecoveryPopulationScopeViolationError`),
 * nie filtrem po stronie aplikacji — cichy filtr ukryłby osłabienie RLS.
 *
 * Mapowanie na wspólny kształt wiersza 4.1 (`recovery-population.v1.schema.json`).
 * Stan spoza słownika populacji jest odmową (`RecoveryPopulationShapeError`), nie
 * pominięciem.
 */
import {
  RECOVERY_CONTRACT_VERSION,
  RECOVERY_TRANSITIONS,
  type RecoveryPopulationType,
} from "./recovery-action-contract"

export type RecoveryPopulationQuery = <T = Record<string, unknown>>(
  sql: string,
  params: ReadonlyArray<unknown>
) => Promise<{ rows: T[] }>

export type RecoveryPopulationRow = {
  contract_version: typeof RECOVERY_CONTRACT_VERSION
  population_type: RecoveryPopulationType
  population_id: string
  instance_id: string
  market_id: string
  state: string
  owner: { owner_type: string; owner_id: string }
  deadline: string
  retry_count: number
  resolution_evidence: Record<string, unknown> | null
  version: number
  occurred_at: string
  closure_path: string
  provenance: { kind: string; source: string }
  payload: Record<string, unknown>
}

export type RecoveryPopulationsResult = {
  instance_id: string
  market_id: string
  populations: Record<RecoveryPopulationType, RecoveryPopulationRow[]>
}

export class RecoveryPopulationShapeError extends Error {
  readonly code = "recovery_row_outside_contract" as const
  constructor(readonly population_type: RecoveryPopulationType, readonly population_id: string, detail: string) {
    super(`[recovery-population-read] ${population_type}/${population_id}: ${detail}`)
    this.name = "RecoveryPopulationShapeError"
  }
}

export class RecoveryPopulationScopeViolationError extends Error {
  readonly code = "recovery_scope_violation" as const
  constructor(readonly population_type: RecoveryPopulationType, readonly population_id: string) {
    super(`[recovery-population-read] ${population_type}/${population_id}: wiersz spoza żądanego scope'u RLS`)
    this.name = "RecoveryPopulationScopeViolationError"
  }
}

/** Stany NIETERMINALNE — populacja „wymagająca człowieka”, z tabeli przejść 4.1. */
export function openStates(population: RecoveryPopulationType): string[] {
  const t = RECOVERY_TRANSITIONS[population]
  return Object.keys(t.allowed).filter((s) => !t.terminal.includes(s))
}

function sqlList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")
}

export const READ_COMPENSATION_FAILURE_POPULATION_SQL = `
  SELECT failure_id AS population_id, instance_id, market_id, resolution_state AS state,
         owner_type, owner_id, deadline, retry_count, resolution_evidence, version,
         occurred_at, closure_path, provenance_kind, provenance_source,
         compensation_kind, delivery_path, stripe_event_id, attempt_count, order_id
    FROM money_path_compensation_failure
   WHERE resolution_state IN (${sqlList(openStates("compensation_failure"))})
   ORDER BY occurred_at ASC, failure_id ASC
`

export const READ_DEFERRED_ISSUANCE_TRACE_POPULATION_SQL = `
  SELECT trace_id AS population_id, instance_id, market_id, state,
         owner_type, owner_id, deadline, retry_count, resolution_evidence, version,
         occurred_at, closure_path, provenance_kind, provenance_source,
         payment_intent_id, stripe_event_id, deferral_reason, psp_occurred_at, age_source
    FROM deferred_issuance_trace
   WHERE state IN (${sqlList(openStates("deferred_issuance_trace"))})
   ORDER BY occurred_at ASC, trace_id ASC
`

export const READ_DLQ_ENTRY_POPULATION_SQL = `
  SELECT population_id, instance_id, market_id, state,
         owner_type, owner_id, deadline, retry_count, resolution_evidence, version,
         occurred_at, closure_path, provenance_kind, provenance_source,
         tier, classification, failure_mode, sqlstate, is_retryable, reason, source_job
    FROM mor_policy_dlq_entry
   WHERE state IN (${sqlList(openStates("dlq_entry"))})
   ORDER BY occurred_at ASC, population_id ASC
`

type Raw = Record<string, unknown>

function iso(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) throw new Error(`niepoprawny znacznik czasu: ${String(value)}`)
  return d.toISOString()
}

function base(population: RecoveryPopulationType, r: Raw, payload: Record<string, unknown>): RecoveryPopulationRow {
  const id = String(r.population_id ?? "")
  const state = String(r.state ?? "")
  if (!Object.prototype.hasOwnProperty.call(RECOVERY_TRANSITIONS[population].allowed, state)) {
    throw new RecoveryPopulationShapeError(population, id, `stan "${state}" spoza słownika populacji`)
  }
  try {
    return {
      contract_version: RECOVERY_CONTRACT_VERSION,
      population_type: population,
      population_id: id,
      instance_id: String(r.instance_id),
      market_id: String(r.market_id),
      state,
      owner: { owner_type: String(r.owner_type), owner_id: String(r.owner_id) },
      deadline: iso(r.deadline),
      retry_count: Number(r.retry_count),
      resolution_evidence: (r.resolution_evidence as Record<string, unknown> | null) ?? null,
      version: Number(r.version),
      occurred_at: iso(r.occurred_at),
      closure_path: String(r.closure_path),
      provenance: { kind: String(r.provenance_kind), source: String(r.provenance_source) },
      payload,
    }
  } catch (err) {
    throw new RecoveryPopulationShapeError(population, id, (err as Error).message)
  }
}

export function mapCompensationFailureRow(r: Raw): RecoveryPopulationRow {
  return base("compensation_failure", r, {
    compensation_kind: r.compensation_kind,
    delivery_path: r.delivery_path,
    stripe_event_id: r.stripe_event_id,
    attempt_count: Number(r.attempt_count),
    order_id: (r.order_id as string | null) ?? null,
  })
}

export function mapDeferredIssuanceTraceRow(r: Raw): RecoveryPopulationRow {
  return base("deferred_issuance_trace", r, {
    payment_intent_id: r.payment_intent_id,
    stripe_event_id: r.stripe_event_id,
    deferral_reason: r.deferral_reason,
    psp_occurred_at: iso(r.psp_occurred_at),
    age_source: r.age_source,
  })
}

/**
 * Story 11.3 (DW-15-341 p.1): redakcja `reason` przy odczycie. Wiersze zapisane
 * przed redakcją writera (format `${err.name}: ${err.message}`) cytują wartość
 * wejścia. Zostają wyłącznie wiodące segmenty kodu (`[A-Za-z0-9_.-]`, separator
 * `:`) — dokładnie kształt `classifyEventFailure`; reszta = znacznik `redacted`.
 */
const DLQ_REASON_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/
export const DLQ_REASON_REDACTED_MARKER = "redacted" as const

export function redactDlqReason(reason: unknown): string {
  const raw = typeof reason === "string" ? reason : ""
  const kept: string[] = []
  for (const segment of raw.split(":")) {
    if (!DLQ_REASON_SEGMENT.test(segment)) break
    kept.push(segment)
  }
  if (kept.length === 0) return DLQ_REASON_REDACTED_MARKER
  const joined = kept.join(":")
  return joined.length === raw.length ? joined : `${joined}:${DLQ_REASON_REDACTED_MARKER}`
}

export function mapDlqEntryRow(r: Raw): RecoveryPopulationRow {
  return base("dlq_entry", r, {
    tier: r.tier,
    classification: r.classification,
    failure_mode: r.failure_mode,
    sqlstate: (r.sqlstate as string | null) ?? null,
    is_retryable: r.is_retryable === true,
    reason: redactDlqReason(r.reason),
    source_job: r.source_job,
  })
}

const READERS: Array<[RecoveryPopulationType, string, (r: Raw) => RecoveryPopulationRow]> = [
  ["compensation_failure", READ_COMPENSATION_FAILURE_POPULATION_SQL, mapCompensationFailureRow],
  ["deferred_issuance_trace", READ_DEFERRED_ISSUANCE_TRACE_POPULATION_SQL, mapDeferredIssuanceTraceRow],
  ["dlq_entry", READ_DLQ_ENTRY_POPULATION_SQL, mapDlqEntryRow],
]

/**
 * Odczyt trzech populacji JEDNEGO rynku. `query` MUSI być związany z tym samym
 * `{instance_id, market_id}` (w runtime: `queryUnderMarketContext`).
 */
export async function readRecoveryPopulations(
  query: RecoveryPopulationQuery,
  scope: { instance_id: string; market_id: string }
): Promise<RecoveryPopulationsResult> {
  const populations = {
    compensation_failure: [],
    deferred_issuance_trace: [],
    dlq_entry: [],
  } as Record<RecoveryPopulationType, RecoveryPopulationRow[]>
  for (const [type, sql, map] of READERS) {
    const { rows } = await query<Raw>(sql, [])
    for (const raw of rows) {
      const row = map(raw)
      if (row.instance_id !== scope.instance_id || row.market_id !== scope.market_id) {
        throw new RecoveryPopulationScopeViolationError(type, row.population_id)
      }
      populations[type].push(row)
    }
  }
  return { instance_id: scope.instance_id, market_id: scope.market_id, populations }
}
