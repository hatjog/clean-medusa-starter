/**
 * market-scope-guard.ts — JEDNA reguła „czy ten zasób należy do rynku żądania".
 *
 * ── Co to zamyka ────────────────────────────────────────────────────────────
 * Guard rynku na powierzchniach dostępowych miał kształt:
 *
 *     if (ctxChannel && resourceChannel && ctxChannel !== resourceChannel) deny()
 *
 * czyli działał WYŁĄCZNIE wtedy, gdy OBIE strony były ustawione. Zasób bez
 * `sales_channel_id` był czytelny z DOWOLNEGO rynku, a brak kontekstu rynku
 * wyłączał guard w całości. To jest fail-OPEN: warunek, który przy niepełnych
 * danych przepuszcza zamiast odmówić.
 *
 * Zachowanie było pre-existing, ale otwarcie `payment-status` dla gościa
 * podniosło jego wagę — trasa przyjmuje ruch nieuwierzytelniony.
 *
 * Decyzja PO (Robert, 2026-08-01): **fix**, fail-closed, zakres CROSS-ROUTE.
 *
 * ── Dlaczego osobny moduł, skoro to jeden warunek ───────────────────────────
 * Bo wzorzec był powielony. Reguła rozsypana po trasach rozjeżdża się przy
 * pierwszej korekcie i tylko jedna kopia dostaje test — dokładnie to dało
 * kształt fail-open w dwóch miejscach naraz. Tutaj jest jedna funkcja i jeden
 * komplet testów; trasy wołają, nie powtarzają.
 */

/**
 * Czy zasób wolno pokazać w kontekście tego rynku.
 *
 * FAIL-CLOSED: brak KTÓREJKOLWIEK ze stron to odmowa, nie zgoda. „Nie wiem, do
 * jakiego rynku to należy" nie może znaczyć „więc pokaż wszystkim".
 *
 * Puste stringi i whitespace są traktowane jak brak — kolumna bywa `text NULL`,
 * a `""` to nie jest identyfikator kanału.
 */
export function isWithinMarketScope(
  contextSalesChannelId: string | null | undefined,
  resourceSalesChannelId: string | null | undefined,
): boolean {
  const context = normalize(contextSalesChannelId)
  const resource = normalize(resourceSalesChannelId)

  if (!context || !resource) return false
  return context === resource
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
