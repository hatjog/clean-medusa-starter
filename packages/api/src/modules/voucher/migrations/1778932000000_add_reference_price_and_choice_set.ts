import { Migration } from "@medusajs/framework/mikro-orm/migrations"

const CHOICE_SET_TABLE = "entitlement_choice_set_item"
const CHOICE_SET_POLICY = "entitlement_choice_set_item_market_isolation"
const GP_MARKET_SESSION_VAR = "app.gp_market_id"

/**
 * Story 3.2 (v1.12.0 Epic 3 / Wave F1/A) — warstwa danych pod
 * CREDIT_PACK/BUNDLE capability: `reference_price_minor`, dedykowana tabela
 * `entitlement_choice_set_item` oraz rozszerzony CHECK `posting_profile`.
 *
 * Podstawa normatywna: ADR-140 §1/§2 + ADR-141 §2/§5. To jest WYŁĄCZNIE schema:
 * - `reference_price_minor` jest nullable snapshotem per instance; invariant-kotwica
 *   ADR-140 §2 zostaje udokumentowana tutaj, ale egzekucja należy do Story 3.4:
 *   CREDIT_PACK `reference_price_minor = face_value_minor`, BUNDLE
 *   `reference_price_minor = SUM(entitlement_choice_set_item.reference_amount_minor)`.
 *   Cross-table CHECK jest niewykonalny jako pojedynczy constraint, więc Story 3.4
 *   doda asercję w issue-tx + golden-test.
 * - `entitlement_choice_set_item` jest dedykowaną tabelą (NIE JSONB) z per-item
 *   CHECK-ami finansowymi i realną store-RLS policy w gp_mercur na `market_id`.
 * - `posting_profile` zostaje rozszerzony schema-level, aby downstream Story 3.3
 *   mogła zapisać profile CREDIT_PACK/BUNDLE. Ta migracja NIE dodaje registry,
 *   resolvera ani nie flipuje `runtime_enabled`.
 *
 * Idempotencja: kolumny/tabele/indeksy używają IF NOT EXISTS, a CHECK-i są
 * guardowane przez `pg_catalog.pg_constraint` i dodawane jako NOT VALID, więc nie
 * walidują wstecznie danych legacy, ale egzekwują nowe INSERT/UPDATE.
 *
 * `down()` jest celowo non-destrukcyjny: entitlement i choice_set trzymają saldo /
 * zobowiązanie finance-adjacent, więc rollback = forward-fix, nie DROP.
 */
export class Migration1778932000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS reference_price_minor bigint NULL
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${CHOICE_SET_TABLE} (
        id                       text PRIMARY KEY,
        instance_id              text NOT NULL
                                   REFERENCES entitlement_instance(id),
        market_id                text NOT NULL,
        label                    text NULL,
        reference_amount_minor   bigint NOT NULL,
        remaining_minor          bigint NOT NULL,
        vat_classification       text NOT NULL,
        status                   text NOT NULL,
        redemption_id            text NULL,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now()
      )
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_choice_set_item_instance_id_idx
        ON ${CHOICE_SET_TABLE} (instance_id)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_choice_set_item_market_id_idx
        ON ${CHOICE_SET_TABLE} (market_id)
    `)

    this.addChoiceSetConstraint(
      "entitlement_choice_set_item_market_id_chk",
      "char_length(market_id) > 0"
    )
    this.addChoiceSetConstraint(
      "entitlement_choice_set_item_reference_amount_chk",
      "reference_amount_minor > 0"
    )
    this.addChoiceSetConstraint(
      "entitlement_choice_set_item_remaining_chk",
      "remaining_minor >= 0 AND remaining_minor <= reference_amount_minor"
    )
    this.addChoiceSetConstraint(
      "entitlement_choice_set_item_vat_classification_chk",
      "vat_classification IN ('SPV','MPV')"
    )
    this.addChoiceSetConstraint(
      "entitlement_choice_set_item_status_chk",
      "status IN ('ACTIVE','REDEEMED')"
    )

    this.addSql(`
      ALTER TABLE ${CHOICE_SET_TABLE} ENABLE ROW LEVEL SECURITY
    `)
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medusa_store') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${CHOICE_SET_TABLE} TO medusa_store;
        END IF;
      END $$;
    `)
    this.addSql(`
      DROP POLICY IF EXISTS ${CHOICE_SET_POLICY} ON ${CHOICE_SET_TABLE}
    `)
    this.addSql(`
      CREATE POLICY ${CHOICE_SET_POLICY}
        ON ${CHOICE_SET_TABLE}
        USING (market_id = NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), ''))
        WITH CHECK (market_id = NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), ''))
    `)

    this.addSql(`
      DO $$
      DECLARE
        constraint_name text;
      BEGIN
        IF to_regclass('voucher_ledger_transaction') IS NOT NULL THEN
          FOR constraint_name IN
            SELECT c.conname
            FROM pg_catalog.pg_constraint c
            WHERE c.conrelid = 'voucher_ledger_transaction'::regclass
              AND c.contype = 'c'
              AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%posting_profile%'
              AND c.conname <> 'voucher_ledger_transaction_posting_profile_chk'
          LOOP
            EXECUTE format(
              'ALTER TABLE voucher_ledger_transaction DROP CONSTRAINT IF EXISTS %I',
              constraint_name
            );
          END LOOP;

          IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
            WHERE conrelid = 'voucher_ledger_transaction'::regclass
              AND conname = 'voucher_ledger_transaction_posting_profile_chk'
          ) THEN
            ALTER TABLE voucher_ledger_transaction
              ADD CONSTRAINT voucher_ledger_transaction_posting_profile_chk
              CHECK (posting_profile IN (
                'voucher_liability_only_v1',
                'voucher_credit_pack_v1',
                'voucher_bundle_v1'
              ))
              NOT VALID;
          END IF;
        END IF;
      END $$;
    `)
  }

  private addChoiceSetConstraint(name: string, expression: string): void {
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE conrelid = '${CHOICE_SET_TABLE}'::regclass
            AND conname = '${name}'
        ) THEN
          ALTER TABLE ${CHOICE_SET_TABLE}
            ADD CONSTRAINT ${name}
            CHECK (${expression})
            NOT VALID;
        END IF;
      END $$;
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (finance-adjacent). CELOWO NIE wykonuje
   * `DROP TABLE`/`DROP COLUMN`/`DROP CONSTRAINT`/`DROP POLICY`: cofnięcie błędu
   * idzie przez forward-fix, żeby nie usuwać struktury salda ani snapshotów.
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (finance-adjacent, NIE DROP).
  }
}
