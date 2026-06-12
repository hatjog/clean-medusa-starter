import { Migration } from "@medusajs/framework/mikro-orm/migrations"

const CHOICE_SET_TABLE = "entitlement_choice_set_item"
const CHOICE_SET_POLICY = "entitlement_choice_set_item_market_isolation"
const GP_MARKET_SESSION_VAR = "app.gp_market_id"
const TOUCH_FN = "fn_entitlement_choice_set_item_touch_updated_at"
const TOUCH_TRIGGER = "trg_entitlement_choice_set_item_touch_updated_at"

/**
 * Story 3.2 (v1.12.0 Epic 3 / Wave F1/A) — warstwa danych pod
 * CREDIT_PACK/BUNDLE capability: `reference_price_minor`, dedykowana tabela
 * `entitlement_choice_set_item` oraz rozszerzony CHECK `posting_profile`.
 *
 * Podstawa normatywna: ADR-140 §1/§2 + ADR-141 §2/§5. To jest WYŁACZNIE schema:
 * - `reference_price_minor` jest nullable snapshotem per instance; invariant-kotwica
 *   ADR-140 §2 zostaje udokumentowana tutaj, ale egzekucja nalezy do Story 3.4:
 *   CREDIT_PACK `reference_price_minor = face_value_minor`, BUNDLE
 *   `reference_price_minor = SUM(entitlement_choice_set_item.reference_amount_minor)`.
 *   Cross-table CHECK jest niewykonalny jako pojedynczy constraint, wiec Story 3.4
 *   doda asercje w issue-tx + golden-test.
 * - `entitlement_choice_set_item` jest dedykowana tabela (NIE JSONB) z per-item
 *   CHECK-ami finansowymi i realna store-RLS policy w gp_mercur na `market_id`
 *   (ENABLE + FORCE, wzorzec Migration20260430090000VoucherRecipientPiiTable +
 *   Migration20260525000000; FORCE gwarantuje fail-closed dla wlasciciela tabeli
 *   i sciezki bez market-context — bez FORCE RLS nie obowiazuje wlasciciela/superusera).
 * - `posting_profile` zostaje rozszerzony schema-level, aby downstream Story 3.3
 *   mogla zapisac profile CREDIT_PACK/BUNDLE. Ta migracja NIE dodaje registry,
 *   resolvera ani nie flipuje `runtime_enabled`.
 *
 * Literaly `posting_profile` dla nowych profili (`voucher_credit_pack_v1`,
 * `voucher_bundle_v1`) sa prowizoryczne — Story 3.3 implementuje registry i jest
 * SSOT nazw profili. Konwencja `voucher_<type>_v1` jest spojna z istniejacym
 * `voucher_liability_only_v1`, ale jesli Story 3.3 ustali inne literaly, bedzie
 * wymagany forward-fix (kolejna migracja podmieniajaca constraint).
 *
 * Idempotencja: kolumny/tabele/indeksy uzywaja IF NOT EXISTS, a CHECK-i sa
 * guardowane przez `pg_catalog.pg_constraint` i dodawane jako NOT VALID, wiec nie
 * waliduja wstecznie danych legacy, ale egzekwuja nowe INSERT/UPDATE.
 *
 * `down()` jest celowo non-destrukcyjny: entitlement i choice_set trzymaja saldo /
 * zobowiazanie finance-adjacent, wiec rollback = forward-fix, nie DROP.
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

    // Store-RLS: ENABLE + FORCE (fail-closed dla wlasciciela tabeli i sciezki bez
    // market-context; wzorzec Migration20260430090000VoucherRecipientPiiTable:78-81
    // i Migration20260525000000). Bez FORCE polityka nie obowiazuje roli bedacej
    // wlascicielem — ściezka bez SET ROLE (tlo, admin, subscriber bez ALS) bylaby
    // fail-open z dostepcm do sald wszystkich rynkow. FORCE wymusza, ze current_setting
    // pusty => NULLIF => NULL => market_id = NULL => zero wierszy (fail-closed).
    this.addSql(`
      ALTER TABLE ${CHOICE_SET_TABLE} ENABLE ROW LEVEL SECURITY
    `)
    this.addSql(`
      ALTER TABLE ${CHOICE_SET_TABLE} FORCE ROW LEVEL SECURITY
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

    // Trigger auto-touch updated_at (wzorzec Migration20260430090000VoucherRecipientPiiTable krok 8).
    // Story 3.7 bedzie robic UPDATE remaining_minor/status na wierszach — bez triggera
    // updated_at zamrozilby sie na czasie INSERT, psujac reconciliation/audit-trail per-pozycja.
    this.addSql(`
      CREATE OR REPLACE FUNCTION ${TOUCH_FN}()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    this.addSql(`
      DROP TRIGGER IF EXISTS ${TOUCH_TRIGGER} ON ${CHOICE_SET_TABLE}
    `)
    this.addSql(`
      CREATE TRIGGER ${TOUCH_TRIGGER}
        BEFORE UPDATE ON ${CHOICE_SET_TABLE}
        FOR EACH ROW EXECUTE FUNCTION ${TOUCH_FN}()
    `)

    // Rozszerzenie CHECK voucher_ledger_transaction.posting_profile o nowe profile
    // capability CREDIT_PACK/BUNDLE (ADR-140 §3). Literaly sa prowizoryczne (patrz
    // docstring klasy) — Story 3.3 implementuje registry i bedzie SSOT nazw profili.
    // Guard dropuje WYLACZNIE znany original auto-constraint (po nazwie z sufiksem
    // _check, nie po substringu definicji) — precyzyjny match, bez ryzyka niezamierzonego
    // usuniecia kompozytowych constraintow w przyszlosci.
    this.addSql(`
      DO $$
      BEGIN
        IF to_regclass('voucher_ledger_transaction') IS NOT NULL THEN
          -- Drop only the specific known original auto-named constraint (inline CHECK
          -- z CREATE TABLE generuje sufiks _check, nie _chk). Precyzyjny match po nazwie
          -- zapobiega przypadkowemu usunieciu innych constraintow zawierajacych posting_profile.
          IF EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
            WHERE conrelid = 'voucher_ledger_transaction'::regclass
              AND conname = 'voucher_ledger_transaction_posting_profile_check'
          ) THEN
            ALTER TABLE voucher_ledger_transaction
              DROP CONSTRAINT IF EXISTS voucher_ledger_transaction_posting_profile_check;
          END IF;

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
   * `DROP TABLE`/`DROP COLUMN`/`DROP CONSTRAINT`/`DROP POLICY`: cofniecie bledu
   * idzie przez forward-fix, zeby nie usuwac struktury salda ani snapshotow.
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (finance-adjacent, NIE DROP).
  }
}
