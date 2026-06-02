import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 2.6 (v1.11.0 Epic 2 / Wave 2) — fundament persystencji entitlement-ledgera.
 * Podstawa normatywna: ADR-139 D1 (persystencja namespaced) + ADR-133 §P6
 * (separacja entitlement↔money). Kontrakt: ledger-transaction.v1.schema.json (Story 2.1).
 *
 * Tworzy NAMESPACED tabele entitlement-ledgera:
 *   - `voucher_ledger_transaction` — nagłówek transakcji księgowej (1:N do entries);
 *   - `voucher_ledger_entry`       — linie double-entry (≥2 na transakcję);
 *   - `ledger_posting_applied`     — tabela dedup (`transaction_id` PK), idempotencja writera (D3).
 *
 * KRYTYCZNE — separacja entitlement-ledger ≠ money-ledger (ADR-139 D1, ADR-133):
 * money-ledger `ledger_entry` / `ledger_transaction` JUŻ ISTNIEJE
 * (`lib/ledger/posting-trigger.ts`, legacy migracja D-47). Te tabele są celowo
 * namespaced (`voucher_ledger_*`), by separacja entitlement↔money była egzekwowana
 * na poziomie TABEL, nie tylko kont. Reuse nazw money-ledger = kolizja i zatarcie
 * granicy (zakazane).
 *
 * Wzorzec: raw SQL hand-rolled DDL (NIE ORM auto-migration), timestampy epoch-ms
 * (`bigint`, milisekundy) — `occurred_at` (czas zdarzenia) jest CELOWO rozdzielony
 * od `created_at` (czas zapisu): reconciliation (D2) i dedup odtwarzają wpis z
 * persystowanego snapshotu zdarzenia, którego czas (`occurred_at`) bywa wcześniejszy
 * niż moment fizycznego zapisu (`created_at`).
 *
 * DB-enforced kontrakt v1 (ADR-139 D1):
 *   - `posting_profile` / `vat_classification` / `lifecycle_event` — NOT NULL + CHECK;
 *   - `entry_type` CHECK = WYŁĄCZNIE `ENTITLEMENT_*` (allow-list; NIE money entry types
 *     `ORDER_PAID`/`ORDER_REFUNDED`/`CASH_SETTLED`/`ADJUSTMENT`);
 *   - `market_id` ZDENORMALIZOWANY na `voucher_ledger_entry` (reconciliation per-market
 *     bez JOIN do nagłówka);
 *   - linia double-entry: dokładnie jedna strona dodatnia (CHECK), kwoty nieujemne.
 *
 * `down()` NON-DESTRUKCYJNY (append-only finance — ADR-139 D1): rollback NIE robi
 * `DROP TABLE`. Cofnięcie błędnego stanu księgowego = forward-fix (nowy wpis korygujący),
 * NIGDY destrukcyjne usunięcie wierszy ledgera. `up()` jest idempotentny
 * (`CREATE TABLE IF NOT EXISTS`), więc re-run jest bezpieczny.
 *
 * Nazwa klasy `Migration1778927000000` (epoch-ms ≈ 2026-05-07+) sortuje się PO
 * istniejących migracjach modułu voucher (max `1778926200000`), więc CREATE tych
 * tabel nie koliduje z wcześniejszymi ALTER-ami.
 *
 * GRANICA (ADR-139 D5 / FR60): migracja dostarcza ZDOLNOŚĆ ZAPISU. NIE aktywuje
 * postingu (`runtime_enabled` w `posting-profile.ts` zostaje `false`) — flip = osobny
 * P6 finance gate (E6), ręczna decyzja Roberta. Migracja nie czyta ani nie zmienia flagi.
 */
export class Migration1778927000000 extends Migration {
  async up(): Promise<void> {
    // ── voucher_ledger_transaction — nagłówek transakcji księgowej (1:N) ────
    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_ledger_transaction (
        transaction_id      text PRIMARY KEY,
        -- entry_type: WYŁĄCZNIE ENTITLEMENT_* (allow-list, ADR-139 D1) — separacja
        -- od money entry types egzekwowana w DB.
        entry_type          text NOT NULL CHECK (entry_type IN (
                              'ENTITLEMENT_ISSUED',
                              'ENTITLEMENT_REDEEMED',
                              'ENTITLEMENT_EXPIRED',
                              'ENTITLEMENT_BREAKAGE'
                            )),
        -- kontrakt v1 promowany do NOT NULL + CHECK (ADR-139 D1):
        posting_profile     text NOT NULL CHECK (posting_profile = 'voucher_liability_only_v1'),
        vat_classification  text NOT NULL CHECK (vat_classification IN ('SPV','MPV')),
        -- lifecycle_event: superset domeny zdarzeń. Generator (Story 2.3) emituje
        -- gruboziarniste ISSUED/REDEEMED/EXPIRED; macierz double-entry (Story 2.5)
        -- używa granularnych REDEEMED_PARTIAL/REDEEMED_FULL. CHECK akceptuje OBA,
        -- by writer i seed golden-matrix (D4) były spójne.
        lifecycle_event     text NOT NULL CHECK (lifecycle_event IN (
                              'ISSUED','REDEEMED','REDEEMED_PARTIAL','REDEEMED_FULL','EXPIRED'
                            )),
        -- scope (ledger-transaction.v1 §scope):
        instance_id         text NOT NULL CHECK (char_length(instance_id) > 0),
        market_id           text NOT NULL CHECK (char_length(market_id) > 0),
        vendor_id           text NULL,
        location_id         text NULL,
        currency            text NOT NULL CHECK (char_length(currency) = 3),
        -- occurred_at (czas zdarzenia) ROZDZIELONY od created_at (czas zapisu),
        -- epoch-ms (bigint). Dedup zachowuje pierwszy occurred_at (D3).
        occurred_at         bigint NOT NULL CHECK (occurred_at > 0),
        created_at          bigint NOT NULL CHECK (created_at > 0),
        metadata            jsonb NULL
      )
    `)

    // ── voucher_ledger_entry — linie double-entry ───────────────────────────
    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_ledger_entry (
        ledger_entry_id     text PRIMARY KEY,
        transaction_id      text NOT NULL
                              REFERENCES voucher_ledger_transaction(transaction_id),
        account             text NOT NULL CHECK (char_length(account) > 0),
        debit_minor         bigint NOT NULL CHECK (debit_minor >= 0),
        credit_minor        bigint NOT NULL CHECK (credit_minor >= 0),
        -- każda linia ma DOKŁADNIE jedną stronę dodatnią (ledger README / AR-LEDGER-FMT):
        CONSTRAINT voucher_ledger_entry_one_sided
          CHECK ((debit_minor > 0) <> (credit_minor > 0)),
        -- market_id ZDENORMALIZOWANY (reconciliation per-market bez JOIN, ADR-139 D1):
        market_id           text NOT NULL CHECK (char_length(market_id) > 0),
        occurred_at         bigint NOT NULL CHECK (occurred_at > 0),
        created_at          bigint NOT NULL CHECK (created_at > 0),
        metadata            jsonb NULL
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_ledger_entry_transaction_id_idx
        ON voucher_ledger_entry (transaction_id)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_ledger_entry_market_id_idx
        ON voucher_ledger_entry (market_id)
    `)

    // ── ledger_posting_applied — dedup / idempotencja writera (D3) ──────────
    // transaction_id PK: dedup-INSERT ON CONFLICT DO NOTHING jest PIERWSZY w
    // hand-rolled DB-tx (przed transaction+entries) → replay = no-op (writer D3).
    // entitlement_id + lifecycle_event: scan reconciliation (D2) — terminalne
    // entitlementy bez wpisu w tej tabeli to luka kompletności do dosłania.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS ledger_posting_applied (
        transaction_id      text PRIMARY KEY,
        entitlement_id      text NOT NULL CHECK (char_length(entitlement_id) > 0),
        lifecycle_event     text NOT NULL CHECK (lifecycle_event IN (
                              'ISSUED','REDEEMED','REDEEMED_PARTIAL','REDEEMED_FULL','EXPIRED'
                            )),
        market_id           text NOT NULL CHECK (char_length(market_id) > 0),
        -- occurred_at = pierwszy occurred_at (konflikt dedup go zachowuje, D3):
        occurred_at         bigint NOT NULL CHECK (occurred_at > 0),
        applied_at          bigint NOT NULL CHECK (applied_at > 0)
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS ledger_posting_applied_entitlement_idx
        ON ledger_posting_applied (entitlement_id, lifecycle_event)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS ledger_posting_applied_market_id_idx
        ON ledger_posting_applied (market_id)
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (ADR-139 D1 — append-only finance). CELOWO NIE
   * wykonuje `DROP TABLE` ani `DELETE`: ledger finansowy jest append-only, więc
   * cofnięcie błędu = forward-fix (nowy wpis korygujący), nie usunięcie danych.
   * `down()` pozostaje no-opem — gdyby MikroORM go uruchomił, NIE skasuje wpisów
   * księgowych. Świadoma, udokumentowana decyzja (NIE pominięcie).
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (append-only finance, NIE DROP).
  }
}
