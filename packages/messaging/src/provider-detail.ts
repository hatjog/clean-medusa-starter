/**
 * provider-detail.ts — bezpieczne przeniesienie ODPOWIEDZI PROVIDERA do ledgera.
 *
 * ── Kształt defektu, który to zamyka (żywy zakup, zamówienie 18, 2026-08-01) ─
 * Obie koperty (`voucher_purchase_confirmation`, `voucher_handoff_link`) wpadły
 * do `voucher_delivery_dispatch` ze statusem `failed`, bez `provider_message_id`
 * i z `error_code = VOUCHER_DELIVERY_DISPATCH_FAILED` — czyli z GENERYCZNYM
 * fallbackiem. Z ledgera nie dało się odróżnić błędu kodu od problemu konta.
 * Realna przyczyna, ustalona dopiero ręcznym odpytaniem API Brevo:
 *
 *   HTTP 401 {"code":"unauthorized","message":"We have detected you are using
 *   an unrecognised IP address …"}
 *
 * Brevo miał włączoną autoryzację IP i adres operatora nie był na liście.
 * OBJAWOWO NIEODRÓŻNIALNE od awarii kodu — dokładnie ta klasa, w której zielony
 * test niczego nie widzi.
 *
 * Dwa niezależne ogniwa gubiły sygnał:
 *   1. `toMessagingProviderError` brał `body.code` DOSŁOWNIE (`"unauthorized"`,
 *      małe litery). Marker `[gp_error_code=…]` przyjmuje wyłącznie `[A-Z0-9_]+`
 *      (patrz `errors.ts`), więc `[gp_error_code=unauthorized]` był dla parsera
 *      NIEWIDOCZNY i subscriber spadał na fallback. Kod klasy błędu ginął, mimo
 *      że provider go podał.
 *   2. Treść odpowiedzi providera była świadomie WYRZUCANA (R-2.2-M5, D-70),
 *      bo `message` Brevo rutynowo cytuje odrzucony adres. Zostawała na `cause`,
 *      która nie przeżywa przepakowania przez moduł Notification Medusy.
 *
 * Ten moduł naprawia OBA, nie łamiąc D-70: kod jest normalizowany do postaci
 * marker-safe, a treść przechodzi przez REDAKTOR, który usuwa PII i sekrety
 * ZANIM cokolwiek trafi do logu, audytu i ledgera.
 *
 * ── Kontrakt bezpieczeństwa (KRYTYCZNY) ─────────────────────────────────────
 * Do ledgera idzie WYŁĄCZNIE wynik `sanitizeProviderDetail` — nigdy surowe
 * body odpowiedzi. Redaktor jest fail-closed w tę stronę, że woli zredagować
 * za dużo niż przepuścić sekret:
 *   - adresy e-mail            → `<redacted:email>`
 *   - adresy IP (v4 i v6)      → `<redacted:ip>`  (IP jest danymi osobowymi
 *                                 wg RODO, a komunikat Brevo je cytuje)
 *   - znane kształty sekretów  → `<redacted:secret>`
 *     (`xkeysib-…`, `xsmtpsib-…`, `sk_test/live_…`, `whsec_…`, `Bearer …`,
 *      DSN Postgresa z hasłem, przypisania `BREVO_*=…`/`*_API_KEY=…`)
 *   - pozostałe długie tokeny  → `<redacted:token>`
 * `BREVO_API_KEY` jest objęty PODWÓJNIE: przez wzorzec `xkeysib-` oraz przez
 * regułę długiego tokenu — nie ma ścieżki, którą trafiłby do ledgera.
 *
 * Diagnostyczność NIE ginie: po redakcji komunikat brzmi „We have detected you
 * are using an unrecognised IP address <redacted:ip>. If you performed this
 * action make sure to add the new IP address in this link: …" — operator widzi
 * PRZYCZYNĘ (autoryzacja IP w Brevo), nie widząc żadnej wartości wrażliwej.
 *
 * ── Dlaczego marker w `message`, a nie nowe pole kontraktu ──────────────────
 * Moduł Notification Medusy 2.14.2 przepakowuje wyjątek providera
 * (`notification-module-service.js`: `new MedusaError(UNEXPECTED_STATE,
 * "Failed to send notification with id …:\n" + e.message)`), a `promiseAll(
 * { aggregateErrors: true })` opakowuje to jeszcze raz. JEDYNYM nośnikiem, który
 * przeżywa oba opakowania, jest `message`. Ta sama obserwacja zrodziła marker
 * `[gp_error_code=…]` (R-2.3-M3) — nie wymyślamy drugiego mechanizmu, tylko
 * dokładamy dwa markery tej samej rodziny. Dzięki temu zero zmian w kontrakcie
 * `NotificationAuditEnvelope`, w gatewayu i we wrapperze providera.
 *
 * Markery są CZYTELNE (nie base64): sanityzowany tekst ma z definicji usunięte
 * `[` i `]`, więc `\[gp_provider_detail=([^\]]*)\]` jest jednoznaczne, a operator
 * czytający surowy log widzi przyczynę bez dekodowania.
 */

/** Twardy limit długości detalu — chroni log, audyt i kolumnę ledgera. */
export const PROVIDER_DETAIL_MAX_LENGTH = 300;

/**
 * Minimalna długość „gołego" tokenu uznawanego za potencjalny sekret.
 *
 * 24 znaki to próg dobrany tak, żeby złapać klucze API i tokeny bearer, a nie
 * ruszyć zwykłych słów ani identyfikatorów w rodzaju `voucher_purchase_confirmation`
 * (te zawierają `_`, ale są dozwolone — patrz `LOOKS_LIKE_TOKEN`).
 */
const TOKEN_MIN_LENGTH = 24;

/**
 * Wzorce sekretów. Kolejność MA ZNACZENIE — bardziej specyficzne najpierw,
 * inaczej ogólna reguła tokenu zjadłaby prefiks i zatarłaby klasę trafienia.
 *
 * Lista jest świadomie zbieżna z `SECRET_PATTERNS` w
 * `_grow/tools/validate_v1140_delivery_smoke_evidence.py` — ten sam katalog
 * kształtów sekretów po obu stronach (runtime redakcji i bramka evidence).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bxkeysib-[A-Za-z0-9_-]{6,}/gi,
  /\bxsmtpsib-[A-Za-z0-9_-]{6,}/gi,
  /\bsk_(?:test|live)_[A-Za-z0-9]{6,}/g,
  /\bpk_(?:test|live)_[A-Za-z0-9]{6,}/g,
  /\bwhsec_[A-Za-z0-9]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /postgres(?:ql)?:\/\/[^:\s"]+:[^@\s"]+@/gi,
  // Przypisania kluczy w treści (np. echo configu w komunikacie błędu).
  /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*[=:]\s*\S+/g,
];

/** Adres e-mail — ten sam kształt, którego pilnuje bramka evidence. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** IPv4 z granicami — `37.31.141.48` z realnej odpowiedzi Brevo. */
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** IPv6 (pełny i skrócony `::`), wystarczająco wąsko, żeby nie łapać czasu. */
const IPV6_PATTERN = /\b(?:[0-9A-Fa-f]{1,4}:){2,7}(?::|[0-9A-Fa-f]{1,4})\b/g;

/**
 * Długi, nieprzerwany token bez spacji. Reguła OSTATNIEJ SZANSY dla sekretu
 * o kształcie, którego nie znamy — dlatego jest szeroka, a wyjątki są jawne.
 */
const LOOKS_LIKE_TOKEN = new RegExp(
  `(?<![<:])\\b[A-Za-z0-9+/=_-]{${TOKEN_MIN_LENGTH},}\\b(?![>])`,
  "g",
);

/**
 * Placeholdery redakcji są same w sobie długie — bez tej listy reguła tokenu
 * redagowałaby własny wynik przy powtórnym przebiegu (redakcja nie jest
 * idempotentna, a musi być: ten sam tekst bywa sanityzowany dwa razy po drodze).
 */
const REDACTION_PLACEHOLDERS = new Set([
  "<redacted:email>",
  "<redacted:ip>",
  "<redacted:secret>",
  "<redacted:token>",
]);

/**
 * Normalizuje kod błędu providera do postaci akceptowanej przez marker
 * `[gp_error_code=…]` (`[A-Z0-9_]+`).
 *
 * Bez tego `body.code` Brevo (`unauthorized`, `invalid_parameter`,
 * `missing_parameter`, …) — czyli KAŻDY kod, który provider realnie podaje —
 * nie przechodził przez parser markera i degradował do generycznego fallbacku.
 * Prefiks `BREVO_` jest doklejany tylko wtedy, gdy kod jeszcze go nie ma, więc
 * już kanoniczne kody (`BREVO_HTTP_401`, `BREVO_TEMPLATE_NOT_CONFIGURED`)
 * zostają nietknięte.
 */
export function normalizeProviderErrorCode(
  raw: unknown,
  fallback: string,
): string {
  if (typeof raw !== "string") return fallback;
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return fallback;
  return normalized.startsWith("BREVO_") ? normalized : `BREVO_${normalized}`;
}

/**
 * Redaguje i przycina treść odpowiedzi providera do postaci, którą wolno
 * zapisać w logu, audycie i ledgerze.
 *
 * Zwraca `null`, gdy po redakcji nie zostaje żadna informacja — pusty detal
 * jest gorszy niż jego brak, bo sugeruje, że provider nic nie powiedział.
 */
export function sanitizeProviderDetail(raw: unknown): string | null {
  const text = extractDetailText(raw);
  if (!text) return null;

  let out = text
    // Nawiasy kwadratowe znikają PIERWSZE: marker `[gp_provider_detail=…]`
    // kończy się na pierwszym `]`, więc ich obecność w treści rozbiłaby parser.
    .replace(/[[\]]/g, " ")
    // Nowe linie i sekwencje sterujące spłaszczamy do spacji — jednowierszowy
    // detal jest wymogiem zarówno markera, jak i czytelności logu.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ");

  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "<redacted:secret>");
  }
  out = out.replace(EMAIL_PATTERN, "<redacted:email>");
  out = out.replace(IPV6_PATTERN, "<redacted:ip>");
  out = out.replace(IPV4_PATTERN, "<redacted:ip>");
  out = out.replace(LOOKS_LIKE_TOKEN, (match) =>
    REDACTION_PLACEHOLDERS.has(match) ? match : "<redacted:token>",
  );

  out = out.replace(/\s+/g, " ").trim();
  if (!out) return null;

  return out.length > PROVIDER_DETAIL_MAX_LENGTH
    ? `${out.slice(0, PROVIDER_DETAIL_MAX_LENGTH - 1).trimEnd()}…`
    : out;
}

/**
 * Wyciąga tekst detalu z tego, co provider realnie zwrócił: string, obiekt
 * `{ message }`, albo obiekt błędu z `body.message`. Nigdy nie serializuje
 * CAŁEGO body — pełny zrzut jest dokładnie tym, czego zakazuje D-70.
 */
function extractDetailText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  for (const key of ["message", "detail", "error"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const body = record.body;
  if (body && typeof body === "object") {
    return extractDetailText(body);
  }
  return null;
}

/** Marker statusu HTTP providera — rodzina `[gp_*]`, patrz `errors.ts`. */
const PROVIDER_STATUS_MARKER = /\[gp_provider_status=(\d{3})\]/;
/** Marker zredagowanej treści odpowiedzi providera. */
const PROVIDER_DETAIL_MARKER = /\[gp_provider_detail=([^\]]*)\]/;

/**
 * Buduje sufiks markerów doklejany do `message` wyjątku. Pusty string, gdy nie
 * ma czego przenieść — brak markera jest jednoznaczny („provider nic nie
 * powiedział"), a pusty marker byłby szumem.
 *
 * `detail` MUSI być już po `sanitizeProviderDetail`; funkcja sanityzuje
 * PONOWNIE (idempotentnie), bo marker w komunikacie jest ostatnią granicą
 * między odpowiedzią providera a logiem.
 */
export function formatProviderResponseMarkers(input: {
  status_code?: number | null;
  detail?: string | null;
}): string {
  const parts: string[] = [];
  if (
    typeof input.status_code === "number" &&
    Number.isInteger(input.status_code) &&
    input.status_code >= 100 &&
    input.status_code <= 599
  ) {
    parts.push(`[gp_provider_status=${input.status_code}]`);
  }
  const detail = sanitizeProviderDetail(input.detail);
  if (detail) {
    parts.push(`[gp_provider_detail=${detail}]`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** Odczytuje status HTTP providera z (dowolnie opakowanego) komunikatu. */
export function extractProviderStatusMarker(message: unknown): number | null {
  if (typeof message !== "string") return null;
  const match = PROVIDER_STATUS_MARKER.exec(message);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Odczytuje zredagowaną treść odpowiedzi providera z komunikatu.
 *
 * Wynik przechodzi jeszcze raz przez `sanitizeProviderDetail`: konsument NIE
 * ufa temu, że po drodze nikt nie wstrzyknął do komunikatu czegoś wrażliwego.
 */
export function extractProviderDetailMarker(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = PROVIDER_DETAIL_MARKER.exec(message);
  return match ? sanitizeProviderDetail(match[1]) : null;
}
