import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.11.0 Story 7.4 — ADR-138 DEC-1 (net-new TTL/410 magic-link voucher-claim).
 *
 * Dodaje stempel `claim_token_issued_at` do `entitlement_instance` — moment
 * wystawienia magic-linka voucher-claim. To podstawa egzekucji okna TTL (24h
 * default, konfigurowalne per-market) i odpowiedzi HTTP 410 (Gone) na wygasły
 * link (egzekucja w routach `by-claim-token` + `claim`, lib
 * `voucher-claim-magic-link-ttl.ts`).
 *
 * Dlaczego osobny stempel (audyt ADR-138, T1 — brak istniejącego TTL):
 *   - `expires_at` = wygaśnięcie **vouchera** (face value), NIE magic-linka.
 *   - `claim_token_revoked_at` = ręczne unieważnienie, NIE TTL.
 *   - Sam `claim_token` NIE miał stempla czasu wystawienia ⇒ link nie wygasał.
 *
 * Egzekucja TTL na warstwie danych+API (Stream A infra hardening) — stempel
 * ustawia TRIGGER DB przy każdym (nowym) przypisaniu `claim_token`, więc
 * logika domenowa mintowania (workflow `issue-entitlement`, Stream B) pozostaje
 * NIETKNIĘTA (granica Stream A/B).
 *
 * Grandfather (ADR-138 M-4 — brak baseline): istniejące wiersze z `claim_token`
 * NIE są backfillowane (issued_at zostaje NULL) ⇒ NIE wygasają retroaktywnie.
 * 24h nie jest regresją wobec znanej krótszej wartości, bo wartości bazowej nie
 * było. Nowe tokeny dostają stempel i niosą TTL.
 *
 * Rollback: feature-flag `VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED=false` (warstwa
 * API) ⇒ link bez wygasania. Trigger jest niezależny od flagi (tylko stempluje);
 * flaga decyduje o egzekucji w routach.
 *
 * Forward: ADD COLUMN + funkcja triggera + trigger. Idempotentne.
 * Reverse: DROP trigger + funkcja + kolumna. NON-destrukcyjne dla claim_token.
 */
export class Migration1778930000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS claim_token_issued_at timestamptz NULL
    `)

    // Trigger stamping: ustaw issued_at = NOW() gdy claim_token jest nadawany
    // (INSERT z niepustym tokenem) lub zmieniany na INNY niepusty token
    // (re-issue / reissue-lost-code in-place).
    //
    // Polityka re-stemplowania (ADR-138 DEC-1 review fix, Story 7.4):
    //   - INSERT z nowym tokenem ⇒ zawsze stempluj (issued_at := NOW()), nadpisując
    //     ewentualną wartość przekazaną przez wywołującego tylko gdy jest NULL.
    //   - UPDATE token DISTINCT FROM OLD ⇒ stempluj BEZWARUNKOWO (reset zegara TTL
    //     przy każdym re-issue in-place) — nowy link musi mieć WŁASNY stempel,
    //     nie dziedziczyć daty z poprzedniego tokenu (latentny bug: stary stempel ⇒
    //     link mógłby urodzić się wygasły).
    //   - UPDATE token nie zmieniony ⇒ nie dotykaj stempla.
    // Czysto na warstwie danych — bez zmian w TS domeny (granica Stream A/B).
    this.addSql(`
      CREATE OR REPLACE FUNCTION entitlement_instance_stamp_claim_token_issued_at()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.claim_token IS NOT NULL THEN
          IF TG_OP = 'INSERT' THEN
            -- INSERT: stempluj gdy issued_at nie zostało jawnie podane.
            IF NEW.claim_token_issued_at IS NULL THEN
              NEW.claim_token_issued_at := NOW();
            END IF;
          ELSIF NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
            -- UPDATE z innym tokenem (re-issue in-place): ZAWSZE reset zegara,
            -- niezależnie od poprzedniej wartości issued_at — nowy token = nowe TTL.
            NEW.claim_token_issued_at := NOW();
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)

    this.addSql(`
      DROP TRIGGER IF EXISTS trg_entitlement_instance_stamp_claim_token_issued_at
        ON entitlement_instance
    `)
    this.addSql(`
      CREATE TRIGGER trg_entitlement_instance_stamp_claim_token_issued_at
        BEFORE INSERT OR UPDATE ON entitlement_instance
        FOR EACH ROW
        EXECUTE FUNCTION entitlement_instance_stamp_claim_token_issued_at()
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_entitlement_instance_stamp_claim_token_issued_at
        ON entitlement_instance
    `)
    this.addSql(`
      DROP FUNCTION IF EXISTS entitlement_instance_stamp_claim_token_issued_at()
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS claim_token_issued_at
    `)
  }
}
