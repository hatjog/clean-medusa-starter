import { Migration } from "@medusajs/framework/mikro-orm/migrations"

import { resolveRuntimeInstanceId } from "../lib/market-context"

/**
 * v1.16.0 Story 4.2 (FR-11, AD-32, AD-44, NFR-3) — wiersz porażki kompensacji
 * dostaje `instance_id`, właściciela, termin i rozszerzony stan rozwiązania.
 *
 * Stempel `20261114120000` pochodzi z rejestru
 * `specs/releases/v1.16.0/migration-registry.yaml` (`story_id: "4.2"`).
 * Migracja 20260818090000 (Story 3.5) pozostaje nietknięta — to jest ALTER.
 *
 * Plan wycofania i kształt kroków: ADR-221 (tabela planu migracji, wiersz
 * `money_path_compensation_failure`) z amendmentem ADR-238 (Proposed) oraz
 * `lib/recovery/recovery-migration-plan.ts` (kroki `cf-*`).
 *
 * ── Wiersze zastane (D-35 p.9) ─────────────────────────────────────────────
 * Nie istnieje dziś certyfikowane źródło ownera/terminu per `failure_id`, więc
 * krok `cf-backfill` z ADR-221 nie kwalifikuje żadnego wiersza: KAŻDY wiersz
 * zastany trafia atomowo (INSERT + DELETE) do
 * `money_path_compensation_failure_backfill_quarantine`. Wiersz kwarantanny
 * niesie jawny stan backfillu `quarantined_pending_review`, ownera
 * `operator_role/ops-recovery`, termin = chwila migracji + 24 h (SLA D-35 p.9)
 * oraz `instance_id` z NAZWANEGO źródła (`GP_INSTANCE_ID` procesu migracji).
 * Tabela populacji nie dostaje żadnej wartości zastępczej.
 *
 * Brak `GP_INSTANCE_ID` przy istniejących wierszach zastanych = migracja
 * przerywa się wyjątkiem (fail-closed, bez placeholdera).
 */

export const COMPENSATION_FAILURE_RECOVERY_MIGRATION =
  "Migration20261114120000MoneyPathCompensationFailureRecoveryColumns" as const

const TABLE = "money_path_compensation_failure"
const QUARANTINE = `${TABLE}_backfill_quarantine`
const RUNTIME_ROLE = "medusa_store"
const MIGRATION_ROLE = "gp_runtime_recovery_migrator"
const MARKET_SETTING = "current_setting('app.gp_market_id', true)"
const INSTANCE_SETTING = "current_setting('app.gp_instance_id', true)"

/** Nazwane źródło `instance_id` wiersza zastanego w kwarantannie. */
export const LEGACY_INSTANCE_ID_BACKFILL_SOURCE =
  `env:GP_INSTANCE_ID@${COMPENSATION_FAILURE_RECOVERY_MIGRATION}` as const
/** Jawny stan backfillu wiersza zastanego (nie NULL, nie „nierozstrzygnięte"). */
export const LEGACY_BACKFILL_STATE = "quarantined_pending_review" as const
export const LEGACY_BACKFILL_OWNER = { owner_type: "operator_role", owner_id: "ops-recovery" } as const
export const LEGACY_BACKFILL_SLA_HOURS = 24
export const LEGACY_BACKFILL_REASON =
  "D-35 p.9: no certified owner/deadline/resolver source for legacy row; quarantined for ops-recovery review" as const

export const RECOVERY_RESOLUTION_STATES = [
  "open",
  "resolved_manually",
  "recovery_in_progress",
  "resolved_recovered",
  "closed_unrecoverable",
  "closed_legacy_unevidenced",
] as const

const STATE_LIST = RECOVERY_RESOLUTION_STATES.map((s) => `'${s}'`).join(", ")

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export class Migration20261114120000MoneyPathCompensationFailureRecoveryColumns extends Migration {
  async up(): Promise<void> {
    const instanceId = resolveRuntimeInstanceId()
    const instanceLiteral = instanceId === null ? "NULL" : sqlLiteral(instanceId)

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

    // cf-add-columns
    this.addSql(`
      ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS instance_id TEXT,
        ADD COLUMN IF NOT EXISTS owner_type TEXT,
        ADD COLUMN IF NOT EXISTS owner_id TEXT,
        ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS closure_path TEXT,
        ADD COLUMN IF NOT EXISTS resolution_evidence JSONB,
        ADD COLUMN IF NOT EXISTS provenance_kind TEXT,
        ADD COLUMN IF NOT EXISTS provenance_source TEXT
    `)
    // AC2: stan pochodzi z enumu i NIE ma wartości domyślnej.
    this.addSql(`ALTER TABLE ${TABLE} ALTER COLUMN resolution_state DROP DEFAULT`)

    // cf-widen-state-check (zachowuje `resolved_manually`; zawężenie po remapie
    // wymaga certyfikowanego źródła — ADR-238 §3).
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_state_check`)
    this.addSql(`
      ALTER TABLE ${TABLE} ADD CONSTRAINT money_path_compensation_failure_state_check
        CHECK (resolution_state IN (${STATE_LIST}))
    `)
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_resolution_check`)
    this.addSql(`
      ALTER TABLE ${TABLE} ADD CONSTRAINT money_path_compensation_failure_resolution_check
        CHECK (
          (resolution_state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
          OR (resolution_state = 'resolved_manually' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
          OR resolution_state IN ('recovery_in_progress', 'resolved_recovered', 'closed_unrecoverable', 'closed_legacy_unevidenced')
        )
    `)
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_owner_type_check`)
    this.addSql(`
      ALTER TABLE ${TABLE} ADD CONSTRAINT money_path_compensation_failure_owner_type_check
        CHECK (owner_type IN ('operator_role', 'operator_user'))
    `)
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_provenance_kind_check`)
    this.addSql(`
      ALTER TABLE ${TABLE} ADD CONSTRAINT money_path_compensation_failure_provenance_kind_check
        CHECK (provenance_kind IN ('runtime_observed', 'backfilled_verified'))
    `)

    // cf-create-quarantine (kształt rozszerzony o D-35 p.9 — ADR-238 §2)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${QUARANTINE} (
        source_failure_id  TEXT PRIMARY KEY,
        source_row         JSONB NOT NULL,
        reason             TEXT NOT NULL,
        quarantined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        market_id          TEXT NOT NULL,
        instance_id        TEXT NOT NULL,
        instance_id_source TEXT NOT NULL,
        backfill_state     TEXT NOT NULL,
        owner_type         TEXT NOT NULL,
        owner_id           TEXT NOT NULL,
        deadline           TIMESTAMPTZ NOT NULL,
        CONSTRAINT ${QUARANTINE}_state_check
          CHECK (backfill_state IN ('${LEGACY_BACKFILL_STATE}')),
        CONSTRAINT ${QUARANTINE}_owner_type_check
          CHECK (owner_type IN ('operator_role', 'operator_user'))
      )
    `)

    // cf-backfill: brak certyfikowanego źródła ⇒ każdy wiersz zastany do
    // kwarantanny, atomowo (INSERT + DELETE w jednym poleceniu).
    this.addSql(`
      DO $$
      DECLARE legacy_rows integer;
      BEGIN
        SELECT count(*) INTO legacy_rows FROM ${TABLE} WHERE instance_id IS NULL;
        IF legacy_rows > 0 AND ${instanceLiteral}::text IS NULL THEN
          RAISE EXCEPTION 'Story 4.2: % legacy compensation failure row(s) require GP_INSTANCE_ID as the named instance_id backfill source', legacy_rows;
        END IF;
      END
      $$
    `)
    this.addSql(`
      WITH quarantined AS (
        INSERT INTO ${QUARANTINE}
          (source_failure_id, source_row, reason, market_id, instance_id,
           instance_id_source, backfill_state, owner_type, owner_id, deadline)
        SELECT c.failure_id, to_jsonb(c), ${sqlLiteral(LEGACY_BACKFILL_REASON)}, c.market_id,
               ${instanceLiteral}, ${sqlLiteral(LEGACY_INSTANCE_ID_BACKFILL_SOURCE)},
               '${LEGACY_BACKFILL_STATE}', '${LEGACY_BACKFILL_OWNER.owner_type}',
               '${LEGACY_BACKFILL_OWNER.owner_id}', now() + interval '${LEGACY_BACKFILL_SLA_HOURS} hours'
          FROM ${TABLE} c
         WHERE c.instance_id IS NULL
        ON CONFLICT (source_failure_id) DO NOTHING
        RETURNING source_failure_id
      )
      DELETE FROM ${TABLE} c USING quarantined q WHERE c.failure_id = q.source_failure_id
    `)

    // cf-set-not-null — warunek wstępny: zero NULL-i (wszystkie zastane w kwarantannie).
    this.addSql(`
      ALTER TABLE ${TABLE}
        ALTER COLUMN instance_id SET NOT NULL,
        ALTER COLUMN owner_type SET NOT NULL,
        ALTER COLUMN owner_id SET NOT NULL,
        ALTER COLUMN deadline SET NOT NULL,
        ALTER COLUMN closure_path SET NOT NULL,
        ALTER COLUMN provenance_kind SET NOT NULL,
        ALTER COLUMN provenance_source SET NOT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_money_path_compensation_failure_scope
        ON ${TABLE} (instance_id, market_id)
    `)

    // Granica RLS zgodna z 11.1: właściciel = rola migracyjna, runtime pod polityką.
    for (const table of [TABLE, QUARANTINE]) {
      this.addSql(`ALTER TABLE ${table} OWNER TO ${MIGRATION_ROLE}`)
    }
    this.addSql(`SET ROLE ${MIGRATION_ROLE}`)
    for (const table of [TABLE, QUARANTINE]) {
      this.addSql(`REVOKE ALL PRIVILEGES ON ${table} FROM ${RUNTIME_ROLE}`)
      this.addSql(
        table === TABLE
          ? `GRANT SELECT, INSERT, UPDATE ON ${table} TO ${RUNTIME_ROLE}`
          : `GRANT SELECT ON ${table} TO ${RUNTIME_ROLE}`
      )
      this.addSql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${table}`)
      this.addSql(`
        CREATE POLICY market_isolation ON ${table}
          TO ${RUNTIME_ROLE}
          USING (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
          WITH CHECK (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
      `)
    }
    this.addSql(`RESET ROLE`)
    this.addSql(`REVOKE ${MIGRATION_ROLE} FROM CURRENT_USER`)
  }

  /**
   * Plan wycofania ADR-221 + ADR-238 §4. Odmawia (wyjątek), gdy istnieje wiersz
   * w stanie spoza słownika legacy — taki wiersz nie ma reprezentacji w starym
   * schemacie, a jego skasowanie byłoby utratą faktu.
   */
  async down(): Promise<void> {
    this.addSql(`
      DO $$
      DECLARE runtime_rows integer;
      BEGIN
        SELECT count(*) INTO runtime_rows FROM ${TABLE}
         WHERE resolution_state NOT IN ('open', 'resolved_manually');
        IF runtime_rows > 0 THEN
          RAISE EXCEPTION 'Story 4.2 rollback refused: % row(s) in post-migration resolution_state cannot be represented by the legacy schema', runtime_rows;
        END IF;
      END
      $$
    `)
    this.addSql(`GRANT ${MIGRATION_ROLE} TO CURRENT_USER`)
    this.addSql(`SET ROLE ${MIGRATION_ROLE}`)
    this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${TABLE}`)
    this.addSql(`ALTER TABLE ${TABLE} NO FORCE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${TABLE} DISABLE ROW LEVEL SECURITY`)
    this.addSql(`REVOKE ALL PRIVILEGES ON ${TABLE} FROM ${RUNTIME_ROLE}`)
    this.addSql(`RESET ROLE`)
    // Symetria z up() (ADR-238 §4): stan uprawnień sprzed 4.2 = właściciel to
    // wykonawca migracji, a runtime ma szerokie granty provisioningu 003
    // (SELECT, INSERT, UPDATE, DELETE, bez RLS).
    this.addSql(`ALTER TABLE ${TABLE} OWNER TO CURRENT_USER`)
    this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${RUNTIME_ROLE}`)
    this.addSql(`DROP INDEX IF EXISTS idx_money_path_compensation_failure_scope`)
    // cf-unset-not-null
    this.addSql(`
      ALTER TABLE ${TABLE}
        ALTER COLUMN instance_id DROP NOT NULL,
        ALTER COLUMN owner_type DROP NOT NULL,
        ALTER COLUMN owner_id DROP NOT NULL,
        ALTER COLUMN deadline DROP NOT NULL,
        ALTER COLUMN closure_path DROP NOT NULL,
        ALTER COLUMN provenance_kind DROP NOT NULL,
        ALTER COLUMN provenance_source DROP NOT NULL
    `)
    // cf-unbackfill: odtworzenie przeniesionych source rows PRZED dropem kwarantanny.
    this.addSql(`
      DO $$
      BEGIN
        IF to_regclass('${QUARANTINE}') IS NOT NULL THEN
          INSERT INTO ${TABLE}
          SELECT (jsonb_populate_record(NULL::${TABLE}, q.source_row)).*
            FROM ${QUARANTINE} q
          ON CONFLICT (failure_id) DO NOTHING;
        END IF;
      END
      $$
    `)
    // cf-drop-quarantine
    this.addSql(`DROP TABLE IF EXISTS ${QUARANTINE}`)
    // cf-restore-state-check
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_provenance_kind_check`)
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_owner_type_check`)
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_state_check`)
    this.addSql(`
      ALTER TABLE ${TABLE} ADD CONSTRAINT money_path_compensation_failure_state_check
        CHECK (resolution_state IN ('open', 'resolved_manually'))
    `)
    this.addSql(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS money_path_compensation_failure_resolution_check`)
    this.addSql(`
      ALTER TABLE ${TABLE} ADD CONSTRAINT money_path_compensation_failure_resolution_check
        CHECK (
          (resolution_state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
          OR (resolution_state = 'resolved_manually' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
        )
    `)
    this.addSql(`ALTER TABLE ${TABLE} ALTER COLUMN resolution_state SET DEFAULT 'open'`)
    // cf-drop-columns
    this.addSql(`
      ALTER TABLE ${TABLE}
        DROP COLUMN IF EXISTS instance_id,
        DROP COLUMN IF EXISTS owner_type,
        DROP COLUMN IF EXISTS owner_id,
        DROP COLUMN IF EXISTS deadline,
        DROP COLUMN IF EXISTS retry_count,
        DROP COLUMN IF EXISTS version,
        DROP COLUMN IF EXISTS closure_path,
        DROP COLUMN IF EXISTS resolution_evidence,
        DROP COLUMN IF EXISTS provenance_kind,
        DROP COLUMN IF EXISTS provenance_source
    `)
    this.addSql(`REVOKE ${MIGRATION_ROLE} FROM CURRENT_USER`)
  }
}
