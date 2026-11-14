/**
 * event-dead-letter.ts — v1.16.0 Story 4.6 (AD-32, AD-44; ADR-239).
 *
 * Zapis wiersza populacji (c) DLQ do `mor_policy_dlq_entry`
 * (migracja `1779018600000_create_mor_policy_dlq_entry`).
 *
 *  - Odmawia klasy `transient_retry` (wada przejściowa idzie do ponowienia).
 *  - Odmawia wiersza bez `instance_id`/`market_id` — nośnik jest pod RLS na
 *    obu osiach, a scope NIE jest zgadywany (AD-44).
 *  - Ustawia GUC scope'u lokalnie dla transakcji (jak pool hook) i przywraca
 *    poprzednie wartości, żeby nie przestawić scope'u reszty transakcji.
 *  - Idempotentny: `dlq_entry_id` = `source_job|event_id|subject_id`,
 *    `ON CONFLICT DO NOTHING` — powtórka zdarzenia nie mnoży wierszy ani nie pętli.
 *  - Właściciel `operator_role:ops-recovery`, termin 24 h (decyzja PO D-35 p.9).
 */
import {
  isDeadLetterClass,
  type EventFailureClassification,
} from "./event-failure-classification"

export const DLQ_ENTRY_TABLE = "mor_policy_dlq_entry" as const
export const DLQ_DEFAULT_OWNER = { owner_type: "operator_role", owner_id: "ops-recovery" } as const
export const DLQ_DEADLINE_HOURS = 24

export type DlqQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

export type DeadLetterEntryInput = {
  instance_id: string | null
  market_id: string | null
  source_job: string
  event_id: string
  subject_id: string
  classification: EventFailureClassification
  occurred_at: Date
}

export class DeadLetterRefusedError extends Error {
  constructor(
    readonly refusal: "transient_not_dead_letter" | "scope_missing",
    message: string
  ) {
    super(message)
    this.name = "DeadLetterRefusedError"
  }
}

export const INSERT_DLQ_ENTRY_SQL = `
  INSERT INTO ${DLQ_ENTRY_TABLE} (
    dlq_entry_id, instance_id, market_id, state, owner_type, owner_id, deadline,
    occurred_at, closure_path, resolution_evidence, provenance_kind, provenance_source,
    tier, classification, failure_mode, sqlstate, is_retryable, reason, source_job,
    event_class, event_id, subject_id
  ) VALUES (
    $1, $2, $3, 'dlq_pending_ops_review', $4, $5, $6,
    $7, 'not_closed', NULL, 'runtime_observed', $8,
    'dlq_pending_ops_review', 'terminal', $9, $10, false, $11, $8,
    $12, $13, $14
  )
  ON CONFLICT DO NOTHING
  RETURNING dlq_entry_id`

export function dlqEntryId(sourceJob: string, eventId: string, subjectId: string): string {
  return `${sourceJob}|${eventId}|${subjectId}`
}

export async function recordEventDeadLetter(
  client: DlqQueryClient,
  input: DeadLetterEntryInput
): Promise<{ dlq_entry_id: string; inserted: boolean }> {
  if (!isDeadLetterClass(input.classification.event_class)) {
    throw new DeadLetterRefusedError(
      "transient_not_dead_letter",
      `[event-dead-letter] ${input.event_id}: klasa ${input.classification.event_class} idzie do ponowienia, nie do DLQ`
    )
  }
  const instanceId = input.instance_id?.trim() ?? ""
  const marketId = input.market_id?.trim() ?? ""
  if (!instanceId || !marketId) {
    throw new DeadLetterRefusedError(
      "scope_missing",
      `[event-dead-letter] ${input.event_id}: brak instance_id/market_id — wiersz DLQ pod RLS wymaga obu osi (AD-44)`
    )
  }

  const id = dlqEntryId(input.source_job, input.event_id, input.subject_id)
  const deadline = new Date(input.occurred_at.getTime() + DLQ_DEADLINE_HOURS * 3600 * 1000)

  const previous = await client.query<{ instance_id: string | null; market_id: string | null }>(
    "SELECT current_setting('app.gp_instance_id', true) AS instance_id, current_setting('app.gp_market_id', true) AS market_id"
  )
  const prior = previous.rows[0] ?? { instance_id: null, market_id: null }
  await setScope(client, instanceId, marketId)
  // Bez `finally`: po porażce INSERT transakcja jest przerwana i przywrócenie
  // zamaskowałoby właściwy błąd — ten idzie do wołającego bez zmian.
  {
    const result = await client.query<{ dlq_entry_id: string }>(INSERT_DLQ_ENTRY_SQL, [
      id,
      instanceId,
      marketId,
      DLQ_DEFAULT_OWNER.owner_type,
      DLQ_DEFAULT_OWNER.owner_id,
      deadline.toISOString(),
      input.occurred_at.toISOString(),
      input.source_job,
      input.classification.dlq.failure_mode,
      input.classification.dlq.sqlstate,
      input.classification.reason,
      input.classification.event_class,
      input.event_id,
      input.subject_id,
    ])
    await setScope(client, prior.instance_id ?? "", prior.market_id ?? "")
    return { dlq_entry_id: id, inserted: result.rows.length > 0 }
  }
}

async function setScope(client: DlqQueryClient, instanceId: string, marketId: string): Promise<void> {
  await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [instanceId])
  await client.query("SELECT set_config('app.gp_market_id', $1, true)", [marketId])
}
