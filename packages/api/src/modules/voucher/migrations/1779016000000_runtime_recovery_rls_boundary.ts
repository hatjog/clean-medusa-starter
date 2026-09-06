import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 11.1 — market scope dla claim/audit i biznesowej deduplikacji issuance.
 *
 * Historyczne wiersze bez udowodnionego rynku pozostają NULL. NULL oznacza
 * UNKNOWN i polityka RLS nie udostępnia go żadnemu marketowi; migracja nie
 * przypisuje domyślnego marketu ani nie wykonuje backfillu.
 */
const TABLES = [
  "voucher_claim_audit",
  "voucher_claim_binding",
  "event_processed",
] as const

const MARKET_SETTING = "current_setting('app.gp_market_id', true)"
const INSTANCE_SETTING = "current_setting('app.gp_instance_id', true)"
const RUNTIME_ROLE = "medusa_store"
const MIGRATION_ROLE = "gp_runtime_recovery_migrator"

function runtimeGrant(table: (typeof TABLES)[number]): string {
  if (table === "voucher_claim_binding") {
    return `GRANT SELECT, INSERT, UPDATE ON ${table} TO ${RUNTIME_ROLE}`
  }
  return `GRANT SELECT, INSERT ON ${table} TO ${RUNTIME_ROLE}`
}

export class Migration1779016000000 extends Migration {
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
    this.addSql(`ALTER ROLE ${MIGRATION_ROLE} NOLOGIN NOBYPASSRLS`)

    for (const table of TABLES) {
      this.addSql(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS market_id text NULL`)
      this.addSql(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS instance_id text NULL`)
      this.addSql(`CREATE INDEX IF NOT EXISTS ${table}_market_id_idx ON ${table} (market_id)`)
      this.addSql(`CREATE INDEX IF NOT EXISTS ${table}_instance_market_id_idx ON ${table} (instance_id, market_id)`)
      this.addSql(`ALTER TABLE ${table} OWNER TO ${MIGRATION_ROLE}`)
      this.addSql(`REVOKE ALL PRIVILEGES ON ${table} FROM ${RUNTIME_ROLE}`)
      this.addSql(runtimeGrant(table))
      this.addSql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${table}`)
      this.addSql(`
        CREATE POLICY market_isolation ON ${table}
          TO medusa_store
          USING (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
          WITH CHECK (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
      `)
    }

    this.addSql(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)
    this.addSql(`ALTER TABLE voucher_claim_audit ADD COLUMN IF NOT EXISTS prev_row_hash text NULL`)
    this.addSql(`ALTER TABLE voucher_claim_audit ADD COLUMN IF NOT EXISTS content_hash text NULL`)
    this.addSql(`
      WITH RECURSIVE ordered AS (
        SELECT audit_id, idempotency_key, code, ip, outcome, occurred_at, created_at, instance_id, market_id,
               row_number() OVER (ORDER BY audit_id) AS position
        FROM voucher_claim_audit
      ), chain AS (
        SELECT audit_id, position, NULL::text AS prev_row_hash,
               encode(digest(jsonb_build_object(
                 'audit_id', audit_id, 'idempotency_key', idempotency_key, 'code', code,
                 'ip', ip, 'outcome', outcome, 'occurred_at', occurred_at,
                 'created_at', created_at, 'instance_id', instance_id, 'market_id', market_id,
                 'prev_row_hash', NULL
               )::text, 'sha256'), 'hex') AS content_hash
        FROM ordered WHERE position = 1
        UNION ALL
        SELECT next_row.audit_id, next_row.position, chain.content_hash AS prev_row_hash,
               encode(digest(jsonb_build_object(
                 'audit_id', next_row.audit_id, 'idempotency_key', next_row.idempotency_key,
                 'code', next_row.code, 'ip', next_row.ip, 'outcome', next_row.outcome,
                 'occurred_at', next_row.occurred_at, 'created_at', next_row.created_at,
                 'instance_id', next_row.instance_id, 'market_id', next_row.market_id,
                 'prev_row_hash', chain.content_hash
               )::text, 'sha256'), 'hex') AS content_hash
        FROM ordered next_row
        JOIN chain ON next_row.position = chain.position + 1
      )
      UPDATE voucher_claim_audit audit
         SET prev_row_hash = chain.prev_row_hash,
             content_hash = chain.content_hash
        FROM chain
       WHERE audit.audit_id = chain.audit_id
    `)
    this.addSql(`
      CREATE OR REPLACE FUNCTION public.gp_voucher_claim_audit_hash_chain()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE prior_hash text;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('public.voucher_claim_audit'));
        SELECT content_hash INTO prior_hash
          FROM voucher_claim_audit
         ORDER BY audit_id DESC
         LIMIT 1;
        NEW.prev_row_hash := prior_hash;
        NEW.content_hash := encode(digest(jsonb_build_object(
          'audit_id', NEW.audit_id, 'idempotency_key', NEW.idempotency_key,
          'code', NEW.code, 'ip', NEW.ip, 'outcome', NEW.outcome,
          'occurred_at', NEW.occurred_at, 'created_at', NEW.created_at,
          'instance_id', NEW.instance_id, 'market_id', NEW.market_id,
          'prev_row_hash', prior_hash
        )::text, 'sha256'), 'hex');
        RETURN NEW;
      END
      $$
    `)
    this.addSql(`DROP TRIGGER IF EXISTS gp_voucher_claim_audit_hash_chain_before_insert ON voucher_claim_audit`)
    this.addSql(`
      CREATE TRIGGER gp_voucher_claim_audit_hash_chain_before_insert
      BEFORE INSERT ON voucher_claim_audit
      FOR EACH ROW EXECUTE FUNCTION public.gp_voucher_claim_audit_hash_chain()
    `)

    this.addSql(`REVOKE ALL PRIVILEGES ON SEQUENCE voucher_claim_audit_audit_id_seq FROM ${RUNTIME_ROLE}`)
    this.addSql(`GRANT USAGE ON SEQUENCE voucher_claim_audit_audit_id_seq TO ${RUNTIME_ROLE}`)
    this.addSql(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_ROLE} IN SCHEMA public
      REVOKE ALL ON TABLES FROM ${RUNTIME_ROLE}
    `)

    // Klucze pozostają globalne: ta sama intencja biznesowa nie może dać
    // drugiego claimu ani issuance przez zmianę marketu.
    this.addSql(`COMMENT ON COLUMN voucher_claim_audit.market_id IS 'NULL = UNKNOWN legacy provenance; never visible through RLS; runtime is INSERT-only'`)
    this.addSql(`COMMENT ON COLUMN voucher_claim_audit.instance_id IS 'NULL = UNKNOWN legacy provenance; RLS requires both instance_id and market_id'`)
    this.addSql(`COMMENT ON COLUMN voucher_claim_binding.market_id IS 'NULL = UNKNOWN legacy provenance; never visible through RLS'`)
    this.addSql(`COMMENT ON COLUMN voucher_claim_binding.instance_id IS 'NULL = UNKNOWN legacy provenance; RLS requires both instance_id and market_id'`)
    this.addSql(`COMMENT ON COLUMN event_processed.market_id IS 'NULL = UNKNOWN legacy provenance; business dedupe key remains global; runtime is INSERT-only'`)
    this.addSql(`COMMENT ON COLUMN event_processed.instance_id IS 'NULL = UNKNOWN legacy provenance; RLS requires both instance_id and market_id'`)
  }

  async down(): Promise<void> {
    // Forward-fix only: policy removal or dropping market_id could reveal or
    // destroy provenance. The data model is intentionally retained.
  }
}
