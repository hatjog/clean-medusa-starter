/**
 * entitlement-dedupe.ts — Story 3.3 (v1.11.0 Epic 3) — kontrakt warstwy danych dla
 * PER-ENTITLEMENT idempotencji live-issue (ADR-137 §Decyzja pkt 3 / DEC-5 pkt 3.ii,
 * finding H-2 net-new pola, finding L-2 pełny digest).
 *
 * Towarzyszy migracji `1778928200000_add_entitlement_dedupe_key_and_recipient_index.ts`
 * (kolumny `entitlement_dedupe_key` + `recipient_index` + partial UNIQUE index na
 * `entitlement_instance`). Dostarcza:
 *   - deterministyczny builder klucza dedupe `buildEntitlementDedupeKey()`
 *     (sha256 PEŁNY hex digest, separator `‖` — BEZ truncacji, finding L-2);
 *   - stałe nazw kolumn + unique-indexu (single source-of-truth dla 3.3 writer
 *     + asercji migracyjnych);
 *   - prymityw idempotentnego INSERT `buildEntitlementDedupeInsertClause()`
 *     (fragment `ON CONFLICT (entitlement_dedupe_key) DO NOTHING`).
 *
 * ── DWUPOZIOMOWA IDEMPOTENCJA (ADR-137 DEC-5) ───────────────────────────────
 * Warstwa (i) EVENT-LEVEL żyje w `event-processed.ts` (Story 3.2): dedupe po
 * `(external_id, event_type)`. Chroni przed ponownym przetworzeniem CAŁEGO eventu.
 *
 * Warstwa (ii) PER-ENTITLEMENT (TEN plik): `entitlement_dedupe_key =
 * sha256(payment_intent_id ‖ line_item_id ‖ recipient_index)`. To OSTATNIA bariera
 * przed podwojeniem POJEDYNCZEGO entitlementu. Dwa poziomy są konieczne (DEC-5):
 * FR10 — jeden zakup (jeden `payment_intent`) może dać WIELE entitlementów
 * (per-recipient / per-line-item); naiwny dedupe po samym `external_id` blokowałby
 * legalne multi-recipient issue. Klucz per-entitlement rozróżnia recipientów
 * (`recipient_index`) oraz pozycje (`line_item_id`) w obrębie jednego eventu, więc:
 *   - retry tego samego eventu ⇒ identyczne klucze ⇒ `ON CONFLICT DO NOTHING` ⇒
 *     no-op (NIE error → brak retry-loop) ⇒ JEDEN entitlement;
 *   - jeden zakup z N recipientami ⇒ N RÓŻNYCH kluczy ⇒ N entitlementów.
 *
 * GRANICA (E3): to WARSTWA DANYCH / prymityw idempotencji. NIE okablowuje maszyny
 * stanów (3.4), NIE aktywuje postingu. Snapshot policy/VAT i sam zapis ISSUED żyją
 * w writerze live-issue (3.3), który KONSUMUJE ten klucz.
 */

import { createHash } from "node:crypto"

/** Nazwa kolumny klucza dedupe per-entitlement (zgodna z migracją 3.3). */
export const ENTITLEMENT_DEDUPE_KEY_COLUMN = "entitlement_dedupe_key" as const

/** Nazwa kolumny deterministycznego indeksu recipienta w obrębie eventu. */
export const ENTITLEMENT_RECIPIENT_INDEX_COLUMN = "recipient_index" as const

/** Nazwa partial UNIQUE indexu egzekwującego dedupe per-entitlement w DB. */
export const ENTITLEMENT_DEDUPE_KEY_UNIQUE_INDEX =
  "entitlement_instance_dedupe_key_uq" as const

/**
 * Separator komponentów klucza dedupe. Znak U+2016 (DOUBLE VERTICAL LINE, `‖`)
 * jest CELOWY (kontrakt ADR-137 DEC-5 pkt 3.ii): nie występuje w Stripe
 * `payment_intent_id` (`pi_...`), Medusa `line_item_id` ani w dziesiętnym
 * `recipient_index`, więc eliminuje ambiguity konkatenacji (`a‖b` ≠ `ab‖` itd.).
 */
export const ENTITLEMENT_DEDUPE_KEY_SEPARATOR = "‖" as const

/**
 * Deterministyczny klucz dedupe per-entitlement:
 *   `sha256(payment_intent_id ‖ line_item_id ‖ recipient_index)` — PEŁNY hex
 *   digest (64 znaki), BEZ truncacji (finding L-2: truncacja podnosi ryzyko
 *   kolizji i jest zakazana). Separator `‖` zapobiega ambiguity konkatenacji.
 *
 * Klucz jest stabilny względem retry/replay tego samego faktu płatności
 * (te same komponenty ⇒ ten sam digest ⇒ `ON CONFLICT DO NOTHING`) oraz UNIKALNY
 * dla każdego recipienta/pozycji (różny `recipient_index`/`line_item_id` ⇒ różny
 * digest), co realizuje FR10 (jeden zakup ⇒ wiele entitlementów per-recipient).
 *
 * Czysta funkcja (deterministyczna, bez I/O). `recipient_index` MUSI być
 * nieujemną liczbą całkowitą (deterministyczny indeks recipienta zamrożonego
 * w immutable payload płatności — precondition ADR-137); inne wartości są błędem
 * programistycznym i są odrzucane fail-loud.
 */
export function buildEntitlementDedupeKey(
  paymentIntentId: string,
  lineItemId: string,
  recipientIndex: number
): string {
  if (!paymentIntentId) {
    throw new Error("buildEntitlementDedupeKey: payment_intent_id wymagany (niepusty)")
  }
  if (!lineItemId) {
    throw new Error("buildEntitlementDedupeKey: line_item_id wymagany (niepusty)")
  }
  if (!Number.isInteger(recipientIndex) || recipientIndex < 0) {
    throw new Error(
      `buildEntitlementDedupeKey: recipient_index musi być nieujemną liczbą całkowitą (otrzymano ${recipientIndex})`
    )
  }

  const material = [paymentIntentId, lineItemId, String(recipientIndex)].join(
    ENTITLEMENT_DEDUPE_KEY_SEPARATOR
  )
  // Pełny hex digest — NIE truncujemy (finding L-2).
  return createHash("sha256").update(material).digest("hex")
}

/**
 * Fragment SQL `ON CONFLICT (entitlement_dedupe_key) DO NOTHING` — kanoniczna
 * końcówka INSERT-u entitlementu w writerze 3.3. Re-utworzenie wiersza o tym samym
 * `entitlement_dedupe_key` jest NO-OP-em na poziomie DB (0 affected rows),
 * gwarantowanym przez partial UNIQUE index — bez wyjątku, bez retry-loop.
 */
export const ENTITLEMENT_DEDUPE_ON_CONFLICT_CLAUSE =
  `ON CONFLICT (${ENTITLEMENT_DEDUPE_KEY_COLUMN}) DO NOTHING` as const
