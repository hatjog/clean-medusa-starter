import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 3.3 (FR-9, AD-33, AD-47, NFR-3, AD-44) — wspólna bariera
 * idempotencji SKUTKU per należna jednostka biznesowa.
 *
 * Stempel `20261114140000` z rejestru `specs/releases/v1.16.0/migration-registry.yaml`
 * (`story_id: "3.3"`), po 4.2 (`20261114120000`). ADR-242 (Proposed) —
 * amendment ADR-166: SemVer kontraktu bariery 1.0.0 → 1.1.0 (MINOR).
 *
 * Tabela `owed_unit_effect_barrier`: PK `owed_business_unit_key`
 * (`payment_intent_id:order_id`, ADR-166) BEZ `event_type` i BEZ `provider` —
 * jedna jednostka = jeden wiersz niezależnie od trasy. `instance_id` i
 * `market_id` NOT NULL (NFR-3). Runtime (`medusa_store`) ma SELECT/INSERT,
 * BEZ UPDATE/DELETE: rezerwacja jest nieodwracalna po COMMIT.
 *
 * Backfill: jednostki już rozliczone w `event_processed` (event Path Y,
 * pełny scope, `external_id = purchase_key || ':' || order_id`) dostają wiersz
 * bariery, żeby druga trasa nie wystawiła ich ponownie. Wiersze zastane bez
 * scope (NULL = UNKNOWN, 11.1) NIE są przenoszone — nadal chroni je
 * `event_processed` (PK `(external_id, event_type)`).
 *
 * Strażnik widoczności (fix po checkpoincie 3.3, AC3; precedens fail-loud
 * `1779010000000`, ADR-197): `event_processed` jest pod FORCE RLS (właściciel
 * `gp_runtime_recovery_migrator`, polityka tylko dla `medusa_store`), więc rola
 * bez BYPASSRLS/superusera widzi 0 wierszy i backfill skończyłby się ZIELONO,
 * nie przenosząc niczego. Migracja odmawia wtedy startu PRZED jakimkolwiek
 * zapisem, a po backfillu sprawdza post-warunek źródło ⊆ cel (każdy
 * kwalifikowany klucz `event_processed` ma wiersz bariery).
 *
 * Rollback: `down` usuwa wyłącznie nową tabelę; `event_processed` nietknięta
 * (forward-fix — plan migracji w ADR-242).
 */
const TABLE = "owed_unit_effect_barrier"
const RUNTIME_ROLE = "medusa_store"
const MARKET_SETTING = "current_setting('app.gp_market_id', true)"
const INSTANCE_SETTING = "current_setting('app.gp_instance_id', true)"
const PATH_Y_EVENT_TYPE = "gp.stripe.payment_intent_succeeded.v1"

/**
 * Predykat populacji źródłowej backfillu — JEDNO wyrażenie dla INSERT i dla
 * post-warunku (dwie kopie rozjechałyby się cicho).
 */
const BACKFILL_SOURCE_PREDICATE = `ep.event_type = '${PATH_Y_EVENT_TYPE}'
             AND ep.purchase_key IS NOT NULL
             AND ep.instance_id IS NOT NULL AND length(btrim(ep.instance_id)) > 0
             AND ep.market_id IS NOT NULL AND length(btrim(ep.market_id)) > 0
             AND length(ep.external_id) > length(ep.purchase_key) + 1
             AND left(ep.external_id, length(ep.purchase_key) + 1) = ep.purchase_key || ':'`

export class Migration20261114140000SharedIdempotencyBarrier extends Migration {
  async up(): Promise<void> {
    // ── STRAŻNIK WIDOCZNOŚCI — PRZED jakimkolwiek zapisem ──────────────────
    this.addSql(`
      DO $$
      DECLARE
        v_bypass boolean;
        v_super  boolean;
        v_forced boolean;
      BEGIN
        SELECT rolbypassrls, rolsuper INTO v_bypass, v_super
          FROM pg_roles WHERE rolname = current_user;
        SELECT c.relforcerowsecurity INTO v_forced
          FROM pg_class c WHERE c.oid = to_regclass('event_processed');
        IF COALESCE(v_forced, false)
           AND NOT COALESCE(v_bypass, false)
           AND NOT COALESCE(v_super, false) THEN
          RAISE EXCEPTION
            'GP_OWED_UNIT_BARRIER_BACKFILL_BLIND: rola migracyjna % nie ma ani BYPASSRLS, '
            'ani superusera, a event_processed jest pod FORCE ROW LEVEL SECURITY (FORCE '
            'obejmuje takze wlasciciela). Taka rola widzi co najwyzej jeden rynek, a bez '
            'app.gp_market_id ZERO wierszy: backfill bariery konczylby sie zielono bez '
            'przeniesienia rozliczonych jednostek (ADR-242, plan migracji). Uruchom '
            'migracje rola z BYPASSRLS albo superuserem.',
            current_user;
        END IF;
      END
      $$
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        owed_business_unit_key TEXT PRIMARY KEY,
        payment_intent_id      TEXT NOT NULL,
        order_id               TEXT NOT NULL,
        instance_id            TEXT NOT NULL,
        market_id              TEXT NOT NULL,
        claimed_by_path        TEXT NOT NULL,
        claimed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ${TABLE}_key_shape_check
          CHECK (owed_business_unit_key = payment_intent_id || ':' || order_id),
        CONSTRAINT ${TABLE}_scope_check
          CHECK (length(btrim(instance_id)) > 0 AND length(btrim(market_id)) > 0),
        CONSTRAINT ${TABLE}_path_check
          CHECK (length(btrim(claimed_by_path)) > 0)
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_payment_intent
        ON ${TABLE} (payment_intent_id)
    `)

    this.addSql(`
      DO $$
      DECLARE
        v_missing bigint;
      BEGIN
        IF EXISTS (SELECT FROM information_schema.tables
                    WHERE table_schema = current_schema() AND table_name = 'event_processed')
           AND EXISTS (SELECT FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'event_processed'
                      AND column_name = 'purchase_key') THEN
          INSERT INTO ${TABLE}
            (owed_business_unit_key, payment_intent_id, order_id, instance_id, market_id, claimed_by_path, claimed_at)
          SELECT ep.external_id,
                 ep.purchase_key,
                 substring(ep.external_id FROM length(ep.purchase_key) + 2),
                 ep.instance_id,
                 ep.market_id,
                 'backfill:event_processed',
                 to_timestamp(ep.processed_at / 1000.0)
            FROM event_processed ep
           WHERE ${BACKFILL_SOURCE_PREDICATE}
          ON CONFLICT (owed_business_unit_key) DO NOTHING;

          -- Post-warunek źródło ⊆ cel: każdy kwalifikowany klucz event_processed
          -- MUSI mieć wiersz bariery (z backfillu albo zastany).
          SELECT count(*) INTO v_missing
            FROM event_processed ep
           WHERE ${BACKFILL_SOURCE_PREDICATE}
             AND NOT EXISTS (SELECT 1 FROM ${TABLE} b
                              WHERE b.owed_business_unit_key = ep.external_id);
          IF v_missing > 0 THEN
            RAISE EXCEPTION
              'GP_OWED_UNIT_BARRIER_BACKFILL_INCOMPLETE: % rozliczonych jednostek event_processed bez wiersza bariery',
              v_missing;
          END IF;
        END IF;
      END
      $$
    `)

    this.addSql(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`)
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          EXECUTE 'REVOKE ALL PRIVILEGES ON ${TABLE} FROM ${RUNTIME_ROLE}';
          EXECUTE 'GRANT SELECT, INSERT ON ${TABLE} TO ${RUNTIME_ROLE}';
          EXECUTE 'DROP POLICY IF EXISTS market_isolation ON ${TABLE}';
          EXECUTE $policy$CREATE POLICY market_isolation ON ${TABLE} TO ${RUNTIME_ROLE}
            USING (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})
            WITH CHECK (instance_id = ${INSTANCE_SETTING} AND market_id = ${MARKET_SETTING})$policy$;
        END IF;
      END
      $$
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS ${TABLE}`)
  }
}
