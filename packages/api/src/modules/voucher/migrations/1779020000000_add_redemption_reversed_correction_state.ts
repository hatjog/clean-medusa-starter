import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 5.7 (FR-19a, AD-34, NFR-3; decyzja PO D-36; ADR-245 `Proposed`)
 * — nazwany stan KOREKTY pomyłkowej realizacji `REDEMPTION_REVERSED`.
 *
 * Znacznik `1779020000000` POBRANY z `specs/releases/v1.16.0/migration-registry.yaml`
 * (wpis `story_id: "5.7"`), nie wygenerowany w worktree — ADR-177, D-35 p.16.
 *
 * ── Dwa CHECK-i, jeden fakt ─────────────────────────────────────────────────
 * (1) `entitlement_instance_state_check` dostaje `REDEMPTION_REVERSED` — stan
 *     różny od `ACTIVE` („nigdy nie zrealizowany") i od `REDEEMED_FULL`
 *     („zrealizowany"); po nim voucher jest ZNÓW realizowalny (D-36).
 * (2) `voucher_redemption_resulting_state_check` dopuszcza `REDEMPTION_REVERSED`
 *     WYŁĄCZNIE dla wiersza `kind = 'REVERSAL'`. Realizacja (`REDEMPTION`) nadal
 *     kończy się tylko `REDEEMED_PARTIAL`/`REDEEMED_FULL` — allow-lista wyników
 *     realizacji się NIE zmienia, a wiersz korekty jest odróżnialny od wiersza
 *     zwrotu (który niesie stan wynikowy odwracanej realizacji, ADR-178 §2.3).
 *
 * ── Dlaczego zbiory są LITERAŁAMI ───────────────────────────────────────────
 * `_grow/tools/validate_voucher_state_vocabulary.py` czyta PIERWSZE wystąpienie
 * klauzuli CHECK na kolumnie (`state`, `resulting_state`) — zbiór sklejony ze
 * stałej byłby dla bramki pusty. `up()` stoi PRZED `down()`, bo bramka bierze
 * pierwsze dopasowanie.
 *
 * ── `up()` idempotentny, `down()` NIE kasuje danych ─────────────────────────
 * `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` — powtórzone `up()` daje ten
 * sam stan. `down()` NAJPIERW liczy wiersze niosące nowy stan i przy niezerowym
 * wyniku ZATRZYMUJE rollback (`GP_REDEMPTION_REVERSED_ROWS_PRESENT`) — zwężenie
 * CHECK-a musiałoby skasować albo przepisać fakt korekty, a to byłoby kłamstwem
 * o zdarzeniu, które zaszło (wzorzec `1779008000000`). Na bazie bez korekt
 * przywraca oba CHECK-i sprzed migracji.
 */
export class Migration1779020000000 extends Migration {
  async up(): Promise<void> {
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
          'REFUNDED','DISPUTED','PENDING_VENDOR_DECISION',
          'REDEMPTION_REVERSED'
        ))
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher_redemption
        DROP CONSTRAINT IF EXISTS voucher_redemption_resulting_state_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher_redemption
        ADD CONSTRAINT voucher_redemption_resulting_state_check CHECK (
          resulting_state IN ('REDEEMED_PARTIAL','REDEEMED_FULL')
          OR (kind = 'REVERSAL' AND resulting_state = 'REDEMPTION_REVERSED')
        )
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      DO $$
      DECLARE
        reversed_entitlements bigint := 0;
        reversed_rows bigint := 0;
      BEGIN
        IF to_regclass('entitlement_instance') IS NOT NULL THEN
          SELECT count(*) INTO reversed_entitlements
            FROM entitlement_instance WHERE state = 'REDEMPTION_REVERSED';
        END IF;
        IF to_regclass('voucher_redemption') IS NOT NULL THEN
          SELECT count(*) INTO reversed_rows
            FROM voucher_redemption WHERE resulting_state = 'REDEMPTION_REVERSED';
        END IF;
        IF reversed_entitlements > 0 OR reversed_rows > 0 THEN
          RAISE EXCEPTION
            'GP_REDEMPTION_REVERSED_ROWS_PRESENT: % uprawnien i % wierszy voucher_redemption '
            'niesie stan REDEMPTION_REVERSED — rollback zatrzymany, bo zwezenie CHECK-a '
            'wymagaloby skasowania albo przepisania faktu korekty (forward-fix).',
            reversed_entitlements, reversed_rows;
        END IF;
      END
      $$;
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher_redemption
        DROP CONSTRAINT IF EXISTS voucher_redemption_resulting_state_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher_redemption
        ADD CONSTRAINT voucher_redemption_resulting_state_check
        CHECK (resulting_state IN ('REDEEMED_PARTIAL','REDEEMED_FULL'))
    `)
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
}
