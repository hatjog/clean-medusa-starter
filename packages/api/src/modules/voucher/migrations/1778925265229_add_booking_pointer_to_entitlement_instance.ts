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
    this.addSql(`
      ALTER TABLE voucher_event
      ALTER COLUMN voucher_code DROP NOT NULL
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      DROP CONSTRAINT IF EXISTS voucher_event_event_type_check
    `)
    this.addSql(`
      ALTER TABLE voucher_event
      ADD CONSTRAINT voucher_event_event_type_check
      CHECK (event_type IN (
        'created',
        'sent',
        'opened',
        'claimed',
        'withdrawn',
        'ENTITLEMENT_BOOKING_CANCELLED'
      ))
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_event_entitlement_id_idx
      ON voucher_event (entitlement_id, occurred_at)
      WHERE entitlement_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS voucher_event_entitlement_id_idx`)
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
