import { Migration } from "@mikro-orm/migrations"

/**
 * Etykiety AD-25 dla źródła pomiaru SM-2.
 *
 * Historycznych wierszy nie da się uczciwie przypisać do środowiska, dlatego
 * dostają `unattributed`. Default istnieje tylko na czas backfillu i jest
 * natychmiast usuwany: każdy nowy zapis musi podać obie etykiety jawnie.
 */
export class Migration1779014000000 extends Migration {
  override async up(): Promise<void> {
    for (const table of [
      "voucher_delivery_dispatch",
      "voucher_delivery_dispatch_audit",
    ]) {
      this.addSql(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS env text NOT NULL DEFAULT 'unattributed'
            CHECK (char_length(env) > 0),
          ADD COLUMN IF NOT EXISTS instance_id text NOT NULL DEFAULT 'unattributed'
            CHECK (char_length(instance_id) > 0)
      `)
      this.addSql(`
        ALTER TABLE ${table}
          ALTER COLUMN env DROP DEFAULT,
          ALTER COLUMN instance_id DROP DEFAULT
      `)
    }
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS provider_attempted_at timestamptz NULL
    `)
  }

  override async down(): Promise<void> {
    // Ledger jest forward-only; usunięcie etykiet zniszczyłoby zakres dowodu.
  }
}
