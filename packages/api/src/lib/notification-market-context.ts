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
 * DŁUG (świadomy, odnotowany) — R-2.2-M4 poszerza ten zapis, bo poprzedni
 * ograniczał go WYŁĄCZNIE do call-site'ów administracyjnych, a fallback jest
 * realnie używany także przez dwa call-site'y VOUCHEROWE (dokładnie domena S3):
 *
 *   - administracyjne: decyzja vendora, T-30 (rynek = dana konfiguracyjna),
 *   - voucherowe: `voucher-claimed-buyer-notification`,
 *     `voucher-appointment-confirmed-delivery`. Te są z natury market-scoped, ale
 *     ani event, ani projekcja źródłowa (`findBuyerClaimSource`,
 *     `findAppointmentConfirmationDeliverySource`) NIE niosą dziś `market_id`.
 *     Oba subscribery preferują `market_id` z eventu/źródła, gdy się pojawi
 *     (pole opcjonalne już jest), i logują ostrzeżenie, gdy muszą sięgnąć po
 *     fallback — cichy „poprawnie wyglądający wynik z błędnym rynkiem" jest tu
 *     groźniejszy niż głośny brak.
 *
 * Domknięcie długu (przeniesienie `market_id` do danych domenowych vouchera /
 * na rekord vendora + rozszerzenie projekcji SQL) wymaga zmiany kontraktu
 * eventów i zapytań domenowych — WŁAŚCICIEL: Story 2.3, wymaga ADR. Do tego
 * czasu wysyłka na drugim rynku rozwiąże nadawcę rynku domyślnego.
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
 * domenowych (patrz dług w nagłówku pliku).
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
