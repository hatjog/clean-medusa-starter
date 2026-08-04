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
 */

import * as crypto from "node:crypto"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { parseCartProof } from "../../lib/orders/guest-order-access"
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

const GLOBAL_KEY = "route:payment-status"
const UNKNOWN_IP_SENTINEL = "unknown"

export const paymentStatusRateLimiter = new SlidingWindowRateLimiter(
  PAYMENT_STATUS_RATE_LIMIT_WINDOW_MS,
)

type RequestWithNetwork = MedusaRequest & {
  ip?: string
  socket?: { remoteAddress?: string }
  connection?: { remoteAddress?: string }
}

type LoggerLike = {
  warn?: (message: string, metadata?: Record<string, unknown>) => void
}

export async function paymentStatusRateLimitMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const buckets = [
    { key: GLOBAL_KEY, capacity: PAYMENT_STATUS_GLOBAL_CAPACITY },
    { key: `ip:${hash(resolveSourceIp(req))}`, capacity: PAYMENT_STATUS_IP_CAPACITY },
    ...resolveCartBuckets(req),
  ]

  const decision = paymentStatusRateLimiter.consume(buckets)
  if (decision.allowed) {
    next()
    return
  }

  // FAIL-CLOSED: przekroczenie kończy żądanie, nie przepuszcza go „na wszelki
  // wypadek". Limit, który przy przekroczeniu woła `next()`, jest dokładnie tą
  // klasą martwej bramki, którą ta zmiana zamyka.
  res.setHeader("Retry-After", String(decision.retryAfterSeconds))
  resolveLogger(req)?.warn?.(
    JSON.stringify({
      scope: "payment-status",
      outcome: "rate_limited",
      // Sam RODZAJ limitu, nigdy wartość klucza — inaczej log stawałby się
      // rejestrem adresów IP i dowodów koszyka.
      limit: describeLimit(decision.exceededKey),
      retry_after_seconds: decision.retryAfterSeconds,
    }),
  )
  res.status(429).json({
    type: "too_many_requests",
    message: "Too many attempts. Try again later.",
  })
}

/**
 * Koszyki dla dowodu. Gdy dowodu nie ma, nie zgadujemy klucza — takie żądanie
 * jest już objęte licznikiem per-IP i globalnym.
 */
function resolveCartBuckets(req: MedusaRequest): { key: string; capacity: number }[] {
  const proof = parseCartProof((req.query as Record<string, unknown> | undefined)?.cart_id)
  if (!proof || proof.values.length === 0) return []
  // Każdy podany `cart_id` ma WŁASNY licznik. Bez tego jedno żądanie z listą
  // wielu identyfikatorów mieściłoby się w jednym budżecie i pozwalało testować
  // dowody hurtem.
  return proof.values.map((value) => ({
    key: `cart:${hash(value)}`,
    capacity: PAYMENT_STATUS_CART_CAPACITY,
  }))
}

function describeLimit(key: string): string {
  if (key === GLOBAL_KEY) return "route"
  if (key.startsWith("ip:")) return "per_ip"
  if (key.startsWith("cart:")) return "per_cart_proof"
  return "unknown"
}

function resolveSourceIp(req: MedusaRequest): string {
  const request = req as RequestWithNetwork
  const direct =
    request.ip ?? request.socket?.remoteAddress ?? request.connection?.remoteAddress
  if (direct?.trim()) return direct.trim()

  const forwarded = req.headers?.["x-forwarded-for"]
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const first = typeof raw === "string" ? raw.split(",")[0]?.trim() : undefined
  return first || UNKNOWN_IP_SENTINEL
}

function resolveLogger(req: MedusaRequest): LoggerLike | undefined {
  try {
    return req.scope?.resolve("logger") as LoggerLike | undefined
  } catch {
    return undefined
  }
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)
}
