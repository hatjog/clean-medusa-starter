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
      this.addSql(`CREATE INDEX IF NOT EXISTS ${table}_market_id_idx ON ${table} (market_id)`)
      this.addSql(`ALTER TABLE ${table} OWNER TO ${MIGRATION_ROLE}`)
      this.addSql(`REVOKE ALL PRIVILEGES ON ${table} FROM ${RUNTIME_ROLE}`)
      this.addSql(runtimeGrant(table))
      this.addSql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${table}`)
      this.addSql(`
        CREATE POLICY market_isolation ON ${table}
          TO medusa_store
          USING (market_id = ${MARKET_SETTING})
          WITH CHECK (market_id = ${MARKET_SETTING})
      `)
    }

    this.addSql(`REVOKE ALL PRIVILEGES ON SEQUENCE voucher_claim_audit_audit_id_seq FROM ${RUNTIME_ROLE}`)
    this.addSql(`GRANT USAGE ON SEQUENCE voucher_claim_audit_audit_id_seq TO ${RUNTIME_ROLE}`)
    this.addSql(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_ROLE} IN SCHEMA public
      REVOKE ALL ON TABLES FROM ${RUNTIME_ROLE}
    `)

    // Klucze pozostają globalne: ta sama intencja biznesowa nie może dać
    // drugiego claimu ani issuance przez zmianę marketu.
    this.addSql(`COMMENT ON COLUMN voucher_claim_audit.market_id IS 'NULL = UNKNOWN legacy provenance; never visible through RLS; runtime is INSERT-only'`)
    this.addSql(`COMMENT ON COLUMN voucher_claim_binding.market_id IS 'NULL = UNKNOWN legacy provenance; never visible through RLS'`)
    this.addSql(`COMMENT ON COLUMN event_processed.market_id IS 'NULL = UNKNOWN legacy provenance; business dedupe key remains global; runtime is INSERT-only'`)
  }

  async down(): Promise<void> {
    // Forward-fix only: policy removal or dropping market_id could reveal or
    // destroy provenance. The data model is intentionally retained.
  }
}
