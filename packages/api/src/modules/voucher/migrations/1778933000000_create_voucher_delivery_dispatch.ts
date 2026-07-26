import { Migration } from "@medusajs/framework/mikro-orm/migrations"

import {
  DELIVERY_DISPATCH_STATES,
  DELIVERY_STATE_CONTRACT_ID,
} from "../../voucher-delivery/delivery-state"
import { RECIPIENT_HASH_PATTERN } from "../../voucher-delivery/recipient-hash"

/**
 * Story 2.3 (v1.14.0) — ledger dostarczeń `voucher_delivery_dispatch` (AD-7).
 *
 * Wzorzec 1:1 z `1778931000000_create_voucher_claim_store.ts`: raw SQL przez
 * `addSql`, `IF NOT EXISTS`, `_binding`-owa tabela idempotencji + append-only
 * `_audit`, non-destrukcyjny `down()`.
 *
 * ── Klucz idempotencji ──────────────────────────────────────────────────────
 * `UNIQUE (entitlement_id, template_key, recipient_hash)` — dokładnie ta trójka
 * odpowiada na pytanie „czy TEN mail (szablon) poszedł już do TEGO odbiorcy dla
 * TEGO entitlementu". Subscriber `voucher-purchase-delivery` jest JEDYNYM
 * pisarzem i wstawia INSERT-first `ON CONFLICT DO NOTHING` (NIE „SELECT then
 * INSERT"), więc redelivery webhooka `payment.captured`, retry subscribera oraz
 * druga konsumpcja (ISSUED + ACTIVE) dają dokładnie jeden mail (NFR3).
 *
 * ── Zero surowego PII (D-70) ────────────────────────────────────────────────
 * Nie ma kolumny na adres e-mail — ani tutaj, ani w audycie. Odbiorca jest
 * reprezentowany WYŁĄCZNIE przez `recipient_hash = sha256(trim+lowercase(email))`
 * w kształcie `sha256:<64 hex>`, egzekwowanym CHECK-iem. Hash liczy jedna
 * funkcja modułu (`voucher-delivery/recipient-hash.ts`), a API ledgera przyjmuje
 * brandowany typ `RecipientHash`, więc wstawienie surowego adresu jest błędem
 * kompilacji.
 *
 * ── Stany: enum ZAPOŻYCZONY, event NIE emitowany (AD-7) ─────────────────────
 * CHECK na `status` jest generowany ze stałej `DELIVERY_DISPATCH_STATES`, która
 * jest runtime'ową projekcją `properties.state.enum` kontraktu
 * `gp.communication.delivery_state_changed.v1`. Nie ma tu drugiego literału
 * enumu — parity z kontraktem pilnuje drift-test. Sam event NIE jest emitowany
 * w v1.14.0; pożyczamy słownik, nie kanał.
 *
 * ── Relacja do zastanej `voucher_delivery_decision` (D-72) ──────────────────
 * Tabele są ROZŁĄCZNE; nowa NIE zastępuje i NIE duplikuje starej:
 *   - `voucher_delivery_decision` — append-only DECYZJA 5-stepowego kontraktu
 *     PII-consent, keyowana po `consent_audit_id`, odpowiada „jak skończył się
 *     krok dostarczenia" (`dispatched` / `dlq_*` / `withdrawn`).
 *   - `voucher_delivery_dispatch` — LEDGER IDEMPOTENCJI WYSYŁKI keyowany po
 *     `(entitlement_id, template_key, recipient_hash)`, odpowiada „czy ten mail
 *     już poszedł" i czyni reconciliation sweep (Story 2.5) możliwym.
 *
 * ── `down()` jest no-op (non-destrukcyjny) ──────────────────────────────────
 * Historia dostarczeń nie może zginąć przez rollback: skasowanie ledgera
 * zamieniłoby „mail już poszedł" w „mail nigdy nie poszedł" i przy pierwszym
 * powtórzonym evencie wysłałoby duplikat do kupującej. Forward-fix jest jedyną
 * bezpieczną korektą.
 *
 * ── Retencja ────────────────────────────────────────────────────────────────
 * `voucher_delivery_dispatch` rośnie liniowo z liczbą wysyłek i jest źródłem
 * prawdy dla idempotencji — NIE ma TTL i nie wolno go czyścić dla wierszy
 * `sent`/`delivered` (usunięcie = ryzyko duplikatu maila). `..._audit` rośnie
 * append-only; indeksy `(dispatch_id, occurred_at)` i `(entitlement_id,
 * occurred_at)` umożliwiają range-scany. Partycjonowanie po `occurred_at` albo
 * cykliczny DELETE wierszy audytu starszych niż 90 dni należy wdrożyć dedykowanym
 * jobem przed skalą > 10M wierszy — decyzja poza zakresem 2.3 (patrz ADR-161).
 */
export class Migration1778933000000 extends Migration {
  async up(): Promise<void> {
    // Enum stanu generowany ze stałej zapożyczonej z kontraktu — zero drugiego
    // literału w SQL-u. `DELIVERY_STATE_CONTRACT_ID` jest tylko w komentarzu:
    // event nie jest emitowany, pożyczony jest wyłącznie słownik stanów.
    const statusList = DELIVERY_DISPATCH_STATES.map((state) => `'${state}'`).join(
      ", ",
    )
    // CHECK kształtu hasha: ten sam wzorzec, co `recipient_contact_hash`
    // (`^sha256:[a-f0-9]{64}$`) w kontrakcie komunikacyjnym.
    const recipientHashRegex = RECIPIENT_HASH_PATTERN.source

    this.addSql(`
      -- Enum status zapożyczony z kontraktu ${DELIVERY_STATE_CONTRACT_ID}
      -- (event NIE jest emitowany w v1.14.0 — AD-7).
      CREATE TABLE IF NOT EXISTS voucher_delivery_dispatch (
        dispatch_id         text PRIMARY KEY,
        entitlement_id      text NOT NULL CHECK (char_length(entitlement_id) > 0),
        template_key        text NOT NULL CHECK (char_length(template_key) > 0),
        recipient_hash      text NOT NULL
                              CHECK (recipient_hash ~ '${recipientHashRegex}'),
        market_id           text NOT NULL CHECK (char_length(market_id) > 0),
        flow_id             text NOT NULL CHECK (char_length(flow_id) > 0),
        locale              text NOT NULL CHECK (char_length(locale) > 0),
        status              text NOT NULL CHECK (status IN (${statusList})),
        provider            text NULL,
        provider_message_id text NULL,
        error_code          text NULL,
        attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        queued_at           timestamptz NOT NULL,
        sent_at             timestamptz NULL,
        failed_at           timestamptz NULL,
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT voucher_delivery_dispatch_identity_uq
          UNIQUE (entitlement_id, template_key, recipient_hash),
        -- 'sent' bez znacznika czasu wysyłki byłby nieaudytowalnym „poszło".
        CONSTRAINT voucher_delivery_dispatch_sent_at_pair
          CHECK (status <> 'sent' OR sent_at IS NOT NULL),
        -- 'failed' bez kodu błędu uniemożliwiałby triage i decyzję o retry.
        CONSTRAINT voucher_delivery_dispatch_failed_code_pair
          CHECK (status <> 'failed' OR error_code IS NOT NULL)
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_delivery_dispatch_entitlement_idx
        ON voucher_delivery_dispatch (entitlement_id)
    `)
    this.addSql(`
      -- Skan sweepa 2.5: „entitlementy bez rekordu sent" per rynek/status.
      CREATE INDEX IF NOT EXISTS voucher_delivery_dispatch_status_market_idx
        ON voucher_delivery_dispatch (status, market_id, queued_at)
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_delivery_dispatch_audit (
        audit_id        bigserial PRIMARY KEY,
        dispatch_id     text NOT NULL,
        entitlement_id  text NOT NULL,
        template_key    text NOT NULL,
        recipient_hash  text NOT NULL
                          CHECK (recipient_hash ~ '${recipientHashRegex}'),
        market_id       text NOT NULL,
        from_status     text NULL CHECK (from_status IS NULL OR from_status IN (${statusList})),
        to_status       text NOT NULL CHECK (to_status IN (${statusList})),
        error_code      text NULL,
        attempt_count   integer NOT NULL DEFAULT 0,
        occurred_at     timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT NOW()
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_delivery_dispatch_audit_dispatch_idx
        ON voucher_delivery_dispatch_audit (dispatch_id, occurred_at)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_delivery_dispatch_audit_entitlement_idx
        ON voucher_delivery_dispatch_audit (entitlement_id, occurred_at)
    `)
  }

  async down(): Promise<void> {
    // Intencjonalnie puste (jak w claim-store): ledger dostarczeń jest trwałym
    // śladem operacyjnym i jednocześnie kluczem idempotencji maila. Rollback,
    // który go kasuje, produkuje duplikaty maili — forward-fix jest jedyną
    // bezpieczną korektą.
  }
}
