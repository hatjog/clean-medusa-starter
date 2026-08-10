/**
 * store-entitlements-rate-limit.ts — dławienie `GET /store/entitlements`
 * (v1.15.0 DW-15-132).
 *
 * ── Po co limit na trasie odczytu uprawnień ─────────────────────────────────
 * Ta trasa przyjmuje ruch NIEUWIERZYTELNIONY (checkout gościa nie zakłada
 * konta) i autoryzuje się dowodem posiadania koszyka. Bez licznika próby dowodu
 * byłyby wyłącznie LOGOWANE, a nic by ich nie dławiło — pomiar bez
 * konsekwencji. Drugi powód jest wprost w kontrakcie BFF: storefront przekazuje
 * `429` dalej z `Retry-After`, więc bez limitu po stronie backendu ten człon
 * kontraktu nie miałby ŹRÓDŁA i nigdy nie dałby się wykonać.
 *
 * ── Dlaczego OSOBNY licznik, a nie ten od `payment-status` ──────────────────
 * Ekran potwierdzenia odpytuje obie trasy RÓWNOLEGLE w tym samym cyklu
 * pollingu. Wspólny licznik zużywałby budżet dwa razy szybciej i odsyłałby
 * `429` kupującej w środku jej własnego zakupu. Mechanizm i polityka są
 * współdzielone (`proof-rate-limit.ts`), STAN nie.
 *
 * ── Dlaczego NIE MA kubełka per-IP ──────────────────────────────────────────
 * Ta trasa jest wołana WYŁĄCZNIE server-side, przez BFF Next.js
 * (`/api/v1/entitlements`). Przeglądarka nie ma jak jej dosięgnąć bezpośrednio:
 * to storefront dokłada `x-publishable-api-key` i dowód. Backend widzi więc
 * JEDEN adres — proces storefrontu — dla CAŁEGO ruchu.
 *
 * Kubełek 10/10 min „per adres" nie był w tych warunkach limitem per klient,
 * tylko limitem GLOBALNYM o pojemności 10. Arytmetyka pollera: 1 żądanie co 5 s
 * przez 10 minut = 120 żądań na JEDNĄ kupującą. Budżet 10 wyczerpuje się po
 * ~50 sekundach pierwszego zakupu, a każda następna kupująca dostaje `429` —
 * czyli DOKŁADNIE ten ekran awarii, który ta zmiana usuwa. Zdejmujemy go.
 *
 * Dławienie zostaje na kluczu, który rozróżnia klientów: `cart_id` (dowód jest
 * per zakup) plus siatka globalna. W `payment-status` kubełek per-IP ZOSTAJE bez
 * zmian — to osobna decyzja PO z 2026-08-01 i osobna trasa.
 */

import { createProofRateLimitMiddleware } from "./proof-rate-limit"
import { SlidingWindowRateLimiter } from "./sliding-window-rate-limit"

/** Okno licznika — 10 minut, zgodnie z budżetem decyzji PO z 2026-08-01. */
export const STORE_ENTITLEMENTS_RATE_LIMIT_WINDOW_MS = 10 * 60_000

/**
 * Kubełek per-IP: ŚWIADOMIE WYŁĄCZONY — patrz nagłówek pliku. Ruch przychodzi
 * z jednego adresu (BFF), więc ten klucz nie rozróżniałby klientów.
 */
export const STORE_ENTITLEMENTS_IP_CAPACITY = null

/**
 * Próby dowodu dla jednego `cart_id` w oknie.
 *
 * To jest klucz, który realnie rozróżnia kupujące. 120 = rytm pollera ekranu
 * potwierdzenia (1 żądanie / 5 s × 10 min), czyli PEŁNY budżet jednego zakupu;
 * ponad to zaczyna się zgadywanie dowodu, a nie oglądanie własnego zamówienia.
 */
export const STORE_ENTITLEMENTS_CART_CAPACITY = 120

/**
 * Ogólny limit trasy — siatka na ruch rozproszony, którego żaden klucz nie łapie.
 *
 * ARYTMETYKA (a nie okrągła liczba): 120 żądań na kupującą na okno × 50
 * równoczesnych kupujących = 6000. Poprzednie 600 znaczyło PIĘĆ równoczesnych
 * kupujących na całym rynku — przy szóstej ekran potwierdzenia zaczynał
 * pokazywać awarię.
 */
export const STORE_ENTITLEMENTS_POLLER_REQUESTS_PER_BUYER = 120
export const STORE_ENTITLEMENTS_CONCURRENT_BUYERS = 50
export const STORE_ENTITLEMENTS_GLOBAL_CAPACITY =
  STORE_ENTITLEMENTS_POLLER_REQUESTS_PER_BUYER * STORE_ENTITLEMENTS_CONCURRENT_BUYERS

export const storeEntitlementsRateLimiter = new SlidingWindowRateLimiter(
  STORE_ENTITLEMENTS_RATE_LIMIT_WINDOW_MS,
)

export const storeEntitlementsRateLimitMiddleware = createProofRateLimitMiddleware({
  scope: "store-entitlements",
  limiter: storeEntitlementsRateLimiter,
  globalCapacity: STORE_ENTITLEMENTS_GLOBAL_CAPACITY,
  ipCapacity: STORE_ENTITLEMENTS_IP_CAPACITY,
  cartCapacity: STORE_ENTITLEMENTS_CART_CAPACITY,
})
