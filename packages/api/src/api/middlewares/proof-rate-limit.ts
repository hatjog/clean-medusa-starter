/**
 * proof-rate-limit.ts — JEDNA polityka dławienia dla tras post-payment, które
 * przyjmują ruch NIEUWIERZYTELNIONY i autoryzują się DOWODEM posiadania koszyka.
 *
 * ── Dlaczego fabryka, a nie druga kopia pliku ───────────────────────────────
 * `payment-status-rate-limit.ts` był pierwszą taką bramką (decyzja PO, Robert,
 * 2026-08-01). DW-15-132 dokłada drugą trasę o DOKŁADNIE tej samej
 * charakterystyce (`GET /store/entitlements`): ten sam aktor, ten sam dowód
 * (`?cart_id=`), ten sam kształt odmowy. Skopiowanie pliku spełniałoby literę
 * („jest limit"), ale nie treść: dwie kopie rozjeżdżają się przy pierwszej
 * korekcie i tylko jedna dostaje test. Mechanizm okna mieszka w
 * `sliding-window-rate-limit.ts`, POLITYKA (klucze, prywatność, kształt `429`)
 * mieszka tutaj, a każda bramka wnosi WŁASNY licznik i własne pojemności.
 *
 * ── Dlaczego każda trasa ma OSOBNĄ instancję licznika ───────────────────────
 * Ekran potwierdzenia odpytuje `payment-status` i `entitlements` RÓWNOLEGLE, w
 * tym samym cyklu pollingu. Wspólny licznik per-IP zużywałby budżet dwa razy
 * szybciej i zaczynał odsyłać `429` do kupującej w środku jej własnego zakupu —
 * czyli współdzielenie instancji byłoby regresją, a nie oszczędnością.
 *
 * ── Prywatność licznika ─────────────────────────────────────────────────────
 * Klucze są hashowane (`sha256`). Ani adres IP (dane osobowe wg RODO), ani
 * `cart_id` (dowód typu bearer) nie leżą w pamięci procesu jawnie i nie trafiają
 * do logu — log niesie wyłącznie RODZAJ przekroczonego limitu.
 */

import * as crypto from "node:crypto"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { parseCartProof } from "../../lib/orders/guest-order-access"
import type { SlidingWindowRateLimiter } from "./sliding-window-rate-limit"

const UNKNOWN_IP_SENTINEL = "unknown"

export type ProofRateLimitPolicy = {
  /** Nazwa bramki w logu — NIE klucz licznika. */
  scope: string
  /** Licznik tej i tylko tej bramki. */
  limiter: SlidingWindowRateLimiter
  /** Ogólny limit trasy — siatka na ruch rozproszony, którego żaden klucz nie łapie. */
  globalCapacity: number
  /**
   * Próby z jednego adresu w oknie — albo `null`, gdy kubełek per-IP nie ma
   * sensu dla tej trasy.
   *
   * `null` jest DECYZJĄ, nie brakiem: trasa wołana wyłącznie server-side (przez
   * BFF Next.js) widzi JEDEN adres dla całego ruchu storefrontu, więc kubełek
   * „per adres" jest w rzeczywistości kubełkiem globalnym o pojemności
   * pojedynczej sesji. Patrz `store-entitlements-rate-limit.ts`.
   */
  ipCapacity: number | null
  /** Próby dla jednego `cart_id` w oknie. */
  cartCapacity: number
}

type RequestWithNetwork = MedusaRequest & {
  ip?: string
  socket?: { remoteAddress?: string }
  connection?: { remoteAddress?: string }
}

type LoggerLike = {
  warn?: (message: string, metadata?: Record<string, unknown>) => void
}

export type ProofRateLimitMiddleware = (
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) => Promise<void>

export function createProofRateLimitMiddleware(
  policy: ProofRateLimitPolicy,
): ProofRateLimitMiddleware {
  const globalKey = `route:${policy.scope}`

  return async function proofRateLimitMiddleware(req, res, next) {
    const buckets = [
      { key: globalKey, capacity: policy.globalCapacity },
      ...(policy.ipCapacity === null
        ? []
        : [{ key: `ip:${hash(resolveSourceIp(req))}`, capacity: policy.ipCapacity }]),
      ...resolveCartBuckets(req, policy.cartCapacity),
    ]

    const decision = policy.limiter.consume(buckets)
    if (decision.allowed) {
      next()
      return
    }

    // FAIL-CLOSED: przekroczenie KOŃCZY żądanie, nie przepuszcza go „na wszelki
    // wypadek". Limit, który przy przekroczeniu woła `next()`, jest dokładnie tą
    // klasą martwej bramki, którą ta warstwa zamyka.
    res.setHeader("Retry-After", String(decision.retryAfterSeconds))
    resolveLogger(req)?.warn?.(
      JSON.stringify({
        scope: policy.scope,
        outcome: "rate_limited",
        // Sam RODZAJ limitu, nigdy wartość klucza — inaczej log stawałby się
        // rejestrem adresów IP i dowodów koszyka.
        limit: describeLimit(decision.exceededKey, globalKey),
        retry_after_seconds: decision.retryAfterSeconds,
      }),
    )
    res.status(429).json({
      type: "too_many_requests",
      message: "Too many attempts. Try again later.",
    })
  }
}

/**
 * Koszyki dla dowodu. Gdy dowodu nie ma, nie zgadujemy klucza — takie żądanie
 * jest już objęte licznikiem per-IP i globalnym.
 */
function resolveCartBuckets(
  req: MedusaRequest,
  capacity: number,
): { key: string; capacity: number }[] {
  const proof = parseCartProof((req.query as Record<string, unknown> | undefined)?.cart_id)
  if (!proof || proof.values.length === 0) return []
  // Każdy podany `cart_id` ma WŁASNY licznik. Bez tego jedno żądanie z listą
  // wielu identyfikatorów mieściłoby się w jednym budżecie i pozwalało testować
  // dowody hurtem.
  return proof.values.map((value) => ({ key: `cart:${hash(value)}`, capacity }))
}

function describeLimit(key: string, globalKey: string): string {
  if (key === globalKey) return "route"
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
