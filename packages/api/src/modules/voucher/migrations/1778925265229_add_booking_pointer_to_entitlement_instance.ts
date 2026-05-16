import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story v180-2-3: add service booking pointer and entitlement audit payloads.
 *
 * Source: epics.md Story 2.3 BE-2 (FR1.13); ADR-099 Layer 4.
 *
 * AUTHORED Story 2.3; APPLY confirmed live infra / Epic 1 Story 1.3. Local
 * Medusa CLI generation was unavailable in this fresh submodule checkout
 * because dependencies were not installed, so this migration is authored in
 * the existing voucher migration class shape and kept idempotent.
 *
 * M1 fix (code review): the original draft also ran DROP+ADD of
 * voucher_event_event_type_check with a specific enum value list.  That
 * full-replace pattern is NOT parallel-collision-safe: a sibling BE-x story
 * (2.2, 2.4–2.11) that ships its own DROP+ADD with a different value list
 * would silently drop any event types added here.  Instead this migration
 * only DROPs the restrictive CHECK (making the column open to any text) and
 * delegates allowed-value enforcement to the application layer
 * (VoucherService.emitEntitlementBookingCancelled).  The `voucher_code DROP
 * NOT NULL` relaxation is intentional: entitlement-lifecycle events have no
 * voucher code (they reference entitlement_id), so the column must be
 * nullable for this category of rows.
 */
export class Migration1778925265229 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE entitlement_instance
      ADD COLUMN IF NOT EXISTS booking_pointer text NULL
    `)

    this.addSql(`
      ALTER TABLE voucher_event
      ADD COLUMN IF NOT EXISTS entitlement_id text NULL
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb
    `)

    // Allow entitlement-lifecycle events that have no voucher_code (they carry
    // entitlement_id instead).  Intentional shared-table invariant relaxation.
    this.addSql(`
      ALTER TABLE voucher_event
      ALTER COLUMN voucher_code DROP NOT NULL
    `)

    // Drop the restrictive enum CHECK so parallel BE-x migrations can each add
    // their own event types without a last-writer-wins collision on this
    // constraint.  Application-layer code enforces valid values per call site.
    this.addSql(`
      ALTER TABLE voucher_event
      DROP CONSTRAINT IF EXISTS voucher_event_event_type_check
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_event_entitlement_id_idx
      ON voucher_event (entitlement_id, occurred_at)
      WHERE entitlement_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS voucher_event_entitlement_id_idx`)

    // INTENTIONAL DESTRUCTIVE ROLLBACK: deletes audit rows for
    // ENTITLEMENT_BOOKING_CANCELLED events before restoring the narrower CHECK
    // constraint (which would otherwise reject those rows).  Audit events are
    // append-only in production — do NOT run this down() against any
    // environment that contains real audit data.
    this.addSql(`
      DELETE FROM voucher_event
      WHERE event_type = 'ENTITLEMENT_BOOKING_CANCELLED'
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      DROP CONSTRAINT IF EXISTS voucher_event_event_type_check
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      ADD CONSTRAINT voucher_event_event_type_check
      CHECK (event_type IN ('created','sent','opened','claimed','withdrawn'))
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      ALTER COLUMN voucher_code SET NOT NULL
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      DROP COLUMN IF EXISTS payload
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      DROP COLUMN IF EXISTS entitlement_id
    `)
    this.addSql(`
      ALTER TABLE entitlement_instance
      DROP COLUMN IF EXISTS booking_pointer
    `)
  }
}
