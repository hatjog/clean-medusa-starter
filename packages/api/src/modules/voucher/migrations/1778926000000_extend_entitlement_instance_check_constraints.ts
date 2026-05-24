import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.9.0 Wave F6 — Epic-2 HIGH-02 / CC-2 #7
 *
 * The Story 2.1 migration `1778880672656_create_entitlement_profiles_section.ts`
 * authored a CHECK constraint listing 12 of 13 entitlement_instance states. The
 * Story 2.7 (BE-6) work added `PENDING_VENDOR_DECISION` to the TypeScript enum
 * and the transition map, but **no migration extended the DDL CHECK**. First
 * INSERT/UPDATE writing that state therefore raises `check_violation` in
 * Postgres — discoverable only at runtime, hidden by mocked unit tests.
 *
 * This migration drops the old CHECK and re-creates it with the full 13-state
 * enum (matches `ALL_ENTITLEMENT_INSTANCE_STATES` in
 * `models/entitlement.ts`). The DDL is the source-of-truth for the enum;
 * `service.ts` + tests assert parity.
 *
 * Per `feedback_pre_prod_db_drop_reload.md` the pre-prod stage rebase strategy
 * is DB drop+reload from gp-config; this migration is therefore additive but
 * does NOT require a backward-compat plan. Authored-not-applied posture is
 * preserved (no docker-compose in this worktree).
 *
 * Forward: DROP CONSTRAINT entitlement_instance_state_check; ADD CONSTRAINT
 * with the 13 enum values. Idempotent: uses `IF EXISTS` on drop and gates the
 * add with a NOT EXISTS lookup against pg_constraint.
 *
 * Reverse: re-creates the 12-state CHECK (Story 2.1 original).
 */
export class Migration1778926000000 extends Migration {
  async up(): Promise<void> {
    // Postgres auto-names the constraint `<table>_<col>_check`. Drop if exists
    // tolerates a fresh-DB scenario where the original migration never ran.
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP CONSTRAINT IF EXISTS entitlement_instance_state_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD CONSTRAINT entitlement_instance_state_check CHECK (state IN (
          'ISSUED','ACTIVE','REDEMPTION_REQUESTED',
          'REDEEMED_PARTIAL','REDEEMED_FULL','SETTLED',
          'CLOSED','VOIDED','EXPIRED','REFUND_REQUESTED',
          'REFUNDED','DISPUTED','PENDING_VENDOR_DECISION'
        ))
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP CONSTRAINT IF EXISTS entitlement_instance_state_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD CONSTRAINT entitlement_instance_state_check CHECK (state IN (
          'ISSUED','ACTIVE','REDEMPTION_REQUESTED',
          'REDEEMED_PARTIAL','REDEEMED_FULL','SETTLED',
          'CLOSED','VOIDED','EXPIRED','REFUND_REQUESTED',
          'REFUNDED','DISPUTED'
        ))
    `)
  }
}
