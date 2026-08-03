/**
 * gift-handoff.ts — JEDYNE miejsce, w którym zapada decyzja „czy ten zakup
 * wysyła handoff-mail do obdarowanej" (Story 2.4, AC1 / AC2; AD-8, FR-15a).
 *
 * ── Dlaczego osobny plik, skoro to jeden `if` ───────────────────────────────
 * Handoff idzie do odbiorcy INNEGO niż kupująca i jest NIEODWRACALNY. Predykat
 * rozsypany po subscriberze prędzej czy później rozjeżdża się z testami
 * tabelarycznymi — dlatego jest czystą funkcją z jawnym enumem powodów odmowy,
 * a subscriber tylko loguje `reason`.
 *
 * ── Kontrakt metadanych (sankcjonowany przez ADR-163 gift-flow-v1) ──────────
 * `purchase_mode` + `gift_recipient_*` żyją na `line_item.metadata` i do
 * Story 2.4 były WYŁĄCZNIE konwencją storefrontu. ADR-163 czyni z nich kontrakt
 * v1; ten plik jest jego jedynym produkcyjnym czytelnikiem po stronie backendu.
 *
 * ── Send-timing: trzy wartości, jedna wysyła ────────────────────────────────
 *   `now`       → wyślij od razu (JEDYNA ścieżka wysyłki w v1.14.0)
 *   `handover`  → „nie wysyłaj, przekażę osobiście" (FR-15a, wariant A-minimal)
 *   `scheduled` → ZASTANE dane sprzed 2.4 (albo koszyk w locie). Traktowane
 *                 JAWNIE jako „nie wysyłaj automatycznie" + log
 *                 `scheduled_deferred_v1150`. Nigdy cicha wysyłka „od razu"
 *                 (mail nie w terminie jest nieodwracalny), nigdy wyjątek
 *                 (konsumpcja eventu nie może się wywrócić). Scheduler → v1.15.0.
 *
 * ── Zero PII poza polem `to` ────────────────────────────────────────────────
 * Ta funkcja ZWRACA adres odbiorczyni (wołający potrzebuje go do `to` i do
 * hasha), ale `reason` jest zawsze enumem — nigdy adresem. Do logów wołającego
 * idzie wyłącznie `reason`.
 */

/** Wartość `purchase_mode` uruchamiająca ścieżkę prezentu. */
export const GIFT_PURCHASE_MODE = "gift"

export const GIFT_SEND_TIMING_NOW = "now"
export const GIFT_SEND_TIMING_HANDOVER = "handover"
/** Zastane (dane sprzed Story 2.4). NIE jest osiągalne z UI od v1.14.0. */
export const GIFT_SEND_TIMING_SCHEDULED = "scheduled"

export type GiftSendTiming =
  | typeof GIFT_SEND_TIMING_NOW
  | typeof GIFT_SEND_TIMING_HANDOVER
  | typeof GIFT_SEND_TIMING_SCHEDULED

/**
 * Kształt minimalny — dokładnie to, czego potrzebuje decyzja. Projekcja
 * (`VoucherService.findBuyerClaimSource`) zwraca te pola z
 * `line_item.metadata` wskazanego przez `entitlement_instance.line_item_id`.
 */
export interface GiftHandoffCandidate {
  purchase_mode?: string | null
  gift_recipient_email?: string | null
  gift_recipient_send_timing?: string | null
  gift_recipient_bound_to_voucher_issue?: boolean | null
}

export type GiftHandoffSkipReason =
  /** `purchase_mode` inny niż `gift` (zakup dla siebie) — nie prezent. */
  | "not_gift"
  /** `gift_recipient_bound_to_voucher_issue` != true — dane nie są powiązane z wydaniem. */
  | "not_bound_to_voucher_issue"
  /** „nie wysyłaj, przekażę osobiście" — świadomy wybór kupującej (FR-15a). */
  | "handover_in_person"
  /** Zastane `scheduled` — scheduler deferowany do v1.15.0 (ADR-163). */
  | "scheduled_deferred_v1150"
  /** Wartość send-timing spoza kontraktu — nie zgadujemy intencji. */
  | "send_timing_unknown"
  | "missing_recipient_email"
  | "invalid_recipient_email"

export type GiftHandoffDecision =
  | { eligible: true; recipient_email: string }
  | { eligible: false; reason: GiftHandoffSkipReason }

/**
 * Ten sam kształt, co walidacja storefrontu (`src/lib/voucher/gift-recipient.ts`).
 * Świadomie minimalny: pełna weryfikacja adresu należy do providera, tutaj
 * chodzi o odrzucenie oczywistych śmieci ZANIM powstanie wiersz `queued`.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Decyzja o handoffie. Kolejność sprawdzeń jest częścią kontraktu:
 * najpierw „czy to w ogóle prezent", potem „czy kupująca chciała wysyłki",
 * a dopiero na końcu adres — dzięki temu wariant „przekażę osobiście" NIE
 * wymaga poprawnego adresu i nie generuje fałszywego findingu.
 */
export function evaluateGiftHandoff(
  candidate: GiftHandoffCandidate | null | undefined,
): GiftHandoffDecision {
  const source = candidate ?? {}

  if (normalize(source.purchase_mode) !== GIFT_PURCHASE_MODE) {
    return { eligible: false, reason: "not_gift" }
  }

  if (source.gift_recipient_bound_to_voucher_issue !== true) {
    // ADR-163: to pole JEST warunkiem powiązania metadanych z wydaniem
    // vouchera. Bez niego mamy szczątkowe dane koszyka, a nie prezent.
    return { eligible: false, reason: "not_bound_to_voucher_issue" }
  }

  const timing = normalize(source.gift_recipient_send_timing)
  if (timing === GIFT_SEND_TIMING_HANDOVER) {
    return { eligible: false, reason: "handover_in_person" }
  }
  if (timing === GIFT_SEND_TIMING_SCHEDULED) {
    return { eligible: false, reason: "scheduled_deferred_v1150" }
  }
  if (timing !== GIFT_SEND_TIMING_NOW) {
    // Brak wartości albo wartość spoza kontraktu. NIE domyślamy się „od razu":
    // fałszywie dodatnia wysyłka do obcej osoby jest nieodwracalna.
    return { eligible: false, reason: "send_timing_unknown" }
  }

  const email = normalizeRaw(source.gift_recipient_email)
  if (!email) {
    return { eligible: false, reason: "missing_recipient_email" }
  }
  if (!EMAIL_SHAPE.test(email)) {
    return { eligible: false, reason: "invalid_recipient_email" }
  }

  return { eligible: true, recipient_email: email }
}

function normalize(value: unknown): string | null {
  const raw = normalizeRaw(value)
  return raw === null ? null : raw.toLowerCase()
}

function normalizeRaw(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
