import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 5.9 review-fix (HIGH-2) — `entitlement_instance.expires_at`
 * uzupełnione z `voucher.expires_at` przez most kod → uprawnienie.
 *
 * Znacznik `1779010000000` DOPISANY do
 * `specs/releases/v1.15.0/migration-registry.yaml` (wpis `story_id: "5.9"`,
 * `kind: review-fix`), nie wygenerowany w worktree — ADR-177.
 *
 * ── Co naprawia ────────────────────────────────────────────────────────────
 * Do 5.9 stan kodu gasił bulk-`UPDATE` sterowany kolumną `voucher.expires_at`.
 * 5.9 usunęła ten zapis (był drugim producentem poza transakcją tranzycji)
 * i przeniosła wygaszanie na tranzycję uprawnienia — a sweeper bierze
 * kandydatów po `entitlement_instance.expires_at IS NOT NULL`. Produkcyjna
 * ścieżka wystawienia (Path Y) tej kolumny NIE wypełniała, więc od 5.9 żaden
 * voucher wystawiony normalnie już by nie wygasł: producent stanu `expired`
 * istniałby w kontrakcie i w bramce, a na realnej ścieżce nie odpaliłby się
 * ani razu.
 *
 * Nowe wiersze naprawia sam kod (`computeValidityEnd` zapisuje termin do OBU
 * nośników). Ta migracja domyka wiersze JUŻ ISTNIEJĄCE — inaczej zwężenie
 * populacji zostałoby ciche, a to jest dokładnie ta klasa defektu, którą
 * story usuwa.
 *
 * ── Dlaczego kopiujemy, a nie rozluźniamy bramki ───────────────────────────
 * `ExpireEntitlementOperation` z `require_due` żąda deterministycznego terminu
 * NA UPRAWNIENIU i słusznie: wygaszanie po terminie z innej tabeli byłoby
 * wygaszaniem po danych, których operacja nie zablokowała. Więc uzupełniamy
 * dane, zamiast osłabiać guard.
 *
 * `down()` jest ODWRACALNY WĄSKO: cofa do NULL wyłącznie te wiersze, których
 * `expires_at` jest RÓWNY terminowi z mostu — czyli te, które ta migracja
 * mogła ustawić. Terminu ustawionego ręcznie (`voucher.extend`) nie rusza.
 */
export class Migration1779010000000 extends Migration {
  async up(): Promise<void> {
    // Idempotentne: warunek `IS NULL` sprawia, że drugi przebieg obejmuje
    // zero wierszy.
    this.addSql(`
      UPDATE entitlement_instance e
         SET expires_at = v.expires_at,
             updated_at = NOW()
        FROM voucher v
       WHERE e.expires_at IS NULL
         AND v.expires_at IS NOT NULL
         AND v.code = e.policy_snapshot->>'voucher_code'
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      UPDATE entitlement_instance e
         SET expires_at = NULL,
             updated_at = NOW()
        FROM voucher v
       WHERE e.expires_at IS NOT NULL
         AND v.code = e.policy_snapshot->>'voucher_code'
         AND v.expires_at = e.expires_at
    `)
  }
}
