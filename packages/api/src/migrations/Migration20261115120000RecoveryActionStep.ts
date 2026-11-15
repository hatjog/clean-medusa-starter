import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 11.3 (FR-11, FR-12, FR-14, AD-48, AD-49, NFR-3; D-35 p.16, D-37).
 *
 * Stempel `20261115120000` pochodzi z rejestru
 * `specs/releases/v1.16.0/migration-registry.yaml` (`story_id: "11.3"`).
 *
 *  1. `recovery_action_step` — APPEND-ONLY rejestr kroków akcji recovery.
 *     D-37: akcję wykonuje ten sam aktor w dwóch krokach (`propose` → `approve`)
 *     z OSOBNYMI kluczami idempotencji; oba kroki (także odmowy i powtórki) mają
 *     wiersz audytu. Unikalność `(instance_id, market_id, step_key)` obejmuje
 *     wyłącznie kroki przyjęte (`step_key IS NOT NULL`) — to jest trwały claim
 *     ledgeru idempotencji (DW-15-252 p.1). Runtime (`medusa_store`) ma tylko
 *     SELECT i INSERT: wiersza audytu nie da się poprawić ani usunąć.
 *  2. `mor_policy_dlq_entry` — runtime dostaje UPDATE WYŁĄCZNIE na kolumnach
 *     zamknięcia (stan, wersja, licznik, evidence, ścieżka zamknięcia). Kolumny
 *     faktu (event_id, reason, klasyfikacja) pozostają nietykalne na poziomie bazy.
 *
 * Polityka `market_isolation` ma ten sam predykat co trzy tabele populacji
 * (GUC `app.gp_instance_id` + `app.gp_market_id`), z FORCE RLS.
 */
export const RECOVERY_ACTION_STEP_MIGRATION = "Migration20261115120000RecoveryActionStep" as const
export const RECOVERY_ACTION_STEP_TABLE = "recovery_action_step" as const
export const DLQ_RUNTIME_CLOSURE_COLUMNS = [
  "state",
  "version",
  "retry_count",
  "resolution_evidence",
  "closure_path",
] as const

const TABLE = RECOVERY_ACTION_STEP_TABLE
const DLQ = "mor_policy_dlq_entry"
const RUNTIME_ROLE = "medusa_store"
const MIGRATION_ROLE = "gp_runtime_recovery_migrator"
const MARKET_SETTING = "current_setting('app.gp_market_id', true)"
const INSTANCE_SETTING = "current_setting('app.gp_instance_id', true)"

export const RECOVERY_ACTION_STEP_OUTCOMES = [
  "proposed",
  "applied",
  "replayed",
  "refused_unauthenticated",
  "refused_market_forbidden",
  "refused_version_conflict",
  "refused_invalid_transition",
  "refused_missing_evidence",
  "refused_proposal_missing",
  "refused_proposal_actor_mismatch",
] as const

export class Migration20261115120000RecoveryActionStep extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATION_ROLE}') THEN
          CREATE ROLE ${MIGRATION_ROLE} NOLOGIN NOBYPASSRLS;
        END IF;
      END
      $$
    `)
    this.addSql(`GRANT ${MIGRATION_ROLE} TO CURRENT_USER`)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        audit_id          TEXT PRIMARY KEY,
        instance_id       TEXT NOT NULL CHECK (btrim(instance_id) <> ''),
        market_id         TEXT NOT NULL CHECK (btrim(market_id) <> ''),
        step              TEXT NOT NULL CHECK (step IN ('propose', 'approve')),
        step_key          TEXT NULL,
        intent_key        TEXT NOT NULL CHECK (btrim(intent_key) <> ''),
        population_type   TEXT NOT NULL
                          CHECK (population_type IN ('compensation_failure', 'deferred_issuance_trace', 'dlq_entry')),
        population_id     TEXT NOT NULL CHECK (btrim(population_id) <> ''),
        action            TEXT NOT NULL,
        target_state      TEXT NULL,
        expected_version  INTEGER NOT NULL CHECK (expected_version >= 1),
        actor_id          TEXT NOT NULL CHECK (btrim(actor_id) <> ''),
        actor             JSONB NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (${RECOVERY_ACTION_STEP_OUTCOMES.map((o) => `'${o}'`).join(", ")})),
        resolution_evidence JSONB NULL,
        audit             JSONB NOT NULL,
        recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ${TABLE}_claim_check CHECK (
          (step_key IS NULL) = (outcome NOT IN ('proposed', 'applied'))
        )
      )
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_claim_idx
        ON ${TABLE} (instance_id, market_id, step_key) WHERE step_key IS NOT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS ${TABLE}_population_idx
        ON ${TABLE} (instance_id, market_id, population_type, population_id, recorded_at)
    `)

    this.addSql(`ALTER TABLE ${TABLE} OWNER TO ${MIGRATION_ROLE}`)
    this.addSql(`SET ROLE ${MIGRATION_ROLE}`)
    this.addSql(`REVOKE ALL PRIVILEGES ON ${TABLE} FROM ${RUNTIME_ROLE}`)
    this.addSql(`GRANT SELECT, INSERT ON ${TABLE} TO ${RUNTIME_ROLE}`)
    this.addSql(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`)
    this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${TABLE}`)
    this.addSql(`
      CREATE POLICY market_isolation ON ${TABLE}
        TO ${RUNTIME_ROLE}
        USING (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
        WITH CHECK (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
    `)
    // Kolumnowy UPDATE zamknięcia na DLQ (właściciel tabeli = rola migracyjna).
    this.addSql(`GRANT UPDATE (${DLQ_RUNTIME_CLOSURE_COLUMNS.join(", ")}) ON ${DLQ} TO ${RUNTIME_ROLE}`)
    this.addSql(`RESET ROLE`)
    this.addSql(`REVOKE ${MIGRATION_ROLE} FROM CURRENT_USER`)
  }

  async down(): Promise<void> {
    this.addSql(`GRANT ${MIGRATION_ROLE} TO CURRENT_USER`)
    this.addSql(`SET ROLE ${MIGRATION_ROLE}`)
    this.addSql(`REVOKE UPDATE (${DLQ_RUNTIME_CLOSURE_COLUMNS.join(", ")}) ON ${DLQ} FROM ${RUNTIME_ROLE}`)
    this.addSql(`RESET ROLE`)
    this.addSql(`REVOKE ${MIGRATION_ROLE} FROM CURRENT_USER`)
    this.addSql(`DROP TABLE IF EXISTS ${TABLE}`)
  }
}
