/**
 * recovery-migration-plan.ts — v1.16.0 Story 4.1 (AD-32, AD-44; ADR-221 §5).
 *
 * PLAN migracji trzech nośników populacji recovery jako DANE. Nie jest migracją
 * MikroORM i nie wykonuje SQL — wykonanie należy do Stories 4.2/4.4/4.6. Ten
 * moduł istnieje, żeby plan z ADR-221 miał egzekwowalny nośnik:
 *
 *  - trzy nośniki są trzema różnymi tabelami (żadna populacja nie jest scalana),
 *  - każdy krok `up` ma odwrotny krok `down` (plan jest symetryczny),
 *  - NOT NULL obowiązuje NOWE dane; dla historycznych `SET NOT NULL` dopiero po
 *    backfillu, którego reguła nie zna wartości zastępczej — wiersz bez wiarygodnej
 *    proweniencji idzie do kwarantanny per nośnik,
 *  - backfill DLQ jest jawnie PUSTY (dzisiejsza klasyfikacja nie ma nośnika trwałego).
 *
 * Test `__tests__/migrations/recovery-populations-contract.unit.spec.ts` sprawdza
 * te własności i porównuje bazę planu z REALNĄ migracją
 * `Migration20260818090000MoneyPathCompensationFailureTable` (RecordingMigration).
 */
import type { RecoveryPopulationType } from "./recovery-action-contract"

/** Jawnie nazwane źródło odwzorowania market_id -> instance_id dla backfillu. */
export const INSTANCE_ID_BACKFILL_SOURCE =
  "specs/contracts/config/fixtures/markets/<market_id>.yaml#instance_id" as const

export type MigrationStep = {
  /** Identyfikator kroku; `down` odwołuje się do niego przez `reverses`. */
  id: string
  sql_shape: string
}

export type DownStep = MigrationStep & { reverses: string }

export type BackfillRule =
  | {
      kind: "none"
      reason: string
    }
  | {
      kind: "from_verified_source"
      source_table: string
      scope_source: typeof INSTANCE_ID_BACKFILL_SOURCE
      state_mapping: Record<string, string>
      on_unresolved_provenance: "quarantine"
      quarantine_table: string
      /** Celowo brak pola `default_value` — jego obecność jest fałszywym backfillem. */
    }

export type CarrierPlan = {
  population_type: RecoveryPopulationType
  table: string
  kind: "alter_existing" | "create_new"
  /** Kolumny, które MUSZĄ być NOT NULL dla nowych danych od pierwszego producenta. */
  not_null_for_new_data: readonly string[]
  /** Kolumny z wartością domyślną i RACJA — tylko liczniki, nigdy scope/stan/owner. */
  semantic_defaults: readonly { column: string; default: string; reason: string }[]
  up: readonly MigrationStep[]
  down: readonly DownStep[]
  backfill: BackfillRule
}

const COMMON_ROW_COLUMNS = [
  "instance_id",
  "market_id",
  "state",
  "owner_type",
  "owner_id",
  "deadline",
  "retry_count",
  "version",
  "occurred_at",
  "closure_path",
  "provenance_kind",
  "provenance_source",
] as const

const COMMON_SEMANTIC_DEFAULTS = [
  { column: "retry_count", default: "0", reason: "zero prób odzysku to fakt o nowym wierszu, nie wartość zastępcza" },
  { column: "version", default: "1", reason: "pierwsza wersja rekordu; kontrola współbieżności startuje od 1" },
] as const

export const COMPENSATION_FAILURE_TABLE = "money_path_compensation_failure" as const
export const DEFERRED_ISSUANCE_TRACE_TABLE = "deferred_issuance_trace" as const
export const DLQ_ENTRY_TABLE = "mor_policy_dlq_entry" as const

/** Słownik CHECK-a `resolution_state` w REALNEJ migracji 20260818090000 (baza planu). */
export const LEGACY_COMPENSATION_STATES = ["open", "resolved_manually"] as const

export const RECOVERY_MIGRATION_PLAN: readonly CarrierPlan[] = [
  {
    population_type: "compensation_failure",
    table: COMPENSATION_FAILURE_TABLE,
    kind: "alter_existing",
    not_null_for_new_data: [...COMMON_ROW_COLUMNS],
    semantic_defaults: [...COMMON_SEMANTIC_DEFAULTS],
    up: [
      { id: "cf-add-columns", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} ADD COLUMN instance_id TEXT, ADD COLUMN owner_type TEXT, ADD COLUMN owner_id TEXT, ADD COLUMN deadline TIMESTAMPTZ, ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0, ADD COLUMN version INTEGER NOT NULL DEFAULT 1, ADD COLUMN closure_path TEXT, ADD COLUMN resolution_evidence JSONB, ADD COLUMN provenance_kind TEXT, ADD COLUMN provenance_source TEXT` },
      { id: "cf-widen-state-check", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} DROP CONSTRAINT money_path_compensation_failure_resolution_state_check, ADD CONSTRAINT money_path_compensation_failure_resolution_state_check CHECK (resolution_state IN ('open','recovery_in_progress','resolved_recovered','closed_unrecoverable','closed_legacy_unevidenced'))` },
      { id: "cf-create-quarantine", sql_shape: `CREATE TABLE ${COMPENSATION_FAILURE_TABLE}_backfill_quarantine (source_failure_id TEXT PRIMARY KEY, source_row JSONB NOT NULL, reason TEXT NOT NULL, quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
      { id: "cf-backfill", sql_shape: `UPDATE ${COMPENSATION_FAILURE_TABLE} SET instance_id = <verified source by market_id>, owner_type='operator_role', owner_id='ops-recovery', deadline = created_at + interval '24 hours', closure_path = CASE resolution_state WHEN 'open' THEN 'not_closed' ELSE 'operator_action' END, provenance_kind='backfilled_verified', provenance_source='${INSTANCE_ID_BACKFILL_SOURCE}'; rows without mapping -> INSERT INTO ${COMPENSATION_FAILURE_TABLE}_backfill_quarantine` },
      { id: "cf-remap-legacy-resolved", sql_shape: `UPDATE ${COMPENSATION_FAILURE_TABLE} SET resolution_state='closed_legacy_unevidenced', resolution_evidence = jsonb_build_object('kind','legacy_manual_resolution','reference', 'money_path_compensation_failure.resolved_by=' || resolved_by || '@' || resolved_at) WHERE resolution_state='resolved_manually'` },
      { id: "cf-set-not-null", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} ALTER COLUMN instance_id SET NOT NULL, ALTER COLUMN owner_type SET NOT NULL, ALTER COLUMN owner_id SET NOT NULL, ALTER COLUMN deadline SET NOT NULL, ALTER COLUMN closure_path SET NOT NULL, ALTER COLUMN provenance_kind SET NOT NULL, ALTER COLUMN provenance_source SET NOT NULL -- PRECONDITION: count(*) WHERE instance_id IS NULL = 0` },
    ],
    down: [
      { id: "cf-unset-not-null", reverses: "cf-set-not-null", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} ALTER COLUMN instance_id DROP NOT NULL, ... (wszystkie kolumny z cf-set-not-null)` },
      { id: "cf-unmap-legacy-resolved", reverses: "cf-remap-legacy-resolved", sql_shape: `UPDATE ${COMPENSATION_FAILURE_TABLE} SET resolution_state='resolved_manually', resolution_evidence=NULL WHERE resolution_state='closed_legacy_unevidenced'` },
      { id: "cf-unbackfill", reverses: "cf-backfill", sql_shape: `UPDATE ${COMPENSATION_FAILURE_TABLE} SET instance_id=NULL, owner_type=NULL, owner_id=NULL, deadline=NULL, closure_path=NULL, provenance_kind=NULL, provenance_source=NULL` },
      { id: "cf-drop-quarantine", reverses: "cf-create-quarantine", sql_shape: `DROP TABLE IF EXISTS ${COMPENSATION_FAILURE_TABLE}_backfill_quarantine` },
      { id: "cf-restore-state-check", reverses: "cf-widen-state-check", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} DROP CONSTRAINT money_path_compensation_failure_resolution_state_check, ADD CONSTRAINT money_path_compensation_failure_resolution_state_check CHECK (resolution_state IN ('open','resolved_manually'))` },
      { id: "cf-drop-columns", reverses: "cf-add-columns", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} DROP COLUMN instance_id, DROP COLUMN owner_type, DROP COLUMN owner_id, DROP COLUMN deadline, DROP COLUMN retry_count, DROP COLUMN version, DROP COLUMN closure_path, DROP COLUMN resolution_evidence, DROP COLUMN provenance_kind, DROP COLUMN provenance_source` },
    ],
    backfill: {
      kind: "from_verified_source",
      source_table: COMPENSATION_FAILURE_TABLE,
      scope_source: INSTANCE_ID_BACKFILL_SOURCE,
      state_mapping: { open: "open", resolved_manually: "closed_legacy_unevidenced" },
      on_unresolved_provenance: "quarantine",
      quarantine_table: `${COMPENSATION_FAILURE_TABLE}_backfill_quarantine`,
    },
  },
  {
    population_type: "deferred_issuance_trace",
    table: DEFERRED_ISSUANCE_TRACE_TABLE,
    kind: "create_new",
    not_null_for_new_data: [...COMMON_ROW_COLUMNS, "payment_intent_id", "stripe_event_id", "psp_occurred_at"],
    semantic_defaults: [...COMMON_SEMANTIC_DEFAULTS],
    up: [
      { id: "dit-create-table", sql_shape: `CREATE TABLE ${DEFERRED_ISSUANCE_TRACE_TABLE} (trace_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, market_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('awaiting_order','escalated','issued_after_link','closed_order_never_created')), owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, deadline TIMESTAMPTZ NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, occurred_at TIMESTAMPTZ NOT NULL, closure_path TEXT NOT NULL, resolution_evidence JSONB, provenance_kind TEXT NOT NULL, provenance_source TEXT NOT NULL, payment_intent_id TEXT NOT NULL, stripe_event_id TEXT NOT NULL, psp_occurred_at TIMESTAMPTZ NOT NULL)` },
      { id: "dit-create-quarantine", sql_shape: `CREATE TABLE ${DEFERRED_ISSUANCE_TRACE_TABLE}_backfill_quarantine (source_event_id TEXT PRIMARY KEY, source_row JSONB NOT NULL, reason TEXT NOT NULL, quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now())` },
      { id: "dit-backfill", sql_shape: `INSERT INTO ${DEFERRED_ISSUANCE_TRACE_TABLE} SELECT ... FROM webhook_event_processed WHERE event_id LIKE '%#deferred-issuance' AND <market_id has verified instance mapping>; rows without mapping -> INSERT INTO ${DEFERRED_ISSUANCE_TRACE_TABLE}_backfill_quarantine` },
    ],
    down: [
      { id: "dit-unbackfill", reverses: "dit-backfill", sql_shape: `-- brak kroku danych: źródło (webhook_event_processed) pozostaje nietknięte, DROP tabeli wystarcza` },
      { id: "dit-drop-quarantine", reverses: "dit-create-quarantine", sql_shape: `DROP TABLE IF EXISTS ${DEFERRED_ISSUANCE_TRACE_TABLE}_backfill_quarantine` },
      { id: "dit-drop-table", reverses: "dit-create-table", sql_shape: `DROP TABLE IF EXISTS ${DEFERRED_ISSUANCE_TRACE_TABLE}` },
    ],
    backfill: {
      kind: "from_verified_source",
      source_table: "webhook_event_processed",
      scope_source: INSTANCE_ID_BACKFILL_SOURCE,
      state_mapping: { "#deferred-issuance": "awaiting_order" },
      on_unresolved_provenance: "quarantine",
      quarantine_table: `${DEFERRED_ISSUANCE_TRACE_TABLE}_backfill_quarantine`,
    },
  },
  {
    population_type: "dlq_entry",
    table: DLQ_ENTRY_TABLE,
    kind: "create_new",
    not_null_for_new_data: [...COMMON_ROW_COLUMNS, "tier", "classification", "failure_mode", "is_retryable", "reason", "source_job"],
    semantic_defaults: [...COMMON_SEMANTIC_DEFAULTS],
    up: [
      { id: "dlq-create-table", sql_shape: `CREATE TABLE ${DLQ_ENTRY_TABLE} (dlq_entry_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, market_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('dlq_pending_retry','dlq_pending_ops_review','replayed','discarded_with_evidence')), owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, deadline TIMESTAMPTZ NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, occurred_at TIMESTAMPTZ NOT NULL, closure_path TEXT NOT NULL, resolution_evidence JSONB, provenance_kind TEXT NOT NULL, provenance_source TEXT NOT NULL, tier TEXT NOT NULL, classification TEXT NOT NULL CHECK (classification IN ('retryable','terminal')), failure_mode TEXT NOT NULL, sqlstate TEXT, is_retryable BOOLEAN NOT NULL, reason TEXT NOT NULL, source_job TEXT NOT NULL)` },
    ],
    down: [{ id: "dlq-drop-table", reverses: "dlq-create-table", sql_shape: `DROP TABLE IF EXISTS ${DLQ_ENTRY_TABLE}` }],
    backfill: {
      kind: "none",
      reason: "klasyfikacja DLQ (modules/mor-policy/dlq.ts) nie ma dziś nośnika trwałego — nie ma czego przenosić; backfill jest jawnie pusty, nie domyślny",
    },
  },
]

export type HistoricalCompensationRow = {
  failure_id: string
  market_id: string
  resolution_state: (typeof LEGACY_COMPENSATION_STATES)[number]
  resolved_by: string | null
  resolved_at: string | null
}

export type BackfillDecision =
  | {
      decision: "migrate"
      instance_id: string
      state: string
      provenance: { kind: "backfilled_verified"; source: typeof INSTANCE_ID_BACKFILL_SOURCE }
      resolution_evidence_kind: "legacy_manual_resolution" | null
    }
  | { decision: "quarantine"; reason: string }

/**
 * Reguła backfillu wiersza kompensacji. `instanceByMarket` to odwzorowanie z JAWNIE
 * nazwanego źródła (INSTANCE_ID_BACKFILL_SOURCE). Brak odwzorowania = kwarantanna,
 * NIGDY wartość zastępcza. Funkcja nie przyjmuje `defaultInstanceId` — taki parametr
 * byłby fałszywym backfillem.
 */
export function classifyHistoricalCompensationRow(
  row: HistoricalCompensationRow,
  instanceByMarket: ReadonlyMap<string, string>
): BackfillDecision {
  const instance = instanceByMarket.get(row.market_id)
  if (!instance || !isTrustworthyScopeValue(instance)) {
    return { decision: "quarantine", reason: `brak wiarygodnego instance_id dla market_id="${row.market_id}"` }
  }
  if (!isTrustworthyScopeValue(row.market_id)) {
    return { decision: "quarantine", reason: `market_id="${row.market_id}" jest wartością zastępczą` }
  }
  if (row.resolution_state === "open") {
    return {
      decision: "migrate",
      instance_id: instance,
      state: "open",
      provenance: { kind: "backfilled_verified", source: INSTANCE_ID_BACKFILL_SOURCE },
      resolution_evidence_kind: null,
    }
  }
  if (row.resolution_state === "resolved_manually") {
    if (!row.resolved_by || !row.resolved_at) {
      return { decision: "quarantine", reason: "resolved_manually bez resolved_by/resolved_at — brak nawet dowodu legacy" }
    }
    return {
      decision: "migrate",
      instance_id: instance,
      state: "closed_legacy_unevidenced",
      provenance: { kind: "backfilled_verified", source: INSTANCE_ID_BACKFILL_SOURCE },
      resolution_evidence_kind: "legacy_manual_resolution",
    }
  }
  return { decision: "quarantine", reason: `nieznany resolution_state="${String(row.resolution_state)}"` }
}

const PLACEHOLDER_SCOPE_VALUES = new Set(["unknown", "default", "null", "none", "n/a", "tbd", "todo", ""])

export function isTrustworthyScopeValue(value: string): boolean {
  return !PLACEHOLDER_SCOPE_VALUES.has(value.trim().toLowerCase())
}
