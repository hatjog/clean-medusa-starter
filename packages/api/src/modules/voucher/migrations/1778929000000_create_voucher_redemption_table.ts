import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 4.1 (v1.11.0 Epic 4 / Wave 4 — lifecycle) — warstwa DOMENY idempotencji
 * redeemu: tabela `voucher_redemption` (dedupe operacji redeem per
 * `(entitlement_id, idempotency_key)`, AC2).
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-139 D3
 * (idempotencja deterministyczna; tu DOMENOWA pierwsza/wiążąca bariera) + ADR-133
 * (derecognition jako event lifecycle redeem). Warstwa ledgera (deterministyczny
 * `transaction_id` writera 2.6) jest DRUGĄ barierą — ta tabela jest PIERWSZĄ.
 *
 * Kontrakt idempotencji (AC2):
 *   PRIMARY KEY (entitlement_id, idempotency_key) — composite. Powtórzony redeem
 *   z tą samą parą ⇒ `INSERT ... ON CONFLICT (entitlement_id, idempotency_key)
 *   DO NOTHING` = NO-OP (NIE obniża salda po raz drugi). Operacja redeem (4.1)
 *   czyta record (replay ⇒ skutek pierwszego redeemu) PRZED jakąkolwiek mutacją,
 *   pod row-lock `entitlement_instance FOR UPDATE` (serializacja redeemów).
 *   `redemption_id` przechowywany ⇒ replay routuje TEN SAM dyskryminator do
 *   writera ⇒ jeden derecognition posting (NIE podwaja). Różny `idempotency_key`
 *   (rata multi-installment) ⇒ różny `redemption_id` ⇒ N postingów dla N rat.
 *
 * Wzorzec migracji (spójnie z 2.6 `1778927000000` / 3.2 `1778928000000`):
 *   raw SQL hand-rolled DDL (NIE ORM auto-migration), `created_at` epoch-ms
 *   (`bigint`), `up()` idempotentny (`CREATE TABLE IF NOT EXISTS`).
 *
 * `down()` NON-DESTRUKCYJNY (append-only, spójnie z 2.6 D1 / 3.2): rollback NIE
 * robi `DROP TABLE` — usunięcie rejestru dedupe groziłoby PODWOJENIEM redeemu
 * (ponowne obniżenie salda + drugi derecognition posting) po re-applikacji.
 * Cofnięcie błędu = forward-fix. Świadomy, udokumentowany no-op (NIE pominięcie).
 *
 * Nazwa klasy `Migration1778929000000` (epoch-ms) sortuje się PO istniejących
 * migracjach modułu voucher (max `1778928300000` = 3.3 tighten sales_channel).
 *
 * NFR6 (cross-modułowość): tabela jest tworzona w module `voucher` i NIE odwołuje
 * się FK do tabel innych modułów (izolacja modułów Medusa 2) — migracja
 * single-module, brak triggera STOP-i-pytaj cross-domain.
 *
 * GRANICA (E4 / D-5 / ADR-139 D5): tabela = WARSTWA DANYCH dedupe domeny. NIE
 * aktywuje postingu (`runtime_enabled` zostaje `false`, flip = E6/P6). Migracja
 * nie czyta ani nie zmienia flagi aktywacji. NIE zmienia taksonomii stanów.
 */
export class Migration1778929000000 extends Migration {
  async up(): Promise<void> {
    // Domenowy dedupe redeemu: composite PK (entitlement_id, idempotency_key)
    // jest gwarantem idempotencji — powtórzony redeem ⇒ konflikt PK ⇒ no-op.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_redemption (
        -- entitlement, którego dotyczy redeem (saldo żyje na tym wierszu, NIE reissue).
        entitlement_id        text NOT NULL CHECK (char_length(entitlement_id) > 0),
        -- klucz idempotencji operacji domeny (z entitlement_id = klucz dedupe AC2).
        idempotency_key       text NOT NULL CHECK (char_length(idempotency_key) > 0),
        -- deterministyczny redemption_id (sha256(entitlement_id‖idempotency_key)) —
        -- dyskryminator transaction_id writera (ADR-139 D3, multi-installment-safe).
        redemption_id         text NOT NULL CHECK (char_length(redemption_id) > 0),
        -- zrealizowane brutto w tym redeemie (minor units), dodatnie.
        amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
        -- stan docelowy redeemu: WYŁĄCZNIE REDEEMED_PARTIAL / REDEEMED_FULL
        -- (taksonomia niezmieniona, D-5; allow-list fail-closed).
        resulting_state       text NOT NULL
                                CHECK (resulting_state IN ('REDEEMED_PARTIAL','REDEEMED_FULL')),
        -- saldo po redeemie (minor units), nieujemne (NIGDY < 0, AC1).
        remaining_after_minor bigint NOT NULL CHECK (remaining_after_minor >= 0),
        -- brutto całego vouchera przy emisji (net+vat, minor units) — źródło prawdy
        -- dla walidacji spójności net/vat między ratami (VER-H1 fail-closed, L3).
        issued_gross_minor    bigint NOT NULL CHECK (issued_gross_minor > 0),
        -- epoch-ms pierwszego redeemu (konflikt PK zachowuje pierwotny).
        created_at            bigint NOT NULL CHECK (created_at > 0),
        CONSTRAINT voucher_redemption_pkey PRIMARY KEY (entitlement_id, idempotency_key)
      )
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (spójnie z 2.6 D1 / 3.2). CELOWO NIE wykonuje
   * `DROP TABLE` ani `DELETE`/`TRUNCATE`: usunięcie rejestru dedupe redeemu
   * umożliwiłoby ponowne obniżenie salda i drugi derecognition posting
   * (podwojenie) po re-applikacji — odwrotność celu tabeli. Cofnięcie błędu =
   * forward-fix. Świadomy, udokumentowany no-op (NIE pominięcie).
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (idempotencja append-only, NIE DROP).
  }
}
