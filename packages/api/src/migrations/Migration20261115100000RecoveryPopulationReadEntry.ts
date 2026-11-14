import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 4.7 (FR-11/FR-12/FR-14, AD-31, AD-22, NFR-3; ADR-244 Proposed).
 *
 * Jedyna migracja schematu partii B4 (D-35 p.16). Zakres jest wąski i addytywny:
 *
 *  1. `mor_policy_dlq_entry.population_id` — identyfikator populacji zgodny z
 *     `recovery-population.v1.schema.json#/$defs/population_id`. Klucz writera
 *     DLQ (`instance|market|source_job|event|subject`) zawiera `|`, którego wzorzec
 *     kontraktu nie dopuszcza, więc wejście odczytu nie mogłoby oddać wiersza DLQ
 *     w kształcie 4.1. Kolumna jest GENEROWANA (md5 klucza writera — funkcja IMMUTABLE wymagana przez kolumnę generowaną; identyfikator, nie zabezpieczenie) — writer
 *     4.6 nie zmienia się, wartość jest deterministyczna i unikalna.
 *  2. Retencja kwarantann backfillu: 2555 dni BEZ sweepa (D-35 p.10). Kolumna
 *     `retention_until` jest datą, przed którą wiersza nie wolno usunąć; żaden
 *     job jej nie czyta i nic nie kasuje.
 *  3. Kwarantanna śladu płatności (4.4) dostaje właściciela `ops-recovery`
 *     i termin 24 h od kwarantanny (D-35 p.9), jak kwarantanna kompensacji (4.2).
 *
 * Polityki RLS trzech tabel populacji NIE są zmieniane (predykat
 * `instance_id`/`market_id` z GUC zostaje — asercja `pg_policies` w teście PG 4.7).
 */
export const RECOVERY_POPULATION_READ_MIGRATION = "Migration20261115100000RecoveryPopulationReadEntry" as const

export const QUARANTINE_RETENTION_DAYS = 2555
export const DLQ_POPULATION_ID_PREFIX = "dlq_" as const
export const TRACE_QUARANTINE_OWNER = { owner_type: "operator_role", owner_id: "ops-recovery" } as const
export const TRACE_QUARANTINE_SLA_HOURS = 24

const DLQ = "mor_policy_dlq_entry"
const MPCF_QUARANTINE = "money_path_compensation_failure_backfill_quarantine"
const DIT_QUARANTINE = "deferred_issuance_trace_backfill_quarantine"

export class Migration20261115100000RecoveryPopulationReadEntry extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE ${DLQ}
        ADD COLUMN IF NOT EXISTS population_id TEXT
        GENERATED ALWAYS AS ('${DLQ_POPULATION_ID_PREFIX}' || md5(dlq_entry_id)) STORED
    `)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS ${DLQ}_population_id_idx ON ${DLQ} (population_id)`)

    for (const table of [MPCF_QUARANTINE, DIT_QUARANTINE]) {
      this.addSql(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ`)
      this.addSql(
        `UPDATE ${table} SET retention_until = quarantined_at + interval '${QUARANTINE_RETENTION_DAYS} days' WHERE retention_until IS NULL`
      )
      this.addSql(
        `ALTER TABLE ${table} ALTER COLUMN retention_until SET DEFAULT (now() + interval '${QUARANTINE_RETENTION_DAYS} days')`
      )
      this.addSql(`ALTER TABLE ${table} ALTER COLUMN retention_until SET NOT NULL`)
    }

    this.addSql(`
      ALTER TABLE ${DIT_QUARANTINE}
        ADD COLUMN IF NOT EXISTS owner_type TEXT,
        ADD COLUMN IF NOT EXISTS owner_id TEXT,
        ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ
    `)
    this.addSql(`
      UPDATE ${DIT_QUARANTINE}
         SET owner_type = COALESCE(owner_type, '${TRACE_QUARANTINE_OWNER.owner_type}'),
             owner_id = COALESCE(owner_id, '${TRACE_QUARANTINE_OWNER.owner_id}'),
             deadline = COALESCE(deadline, quarantined_at + interval '${TRACE_QUARANTINE_SLA_HOURS} hours')
    `)
    this.addSql(`
      ALTER TABLE ${DIT_QUARANTINE}
        ALTER COLUMN owner_type SET DEFAULT '${TRACE_QUARANTINE_OWNER.owner_type}',
        ALTER COLUMN owner_id SET DEFAULT '${TRACE_QUARANTINE_OWNER.owner_id}',
        ALTER COLUMN deadline SET DEFAULT (now() + interval '${TRACE_QUARANTINE_SLA_HOURS} hours'),
        ALTER COLUMN owner_type SET NOT NULL,
        ALTER COLUMN owner_id SET NOT NULL,
        ALTER COLUMN deadline SET NOT NULL
    `)
    this.addSql(`ALTER TABLE ${DIT_QUARANTINE} DROP CONSTRAINT IF EXISTS ${DIT_QUARANTINE}_owner_type_check`)
    this.addSql(`
      ALTER TABLE ${DIT_QUARANTINE} ADD CONSTRAINT ${DIT_QUARANTINE}_owner_type_check
        CHECK (owner_type IN ('operator_role', 'operator_user') AND btrim(owner_id) <> '')
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE ${DIT_QUARANTINE} DROP CONSTRAINT IF EXISTS ${DIT_QUARANTINE}_owner_type_check`)
    this.addSql(`
      ALTER TABLE ${DIT_QUARANTINE}
        DROP COLUMN IF EXISTS deadline,
        DROP COLUMN IF EXISTS owner_id,
        DROP COLUMN IF EXISTS owner_type
    `)
    for (const table of [DIT_QUARANTINE, MPCF_QUARANTINE]) {
      this.addSql(`ALTER TABLE ${table} DROP COLUMN IF EXISTS retention_until`)
    }
    this.addSql(`DROP INDEX IF EXISTS ${DLQ}_population_id_idx`)
    this.addSql(`ALTER TABLE ${DLQ} DROP COLUMN IF EXISTS population_id`)
  }
}
