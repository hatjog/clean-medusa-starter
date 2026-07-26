/**
 * notification-market-context.ts — rozwiązanie `market_id` dla wysyłek, których
 * call-site nie niesie kontekstu rynku (Story 2.2, AC5).
 *
 * Provider brevo wymaga `market_id` (rozwiązanie nadawcy + market-scoped audit) i
 * failuje głośno, gdy go nie ma — nie podstawia „jakiegoś" rynku. Część zastanych
 * call-site'ów administracyjnych (decyzja vendora, T-30) biegnie poza
 * `marketContextStorage`, więc ich rynek jest daną konfiguracyjną, nie danymi
 * żądania.
 *
 * ── Stan po Story 2.3 (ADR-162, `Accepted`) ────────────────────────────────
 * Dług R-2.2-M4 jest DOMKNIĘTY w części kontraktowej: `market_id` JEST już daną
 * domenową. Normatywnym nośnikiem jest `scope.market_id` koperty `envelope.v1`
 * (pole wymagane), a **obie** projekcje voucherowe (`findBuyerClaimSource`,
 * `findAppointmentConfirmationDeliverySource`) zwracają `market_id`
 * z `entitlement_instance.market_id` (fallback `policy_snapshot->>'market_id'`).
 * Kolejność u każdego konsumenta: `scope` → projekcja → *dopiero* ta funkcja.
 *
 * Fallback konfiguracyjny zostaje jako OSTATNIA linia obrony dla:
 *   - call-site'ów administracyjnych (decyzja vendora, T-30 — rynek jest tam
 *     daną konfiguracyjną, nie danymi żądania),
 *   - zastanych wierszy bez `market_id` (pole jest NULLABLE; 2.3 nie robi
 *     backfillu danych).
 * Każde jego użycie loguje `warn` — cichy „poprawnie wyglądający wynik
 * z błędnym rynkiem" jest groźniejszy niż głośny brak.
 *
 * Ścieżka wycofania fallbacku jest zapisana w ADR-162 (tabela semver):
 *   v1 (v1.14.0)  — pole opcjonalne z pierwszeństwem, fallback + `warn`,
 *   v1.1 (v1.15.0) — backfill `entitlement_instance.market_id` + metryka liczby
 *                    `warn`-ów (oczekiwana: 0 na ścieżce produkcyjnej),
 *   v2 (v1.16.0)  — `market_id` wymagane, `GP_DEFAULT_MARKET_ID` usunięty.
 * Kontrakt `purchase_locale` (ten sam ADR) konsumują 2.4 i 2.5.
 */

/** Zgodne z `DEFAULT_MARKET_ID` w payment-stripe-multi-market (v1.9.x BonBeauty-only). */
export const FALLBACK_NOTIFICATION_MARKET_ID = "bonbeauty"

export const NOTIFICATION_MARKET_ID_ENV = "GP_DEFAULT_MARKET_ID"

export function resolveNotificationMarketId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[NOTIFICATION_MARKET_ID_ENV]?.trim() || FALLBACK_NOTIFICATION_MARKET_ID
}

type MarketFallbackLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Rynek dla call-site'u MARKET-SCOPED (voucherowego): bierze `market_id` z danych
 * domenowych, a gdy ich nie ma — schodzi do konfiguracji i GŁOŚNO to odnotowuje.
 *
 * Fallback jest tu gorszy niż dla call-site'ów administracyjnych: nadawca i
 * `market_id` w audycie będą z rynku domyślnego, a wynik i tak wygląda poprawnie.
 * Ostrzeżenie jest jedynym sygnałem, dopóki `market_id` nie wejdzie do danych
 * domenowych; po 2.3 ta ścieżka NIE powinna się już odpalać na ruchu
 * produkcyjnym (patrz nagłówek pliku + tabela semver w ADR-162).
 */
export function resolveMarketScopedNotificationMarketId(input: {
  market_id?: string | null
  call_site: string
  logger?: MarketFallbackLogger
  env?: NodeJS.ProcessEnv
}): string {
  const fromDomain = input.market_id?.trim()
  if (fromDomain) {
    return fromDomain
  }

  const fallback = resolveNotificationMarketId(input.env ?? process.env)
  input.logger?.warn?.(
    `[notification-market-context] ${input.call_site}: brak market_id w danych ` +
      `domenowych — użyto fallbacku konfiguracyjnego '${fallback}' ` +
      `(${NOTIFICATION_MARKET_ID_ENV}); wysyłka na innym rynku rozwiąże ` +
      "nadawcę rynku domyślnego",
    { call_site: input.call_site, market_id: fallback },
  )
  return fallback
}
