import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 4.6 — trwały nośnik populacji (c) DLQ (AD-32, AD-44, FR-14, NFR-4).
 *
 * Kształt tabeli jest krokiem `dlq-create-table` planu ADR-221
 * (`lib/recovery/recovery-migration-plan.ts`) rozszerzonym o kolumny wiązania
 * zdarzenia (`event_id`, `subject_id`, `event_class`) — decyzja w ADR-239.
 *
 * Granice tej migracji (D-35 p.16):
 *  - WYŁĄCZNIE `CREATE TABLE` nowej tabeli + RLS; bez ALTER istniejących tabel
 *    i bez snapshotu modułu;
 *  - backfill jest jawnie PUSTY — dzisiejsza klasyfikacja nie miała nośnika,
 *    więc nie ma czego przenosić (ADR-221 §5);
 *  - granica RLS jak w Story 11.1 (`1779016000000`): właściciel
 *    `gp_runtime_recovery_migrator`, polityka `market_isolation` TO
 *    `medusa_store` na OBU osiach (`app.gp_instance_id`, `app.gp_market_id`),
 *    runtime ma wyłącznie SELECT + INSERT (zamknięcie wiersza to akcja 11.3).
 *
 * `classification` jest rozłączna (`retryable` / `terminal`) i spójna z `tier`
 * oraz `is_retryable` CHECK-iem — nie istnieje wiersz „spróbuj jeszcze raz”
 * bez klasy. `event_class = 'transient_retry'` jest zabronione: wada przejściowa
 * idzie do ponowienia, nigdy do DLQ.
 */
const TABLE = "mor_policy_dlq_entry"
const MARKET_SETTING = "current_setting('app.gp_market_id', true)"
const INSTANCE_SETTING = "current_setting('app.gp_instance_id', true)"
const RUNTIME_ROLE = "medusa_store"
const MIGRATION_ROLE = "gp_runtime_recovery_migrator"

export class Migration1779018600000 extends Migration {
  async up(): Promise<void> {
    // Rola runtime MUSI istnieć — bez niej polityka TO medusa_store nie ma
    // adresata, a cicha kreacja roli byłaby wymyśleniem tożsamości (fail-closed).
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          RAISE EXCEPTION 'Story 4.6: rola runtime ${RUNTIME_ROLE} nie istnieje — odmowa utworzenia nośnika DLQ bez adresata RLS';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATION_ROLE}') THEN
          CREATE ROLE ${MIGRATION_ROLE} NOLOGIN NOBYPASSRLS;
        END IF;
      END
      $$
    `)
    this.addSql(`ALTER ROLE ${MIGRATION_ROLE} NOLOGIN NOBYPASSRLS`)
    this.addSql(`GRANT ${MIGRATION_ROLE} TO CURRENT_USER`)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        dlq_entry_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL CHECK (btrim(instance_id) <> ''),
        market_id TEXT NOT NULL CHECK (btrim(market_id) <> ''),
        state TEXT NOT NULL CHECK (state IN ('dlq_pending_retry','dlq_pending_ops_review','replayed','discarded_with_evidence')),
        owner_type TEXT NOT NULL CHECK (owner_type IN ('operator_role','operator_user')),
        owner_id TEXT NOT NULL CHECK (btrim(owner_id) <> ''),
        deadline TIMESTAMPTZ NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        occurred_at TIMESTAMPTZ NOT NULL,
        closure_path TEXT NOT NULL CHECK (closure_path IN ('not_closed','operator_action','automatic_recovery')),
        resolution_evidence JSONB,
        provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('runtime_observed','backfilled_verified')),
        provenance_source TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('dlq_pending_retry','dlq_pending_ops_review')),
        classification TEXT NOT NULL CHECK (classification IN ('retryable','terminal')),
        failure_mode TEXT NOT NULL CHECK (failure_mode ~ '^FM-71-(RT-([1-9]|10)|DLQ-[12])$'),
        sqlstate TEXT CHECK (sqlstate IS NULL OR sqlstate ~ '^[0-9A-Z]{5}$'),
        is_retryable BOOLEAN NOT NULL,
        reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
        source_job TEXT NOT NULL CHECK (btrim(source_job) <> ''),
        event_class TEXT NOT NULL CHECK (event_class IN ('permanent_data_defect','unknown_fail_closed')),
        event_id TEXT NOT NULL CHECK (btrim(event_id) <> ''),
        subject_id TEXT NOT NULL CHECK (btrim(subject_id) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ${TABLE}_classification_disjoint CHECK (
          (classification = 'retryable' AND tier = 'dlq_pending_retry' AND is_retryable)
          OR (classification = 'terminal' AND tier = 'dlq_pending_ops_review' AND NOT is_retryable)
        ),
        CONSTRAINT ${TABLE}_evidence_terminal CHECK (
          (state IN ('replayed','discarded_with_evidence')) = (resolution_evidence IS NOT NULL)
        ),
        CONSTRAINT ${TABLE}_event_subject_unique UNIQUE (source_job, event_id, subject_id)
      )
    `)
    this.addSql(`CREATE INDEX IF NOT EXISTS ${TABLE}_instance_market_state_idx ON ${TABLE} (instance_id, market_id, state)`)
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
    this.addSql(`COMMENT ON TABLE ${TABLE} IS 'Story 4.6 / ADR-239: populacja (c) DLQ (AD-32); wada przejściowa nigdy tu nie trafia; runtime INSERT-only'`)
    this.addSql(`RESET ROLE`)
    this.addSql(`REVOKE ${MIGRATION_ROLE} FROM CURRENT_USER`)
  }

  async down(): Promise<void> {
    // Krok `dlq-drop-table` planu ADR-221 (odwrotność `dlq-create-table`).
    this.addSql(`DROP TABLE IF EXISTS ${TABLE}`)
  }
}
