import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story v180-2-3: dodaje booking pointer usługi i payloady audytu entitlement.
 *
 * Źródło: epics.md Story 2.3 BE-2 (FR1.13); ADR-099 Layer 4.
 *
 * AUTHORED Story 2.3; APPLY potwierdzone dla live infra / Epic 1 Story 1.3.
 * Lokalna generacja przez Medusa CLI była niedostępna w świeżym checkoutcie
 * submodule, bo zależności nie były zainstalowane, więc migracja zachowuje
 * istniejący kształt klasy migracji voucher i pozostaje idempotentna.
 *
 * Fix M1 z review: pierwszy szkic robił DROP+ADD
 * voucher_event_event_type_check z konkretną listą wartości enum. Taki wzorzec
 * full-replace nie jest odporny na równoległe kolizje: równoległa story BE-x
 * (2.2, 2.4-2.11) z własnym DROP+ADD i inną listą wartości mogłaby po cichu
 * usunąć typy eventów dodane tutaj. Ta migracja tylko usuwa restrykcyjny CHECK
 * (kolumna akceptuje dowolny text), a walidację dozwolonych wartości deleguje
 * do warstwy aplikacyjnej (VoucherService.emitEntitlementBookingCancelled).
 * Poluzowanie `voucher_code DROP NOT NULL` jest celowe: eventy cyklu życia
 * entitlement nie mają kodu vouchera, bo wskazują `entitlement_id`, więc ta
 * kategoria wierszy wymaga nullable voucher_code.
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

    // Eventy cyklu życia entitlement nie mają voucher_code, tylko entitlement_id.
    // To celowe poluzowanie invariantów współdzielonej tabeli.
    this.addSql(`
      ALTER TABLE voucher_event
      ALTER COLUMN voucher_code DROP NOT NULL
    `)

    // Usuwa restrykcyjny CHECK enum, żeby równoległe migracje BE-x mogły dodać
    // własne typy eventów bez kolizji last-writer-wins na tym constraint.
    // Warstwa aplikacyjna waliduje dozwolone wartości w miejscach wywołania.
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

    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_event_archive
      (LIKE voucher_event INCLUDING ALL)
    `)
    this.addSql(`
      ALTER TABLE voucher_event_archive
      ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now()
    `)
    this.addSql(`
      DO $$
      DECLARE
        before_count integer;
        archived_count integer;
      BEGIN
        SELECT COUNT(*)::integer
          INTO before_count
          FROM voucher_event
         WHERE event_type = 'ENTITLEMENT_BOOKING_CANCELLED';

        INSERT INTO voucher_event_archive (
          id,
          voucher_code,
          event_type,
          occurred_at,
          created_at,
          entitlement_id,
          payload,
          archived_at
        )
        SELECT
          id,
          voucher_code,
          event_type,
          occurred_at,
          created_at,
          entitlement_id,
          payload,
          now()
        FROM voucher_event
        WHERE event_type = 'ENTITLEMENT_BOOKING_CANCELLED'
        ON CONFLICT (id) DO UPDATE SET
          voucher_code = EXCLUDED.voucher_code,
          event_type = EXCLUDED.event_type,
          occurred_at = EXCLUDED.occurred_at,
          created_at = EXCLUDED.created_at,
          entitlement_id = EXCLUDED.entitlement_id,
          payload = EXCLUDED.payload,
          archived_at = EXCLUDED.archived_at;

        GET DIAGNOSTICS archived_count = ROW_COUNT;
        IF archived_count <> before_count THEN
          RAISE EXCEPTION 'voucher_event rollback archive mismatch: archived %, expected %',
            archived_count,
            before_count;
        END IF;

        DELETE FROM voucher_event
        WHERE event_type = 'ENTITLEMENT_BOOKING_CANCELLED';
      END $$;
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
