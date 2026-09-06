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
import type {
  RecoveryOwner,
  RecoveryPopulationType,
  ResolutionEvidence,
  SessionActor,
} from "./recovery-action-contract"

/** Jawnie nazwane źródło odwzorowania market_id -> instance_id dla backfillu. */
export const INSTANCE_ID_BACKFILL_SOURCE =
  "specs/contracts/config/fixtures/markets/<market_id>.yaml#instance_id" as const

/**
 * Jedyny dopuszczalny nośnik brakujących faktów historycznych. Eksport jest
 * tworzony i podpisywany przed migracją przez operatora; nie jest stałą w SQL.
 * Bez wpisu dla konkretnego failure_id rekord idzie do kwarantanny.
 */
export const COMPENSATION_BACKFILL_PROVENANCE_SOURCE =
  "operator-certified/recovery-compensation-provenance.v1#failure_id" as const

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
      {
        id: "cf-backfill",
        sql_shape: `BEGIN; WITH qualified AS (SELECT c.failure_id, m.instance_id, p.owner_type, p.owner_id, p.deadline, p.legacy_resolver FROM ${COMPENSATION_FAILURE_TABLE} c JOIN <verified instance mapping by market_id: ${INSTANCE_ID_BACKFILL_SOURCE}> m ON m.market_id=c.market_id JOIN <operator-certified per-failure provenance: ${COMPENSATION_BACKFILL_PROVENANCE_SOURCE}> p ON p.failure_id=c.failure_id WHERE m.instance_id IS NOT NULL AND btrim(m.instance_id) <> '' AND lower(btrim(m.instance_id)) NOT IN ('unknown','default','null','none','n/a','tbd','todo','unassigned') AND p.owner_type IN ('operator_role','operator_user') AND btrim(p.owner_id) <> '' AND lower(btrim(p.owner_id)) NOT IN ('unknown','default','null','none','n/a','tbd','todo','unassigned') AND p.deadline IS NOT NULL AND p.deadline::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' AND (c.resolution_state <> 'resolved_manually' OR (c.resolved_by IS NOT NULL AND c.resolved_at IS NOT NULL AND c.resolved_at::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' AND jsonb_typeof(p.legacy_resolver)='object' AND p.legacy_resolver->>'actor_type'='user' AND btrim(coalesce(p.legacy_resolver->>'actor_id','')) <> '' AND lower(btrim(p.legacy_resolver->>'actor_id')) NOT IN ('unknown','default','null','none','n/a','tbd','todo','unassigned') AND p.legacy_resolver->>'actor_id'=c.resolved_by AND p.legacy_resolver->>'session_source'='medusa_admin_session'))), quarantined AS (INSERT INTO ${COMPENSATION_FAILURE_TABLE}_backfill_quarantine (source_failure_id, source_row, reason) SELECT c.failure_id, to_jsonb(c), 'missing certified scope, owner, deadline, or legacy resolver evidence' FROM ${COMPENSATION_FAILURE_TABLE} c LEFT JOIN qualified q ON q.failure_id=c.failure_id WHERE q.failure_id IS NULL RETURNING source_failure_id), removed AS (DELETE FROM ${COMPENSATION_FAILURE_TABLE} c USING quarantined q WHERE c.failure_id=q.source_failure_id RETURNING c.failure_id) UPDATE ${COMPENSATION_FAILURE_TABLE} c SET instance_id=q.instance_id, owner_type=q.owner_type, owner_id=q.owner_id, deadline=q.deadline, closure_path=CASE c.resolution_state WHEN 'open' THEN 'not_closed' ELSE 'operator_action' END, provenance_kind='backfilled_verified', provenance_source='${COMPENSATION_BACKFILL_PROVENANCE_SOURCE}' FROM qualified q WHERE c.failure_id=q.failure_id; COMMIT; -- kwalifikacja SQL powtarza pełną walidację certyfikowanych faktów; kwarantanna jest atomowym PRZENIESIENIEM (INSERT + DELETE), nie kopią pozostawiającą NULL-e`,
      },
      {
        id: "cf-remap-legacy-resolved",
        sql_shape: `UPDATE ${COMPENSATION_FAILURE_TABLE} c SET resolution_state='closed_legacy_unevidenced', resolution_evidence=jsonb_build_object('kind','legacy_manual_resolution','reference','money_path_compensation_failure.resolved_by=' || c.resolved_by || '@' || c.resolved_at,'recorded_at',c.resolved_at,'recorded_by',q.legacy_resolver) FROM <operator-certified per-failure provenance: ${COMPENSATION_BACKFILL_PROVENANCE_SOURCE}> q WHERE c.failure_id=q.failure_id AND c.resolution_state='resolved_manually' AND q.owner_type IN ('operator_role','operator_user') AND btrim(q.owner_id) <> '' AND lower(btrim(q.owner_id)) NOT IN ('unknown','default','null','none','n/a','tbd','todo','unassigned') AND q.deadline IS NOT NULL AND q.deadline::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' AND c.resolved_by IS NOT NULL AND c.resolved_at IS NOT NULL AND c.resolved_at::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' AND jsonb_typeof(q.legacy_resolver)='object' AND q.legacy_resolver->>'actor_type'='user' AND btrim(coalesce(q.legacy_resolver->>'actor_id','')) <> '' AND lower(btrim(q.legacy_resolver->>'actor_id')) NOT IN ('unknown','default','null','none','n/a','tbd','todo','unassigned') AND q.legacy_resolver->>'actor_id'=c.resolved_by AND q.legacy_resolver->>'session_source'='medusa_admin_session' -- wiersz bez wszystkich certyfikowanych faktów został wcześniej przeniesiony do kwarantanny`,
      },
      { id: "cf-set-not-null", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} ALTER COLUMN instance_id SET NOT NULL, ALTER COLUMN owner_type SET NOT NULL, ALTER COLUMN owner_id SET NOT NULL, ALTER COLUMN deadline SET NOT NULL, ALTER COLUMN closure_path SET NOT NULL, ALTER COLUMN provenance_kind SET NOT NULL, ALTER COLUMN provenance_source SET NOT NULL -- PRECONDITION: count(*) WHERE instance_id IS NULL OR owner_id IS NULL OR deadline IS NULL OR closure_path IS NULL OR provenance_kind IS NULL OR provenance_source IS NULL = 0; wiersze bez faktów są atomowo przeniesione do ${COMPENSATION_FAILURE_TABLE}_backfill_quarantine przed tym krokiem` },
    ],
    down: [
      { id: "cf-unset-not-null", reverses: "cf-set-not-null", sql_shape: `ALTER TABLE ${COMPENSATION_FAILURE_TABLE} ALTER COLUMN instance_id DROP NOT NULL, ... (wszystkie kolumny z cf-set-not-null)` },
      { id: "cf-unmap-legacy-resolved", reverses: "cf-remap-legacy-resolved", sql_shape: `UPDATE ${COMPENSATION_FAILURE_TABLE} SET resolution_state='resolved_manually', resolution_evidence=NULL WHERE resolution_state='closed_legacy_unevidenced'` },
      { id: "cf-unbackfill", reverses: "cf-backfill", sql_shape: `INSERT INTO ${COMPENSATION_FAILURE_TABLE} SELECT (jsonb_populate_record(NULL::${COMPENSATION_FAILURE_TABLE}, source_row)).* FROM ${COMPENSATION_FAILURE_TABLE}_backfill_quarantine ON CONFLICT (failure_id) DO NOTHING; UPDATE ${COMPENSATION_FAILURE_TABLE} SET instance_id=NULL, owner_type=NULL, owner_id=NULL, deadline=NULL, closure_path=NULL, provenance_kind=NULL, provenance_source=NULL, resolution_evidence=NULL WHERE provenance_source='${COMPENSATION_BACKFILL_PROVENANCE_SOURCE}' -- najpierw odtwarza source rows przeniesione do kwarantanny, potem cofa tylko zweryfikowany backfill` },
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

/**
 * Fakty historyczne NIEOBECNE w money_path_compensation_failure. Wartości są
 * dopuszczalne tylko, jeśli pochodzą z audytowalnego eksportu per failure_id;
 * stały owner `ops-recovery` i termin wyliczony z created_at są zakazane.
 */
export type VerifiedHistoricalCompensationMetadata = {
  owner: RecoveryOwner
  deadline: string
  /** Pełny aktor odtworzony z wiarygodnego źródła tożsamości, nie z samego stringa resolved_by. */
  legacy_resolver: SessionActor | null
}

export type BackfillDecision =
  | {
      decision: "migrate"
      instance_id: string
      state: string
      owner: RecoveryOwner
      deadline: string
      provenance: { kind: "backfilled_verified"; source: typeof INSTANCE_ID_BACKFILL_SOURCE }
      resolution_evidence: ResolutionEvidence | null
    }
  | { decision: "quarantine"; reason: string }

/**
 * Reguła backfillu wiersza kompensacji. `instance_id` może przyjść wyłącznie z
 * nazwanej mapy market→instance; owner, deadline i — dla legacy — pełny aktor
 * dowodu muszą przyjść z audytowalnych metadanych per `failure_id`. Brak dowolnego
 * faktu = kwarantanna, NIGDY wartość zastępcza. Funkcja nie przyjmuje
 * defaultInstanceId/defaultOwner ani defaultDeadline — taki parametr byłby
 * fałszywym backfillem.
 */
export function classifyHistoricalCompensationRow(
  row: HistoricalCompensationRow,
  instanceByMarket: ReadonlyMap<string, string>,
  metadataByFailureId: ReadonlyMap<string, VerifiedHistoricalCompensationMetadata>
): BackfillDecision {
  const metadata = metadataByFailureId.get(row.failure_id)
  if (!metadata) {
    return { decision: "quarantine", reason: `brak audytowalnych metadanych dla failure_id="${row.failure_id}"` }
  }
  const instanceId = instanceByMarket.get(row.market_id)
  if (!instanceId || !isTrustworthyScopeValue(instanceId) || !isTrustworthyScopeValue(row.market_id)) {
    return { decision: "quarantine", reason: `brak wiarygodnego scope'u dla failure_id="${row.failure_id}"` }
  }
  if (!isTrustworthyOwner(metadata.owner)) {
    return { decision: "quarantine", reason: `brak wiarygodnego ownera dla failure_id="${row.failure_id}"` }
  }
  if (!isRfc3339Timestamp(metadata.deadline)) {
    return { decision: "quarantine", reason: `brak wiarygodnego deadline dla failure_id="${row.failure_id}"` }
  }
  if (row.resolution_state === "open") {
    return {
      decision: "migrate",
      instance_id: instanceId,
      state: "open",
      owner: metadata.owner,
      deadline: metadata.deadline,
      provenance: { kind: "backfilled_verified", source: INSTANCE_ID_BACKFILL_SOURCE },
      resolution_evidence: null,
    }
  }
  if (row.resolution_state === "resolved_manually") {
    const resolver = metadata.legacy_resolver
    if (
      !row.resolved_by ||
      !row.resolved_at ||
      !isRfc3339Timestamp(row.resolved_at) ||
      !resolver ||
      !isSessionActor(resolver) ||
      resolver.actor_id !== row.resolved_by
    ) {
      return { decision: "quarantine", reason: "resolved_manually bez zweryfikowanego resolved_by/resolved_at/recorded_by — brak dowodu legacy" }
    }
    return {
      decision: "migrate",
      instance_id: instanceId,
      state: "closed_legacy_unevidenced",
      owner: metadata.owner,
      deadline: metadata.deadline,
      provenance: { kind: "backfilled_verified", source: INSTANCE_ID_BACKFILL_SOURCE },
      resolution_evidence: {
        kind: "legacy_manual_resolution",
        reference: `${COMPENSATION_FAILURE_TABLE}.resolved_by=${row.resolved_by}@${row.resolved_at}`,
        recorded_at: row.resolved_at,
        recorded_by: resolver,
      },
    }
  }
  return { decision: "quarantine", reason: `nieznany resolution_state="${String(row.resolution_state)}"` }
}

export type CompensationBackfillMaterialization = {
  migrated: Extract<BackfillDecision, { decision: "migrate" }>[]
  quarantine: Extract<BackfillDecision, { decision: "quarantine" }>[]
  /** Wiersze źródłowe po atomowym INSERT do kwarantanny + DELETE ze źródła. */
  source_rows_after: (HistoricalCompensationRow & {
    instance_id: string
    owner: RecoveryOwner
    deadline: string
    resolution_evidence: ResolutionEvidence | null
  })[]
}

/** Model danych kroku SQL `cf-backfill`, używany przez test kontraktu migracji. */
export function materializeCompensationBackfill(
  rows: readonly HistoricalCompensationRow[],
  instanceByMarket: ReadonlyMap<string, string>,
  metadataByFailureId: ReadonlyMap<string, VerifiedHistoricalCompensationMetadata>
): CompensationBackfillMaterialization {
  const migrated: Extract<BackfillDecision, { decision: "migrate" }>[] = []
  const quarantine: Extract<BackfillDecision, { decision: "quarantine" }>[] = []
  const source_rows_after: CompensationBackfillMaterialization["source_rows_after"] = []
  for (const row of rows) {
    const decision = classifyHistoricalCompensationRow(row, instanceByMarket, metadataByFailureId)
    if (decision.decision === "migrate") {
      migrated.push(decision)
      source_rows_after.push({
        ...row,
        instance_id: decision.instance_id,
        owner: decision.owner,
        deadline: decision.deadline,
        resolution_evidence: decision.resolution_evidence,
      })
    } else {
      quarantine.push(decision)
    }
  }
  // Krok SQL przetwarza każdy istniejący wiersz: kwalifikujący się zostaje
  // zaktualizowany, a każdy niekwalifikujący przeniesiony do kwarantanny. Żaden
  // source row bez wymaganych faktów nie zostaje przed SET NOT NULL.
  return { migrated, quarantine, source_rows_after }
}

const PLACEHOLDER_SCOPE_VALUES = new Set(["unknown", "default", "null", "none", "n/a", "tbd", "todo", "unassigned", ""])

export function isTrustworthyScopeValue(value: string): boolean {
  return !PLACEHOLDER_SCOPE_VALUES.has(value.trim().toLowerCase())
}

export function isTrustworthyOwner(owner: RecoveryOwner): boolean {
  return (owner.owner_type === "operator_role" || owner.owner_type === "operator_user") && isTrustworthyScopeValue(owner.owner_id)
}

const RFC3339_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/

export function isRfc3339Timestamp(value: string): boolean {
  return RFC3339_TIMESTAMP.test(value)
}

function isSessionActor(actor: SessionActor): boolean {
  return actor.actor_type === "user" && isTrustworthyScopeValue(actor.actor_id) && actor.session_source === "medusa_admin_session"
}
