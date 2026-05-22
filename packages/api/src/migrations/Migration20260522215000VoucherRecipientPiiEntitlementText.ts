import { Migration } from "@mikro-orm/migrations";

/**
 * Align voucher_recipient_pii.entitlement_id with the current GP entitlement
 * runtime, where entitlement_instance.id is a text id such as `ent_...`.
 */
export class Migration20260522215000VoucherRecipientPiiEntitlementText extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE voucher_recipient_pii
       ALTER COLUMN entitlement_id TYPE text
       USING entitlement_id::text`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE voucher_recipient_pii
       ALTER COLUMN entitlement_id TYPE uuid
       USING entitlement_id::uuid`
    );
  }
}
