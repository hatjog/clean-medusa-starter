import { Migration } from "@medusajs/framework/mikro-orm/migrations";

const GP_CORE_RUNTIME_ROLE = "gp_core_runtime";
const GP_MARKET_SESSION_VAR = "app.gp_market_id";
const RLS_TABLES = [
  "entitlements",
  "redemptions",
  "entitlement_audit_log",
] as const;

/**
 * v1.12.0 Story 1.3 — gp_core runtime role + FORCE RLS market policies.
 *
 * ADR-141: external infra may provision the role first, so this migration is
 * intentionally idempotent and reconciles the runtime role to NOBYPASSRLS.
 *
 * MED-1 / Deferred: architectural — ADR-141 §8, enforcement-flip in Story 1.4 (HG-5, rollout za flagą).
 *
 * FORCE ROW LEVEL SECURITY affects the table owner too (not just gp_core_runtime).
 * This is NON-REGRESSIVE pre-flip ONLY because `corePool` connects as a superuser
 * or BYPASSRLS role (e.g. `postgres`) before Story 1.4 switches the connection to
 * `gp_core_runtime`.  If `GP_CORE_DATABASE_URL` points to a non-privileged owner
 * role, admin read paths (enrichEntitlements / adminSearch*) would silently return
 * 0 rows after this migration.
 *
 * PRE-FLIP PRECONDITION (Story 1.4): verify that all `getCorePool()` callers that
 * read/write entitlements / redemptions / entitlement_audit_log pass marketId to
 * withTransaction / withMarketContext before enabling GP_CORE_RLS_ENFORCED.
 */
export class Migration20260525000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`CREATE SCHEMA IF NOT EXISTS gp_core`);

    this.addSql(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = '${GP_CORE_RUNTIME_ROLE}'
        ) THEN
          CREATE ROLE ${GP_CORE_RUNTIME_ROLE} NOLOGIN;
        END IF;

        ALTER ROLE ${GP_CORE_RUNTIME_ROLE} NOBYPASSRLS;
        COMMENT ON ROLE ${GP_CORE_RUNTIME_ROLE} IS
          'ADR-141 gp_core runtime role; reconciled in-repo to NOBYPASSRLS even when externally provisioned.';
      END $$
    `);

    this.addSql(`GRANT USAGE ON SCHEMA gp_core TO ${GP_CORE_RUNTIME_ROLE}`);

    for (const table of RLS_TABLES) {
      this.addSql(`
        DO $$ BEGIN
          IF to_regclass('gp_core.${table}') IS NOT NULL THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON gp_core.${table} TO ${GP_CORE_RUNTIME_ROLE};

            ALTER TABLE gp_core.${table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE gp_core.${table} FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS market_isolation ON gp_core.${table};
            CREATE POLICY market_isolation ON gp_core.${table}
              USING (market_id = NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), '')::uuid)
              WITH CHECK (market_id = NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), '')::uuid);
          END IF;
        END $$
      `);
    }
  }

  async down(): Promise<void> {
    for (const table of [...RLS_TABLES].reverse()) {
      this.addSql(`
        DO $$ BEGIN
          IF to_regclass('gp_core.${table}') IS NOT NULL THEN
            DROP POLICY IF EXISTS market_isolation ON gp_core.${table};
            ALTER TABLE gp_core.${table} NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE gp_core.${table} DISABLE ROW LEVEL SECURITY;
            REVOKE SELECT, INSERT, UPDATE, DELETE ON gp_core.${table} FROM ${GP_CORE_RUNTIME_ROLE};
          END IF;
        END $$
      `);
    }

    this.addSql(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = '${GP_CORE_RUNTIME_ROLE}'
        ) THEN
          REVOKE USAGE ON SCHEMA gp_core FROM ${GP_CORE_RUNTIME_ROLE};
          DROP ROLE ${GP_CORE_RUNTIME_ROLE};
        END IF;
      EXCEPTION WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'Role ${GP_CORE_RUNTIME_ROLE} retained because dependent objects still exist';
      END $$
    `);
  }
}
