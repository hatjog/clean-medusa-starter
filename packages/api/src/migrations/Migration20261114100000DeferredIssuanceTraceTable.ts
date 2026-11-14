import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 4.4 (FR-12, AD-32, NFR-3, NFR-5) — TRWAŁY rekord śladu
 * płatności bez zamówienia (`deferred_issuance_trace`).
 *
 * Stempel `20261114100000` pochodzi z rejestru
 * `specs/releases/v1.16.0/migration-registry.yaml` (`story_id: "4.4"`).
 *
 * ── Co ta tabela zastępuje ─────────────────────────────────────────────────
 * Do tej pory populację „płatność bez zamówienia" WYLICZANO na żądanie:
 * marker `<event_id>#deferred-issuance` w `webhook_event_processed` łączony
 * z `payment`/`order_payment_collection`. Populacja nie miała własnej
 * tożsamości ani właściciela i mogła zniknąć między dwoma zapytaniami (AD-32
 * człon (b)). Ten plik zakłada nośnik, do którego route webhooka ZAPISUJE
 * rekord w chwili wykrycia, a subscriber `order.placed` go DOMYKA.
 *
 * ── Kształt = plan `dit-create-table` / `dit-create-quarantine` ────────────
 * Kolumny są dokładnie tymi z `lib/recovery/recovery-migration-plan.ts`
 * (test jednostkowy Story 4.4 porównuje je z planem). Ponad plan dochodzą
 * wyłącznie OGRANICZENIA (CHECK), nie kolumny:
 *  - stan nieterminalny ⇔ `closure_path = 'not_closed'` i brak evidence,
 *  - stan terminalny ⇒ niepusta ścieżka zamknięcia i NIEPUSTY obiekt
 *    `resolution_evidence` — domknięcie bez dowodu jest odmową bazy, nie
 *    konwencją kodu.
 *
 * ── RLS (granica Story 11.1) ───────────────────────────────────────────────
 * ENABLE + FORCE RLS i polityka `market_isolation` dla roli runtime
 * `medusa_store` (NOBYPASSRLS) — ten sam predykat co w
 * `modules/voucher/migrations/1779016000000_runtime_recovery_rls_boundary.ts`.
 * Runtime dostaje SELECT/INSERT/UPDATE, BEZ DELETE: historia rekordu zostaje
 * odczytywalna po domknięciu. Kwarantanna backfillu nie ma polityki dla
 * runtime — czyta ją i pisze wyłącznie operator (D-35 p.9).
 *
 * Migracja NIE zmienia żadnej istniejącej tabeli (D-35 p.16): tylko CREATE.
 */
const TABLE = "deferred_issuance_trace"
const QUARANTINE = `${TABLE}_backfill_quarantine`
const RUNTIME_ROLE = "medusa_store"
const MARKET_SETTING = "current_setting('app.gp_market_id', true)"
const INSTANCE_SETTING = "current_setting('app.gp_instance_id', true)"

export class Migration20261114100000DeferredIssuanceTraceTable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        trace_id            TEXT PRIMARY KEY,
        instance_id         TEXT NOT NULL,
        market_id           TEXT NOT NULL,
        state               TEXT NOT NULL,
        owner_type          TEXT NOT NULL,
        owner_id            TEXT NOT NULL,
        deadline            TIMESTAMPTZ NOT NULL,
        retry_count         INTEGER NOT NULL DEFAULT 0,
        version             INTEGER NOT NULL DEFAULT 1,
        occurred_at         TIMESTAMPTZ NOT NULL,
        closure_path        TEXT NOT NULL,
        resolution_evidence JSONB,
        provenance_kind     TEXT NOT NULL,
        provenance_source   TEXT NOT NULL,
        payment_intent_id   TEXT NOT NULL,
        stripe_event_id     TEXT NOT NULL,
        deferral_reason     TEXT NOT NULL,
        psp_occurred_at     TIMESTAMPTZ NOT NULL,
        age_source          TEXT NOT NULL,
        CONSTRAINT ${TABLE}_state_check
          CHECK (state IN ('awaiting_order','escalated','issued_after_link','closed_order_never_created')),
        CONSTRAINT ${TABLE}_deferral_reason_check
          CHECK (deferral_reason = 'webhook_before_order'),
        CONSTRAINT ${TABLE}_age_source_check
          CHECK (age_source = 'database_now_minus_occurred_at'),
        CONSTRAINT ${TABLE}_owner_check
          CHECK (owner_type IN ('operator_role','operator_user') AND length(btrim(owner_id)) > 0),
        CONSTRAINT ${TABLE}_scope_check
          CHECK (length(btrim(instance_id)) > 0 AND length(btrim(market_id)) > 0),
        CONSTRAINT ${TABLE}_counters_check
          CHECK (retry_count >= 0 AND version >= 1),
        CONSTRAINT ${TABLE}_closure_check
          CHECK (
            (state IN ('awaiting_order','escalated')
              AND closure_path = 'not_closed'
              AND resolution_evidence IS NULL)
            OR
            (state IN ('issued_after_link','closed_order_never_created')
              AND closure_path <> 'not_closed'
              AND length(btrim(closure_path)) > 0
              AND resolution_evidence IS NOT NULL
              AND jsonb_typeof(resolution_evidence) = 'object'
              AND resolution_evidence <> '{}'::jsonb)
          )
      )
    `)

    // Populacja otwarta per rynek — indeks częściowy nie rośnie z historią.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_open
        ON ${TABLE} (instance_id, market_id, occurred_at)
        WHERE state IN ('awaiting_order','escalated')
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_payment_intent
        ON ${TABLE} (payment_intent_id)
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${QUARANTINE} (
        source_event_id TEXT PRIMARY KEY,
        source_row      JSONB NOT NULL,
        reason          TEXT NOT NULL,
        quarantined_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    this.addSql(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${QUARANTINE} ENABLE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${QUARANTINE} FORCE ROW LEVEL SECURITY`)

    // Rola runtime istnieje na stackach z granicą 11.1; środowisko bez niej
    // nie dostaje grantu ani polityki dla nieistniejącej roli (fail-closed:
    // FORCE RLS bez polityki = zero wierszy dla nie-superusera).
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          EXECUTE 'REVOKE ALL PRIVILEGES ON ${TABLE} FROM ${RUNTIME_ROLE}';
          EXECUTE 'REVOKE ALL PRIVILEGES ON ${QUARANTINE} FROM ${RUNTIME_ROLE}';
          EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ${TABLE} TO ${RUNTIME_ROLE}';
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
    // Odwrotność `dit-drop-quarantine` / `dit-drop-table` z planu migracji.
    // Źródło backfillu (`webhook_event_processed`) pozostaje nietknięte.
    this.addSql(`DROP TABLE IF EXISTS ${QUARANTINE}`)
    this.addSql(`DROP TABLE IF EXISTS ${TABLE}`)
  }
}
