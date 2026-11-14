/**
 * recovery-population-adapters.ts — v1.16.0 Story 4.3 AC1 (FR-11, AD-32, AD-48, NFR-4).
 *
 * Rejestr TYPOWANYCH adapterów populacji kontraktu recovery
 * (`RecoveryPopulationType` z `recovery-action-contract.ts`). Adapter niesie:
 *  - `loader` — odczyt wierszy po terminie pod kontekstem rynku (RLS),
 *  - `deadlineOf` — termin wiersza (z kolumny `deadline`, nie z aplikacji),
 *  - `alarmCode` + `toAlarm` — nazwany wynik alarmu z bezpiecznym identyfikatorem.
 *
 * W 4.3 zarejestrowana jest WYŁĄCZNIE populacja `compensation_failure`
 * (tabela 4.2). Integracja `deferred_issuance_trace` i `dlq_entry` należy do
 * Story 11.3 i nie jest zaliczona samym ukończeniem 4.3.
 *
 * Brak adaptera dla wymaganej populacji = `RecoveryPopulationAdapterMissingError`
 * z kodem `RECOVERY_POPULATION_ADAPTER_MISSING` PRZY STARCIE przebiegu
 * schedulera (fail-loud), zanim cokolwiek zostanie odczytane.
 */
import type { TraceQueryClient } from "./deferred-issuance-trace"
import {
  RECOVERY_TRANSITIONS,
  type RecoveryOwner,
  type RecoveryPopulationType,
} from "./recovery-action-contract"

export const RECOVERY_POPULATION_ADAPTER_MISSING = "RECOVERY_POPULATION_ADAPTER_MISSING" as const

export type RecoveryAlarm = {
  population_type: RecoveryPopulationType
  /** Bezpieczny identyfikator wiersza (klucz techniczny, bez PII). */
  failure_id: string
  instance_id: string
  market_id: string
  owner_type: RecoveryOwner["owner_type"]
  owner_id: string
  deadline: string
  state: string
}

export type RecoveryPopulationAdapter<Row = unknown> = {
  population_type: RecoveryPopulationType
  alarmCode: string
  loader: (client: TraceQueryClient) => Promise<Row[]>
  deadlineOf: (row: Row) => string
  toAlarm: (row: Row) => RecoveryAlarm
}

export class RecoveryPopulationAdapterMissingError extends Error {
  readonly code = RECOVERY_POPULATION_ADAPTER_MISSING
  constructor(readonly missing: RecoveryPopulationType[]) {
    super(`[recovery-population-adapters] ${RECOVERY_POPULATION_ADAPTER_MISSING}: brak adaptera dla ${missing.join(",")}`)
    this.name = "RecoveryPopulationAdapterMissingError"
  }
}

export type RecoveryPopulationAdapterRegistry = ReadonlyMap<RecoveryPopulationType, RecoveryPopulationAdapter>

export function createRecoveryPopulationAdapterRegistry(
  adapters: ReadonlyArray<RecoveryPopulationAdapter<any>>
): RecoveryPopulationAdapterRegistry {
  const registry = new Map<RecoveryPopulationType, RecoveryPopulationAdapter>()
  for (const adapter of adapters) {
    if (registry.has(adapter.population_type)) {
      throw new Error(`[recovery-population-adapters] podwójna rejestracja ${adapter.population_type}`)
    }
    registry.set(adapter.population_type, adapter)
  }
  return registry
}

/** Fail-loud przy starcie: każda wymagana populacja ma adapter. */
export function assertRecoveryPopulationAdapters(
  registry: RecoveryPopulationAdapterRegistry,
  required: ReadonlyArray<RecoveryPopulationType>
): void {
  const missing = required.filter((p) => !registry.has(p))
  if (missing.length > 0) throw new RecoveryPopulationAdapterMissingError(missing)
}

// ── compensation_failure (tabela 4.2) ──────────────────────────────────────

/** Stany nieterminalne kontraktu 4.1 (klucze `allowed` minus `terminal`). */
export const COMPENSATION_FAILURE_ALARMABLE_STATES: readonly string[] = Object.keys(
  RECOVERY_TRANSITIONS.compensation_failure.allowed
).filter((s) => !RECOVERY_TRANSITIONS.compensation_failure.terminal.includes(s))

export const ALERT_CODE_COMPENSATION_FAILURE_OVERDUE = "RECOVERY_COMPENSATION_FAILURE_OVERDUE" as const

/**
 * Termin porównuje BAZA (`statement_timestamp()`); jedyny binding to lista
 * stanów nieterminalnych. Zakres rynku/instancji daje RLS `market_isolation`.
 */
export const LIST_OVERDUE_COMPENSATION_FAILURES_SQL = `
  SELECT failure_id, instance_id, market_id, owner_type, owner_id,
         deadline, resolution_state
    FROM money_path_compensation_failure
   WHERE resolution_state = ANY($1::text[])
     AND deadline < statement_timestamp()
   ORDER BY deadline ASC, failure_id ASC
`

export type OverdueCompensationFailureRow = {
  failure_id: string
  instance_id: string
  market_id: string
  owner_type: RecoveryOwner["owner_type"]
  owner_id: string
  deadline: string | Date
  resolution_state: string
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export const COMPENSATION_FAILURE_ADAPTER: RecoveryPopulationAdapter<OverdueCompensationFailureRow> = {
  population_type: "compensation_failure",
  alarmCode: ALERT_CODE_COMPENSATION_FAILURE_OVERDUE,
  loader: async (client) => {
    const result = await client.query<OverdueCompensationFailureRow>(LIST_OVERDUE_COMPENSATION_FAILURES_SQL, [
      [...COMPENSATION_FAILURE_ALARMABLE_STATES],
    ])
    return result.rows
  },
  deadlineOf: (row) => toIso(row.deadline),
  toAlarm: (row) => ({
    population_type: "compensation_failure",
    failure_id: row.failure_id,
    instance_id: row.instance_id,
    market_id: row.market_id,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    deadline: toIso(row.deadline),
    state: row.resolution_state,
  }),
}

/** Populacje, których adapter MUSI istnieć, żeby scheduler 4.3 wystartował. */
export const COMPENSATION_ALARM_REQUIRED_POPULATIONS: readonly RecoveryPopulationType[] = ["compensation_failure"]

export const DEFAULT_RECOVERY_POPULATION_ADAPTERS = createRecoveryPopulationAdapterRegistry([
  COMPENSATION_FAILURE_ADAPTER,
])
