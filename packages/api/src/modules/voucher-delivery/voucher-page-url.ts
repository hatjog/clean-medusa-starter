/**
 * voucher-page-url.ts — JEDYNY builder linku do strony vouchera (Story 5.7, AC6).
 *
 * ── Dlaczego osobny moduł ───────────────────────────────────────────────────
 * Oba maile voucherowe niosą deep-link do tej samej strony storefrontu
 * (`/{locale}/voucher/{code}`): handoff jako `handoff_url`, potwierdzenie
 * zakupu jako `voucher_pdf_url` (klucz manifestu zostaje, ale wartością jest
 * strona vouchera — PDF przy wystawieniu nie powstaje, więc link do niego nie
 * miałby pokrycia). Gdyby każdy intent liczył ścieżkę sam, obie mogłyby się
 * rozjechać przy pierwszej zmianie routingu. Jest jeden builder.
 *
 * ── Baza linku: per-rynek, ABSOLUTNA, osiągalna spoza hosta (AC6) ───────────
 * Realny incydent 5.3: mail poszedł z `http://localhost:8000/...`. Na telefonie
 * PO taki link jest martwy, a status `sent` wyglądał jak sukces. Dlatego:
 *   - baza pochodzi WYŁĄCZNIE z env per rynek (`GP_STOREFRONT_URL_<MARKET>`);
 *     globalny `STOREFRONT_URL` został usunięty jako źródło, bo cicho kierował
 *     maile jednego rynku na storefront innego,
 *   - akceptowany jest wyłącznie absolutny URL `http(s)`,
 *   - loopback (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`), pusty host i URL
 *     względny są ODRZUCANE — z osobnym, stabilnym kodem błędu,
 *   - błąd konfiguracji leci PRZED wysyłką, więc mail z martwym linkiem nie
 *     może osiągnąć `ledger=sent`.
 *
 * Ten env jest bazą DEEP-LINKU w dev. Nie zastępuje tabelowego `market_url`
 * ani `support_email` z `market_runtime_config` (AC2) — to dwie różne rzeczy
 * i story świadomie ich nie łączy.
 */

/** Hosty, które działają najwyżej na maszynie nadawcy (AC6.3). */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
])

export class StorefrontBaseUrlNotConfiguredError extends Error {
  readonly error_code = "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED"

  constructor(marketId: string) {
    super(
      `[voucher-delivery] brak skonfigurowanego base URL storefrontu dla rynku '${marketId}' ` +
        `(ustaw ${marketStorefrontUrlEnvKey(marketId)}) — ` +
        "mail z martwym linkiem jest gorszy niż brak maila",
    )
    this.name = "StorefrontBaseUrlNotConfiguredError"
  }
}

export class StorefrontBaseUrlNotReachableError extends Error {
  readonly error_code = "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_REACHABLE"

  constructor(marketId: string, reason: string) {
    // Świadomie BEZ wartości env w komunikacie: ta klasa trafia do logu i do
    // ledgera, a env bywa nośnikiem tokenu w URL-u. Powód jest enumeratywny.
    super(
      `[voucher-delivery] base URL storefrontu dla rynku '${marketId}' nie jest publicznie ` +
        `osiągalny (${reason}) — link w mailu byłby martwy poza hostem developerskim`,
    )
    this.name = "StorefrontBaseUrlNotReachableError"
  }
}

/** `bonbeauty` → `GP_STOREFRONT_URL_BONBEAUTY`; `bon-garden` → `..._BON_GARDEN`. */
export function marketStorefrontUrlEnvKey(marketId: string): string {
  const normalized = marketId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
  return `GP_STOREFRONT_URL_${normalized}`
}

/**
 * Baza deep-linku dla rynku. Rzuca zamiast zwracać `null`: brak/zła
 * konfiguracja to błąd operacyjny, który ma zatrzymać wysyłkę.
 */
export function resolveStorefrontBaseUrl(input: {
  marketId: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = input.env ?? process.env
  // AC6.2: WYŁĄCZNIE klucz per rynek. Globalny fallback wysyłałby kupującym
  // jednego rynku linki do storefrontu innego — cicho i wyglądając poprawnie.
  const configured = env[marketStorefrontUrlEnvKey(input.marketId)]?.trim()

  if (!configured) {
    throw new StorefrontBaseUrlNotConfiguredError(input.marketId)
  }

  return assertPubliclyReachableBaseUrl(input.marketId, configured)
}

/** Walidacja kształtu bazy linku — wydzielona, bo jest wprost testowana (AC6.3). */
export function assertPubliclyReachableBaseUrl(
  marketId: string,
  candidate: string,
): string {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    // URL względny („/voucher", "dev.bonbeauty.pl") ląduje tutaj.
    throw new StorefrontBaseUrlNotReachableError(marketId, "url_not_absolute")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new StorefrontBaseUrlNotReachableError(marketId, "protocol_not_http")
  }

  const host = parsed.hostname.trim().toLowerCase()
  if (!host) {
    throw new StorefrontBaseUrlNotReachableError(marketId, "empty_host")
  }
  if (LOOPBACK_HOSTS.has(host)) {
    throw new StorefrontBaseUrlNotReachableError(marketId, "loopback_host")
  }

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
}

/** Kanoniczny deep-link strony vouchera: `/{locale}/voucher/{code}`. */
export function buildVoucherPageUrl(input: {
  baseUrl: string
  locale: string
  voucherCode: string
}): string {
  return (
    `${input.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.locale)}` +
    `/voucher/${encodeURIComponent(input.voucherCode)}`
  )
}

/**
 * Profil publiczny salonu w storefroncie: `/{locale}/sellers/{handle}`.
 *
 * Bazą jest TABELOWY `market_runtime_config.market_url` (AC2/AC4.5), nie env
 * deep-linku — `salon_url` jest adresem produkcyjnym rynku, a nie adresem
 * dev-owego hosta, z którego akurat leci wysyłka.
 */
export function buildSalonUrl(input: {
  marketUrl: string
  locale: string
  sellerHandle: string
}): string {
  return (
    `${input.marketUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.locale)}` +
    `/sellers/${encodeURIComponent(input.sellerHandle)}`
  )
}
