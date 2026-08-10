/**
 * payment-status-rate-limit.ts — dławienie prób dowodu na `GET
 * /store/orders/:id/payment-status`.
 *
 * ── Co to zamyka ────────────────────────────────────────────────────────────
 * Trasa przyjmuje ruch NIEUWIERZYTELNIONY (checkout gościa nie zakłada konta),
 * a nie miała limitu ani na próby dowodu, ani na samą trasę. Odmowy były
 * LOGOWANE (`outcome: "order_access_denied"`), ale nic ich nie zliczało ani nie
 * dławiło — czyli mieliśmy pomiar bez konsekwencji.
 *
 * `cart_id` jest ULID-em, więc zgadywanie jest niepraktyczne i to jest powód,
 * dla którego to nie był incydent. Brak dławienia pozostaje jednak kosztem
 * open-endpointu, którego wcześniej nie było.
 *
 * Decyzja PO (Robert, 2026-08-01): limit osadzamy W WARSTWIE MIDDLEWARE, reuse
 * wzorca `brevoWebhookRateLimitMiddleware`; nie tworzymy nowej warstwy ani
 * drugiego mechanizmu. Budżet: osobny licznik prób per-IP i per-`cart_id`
 * (rząd 10 prób / 10 min) plus ogólny limit na trasę. Przekroczenie = `429`,
 * fail-closed.
 *
 * ── Dlaczego per-`cart_id`, a nie per-`order_id` ────────────────────────────
 * Dławimy próby DOWODU, a dowodem jest `cart_id`. Licznik po `order_id`
 * karałby kupującą odświeżającą własny status (jeden order, wiele wejść), a nie
 * atakującego, który przy każdej próbie podstawia INNY `cart_id` pod ten sam
 * order. Klucz musi leżeć tam, gdzie leży zgadywanie.
 *
 * Dodatkowo licznik per-IP łapie przypadek odwrotny: rotację `cart_id` z
 * jednego źródła. Dopiero para kluczy zamyka obie strony.
 *
 * ── Prywatność licznika ─────────────────────────────────────────────────────
 * Klucze są hashowane (`sha256`). Ani adres IP (dane osobowe wg RODO), ani
 * `cart_id` (dowód typu bearer) nie leżą w pamięci procesu w postaci jawnej i
 * nie trafiają do logu — log niesie wyłącznie rodzaj przekroczonego limitu.
 *
 * ── DW-15-132: polityka wyprowadzona do `proof-rate-limit.ts` ───────────────
 * `GET /store/entitlements` ma DOKŁADNIE tę samą charakterystykę (ten sam
 * aktor, ten sam dowód, ten sam kształt odmowy), więc reguła przestała być
 * własnością tej jednej trasy. Ten plik zostaje ZAŁOŻENIEM POLITYKI dla
 * `payment-status`: pojemności, okno i licznik. Zachowanie bramki się nie
 * zmienia — klucz globalny to nadal `route:payment-status`, a licznik jest
 * osobną instancją, więc dwa strumienie pollingu nie zjadają sobie budżetu.
 */

import { createProofRateLimitMiddleware } from "./proof-rate-limit"
import { SlidingWindowRateLimiter } from "./sliding-window-rate-limit"

/** Okno licznika — 10 minut, zgodnie z budżetem z decyzji PO. */
export const PAYMENT_STATUS_RATE_LIMIT_WINDOW_MS = 10 * 60_000

/** Próby dowodu z jednego adresu w oknie. */
export const PAYMENT_STATUS_IP_CAPACITY = 10

/**
 * Próby dowodu dla jednego `cart_id` w oknie. Ten sam rząd co per-IP: dowód jest
 * jeden, więc powtarzanie go dziesiątki razy nie jest zachowaniem kupującej.
 */
export const PAYMENT_STATUS_CART_CAPACITY = 10

/**
 * Ogólny limit trasy — siatka bezpieczeństwa na wypadek rozproszonego ruchu,
 * którego żaden pojedynczy klucz nie łapie. Świadomie luźny: ma zatrzymać
 * zalew, a nie realny ruch sklepu.
 */
export const PAYMENT_STATUS_GLOBAL_CAPACITY = 600

export const paymentStatusRateLimiter = new SlidingWindowRateLimiter(
  PAYMENT_STATUS_RATE_LIMIT_WINDOW_MS,
)

export const paymentStatusRateLimitMiddleware = createProofRateLimitMiddleware({
  // Nazwa bramki daje klucz globalny `route:payment-status` — dokładnie ten,
  // który ta trasa miała przed wyprowadzeniem polityki.
  scope: "payment-status",
  limiter: paymentStatusRateLimiter,
  globalCapacity: PAYMENT_STATUS_GLOBAL_CAPACITY,
  ipCapacity: PAYMENT_STATUS_IP_CAPACITY,
  cartCapacity: PAYMENT_STATUS_CART_CAPACITY,
})
