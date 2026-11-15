/**
 * recovery-domain-adapters.ts — v1.16.0 Story 11.3, runda fix 1 (R-1, R-4, R-6; FR-11,
 * AD-48, NFR-4; kontrakt `runtime-recovery-capabilities.v1`).
 *
 * Retry populacji recovery NIE jest zmianą etykiety stanu: `approve` akcji `retry`
 * wywołuje adapter domenowy populacji (`retry_compensation`, `retry_issuance_link`,
 * `retry_domain_adapter`) PRZED przejściem stanu i zapisuje jego wynik w audycie kroku.
 *
 *  - `succeeded` ⇒ przejście do stanu z propozycji; dla stanu terminalnego evidence
 *    jest związane z identyfikatorem WYNIKU adaptera (`reference`), nie z faktem wiersza.
 *  - `partial`   ⇒ jawny stan nieterminalny `partial_effect` (kontrakt:
 *    `partial_effect: explicit_nonterminal_state`); jedyny następca per populacja to
 *    `PARTIAL_EFFECT_SUCCESSOR`, ślepy retry jest odrzucany.
 *  - `failed`    ⇒ brak przejścia stanu, nazwana przyczyna w audycie (`retry_failed`).
 *  - `unavailable` ⇒ brak przejścia stanu (`refused_domain_adapter_unavailable`).
 *
 * Produkcyjne adaptery: w zakresie Story 11.3 żadna z trzech populacji nie ma
 * wewnętrznego mechanizmu, który da się wywołać synchronicznie w transakcji akcji
 * i zmierzyć jego skutek:
 *  - DLQ: konsument `on-order-placed-stripe-retry` biegnie we własnej transakcji per
 *    `order.placed` i pomija zdarzenia z wierszem DLQ innym niż `replayed`;
 *  - kompensacja: wykonanie zwrotu/zwolnienia jest po stronie PSP (Stripe);
 *  - ślad odroczonej emisji: emisja wymaga zamówienia, którego jeszcze nie ma.
 * Dlatego domyślny rejestr zwraca `unavailable` z nazwaną przyczyną — retry nie
 * ustawia żadnego stanu (w szczególności terminalnego) bez zmierzonego skutku.
 */
import type { RecoveryPopulationType, RecoveryRecordView, SessionActor } from "./recovery-action-contract"

export type RecoveryDomainAdapterClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

export type RecoveryDomainAdapterInput = {
  client: RecoveryDomainAdapterClient
  record: RecoveryRecordView
  binding: Record<string, string | null>
  actor: SessionActor
  intent_key: string
  now: string
}

export type RecoveryDomainAdapterResult =
  | { status: "succeeded"; reference: string; detail?: Record<string, unknown> }
  | { status: "partial"; reason: string; reference?: string | null; detail?: Record<string, unknown> }
  | { status: "failed"; reason: string; detail?: Record<string, unknown> }
  | { status: "unavailable"; reason: string }

export type RecoveryDomainAdapter = {
  population_type: RecoveryPopulationType
  capability: string
  retry: (input: RecoveryDomainAdapterInput) => Promise<RecoveryDomainAdapterResult>
}

export type RecoveryDomainAdapterRegistry = ReadonlyMap<RecoveryPopulationType, RecoveryDomainAdapter>

/** Nazwy zdolności retry z kontraktu `runtime-recovery-capabilities.v1`. */
export const RECOVERY_RETRY_CAPABILITY: Record<RecoveryPopulationType, string> = {
  compensation_failure: "retry_compensation",
  deferred_issuance_trace: "retry_issuance_link",
  dlq_entry: "retry_domain_adapter",
}

/** Kontrakt: `partial_effect: [<jeden następca>]` per populacja. */
export const PARTIAL_EFFECT_STATE = "partial_effect" as const
export const PARTIAL_EFFECT_SUCCESSOR: Record<RecoveryPopulationType, string> = {
  compensation_failure: "recovery_in_progress",
  deferred_issuance_trace: "escalated",
  dlq_entry: "dlq_pending_ops_review",
}

export const RECOVERY_DOMAIN_ADAPTER_UNAVAILABLE_REASON: Record<RecoveryPopulationType, string> = {
  compensation_failure: "compensation_execution_is_psp_side",
  deferred_issuance_trace: "issuance_requires_order_not_yet_created",
  dlq_entry: "dlq_replay_consumer_not_invocable_in_action_transaction",
}

function unavailableAdapter(population: RecoveryPopulationType): RecoveryDomainAdapter {
  return {
    population_type: population,
    capability: RECOVERY_RETRY_CAPABILITY[population],
    retry: async () => ({ status: "unavailable", reason: RECOVERY_DOMAIN_ADAPTER_UNAVAILABLE_REASON[population] }),
  }
}

export function createRecoveryDomainAdapterRegistry(adapters: ReadonlyArray<RecoveryDomainAdapter>): RecoveryDomainAdapterRegistry {
  const registry = new Map<RecoveryPopulationType, RecoveryDomainAdapter>()
  for (const adapter of adapters) {
    if (registry.has(adapter.population_type)) {
      throw new Error(`[recovery-domain-adapters] podwójna rejestracja ${adapter.population_type}`)
    }
    registry.set(adapter.population_type, adapter)
  }
  return registry
}

export const DEFAULT_RECOVERY_DOMAIN_ADAPTERS = createRecoveryDomainAdapterRegistry([
  unavailableAdapter("compensation_failure"),
  unavailableAdapter("deferred_issuance_trace"),
  unavailableAdapter("dlq_entry"),
])

let activeRegistry: RecoveryDomainAdapterRegistry = DEFAULT_RECOVERY_DOMAIN_ADAPTERS

export function activeRecoveryDomainAdapters(): RecoveryDomainAdapterRegistry {
  return activeRegistry
}

/** Nazwany kod porażki adaptera, który rzucił wyjątek (R-13). */
export const RECOVERY_DOMAIN_ADAPTER_THREW_REASON = "adapter_threw"

/**
 * R-13: widok wyniku adaptera dla ciała HTTP — bez `detail` (szczegół tylko w audycie kroku).
 */
export function publicDomainAdapterResult(result: RecoveryDomainAdapterResult): RecoveryDomainAdapterResult {
  if (!("detail" in result)) return result
  const { detail: _detail, ...rest } = result
  return rest as RecoveryDomainAdapterResult
}

/** Szew testowy (jak `__setKnexForAdminMarketTests`); `undefined` przywraca rejestr domyślny. */
export function __setRecoveryDomainAdaptersForTests(registry: RecoveryDomainAdapterRegistry | undefined): void {
  activeRegistry = registry ?? DEFAULT_RECOVERY_DOMAIN_ADAPTERS
}

/**
 * Wywołanie adaptera pod SAVEPOINT-em: wyjątek albo `failed` cofa skutki adaptera,
 * ale NIE przerywa transakcji akcji — wynik idzie do audytu kroku jako nazwana
 * przyczyna (NFR-4: wyjątek nie ginie, staje się `failed` z treścią).
 */
export async function invokeRecoveryDomainAdapter(
  adapter: RecoveryDomainAdapter | undefined,
  input: RecoveryDomainAdapterInput
): Promise<RecoveryDomainAdapterResult> {
  if (!adapter) return { status: "unavailable", reason: "domain_adapter_not_registered" }
  const { client } = input
  await client.query("SAVEPOINT recovery_domain_adapter", [])
  let result: RecoveryDomainAdapterResult
  try {
    result = await adapter.retry(input)
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT recovery_domain_adapter", [])
    // R-13 (runda fix 2): do odpowiedzi idzie tylko nazwany kod; treść wyjątku (np. komunikat
    // PG/PSP) zostaje w `detail`, który trafia wyłącznie do audytu kroku (HTTP go zdejmuje).
    return {
      status: "failed",
      reason: RECOVERY_DOMAIN_ADAPTER_THREW_REASON,
      detail: { error_message: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
    }
  }
  if (result.status === "failed") await client.query("ROLLBACK TO SAVEPOINT recovery_domain_adapter", [])
  else await client.query("RELEASE SAVEPOINT recovery_domain_adapter", [])
  if (result.status === "succeeded" && !(typeof result.reference === "string" && result.reference.trim())) {
    return { status: "failed", reason: "adapter_succeeded_without_result_reference" }
  }
  return result
}
