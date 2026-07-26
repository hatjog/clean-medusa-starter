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
 * DŁUG (świadomy, odnotowany): dla tych call-site'ów rynek pochodzi z
 * `GP_DEFAULT_MARKET_ID`. Wielorynkowa poczta vendorowa wymaga przeniesienia
 * `market_id` na rekord vendora — poza zakresem 2.2 (S3 dotyczy delivery
 * voucherów, nie lifecycle'u vendorów).
 */

/** Zgodne z `DEFAULT_MARKET_ID` w payment-stripe-multi-market (v1.9.x BonBeauty-only). */
export const FALLBACK_NOTIFICATION_MARKET_ID = "bonbeauty"

export const NOTIFICATION_MARKET_ID_ENV = "GP_DEFAULT_MARKET_ID"

export function resolveNotificationMarketId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[NOTIFICATION_MARKET_ID_ENV]?.trim() || FALLBACK_NOTIFICATION_MARKET_ID
}
