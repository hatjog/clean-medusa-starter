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

/**
 * Zakresy, które działają najwyżej w sieci lokalnej nadawcy (RFC1918 +
 * link-local + mDNS `.local`). NIE są odrzucane — patrz `warnIfLanOnlyHost`.
 */
const LAN_HOST_PATTERNS: readonly RegExp[] = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /\.local$/,
]

export type VoucherPageUrlLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/** `true` dla adresu osiągalnego najwyżej z sieci lokalnej nadawcy. */
export function isLanOnlyHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return LAN_HOST_PATTERNS.some((pattern) => pattern.test(normalized))
}

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
  logger?: VoucherPageUrlLogger
}): string {
  const env = input.env ?? process.env
  // AC6.2: WYŁĄCZNIE klucz per rynek. Globalny fallback wysyłałby kupującym
  // jednego rynku linki do storefrontu innego — cicho i wyglądając poprawnie.
  const configured = env[marketStorefrontUrlEnvKey(input.marketId)]?.trim()

  if (!configured) {
    throw new StorefrontBaseUrlNotConfiguredError(input.marketId)
  }

  return assertNonLoopbackAbsoluteUrl(input.marketId, configured, input.logger)
}

/**
 * Walidacja KSZTAŁTU bazy linku (AC6.3) — wydzielona, bo jest wprost testowana.
 *
 * ── Czego ta funkcja NIE gwarantuje (finding #1 review 5.7) ─────────────────
 * Nie robi ŻADNEGO I/O: nie odpytuje DNS-u, nie wykonuje probe'u HTTP i nie
 * wie, czy pod tym adresem cokolwiek odpowiada. Poprzednia nazwa
 * (`assertPubliclyReachableBaseUrl`) obiecywała „publicznie osiągalny", a kod
 * sprawdzał „absolutny, http(s), nie-loopback" — i dokładnie ta różnica się
 * zmaterializowała: `http://192.168.100.91:3002` przeszedł guard, a link był
 * martwy na telefonie PO.
 *
 * ── Dlaczego świadomie NIE dokładamy probe'u ────────────────────────────────
 *   - probe w ścieżce wysyłki dokłada I/O i nowy tryb awarii (timeout, flaki
 *     DNS) do operacji, która ma być deterministyczna i szybka;
 *   - probe z HOSTA BACKENDU nie odpowiada na pytanie AC6 („czy osiągalny z
 *     telefonu PO"). Backend dosięgnie adresu LAN bez problemu — świeciłby na
 *     zielono i utwierdzał w błędzie;
 *   - odrzucanie zakresów prywatnych zablokowałoby JEDYNY sposób, w jaki PO
 *     może dziś testować na realnym urządzeniu — to byłoby pogorszenie.
 * Adres LAN daje więc `warn`, nie wyjątek. AC6.6 pozostaje bramką OPERACYJNĄ,
 * a nie własnością tego kodu.
 */
export function assertNonLoopbackAbsoluteUrl(
  marketId: string,
  candidate: string,
  logger?: VoucherPageUrlLogger,
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

  warnIfLanOnlyHost(marketId, host, logger)

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
}

/**
 * Sygnał, którego brakowało: baza przechodzi walidację kształtu, ale jest
 * adresem sieci lokalnej. Mail wyjdzie, `ledger=sent` będzie prawdziwy, a link
 * i tak będzie martwy poza siecią nadawcy. `warn`, nie wyjątek — patrz wyżej.
 */
function warnIfLanOnlyHost(
  marketId: string,
  host: string,
  logger?: VoucherPageUrlLogger,
): void {
  if (!isLanOnlyHost(host)) {
    return
  }
  logger?.warn?.(
    "[voucher-delivery] baza deep-linku jest adresem SIECI LOKALNEJ — link " +
      "w mailu nie zadziała poza tą siecią (guard sprawdza kształt, nie " +
      "osiągalność); do wysyłek poza dev ustaw adres publiczny",
    {
      market_id: marketId,
      // Sam host, bez ścieżki i query: env bywa nośnikiem tokenu w URL-u.
      base_url_host: host,
      env_key: marketStorefrontUrlEnvKey(marketId),
    },
  )
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
