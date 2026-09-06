/**
 * recovery-action-contract.ts — v1.16.0 Story 4.1 (FR-11/FR-12/FR-14; AD-32, AD-48, AD-49;
 * ADR-218, ADR-221 §4).
 *
 * KERNEL kontraktu akcji recovery na wierszu wymagającym człowieka. Czysta funkcja,
 * bez I/O: nie zna HTTP, bazy ani CLI. Endpoint (`/admin/*`) i CLI to Stories
 * 11.3/11.4; ten moduł jest tym, co one MUSZĄ wywołać, żeby intencja stała się
 * skutkiem.
 *
 * Kontrakt jako kod (`specs/contracts/recovery/`):
 *
 *  1. AKTOR i AUTORYZACJA pochodzą WYŁĄCZNIE z surowych, serwerowych wyników
 *     `withOperatorAuth` oraz `resolveAdminMarketContext`. Publiczne wejście kernela
 *     NIE przyjmuje gotowego aktora ani grantu: wyprowadza oba wewnątrz, a wynik
 *     resolvera musi być przypisany do tego samego aktora sesji.
 *  2. AUTORYZACJA RYNKU jest wynikiem `resolveAdminMarketContext` (`super_admin` |
 *     `market_grant`); brak dostępu albo rozbieżność aktora =
 *     `refused_market_forbidden`, bez skutku.
 *  3. Każda intencja niesie `idempotency_key` = `<population_type>:<population_id>:<action>:<expected_version>`
 *     (funkcja `buildRecoveryIdempotencyKey`) i `expected_version`. Ta sama intencja dwa razy =
 *     JEDEN skutek domenowy i drugi rekord audytu `replayed` z identycznym `after`.
 *  4. Niezgodna wersja = `refused_version_conflict`; zabronione przejście =
 *     `refused_invalid_transition`; przejście w stan terminalny bez evidence =
 *     `refused_missing_evidence`. Sama zmiana stanu NIE jest dowodem.
 *  5. Tabela przejść i zbiór stanów terminalnych są ZDUPLIKOWANE względem
 *     `recovery-population.v1.schema.json#/$defs/transitions` — celowo, bo runtime nie
 *     czyta super-repo. Duplikat ma BRAMKĘ PORÓWNANIA:
 *     `__tests__/contracts/recovery-population-contract.unit.spec.ts` porównuje oba
 *     nośniki wartość po wartości.
 */
import type { OperatorAuthContext } from "../../middlewares/with-operator-auth"
import type { AdminMarketContextResult } from "../admin-market-context"

export const RECOVERY_CONTRACT_VERSION = "1.0.0" as const

export const RECOVERY_POPULATION_TYPES = [
  "compensation_failure",
  "deferred_issuance_trace",
  "dlq_entry",
] as const
export type RecoveryPopulationType = (typeof RECOVERY_POPULATION_TYPES)[number]

export const RECOVERY_ACTIONS = ["retry", "resolve", "escalate", "discard", "take_ownership"] as const
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

/**
 * Tabela przejść per populacja — drugi nośnik `$defs.transitions` ze schemy.
 * Klucz = stan źródłowy, wartość = dozwolone stany docelowe. Stany terminalne mają
 * pustą listę i są wymienione osobno w `terminal`.
 */
export const RECOVERY_TRANSITIONS: Record<
  RecoveryPopulationType,
  { terminal: readonly string[]; allowed: Record<string, readonly string[]> }
> = {
  compensation_failure: {
    terminal: ["resolved_recovered", "closed_unrecoverable", "closed_legacy_unevidenced"],
    allowed: {
      open: ["recovery_in_progress", "resolved_recovered", "closed_unrecoverable"],
      recovery_in_progress: ["open", "resolved_recovered", "closed_unrecoverable"],
      resolved_recovered: [],
      closed_unrecoverable: [],
      closed_legacy_unevidenced: [],
    },
  },
  deferred_issuance_trace: {
    terminal: ["issued_after_link", "closed_order_never_created"],
    allowed: {
      awaiting_order: ["escalated", "issued_after_link", "closed_order_never_created"],
      escalated: ["issued_after_link", "closed_order_never_created"],
      issued_after_link: [],
      closed_order_never_created: [],
    },
  },
  dlq_entry: {
    terminal: ["replayed", "discarded_with_evidence"],
    allowed: {
      dlq_pending_retry: ["replayed", "dlq_pending_ops_review", "discarded_with_evidence"],
      dlq_pending_ops_review: ["replayed", "discarded_with_evidence"],
      replayed: [],
      discarded_with_evidence: [],
    },
  },
}

export type RecoveryOwner = {
  owner_type: "operator_role" | "operator_user"
  owner_id: string
}

export type SessionActor = {
  actor_type: "user"
  actor_id: string
  auth_identity_id: string | null
  session_source: "medusa_admin_session"
}

export type ResolutionEvidence = {
  kind:
    | "refund_confirmed"
    | "funds_recovered"
    | "entitlement_issued"
    | "replayed_successfully"
    | "written_off_with_approval"
    | "legacy_manual_resolution"
  reference: string
  recorded_at: string
  recorded_by: SessionActor
}

/** Minimalny widok wiersza populacji potrzebny kernelowi (bez payloadu). */
export type RecoveryRecordView = {
  population_type: RecoveryPopulationType
  population_id: string
  instance_id: string
  market_id: string
  state: string
  owner: RecoveryOwner
  version: number
  retry_count: number
  resolution_evidence: ResolutionEvidence | null
}

export type RecoveryIntent = {
  action: RecoveryAction
  population_type: RecoveryPopulationType
  population_id: string
  /** Stan docelowy dla resolve/escalate/discard/retry; dla take_ownership pomijany. */
  target_state?: string
  expected_version: number
  idempotency_key: string
  resolution_evidence?: ResolutionEvidence | null
  new_owner?: RecoveryOwner
}

export type StateSnapshot = { state: string; version: number; owner: RecoveryOwner }

export type RecoveryOutcome =
  | "applied"
  | "replayed"
  | "refused_unauthenticated"
  | "refused_market_forbidden"
  | "refused_version_conflict"
  | "refused_invalid_transition"
  | "refused_missing_evidence"

export type MarketAccess = "super_admin" | "market_grant" | "none"

export type RecoveryActionAuditRecord = {
  contract_version: typeof RECOVERY_CONTRACT_VERSION
  audit_id: string
  action: RecoveryAction
  population_type: RecoveryPopulationType
  population_id: string
  instance_id: string
  market_id: string
  actor: SessionActor
  authorization: {
    market_access: MarketAccess
    verified_by: "server_admin_market_context"
    decision: "granted" | "denied"
  }
  idempotency_key: string
  expected_version: number
  outcome: RecoveryOutcome
  before: StateSnapshot
  after: StateSnapshot
  resolution_evidence: ResolutionEvidence | null
  recorded_at: string
}

/** Jedyny dozwolony kształt klucza idempotencji — wynika z intencji, nie z klienta. */
export function buildRecoveryIdempotencyKey(input: {
  population_type: RecoveryPopulationType
  population_id: string
  action: RecoveryAction
  expected_version: number
}): string {
  if (!/^[^:\s]+$/.test(input.population_id)) {
    throw new Error(
      `[recovery-action-contract] population_id "${input.population_id}" zawiera dwukropek albo biały znak — klucz idempotencji byłby niejednoznaczny`
    )
  }
  if (!Number.isInteger(input.expected_version) || input.expected_version < 1) {
    throw new Error(`[recovery-action-contract] expected_version musi być całkowite >= 1, jest ${String(input.expected_version)}`)
  }
  return `${input.population_type}:${input.population_id}:${input.action}:${input.expected_version}`
}

/**
 * Aktor z sesji. Przyjmuje WYŁĄCZNIE `OperatorAuthContext` (typ z withOperatorAuth) —
 * body żądania nie ma tego typu, więc nie da się go tu podać bez rzutowania.
 */
export function deriveSessionActor(operatorAuth: OperatorAuthContext | undefined | null): SessionActor | null {
  if (!operatorAuth || operatorAuth.actor_type !== "user" || !operatorAuth.actor_id) {
    return null
  }
  return {
    actor_type: "user",
    actor_id: operatorAuth.actor_id,
    auth_identity_id: operatorAuth.auth_identity_id ?? null,
    session_source: "medusa_admin_session",
  }
}

export type MarketAuthorization = {
  market_access: MarketAccess
  decision: "granted" | "denied"
}

/**
 * Autoryzacja rynku i instancji wiersza z wyniku `resolveAdminMarketContext`.
 * Dostęp jest przyznany tylko, gdy kontekst jest `ok`, rynek kontekstu równa się
 * rynkowi WIERSZA (nie nagłówka — nagłówek został już zweryfikowany serwerowo) i
 * instancja sesji równa się instancji wiersza.
 */
export function authorizeRecoveryMarket(input: {
  actor: SessionActor
  marketContext: AdminMarketContextResult
  sessionInstanceId: string
  record: Pick<RecoveryRecordView, "instance_id" | "market_id">
}): MarketAuthorization {
  const ctx = input.marketContext
  if (!ctx.ok) {
    return { market_access: "none", decision: "denied" }
  }
  // Resolver musi być wynikiem oceny TEJ samej sesji. To zamyka drogę, na której
  // endpoint łączyłby prawidłowy grant innego administratora z własnym aktorem.
  if (ctx.actor_id !== input.actor.actor_id || ctx.actor_type !== input.actor.actor_type) {
    return { market_access: "none", decision: "denied" }
  }
  if (input.sessionInstanceId !== input.record.instance_id) {
    return { market_access: "none", decision: "denied" }
  }
  if (ctx.is_super_admin) {
    return { market_access: "super_admin", decision: "granted" }
  }
  if (ctx.market_id !== null && ctx.market_id === input.record.market_id) {
    return { market_access: "market_grant", decision: "granted" }
  }
  return { market_access: "none", decision: "denied" }
}

export function isTerminalState(population: RecoveryPopulationType, state: string): boolean {
  return RECOVERY_TRANSITIONS[population].terminal.includes(state)
}

export function isAllowedTransition(population: RecoveryPopulationType, from: string, to: string): boolean {
  const allowed = RECOVERY_TRANSITIONS[population].allowed[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/** Ledger wykonanych intencji — abstrakcja nad tabelą audytu (Story 11.3 podaje implementację). */
export interface IdempotencyLedger {
  findApplied(idempotencyKey: string): RecoveryActionAuditRecord | undefined
}

export type ApplyRecoveryIntentInput = {
  record: RecoveryRecordView
  intent: RecoveryIntent
  /** Niesfałszowany kontekst ustawiony wyłącznie przez `withOperatorAuth`. */
  operatorAuth: OperatorAuthContext | undefined | null
  /** Wynik serwerowego `resolveAdminMarketContext` dla tej samej sesji. */
  marketContext: AdminMarketContextResult
  /** instance_id sesji serwera; nie pochodzi z body ani z wiersza. */
  sessionInstanceId: string
  ledger: IdempotencyLedger
  now: string
  auditId: string
}

export type ApplyRecoveryIntentResult = {
  outcome: RecoveryOutcome
  /** Nowy stan wiersza; przy odmowie i powtórce IDENTYCZNY z wejściem (ta sama referencja). */
  record: RecoveryRecordView
  audit: RecoveryActionAuditRecord
  /** Liczba skutków domenowych tej próby: 1 tylko przy `applied`. */
  domain_effects: 0 | 1
}

function snapshot(record: RecoveryRecordView): StateSnapshot {
  return { state: record.state, version: record.version, owner: { ...record.owner } }
}

/**
 * Zastosuj intencję do wiersza. Kolejność odmów jest ustalona i nie zależy od body:
 * uwierzytelnienie → autoryzacja rynku/instancji → klucz idempotencji → powtórka →
 * wersja → przejście → evidence → skutek.
 */
export function applyRecoveryIntent(input: ApplyRecoveryIntentInput): ApplyRecoveryIntentResult {
  const { record, intent, ledger } = input
  // Nie przyjmujemy `SessionActor`/`MarketAuthorization` od wywołującego. Oba
  // fakty są wyprowadzane razem z surowych ogniw serwera, zanim kernel oceni
  // klucz, wersję albo przejście.
  const actor = deriveSessionActor(input.operatorAuth)
  if (!actor) {
    throw new RecoveryUnauthenticatedError()
  }
  const authorization = authorizeRecoveryMarket({
    actor,
    marketContext: input.marketContext,
    sessionInstanceId: input.sessionInstanceId,
    record,
  })
  const before = snapshot(record)

  const refuse = (outcome: RecoveryOutcome, actorForAudit: SessionActor): ApplyRecoveryIntentResult => ({
    outcome,
    record,
    domain_effects: 0,
    audit: buildAudit({ outcome, before, after: before, actor: actorForAudit, resolution_evidence: null }),
  })

  const buildAudit = (parts: {
    outcome: RecoveryOutcome
    before: StateSnapshot
    after: StateSnapshot
    actor: SessionActor
    resolution_evidence: ResolutionEvidence | null
  }): RecoveryActionAuditRecord => ({
    contract_version: RECOVERY_CONTRACT_VERSION,
    audit_id: input.auditId,
    action: intent.action,
    population_type: record.population_type,
    population_id: record.population_id,
    instance_id: record.instance_id,
    market_id: record.market_id,
    actor: parts.actor,
    authorization: {
      market_access: authorization.market_access,
      verified_by: "server_admin_market_context",
      decision: authorization.decision,
    },
    idempotency_key: intent.idempotency_key,
    expected_version: intent.expected_version,
    outcome: parts.outcome,
    before: parts.before,
    after: parts.after,
    resolution_evidence: parts.resolution_evidence,
    recorded_at: input.now,
  })

  // 1. Autoryzacja rynku i instancji.
  if (authorization.decision !== "granted") {
    return refuse("refused_market_forbidden", actor)
  }

  // 2. Klucz idempotencji musi wynikać z intencji — brak albo obcy kształt jest błędem
  //    programisty, nie odmową biznesową.
  const expectedKey = buildRecoveryIdempotencyKey({
    population_type: record.population_type,
    population_id: record.population_id,
    action: intent.action,
    expected_version: intent.expected_version,
  })
  if (intent.idempotency_key !== expectedKey) {
    throw new Error(
      `[recovery-action-contract] idempotency_key "${intent.idempotency_key}" nie wynika z intencji (oczekiwano "${expectedKey}")`
    )
  }
  if (intent.population_type !== record.population_type || intent.population_id !== record.population_id) {
    throw new Error("[recovery-action-contract] intencja wskazuje inny wiersz niż podany rekord")
  }

  // 3. Powtórka: ta sama intencja już wykonana → zero skutku, rekord `replayed`
  //    z DOKŁADNIE tym samym `after`, co pierwsze wykonanie.
  const prior = ledger.findApplied(intent.idempotency_key)
  if (prior) {
    return {
      outcome: "replayed",
      record,
      domain_effects: 0,
      audit: buildAudit({
        outcome: "replayed",
        before: prior.after,
        after: prior.after,
        actor,
        resolution_evidence: null,
      }),
    }
  }

  // 4. Optymistyczna kontrola wersji.
  if (intent.expected_version !== record.version) {
    return refuse("refused_version_conflict", actor)
  }

  // 5. Przejście.
  let nextState = record.state
  let nextOwner: RecoveryOwner = { ...record.owner }
  let nextRetry = record.retry_count
  if (intent.action === "take_ownership") {
    if (!intent.new_owner || !intent.new_owner.owner_id) {
      return refuse("refused_invalid_transition", actor)
    }
    nextOwner = { ...intent.new_owner }
  } else {
    if (!intent.target_state || !isAllowedTransition(record.population_type, record.state, intent.target_state)) {
      return refuse("refused_invalid_transition", actor)
    }
    nextState = intent.target_state
    if (intent.action === "retry") {
      nextRetry = record.retry_count + 1
    }
  }

  // 6. Evidence: stan terminalny bez dowodu jest odmową; dowód przy stanie
  //    nieterminalnym też (evidence null wyłącznie nieterminalnie).
  const goesTerminal = isTerminalState(record.population_type, nextState)
  const evidence = intent.resolution_evidence ?? null
  if (goesTerminal && !evidence) {
    return refuse("refused_missing_evidence", actor)
  }
  if (!goesTerminal && evidence) {
    return refuse("refused_invalid_transition", actor)
  }
  if (
    evidence &&
    (evidence.recorded_by.actor_id !== actor.actor_id ||
      evidence.recorded_by.actor_type !== actor.actor_type ||
      evidence.recorded_by.session_source !== actor.session_source)
  ) {
    // Dowód z body nie może podszyć się pod innego operatora niż sesja, która
    // wykonuje mutację. auth_identity_id jest audytowym atrybutem sesji, więc
    // również musi być identyczny (null oznacza jej rzeczywisty brak).
    return refuse("refused_invalid_transition", actor)
  }
  if (evidence && evidence.recorded_by.auth_identity_id !== actor.auth_identity_id) {
    return refuse("refused_invalid_transition", actor)
  }
  if (evidence && evidence.kind === "legacy_manual_resolution") {
    // Stan legacy jest osiągalny wyłącznie przez backfill (ADR-221 §3), nigdy przez akcję.
    return refuse("refused_invalid_transition", actor)
  }

  // 7. Skutek — DOKŁADNIE jeden.
  const nextRecord: RecoveryRecordView = {
    ...record,
    state: nextState,
    owner: nextOwner,
    retry_count: nextRetry,
    version: record.version + 1,
    resolution_evidence: goesTerminal ? evidence : null,
  }
  const after = snapshot(nextRecord)
  return {
    outcome: "applied",
    record: nextRecord,
    domain_effects: 1,
    audit: buildAudit({ outcome: "applied", before, after, actor, resolution_evidence: goesTerminal ? evidence : null }),
  }
}

export class RecoveryUnauthenticatedError extends Error {
  readonly outcome: RecoveryOutcome = "refused_unauthenticated"
  constructor() {
    super("[recovery-action-contract] brak aktora z sesji — intencja odrzucona przed jakąkolwiek oceną")
    this.name = "RecoveryUnauthenticatedError"
  }
}
