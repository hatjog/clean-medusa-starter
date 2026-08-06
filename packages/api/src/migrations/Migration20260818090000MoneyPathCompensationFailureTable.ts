import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 3.5 (FR-6c, NFR-3, AD-22) — TRWAŁY nośnik faktu „kompensacja
 * na ścieżce pieniądza nie doszła do skutku".
 *
 * Stempel `20260818090000` POCHODZI Z REJESTRU
 * `specs/releases/v1.15.0/migration-registry.yaml` (`story_id: "3.5"`,
 * `module: api`) — wpis dopisała ta story zgodnie z krokiem 4 procedury
 * rejestru („Potrzebujesz numeru, którego tu nie ma? Dopisz wpis, nie zgaduj").
 * Rozłączny ze stemplami 3.3 (`20260812090000`) i 5.3 (`20260816090000`).
 *
 * ── Co ta tabela zastępuje ─────────────────────────────────────────────────
 * Jedną linię `logger.error` w `api/webhooks/stripe/payment-intent/route.ts`,
 * która mówiła „wymaga ręcznego usunięcia wiersza" do logu kontenera. Log
 * rotuje, znika z procesem i nie jest czytany, dopóki klientka nie napisze, że
 * nie dostała vouchera. AD-22: zdarzenie finansowe ma ślad w BAZIE.
 *
 * ── Dlaczego OSOBNA tabela, a nie rozszerzenie istniejącej ─────────────────
 *  * `webhook_event_processed` — to jest wiersz REZERWACJI, którego nieudane
 *    usunięcie właśnie odnotowujemy. Zapis faktu do obiektu, którego dotyczy
 *    fakt, miesza skutek z jego kompensacją i ginie razem z nim.
 *  * `operator_alert_firing_history` — pisana wyłącznie przez
 *    `jobs/alert-evaluator-cron.ts`, bez `market_id`, bez związku ze ścieżką
 *    pieniądza.
 *  * log + PostHog — PostHog jest ESKALACJĄ (FR-9g), nie księgą.
 *
 * ── `market_id NOT NULL` i skalarny `order_id` (AD-22, ADR-166) ────────────
 * Jeden wiersz opisuje DOKŁADNIE JEDNO zamówienie. Zakup multi-seller
 * (N zamówień z jednego PaymentIntenta) daje N wierszy, każdy z własnym
 * `market_id` wziętym z TEGO zamówienia. Wyprowadzanie rynku przez
 * `orders[0].market_id` dla wiersza opisującego N zamówień jest zakazane
 * (AC2) — dlatego kardynalność wiersza jest skalarna, a nie agregatowa.
 * Kwoty NIE są tu sumowane ani przechowywane (ADR-166: agregat po N
 * zamówieniach był źródłem defektu „N voucherów po CAŁEJ kwocie PI").
 *
 * Rynek zakupu i rynek realizacji NIE są tu rozdzielane na dwa pola
 * (wzorzec ADR-178 §2.4): wiersz opisuje porażkę kompensacji TRANSPORTU
 * dostawy webhooka, czyli zdarzenie sprzed jakiejkolwiek realizacji —
 * realizacja jeszcze nie istnieje, więc drugie pole nie miałoby wartości
 * i byłoby kolumną `NULL` udającą wymiar.
 *
 * ── `delivery_path` — rozróżnienie ścieżek dostawy nie może zginąć ─────────
 * `lib/payment/stripe-payment-intent-transport.ts` celowo używa innej wartości
 * `provider` (`stripe_payment_intent_webhook`) niż natywny hook (`stripe`),
 * żeby kompensacja jednej ścieżki (`DELETE … WHERE provider = 'stripe'`
 * w `workflows/payment/stripe-payment-audit.ts`) nigdy nie zdjęła rezerwacji
 * drugiej. Ujednolicenie było raz rozważone i ODRZUCONE („łamie kompensację").
 * Wiersz rejestru niesie więc, KTÓREJ ścieżki dotyczy.
 *
 * ── Idempotencja wobec ponowienia Stripe'a ────────────────────────────────
 * `failure_id` jest KLUCZEM GŁÓWNYM i jest deterministycznym skrótem
 * (`sha256` z `delivery_path`, `stripe_event_id`, `compensation_kind`,
 * `failure_code`, `order_id`). Powtórna dostawa TEGO SAMEGO `evt_…` z tą samą
 * klasą porażki trafia w `ON CONFLICT (failure_id) DO UPDATE`, który
 * INKREMENTUJE `attempt_count` i przesuwa `last_attempt_at`. Wiersze się nie
 * mnożą, a informacja o kolejnej próbie NIE ginie. Rozstrzygnięcie jest
 * w kluczu i w predykacie, nie w komentarzu.
 *
 * Klucz główny (a nie `UNIQUE` na krotce) jest tu świadomy: `order_id` bywa
 * `NULL` (porażka przed rezolucją zamówień), a `UNIQUE` w PostgreSQL NIE
 * porównuje `NULL`-i — ograniczenie przepuściłoby dowolną liczbę duplikatów
 * dokładnie w tym przypadku, dla którego istnieje.
 *
 * ── `down()` kasuje tabelę ────────────────────────────────────────────────
 * `up`/`down` jest odwracalne bajt w bajt; przebieg na realnym Postgresie
 * 17.6 jest w `evidence/3-5/rejestr-postgres-proof.out`.
 */
export class Migration20260818090000MoneyPathCompensationFailureTable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS money_path_compensation_failure (
        failure_id               TEXT PRIMARY KEY,
        market_id                TEXT NOT NULL,
        compensation_kind        TEXT NOT NULL,
        delivery_path            TEXT NOT NULL,
        stripe_event_id          TEXT NOT NULL,
        payment_intent_id        TEXT NOT NULL,
        order_id                 TEXT,
        purchase_correlation_key TEXT NOT NULL,
        failure_code             TEXT NOT NULL,
        failure_detail           TEXT NOT NULL,
        occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempt_count            INTEGER NOT NULL DEFAULT 1,
        last_attempt_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolution_state         TEXT NOT NULL DEFAULT 'open',
        resolved_at              TIMESTAMPTZ,
        resolved_by              TEXT,
        CONSTRAINT money_path_compensation_failure_kind_check
          CHECK (compensation_kind IN (
            'webhook_delivery_release',
            'issued_entitlement_rollback',
            'payment_audit_rollback',
            'cart_payment_authorization_cancel'
          )),
        CONSTRAINT money_path_compensation_failure_state_check
          CHECK (resolution_state IN ('open', 'resolved_manually')),
        CONSTRAINT money_path_compensation_failure_resolution_check
          CHECK (
            (resolution_state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
            OR
            (resolution_state = 'resolved_manually' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
          ),
        CONSTRAINT money_path_compensation_failure_attempt_check
          CHECK (attempt_count >= 1)
      )
    `)

    // Zapytanie operatora brzmi „co jest DZIŚ otwarte na tym rynku" — indeks
    // częściowy obsługuje dokładnie je i nie rośnie razem z historią zamkniętą.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_money_path_compensation_failure_open
        ON money_path_compensation_failure (market_id, occurred_at DESC)
        WHERE resolution_state = 'open'
    `)

    // Złączenie wierszy jednego zakupu (klucz korelacji Story 3.3).
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_money_path_compensation_failure_correlation
        ON money_path_compensation_failure (purchase_correlation_key)
    `)
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS idx_money_path_compensation_failure_correlation`
    )
    this.addSql(`DROP INDEX IF EXISTS idx_money_path_compensation_failure_open`)
    this.addSql(`DROP TABLE IF EXISTS money_path_compensation_failure`)
  }
}
