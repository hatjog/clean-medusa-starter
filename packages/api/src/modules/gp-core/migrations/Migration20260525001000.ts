import { Migration } from "@medusajs/framework/mikro-orm/migrations";

const GP_CORE_ADMIN_R4_ROLE = "medusa_market_ops";

/**
 * v1.12.0 Story 1.6 — admin R4 role is provisioned, runtime enforcement gated.
 *
 * ADR-049 names `medusa_market_ops` as the market-operator admin role without
 * BYPASSRLS. ADR-141 keeps gp_core runtime enforcement separate: Story 1.6 only
 * reconciles the role in-repo and documents the multi-market deferral.
 */
export class Migration20260525001000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`CREATE SCHEMA IF NOT EXISTS gp_core`);

    this.addSql(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = '${GP_CORE_ADMIN_R4_ROLE}'
        ) THEN
          CREATE ROLE ${GP_CORE_ADMIN_R4_ROLE} NOLOGIN;
        END IF;

        ALTER ROLE ${GP_CORE_ADMIN_R4_ROLE} NOBYPASSRLS;
        COMMENT ON ROLE ${GP_CORE_ADMIN_R4_ROLE} IS
          'ADR-049/ADR-141 FR-F2 admin R4 market-operator role for gp_core; reconciled in-repo to NOBYPASSRLS even when externally provisioned; runtime enforcement gated/deferred to multi-market.';
      END $$
    `);

    this.addSql(`GRANT USAGE ON SCHEMA gp_core TO ${GP_CORE_ADMIN_R4_ROLE}`);
  }

  async down(): Promise<void> {
    // Reconciliation note (INFO-2): up() reconciles the role even when externally provisioned
    // (CREATE only if absent, then ALTER NOBYPASSRLS). down() drops it unconditionally if present —
    // same asymmetry as the ratified Migration20260525000000 (story 1.3) pattern. Operational
    // awareness: rolling back this migration will remove the role even if it was externally managed
    // before this migration ran. The dependent_objects_still_exist guard prevents hard errors when
    // the role has active dependencies (e.g. public-schema grants added at multi-market flip time).
    this.addSql(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = '${GP_CORE_ADMIN_R4_ROLE}'
        ) THEN
          REVOKE USAGE ON SCHEMA gp_core FROM ${GP_CORE_ADMIN_R4_ROLE};
          DROP ROLE ${GP_CORE_ADMIN_R4_ROLE};
        END IF;
      EXCEPTION WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'Role ${GP_CORE_ADMIN_R4_ROLE} retained because dependent objects still exist';
      END $$
    `);
  }
}
