/**
 * recovery-action-runtime.ts — v1.16.0 Story 11.3 (FR-11, FR-12, FR-14, AD-31, AD-47,
 * AD-48, AD-49, NFR-3; D-37; DW-15-252).
 *
 * Trwałe adaptery kernela `applyRecoveryIntent` (Story 4.1) dla trzech populacji
 * oraz dwukrokowa akcja D-37: `propose` → `approve` tego samego aktora, z osobnymi
 * kluczami idempotencji (`propose:<klucz intencji>`, `approve:<klucz intencji>`)
 * i wierszem audytu dla KAŻDEGO kroku (także odmowy i powtórki) w
 * `recovery_action_step` (append-only, RLS `market_isolation`).
 *
 * Wszystkie reguły domenowe mieszkają tutaj (backend), nie w CLI (Story 11.4):
 * dozwolona para retry/resolve per populacja, stan docelowy, rodzaj evidence,
 * wiązanie evidence z wierszem, aktor z sesji, rynek z uprawnień aktora.
 *
 *  - `RecoveryRecordStore` (DB): odczyt wiersza pod RLS w tej samej transakcji
 *    co skutek; `compareAndSetForRecovery` = `UPDATE … WHERE version = $expected`.
 *  - `IdempotencyLedger` (DB): `pg_advisory_xact_lock` na kluczu kroku +
 *    unikalny claim `(instance_id, market_id, step_key)` — dwa równoległe żądania
 *    z tym samym kluczem dają JEDEN skutek; drugie dostaje `replayed`.
 *  - `ResolutionEvidenceVerifier`: rodzaj evidence dozwolony dla stanu
 *    docelowego + referencja związana z faktem wiersza (patrz
 *    `EVIDENCE_BINDING`). Weryfikacja referencji w zewnętrznym PSP nie jest
 *    częścią tej story (DW nazwane w Completion Notes).
 */
import {
  applyRecoveryIntent,
  authorizeRecoveryMarket,
  buildRecoveryIdempotencyKey,
  establishRecoveryServerSession,
  isAllowedTransition,
  isTerminalState,
  RECOVERY_CONTRACT_VERSION,
  type ApplyRecoveryIntentResult,
  type IdempotencyLedger,
  type RecoveryActionAuditRecord,
  type RecoveryCompareAndSetResult,
  type RecoveryPopulationType,
  type RecoveryRecordStore,
  type RecoveryRecordView,
  type ResolutionEvidence,
  type ResolutionEvidenceVerifier,
  type SessionActor,
} from "./recovery-action-contract"
import type { OperatorAuthContext } from "../../middlewares/with-operator-auth"
import type { AdminMarketContextResult } from "../admin-market-context"

export type RecoveryActionClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

/** Akcje wystawione przez API 11.3 (AC-1/AC-3): para retry/resolve. */
export const EXPOSED_RECOVERY_ACTIONS = ["retry", "resolve"] as const
export type ExposedRecoveryAction = (typeof EXPOSED_RECOVERY_ACTIONS)[number]

/**
 * Dozwolona para retry/resolve per populacja (contract `runtime-recovery-capabilities.v1`:
 * retry_compensation/resolve_compensation, retry_issuance_link/resolve_issuance_link,
 * retry_domain_adapter/resolve_domain_adapter). Retry z wiersza, który już niesie
 * częściowy skutek (np. `recovery_in_progress`, `escalated`), nie ma tu celu —
 * tabela przejść 4.1 odrzuca ślepy retry.
 */
export const RECOVERY_ACTION_TARGETS: Record<RecoveryPopulationType, Record<ExposedRecoveryAction, readonly string[]>> = {
  compensation_failure: { retry: ["recovery_in_progress"], resolve: ["resolved_recovered", "closed_unrecoverable"] },
  deferred_issuance_trace: { retry: ["escalated"], resolve: ["issued_after_link", "closed_order_never_created"] },
  dlq_entry: { retry: ["replayed"], resolve: ["discarded_with_evidence"] },
}

/** Rodzaj evidence dopuszczony dla stanu terminalnego. */
export const EVIDENCE_KINDS_BY_TARGET: Record<string, readonly ResolutionEvidence["kind"][]> = {
  resolved_recovered: ["refund_confirmed", "funds_recovered"],
  closed_unrecoverable: ["written_off_with_approval"],
  issued_after_link: ["entitlement_issued"],
  closed_order_never_created: ["refund_confirmed", "written_off_with_approval"],
  replayed: ["replayed_successfully"],
  discarded_with_evidence: ["written_off_with_approval"],
}

/**
 * Wiązanie referencji evidence z faktem wiersza: dla wymienionych rodzajów
 * referencja MUSI równać się wskazanej kolumnie wiersza (nie da się zamknąć
 * wiersza dowodem z innej płatności/zdarzenia). Pozostałe rodzaje (odpis z
 * akceptacją) wymagają konkretnej referencji decyzji.
 */
export const EVIDENCE_BINDING: Record<string, { kind: ResolutionEvidence["kind"]; field: string }[]> = {
  compensation_failure: [
    { kind: "refund_confirmed", field: "payment_intent_id" },
    { kind: "funds_recovered", field: "payment_intent_id" },
  ],
  deferred_issuance_trace: [
    { kind: "entitlement_issued", field: "payment_intent_id" },
    { kind: "refund_confirmed", field: "payment_intent_id" },
  ],
  dlq_entry: [{ kind: "replayed_successfully", field: "event_id" }],
}

const CONCRETE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:#\/-]{2,199}$/

type PopulationTable = {
  table: string
  id: string
  state: string
  binding: string[]
  extraTerminalSet?: (actorId: string) => { sql: string; values: unknown[] }
}

export const RECOVERY_POPULATION_TABLES: Record<RecoveryPopulationType, PopulationTable> = {
  compensation_failure: {
    table: "money_path_compensation_failure",
    id: "failure_id",
    state: "resolution_state",
    binding: ["payment_intent_id"],
  },
  deferred_issuance_trace: {
    table: "deferred_issuance_trace",
    id: "trace_id",
    state: "state",
    binding: ["payment_intent_id"],
  },
  dlq_entry: {
    table: "mor_policy_dlq_entry",
    id: "population_id",
    state: "state",
    binding: ["event_id"],
  },
}

type RawRecord = {
  population_id: string
  instance_id: string
  market_id: string
  state: string
  owner_type: string
  owner_id: string
  version: number | string
  retry_count: number | string
  resolution_evidence: ResolutionEvidence | null
  [binding: string]: unknown
}

export function selectRecordSql(population: RecoveryPopulationType): string {
  const t = RECOVERY_POPULATION_TABLES[population]
  return `SELECT ${t.id} AS population_id, instance_id, market_id, ${t.state} AS state, owner_type, owner_id,
            version, retry_count, resolution_evidence, ${t.binding.join(", ")}
       FROM ${t.table} WHERE ${t.id} = $1`
}

export function compareAndSetSql(population: RecoveryPopulationType): string {
  const t = RECOVERY_POPULATION_TABLES[population]
  const resolved =
    population === "compensation_failure"
      ? `, resolved_at = CASE WHEN $8::boolean THEN now() ELSE resolved_at END,
           resolved_by = CASE WHEN $8::boolean THEN $9 ELSE resolved_by END`
      : ""
  return `UPDATE ${t.table}
       SET ${t.state} = $3, version = $4, retry_count = $5, resolution_evidence = $6::jsonb,
           closure_path = $7${resolved}
     WHERE ${t.id} = $1 AND version = $2
     RETURNING ${t.id} AS population_id`
}

function toView(population: RecoveryPopulationType, raw: RawRecord): RecoveryRecordView {
  return {
    population_type: population,
    population_id: String(raw.population_id),
    instance_id: String(raw.instance_id),
    market_id: String(raw.market_id),
    state: String(raw.state),
    owner: { owner_type: raw.owner_type as RecoveryRecordView["owner"]["owner_type"], owner_id: String(raw.owner_id) },
    version: Number(raw.version),
    retry_count: Number(raw.retry_count),
    resolution_evidence: raw.resolution_evidence ?? null,
  }
}

function closurePath(population: RecoveryPopulationType, terminal: boolean): string {
  void population
  return terminal ? "operator_action" : "not_closed"
}

/** Wiersz populacji odczytany w transakcji akcji (pod RLS) + fakty wiązania evidence. */
export type LoadedRecoveryRecord = { view: RecoveryRecordView; binding: Record<string, string | null> }

export async function loadRecoveryRecord(
  client: RecoveryActionClient,
  population: RecoveryPopulationType,
  populationId: string
): Promise<LoadedRecoveryRecord | null> {
  const { rows } = await client.query<RawRecord>(selectRecordSql(population), [populationId])
  const raw = rows[0]
  if (!raw) return null
  const binding: Record<string, string | null> = {}
  for (const f of RECOVERY_POPULATION_TABLES[population].binding) {
    binding[f] = raw[f] === null || raw[f] === undefined ? null : String(raw[f])
  }
  return { view: toView(population, raw), binding }
}

/** Trwały store CAS. `readForRecovery` jest synchroniczny w kontrakcie 4.1 — oddaje wiersz załadowany w TEJ transakcji. */
export function createDbRecoveryRecordStore(
  client: RecoveryActionClient,
  loaded: LoadedRecoveryRecord,
  actor: SessionActor
): RecoveryRecordStore {
  return {
    readForRecovery: (input) =>
      input.population_type === loaded.view.population_type &&
      input.population_id === loaded.view.population_id &&
      input.instance_id === loaded.view.instance_id
        ? loaded.view
        : null,
    compareAndSetForRecovery: async (input): Promise<RecoveryCompareAndSetResult> => {
      const terminal = isTerminalState(input.population_type, input.next.state)
      const values: unknown[] = [
        input.population_id,
        input.expected_version,
        input.next.state,
        input.next.version,
        input.next.retry_count,
        input.next.resolution_evidence === null ? null : JSON.stringify(input.next.resolution_evidence),
        closurePath(input.population_type, terminal),
      ]
      if (input.population_type === "compensation_failure") values.push(terminal, actor.actor_id)
      const updated = await client.query(compareAndSetSql(input.population_type), values)
      if (updated.rows.length === 1) return { applied: true, record: input.next }
      const current = await loadRecoveryRecord(client, input.population_type, input.population_id)
      if (!current) throw new Error("[recovery-action-runtime] wiersz zniknął w trakcie CAS")
      return { applied: false, record: current.view }
    },
  }
}

export function createBindingEvidenceVerifier(loaded: LoadedRecoveryRecord): ResolutionEvidenceVerifier {
  return {
    verifies: ({ evidence, record, target_state }) => verifyEvidenceBinding(evidence, record.population_type, target_state, loaded.binding),
  }
}

export function verifyEvidenceBinding(
  evidence: ResolutionEvidence,
  population: RecoveryPopulationType,
  targetState: string,
  binding: Record<string, string | null>
): boolean {
  const allowed = EVIDENCE_KINDS_BY_TARGET[targetState] ?? []
  if (!allowed.includes(evidence.kind)) return false
  if (typeof evidence.reference !== "string" || !CONCRETE_REFERENCE.test(evidence.reference)) return false
  const rule = EVIDENCE_BINDING[population]?.find((b) => b.kind === evidence.kind)
  if (rule) {
    const fact = binding[rule.field]
    return typeof fact === "string" && fact.length > 0 && fact === evidence.reference
  }
  return true
}

// ── Rejestr kroków (audyt + ledger) ────────────────────────────────────────

export const INSERT_RECOVERY_ACTION_STEP_SQL = `
  INSERT INTO recovery_action_step
    (audit_id, instance_id, market_id, step, step_key, intent_key, population_type, population_id,
     action, target_state, expected_version, actor_id, actor, outcome, resolution_evidence, audit, recorded_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb, $16::jsonb, $17)`

export const SELECT_CLAIMED_STEP_SQL = `
  SELECT audit_id, step, outcome, actor_id, target_state, resolution_evidence, audit
    FROM recovery_action_step
   WHERE instance_id = $1 AND market_id = $2 AND step_key = $3`

export type RecoveryStep = "propose" | "approve"

export type RecoveryStepRow = {
  audit_id: string
  step: RecoveryStep
  outcome: string
  actor_id: string
  target_state: string | null
  resolution_evidence: ResolutionEvidence | null
  audit: Record<string, unknown>
}

export function stepKey(step: RecoveryStep, intentKey: string): string {
  return `${step}:${intentKey}`
}

async function lockStepKey(client: RecoveryActionClient, scope: { instance_id: string; market_id: string }, key: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${scope.instance_id}|${scope.market_id}|${key}`,
  ])
}

async function readClaimed(
  client: RecoveryActionClient,
  scope: { instance_id: string; market_id: string },
  key: string
): Promise<RecoveryStepRow | null> {
  const { rows } = await client.query<RecoveryStepRow>(SELECT_CLAIMED_STEP_SQL, [scope.instance_id, scope.market_id, key])
  return rows[0] ?? null
}

export type StepAuditInput = {
  audit_id: string
  step: RecoveryStep
  claimed: boolean
  intent_key: string
  population_type: RecoveryPopulationType
  population_id: string
  instance_id: string
  market_id: string
  action: string
  target_state: string | null
  expected_version: number
  actor: SessionActor
  outcome: string
  resolution_evidence: ResolutionEvidence | null
  audit: Record<string, unknown>
  recorded_at: string
}

export async function insertStepAudit(client: RecoveryActionClient, row: StepAuditInput): Promise<void> {
  await client.query(INSERT_RECOVERY_ACTION_STEP_SQL, [
    row.audit_id,
    row.instance_id,
    row.market_id,
    row.step,
    row.claimed ? stepKey(row.step, row.intent_key) : null,
    row.intent_key,
    row.population_type,
    row.population_id,
    row.action,
    row.target_state,
    row.expected_version,
    row.actor.actor_id,
    JSON.stringify(row.actor),
    row.outcome,
    row.resolution_evidence === null ? null : JSON.stringify(row.resolution_evidence),
    JSON.stringify(row.audit),
    row.recorded_at,
  ])
}

/**
 * Ledger kroku `approve`: blokada doradcza transakcji na kluczu kroku, odczyt
 * claimu, operacja i zapis claimu w JEDNEJ transakcji. Odmowa kernela nie
 * zajmuje claimu (ponowienie po usunięciu przyczyny jest możliwe), ale ma
 * własny wiersz audytu bez `step_key`.
 */
export function createDbIdempotencyLedger(
  client: RecoveryActionClient,
  meta: { target_state: string; actor: SessionActor }
): IdempotencyLedger {
  return {
    executeOnce: async (scope, idempotencyKey, operation) => {
      const key = stepKey("approve", idempotencyKey)
      await lockStepKey(client, scope, key)
      const prior = await readClaimed(client, scope, key)
      if (prior) return { created: false, applied: prior.audit as unknown as RecoveryActionAuditRecord }
      const result = await operation()
      await insertStepAudit(client, {
        ...auditColumns(result.audit),
        step: "approve",
        claimed: result.outcome === "applied",
        target_state: meta.target_state,
        actor: meta.actor,
        audit: result.audit as unknown as Record<string, unknown>,
      })
      return { created: true, result }
    },
  }
}

function auditColumns(audit: RecoveryActionAuditRecord) {
  return {
    audit_id: audit.audit_id,
    intent_key: audit.idempotency_key,
    population_type: audit.population_type,
    population_id: audit.population_id,
    instance_id: audit.instance_id,
    market_id: audit.market_id,
    action: audit.action,
    expected_version: audit.expected_version,
    outcome: audit.outcome,
    resolution_evidence: audit.resolution_evidence,
    recorded_at: audit.recorded_at,
  }
}

// ── Dwa kroki D-37 ─────────────────────────────────────────────────────────

export type RecoveryStepRequest = {
  population_type: RecoveryPopulationType
  population_id: string
  action: ExposedRecoveryAction
  target_state: string
  expected_version: number
  /** Tylko `propose`; `recorded_by`/`recorded_at` wypełnia serwer z sesji. */
  evidence?: { kind: ResolutionEvidence["kind"]; reference: string } | null
}

export type RecoveryStepSession = {
  operatorAuth: OperatorAuthContext | undefined | null
  marketContext: AdminMarketContextResult
  instanceId: string
}

export type RecoveryStepOutcome =
  | "proposed"
  | "applied"
  | "replayed"
  | "refused_market_forbidden"
  | "refused_version_conflict"
  | "refused_invalid_transition"
  | "refused_missing_evidence"
  | "refused_proposal_missing"
  | "refused_proposal_actor_mismatch"
  | "not_found"

export type RecoveryStepResult = {
  step: RecoveryStep
  outcome: RecoveryStepOutcome
  audit_id: string | null
  intent_key: string
  step_key: string
  record: { state: string; version: number } | null
  domain_effects: 0 | 1
}

export type RecoveryStepDeps = {
  now: () => string
  newAuditId: () => string
}

function deriveActor(session: RecoveryStepSession): SessionActor {
  // establishRecoveryServerSession weryfikuje pochodzenie obu kontekstów (WeakSet/WeakMap).
  establishRecoveryServerSession({
    operatorAuth: session.operatorAuth,
    marketContext: session.marketContext,
    sessionInstanceId: session.instanceId,
  })
  const auth = session.operatorAuth as OperatorAuthContext
  return {
    actor_type: "user",
    actor_id: auth.actor_id,
    auth_identity_id: auth.auth_identity_id ?? null,
    session_source: "medusa_admin_session",
  }
}

export function isExposedTarget(population: RecoveryPopulationType, action: ExposedRecoveryAction, target: string): boolean {
  return RECOVERY_ACTION_TARGETS[population][action].includes(target)
}

/**
 * Krok 1 (`propose`): pełna walidacja bez skutku domenowego (autoryzacja rynku,
 * wersja, para akcja→stan, przejście 4.1, evidence i jego wiązanie). Przyjęta
 * propozycja zajmuje klucz `propose:<intencja>`; powtórka oddaje poprzedni wynik.
 */
export async function proposeRecoveryAction(
  client: RecoveryActionClient,
  session: RecoveryStepSession,
  request: RecoveryStepRequest,
  deps: RecoveryStepDeps
): Promise<RecoveryStepResult> {
  const actor = deriveActor(session)
  const intentKey = buildRecoveryIdempotencyKey({
    population_type: request.population_type,
    population_id: request.population_id,
    action: request.action,
    expected_version: request.expected_version,
  })
  const key = stepKey("propose", intentKey)
  const loaded = await loadRecoveryRecord(client, request.population_type, request.population_id)
  const base = { step: "propose" as const, intent_key: intentKey, step_key: key }
  if (!loaded) return { ...base, outcome: "not_found", audit_id: null, record: null, domain_effects: 0 }
  const record = loaded.view
  const scope = { instance_id: record.instance_id, market_id: record.market_id }
  const authorization = authorizeRecoveryMarket({
    actor,
    marketContext: session.marketContext,
    sessionInstanceId: session.instanceId,
    record,
  })
  const now = deps.now()
  const evidence: ResolutionEvidence | null = request.evidence
    ? { kind: request.evidence.kind, reference: request.evidence.reference, recorded_at: now, recorded_by: actor }
    : null

  let outcome: RecoveryStepOutcome = "proposed"
  if (authorization.decision !== "granted") outcome = "refused_market_forbidden"
  else if (!isExposedTarget(request.population_type, request.action, request.target_state)) outcome = "refused_invalid_transition"
  else if (record.version !== request.expected_version) outcome = "refused_version_conflict"
  else if (!isAllowedTransition(request.population_type, record.state, request.target_state)) outcome = "refused_invalid_transition"
  else {
    const terminal = isTerminalState(request.population_type, request.target_state)
    if (terminal && !evidence) outcome = "refused_missing_evidence"
    else if (!terminal && evidence) outcome = "refused_invalid_transition"
    else if (evidence && !verifyEvidenceBinding(evidence, request.population_type, request.target_state, loaded.binding)) {
      outcome = "refused_invalid_transition"
    }
  }

  if (outcome === "proposed") {
    await lockStepKey(client, scope, key)
    const prior = await readClaimed(client, scope, key)
    if (prior) {
      const auditId = deps.newAuditId()
      await insertStepAudit(client, stepRow(auditId, "replayed", false))
      return { ...base, outcome: "replayed", audit_id: prior.audit_id, record: snapshotOf(record), domain_effects: 0 }
    }
  }
  const auditId = deps.newAuditId()
  await insertStepAudit(client, stepRow(auditId, outcome, outcome === "proposed"))
  return { ...base, outcome, audit_id: auditId, record: snapshotOf(record), domain_effects: 0 }

  function stepRow(auditId: string, stepOutcome: string, claimed: boolean): StepAuditInput {
    return {
      audit_id: auditId,
      step: "propose",
      claimed,
      intent_key: intentKey,
      population_type: request.population_type,
      population_id: record.population_id,
      instance_id: record.instance_id,
      market_id: record.market_id,
      action: request.action,
      target_state: request.target_state,
      expected_version: request.expected_version,
      actor,
      outcome: stepOutcome,
      resolution_evidence: evidence,
      audit: {
        contract_version: RECOVERY_CONTRACT_VERSION,
        step: "propose",
        authorization: { market_access: authorization.market_access, decision: authorization.decision },
        before: { state: record.state, version: record.version },
      },
      recorded_at: now,
    }
  }
}

function snapshotOf(record: RecoveryRecordView) {
  return { state: record.state, version: record.version }
}

/**
 * Krok 2 (`approve`): wymaga przyjętej propozycji TEGO SAMEGO aktora dla tej
 * samej intencji i stanu docelowego; skutek wykonuje kernel 4.1
 * (`applyRecoveryIntent`) z trwałym store, ledgerem i weryfikatorem.
 */
export async function approveRecoveryAction(
  client: RecoveryActionClient,
  session: RecoveryStepSession,
  request: RecoveryStepRequest,
  deps: RecoveryStepDeps
): Promise<RecoveryStepResult> {
  const actor = deriveActor(session)
  const intentKey = buildRecoveryIdempotencyKey({
    population_type: request.population_type,
    population_id: request.population_id,
    action: request.action,
    expected_version: request.expected_version,
  })
  const key = stepKey("approve", intentKey)
  const base = { step: "approve" as const, intent_key: intentKey, step_key: key }
  const loaded = await loadRecoveryRecord(client, request.population_type, request.population_id)
  if (!loaded) return { ...base, outcome: "not_found", audit_id: null, record: null, domain_effects: 0 }
  const record = loaded.view
  const scope = { instance_id: record.instance_id, market_id: record.market_id }

  const authorization = authorizeRecoveryMarket({
    actor,
    marketContext: session.marketContext,
    sessionInstanceId: session.instanceId,
    record,
  })
  const proposal = authorization.decision === "granted" ? await readClaimed(client, scope, stepKey("propose", intentKey)) : null
  const refuseStep = async (outcome: RecoveryStepOutcome): Promise<RecoveryStepResult> => {
    const auditId = deps.newAuditId()
    await insertStepAudit(client, {
      audit_id: auditId,
      step: "approve",
      claimed: false,
      intent_key: intentKey,
      population_type: request.population_type,
      population_id: record.population_id,
      instance_id: record.instance_id,
      market_id: record.market_id,
      action: request.action,
      target_state: request.target_state,
      expected_version: request.expected_version,
      actor,
      outcome,
      resolution_evidence: null,
      audit: { contract_version: RECOVERY_CONTRACT_VERSION, step: "approve", reason: outcome },
      recorded_at: deps.now(),
    })
    return { ...base, outcome, audit_id: auditId, record: snapshotOf(record), domain_effects: 0 }
  }
  if (authorization.decision === "granted") {
    if (!proposal || proposal.target_state !== request.target_state) return refuseStep("refused_proposal_missing")
    if (proposal.actor_id !== actor.actor_id) return refuseStep("refused_proposal_actor_mismatch")
  }

  const recoverySession = establishRecoveryServerSession({
    operatorAuth: session.operatorAuth,
    marketContext: session.marketContext,
    sessionInstanceId: session.instanceId,
  })
  const ledger = createDbIdempotencyLedger(client, { target_state: request.target_state, actor })
  const now = deps.now()
  const result: ApplyRecoveryIntentResult = await applyRecoveryIntent({
    intent: {
      action: request.action,
      population_type: request.population_type,
      population_id: request.population_id,
      target_state: request.target_state,
      expected_version: request.expected_version,
      idempotency_key: intentKey,
      resolution_evidence: proposal?.resolution_evidence
        ? { ...proposal.resolution_evidence, recorded_by: actor }
        : null,
    },
    recoverySession,
    recordStore: createDbRecoveryRecordStore(client, loaded, actor),
    evidenceVerifier: createBindingEvidenceVerifier(loaded),
    ledger,
    now,
    auditId: deps.newAuditId(),
  })
  if (result.outcome === "replayed" || result.outcome === "refused_market_forbidden") {
    // Powtórka i odmowa przed claimem nie przechodzą przez zapis ledgeru — audyt osobno.
    await insertStepAudit(client, {
      ...auditColumns(result.audit),
      step: "approve",
      claimed: false,
      target_state: request.target_state,
      actor,
      audit: result.audit as unknown as Record<string, unknown>,
    })
  }
  return {
    ...base,
    outcome: result.outcome as RecoveryStepOutcome,
    audit_id: result.audit.audit_id,
    record: snapshotOf(result.record),
    domain_effects: result.domain_effects,
  }
}

/** Kod HTTP wyniku kroku — jawny konflikt (409), odmowa rynku (403). */
export function httpStatusForStepOutcome(outcome: RecoveryStepOutcome): number {
  switch (outcome) {
    case "proposed":
      return 201
    case "applied":
    case "replayed":
      return 200
    case "refused_market_forbidden":
    case "refused_proposal_actor_mismatch":
      return 403
    case "refused_version_conflict":
    case "refused_proposal_missing":
      return 409
    case "refused_invalid_transition":
    case "refused_missing_evidence":
      return 422
    case "not_found":
      return 404
    default: {
      const unreachable: never = outcome
      throw new Error(`unmapped recovery step outcome ${String(unreachable)}`)
    }
  }
}
