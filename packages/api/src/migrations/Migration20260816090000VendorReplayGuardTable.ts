import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 5.3 (FR-11 człon replay-guard, AD-20, AD-23, ADR-185) —
 * trwały nośnik bariery anty-replay dla `/vendor/*`.
 *
 * Stempel `20260816090000` POCHODZI Z REJESTRU
 * `specs/releases/v1.15.0/migration-registry.yaml` (`story_id: "5.3"`,
 * `module: api`), a nie z generatora w worktree — Z-10: jeden właściciel
 * numeracji na release.
 *
 * ── Co ta tabela zastępuje ─────────────────────────────────────────────────
 * Mapę `NonceLru` w pamięci procesu API. Przy dwóch instancjach każda miała
 * własną mapę, więc powtórzenie skierowane do drugiej instancji nie było
 * widoczne w ogóle.
 *
 * ── Dlaczego `guard_key` jest KLUCZEM GŁÓWNYM ──────────────────────────────
 * Bo ograniczenie unikalności JEST barierą (AD-23). Kod nie „sprawdza, czy
 * klucz istnieje" — wysyła jedno `INSERT … ON CONFLICT (guard_key) DO UPDATE
 * … WHERE expires_at <= $now RETURNING …` i czyta werdykt z liczby zwróconych
 * wierszy. Bez tego ograniczenia całe stwierdzenie nie miałoby na czym stanąć.
 *
 * `guard_key` to skrót SHA-256 (64 znaki hex) z `sellerId` + `ts` + `nonce` +
 * skrótu treści — stała szerokość niezależnie od długości `nonce`.
 *
 * ── `expires_at` to PREDYKAT, nie zadanie sprzątające ──────────────────────
 * Wygasanie realizuje `WHERE expires_at <= $now` na `DO UPDATE`: wygasły wiersz
 * przestaje blokować SAM Z SIEBIE, bez udziału jakiegokolwiek crona. Indeks
 * `idx_vendor_replay_guard_expires_at` obsługuje wyłącznie HIGIENĘ (kasowanie
 * wygasłych wierszy) i jego brak nie zmieniłby werdyktu bariery.
 *
 * ── `down()` kasuje tabelę ─────────────────────────────────────────────────
 * W odróżnieniu od tabel konfiguracyjnych, tu nie ma danych operacyjnych do
 * ochrony: zawartość to efemeryczne wpisy o żywotności `2 × drift + margines`
 * (domyślnie 660 s). Rollback zdejmuje dokładnie to, co założył `up`.
 */
export class Migration20260816090000VendorReplayGuardTable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS vendor_replay_guard (
        guard_key   TEXT PRIMARY KEY,
        seller_id   TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_vendor_replay_guard_expires_at
        ON vendor_replay_guard (expires_at)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_vendor_replay_guard_expires_at`)
    this.addSql(`DROP TABLE IF EXISTS vendor_replay_guard`)
  }
}
