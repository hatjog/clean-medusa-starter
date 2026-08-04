/**
 * upstream-order-access-guard.ts — wyrównanie W GÓRĘ progu dostępu do
 * upstreamowego `GET /store/orders/:id`.
 *
 * ── Rozbieżność, którą to zamyka ────────────────────────────────────────────
 * Na TEJ SAMEJ powierzchni (zamówienie po zakupie) obowiązywały DWA różne progi:
 *
 *   GP `GET /store/orders/:id/payment-status`  → sesja ALBO dowód koszyka
 *   upstream `GET /store/orders/:id`           → BEZ `authenticate`
 *
 * Upstreamowa trasa core traktuje `order_id` jako capability — kto zna
 * identyfikator, dostaje pozycje zamówienia i adres e-mail kupującej. Handler
 * core niesie to wprost jako otwarte pytanie:
 *
 *     // TODO: Do we want to apply some sort of authentication here?
 *     (node_modules/@medusajs/medusa/dist/api/store/orders/middlewares.js)
 *
 * Zweryfikowane `curl`-em 2026-07-27.
 *
 * ── Decyzja ─────────────────────────────────────────────────────────────────
 * PO (Robert, 2026-08-01), kryterium „ma być bezpiecznie": **wyrównujemy W
 * GÓRĘ**. Wzorcem zostaje próg GP-owy; upstreamowa trasa dostaje ten sam dowód.
 * Uzasadnienie jest empiryczne, nie teoretyczne: dziś każdy, kto zna `order_id`,
 * odczytuje pozycje i adres e-mail kupującej.
 *
 * ── Dlaczego middleware, a NIE `pnpm patch` ─────────────────────────────────
 * Decyzja dopuszczała „lokalny patch/middleware". Wybrane jest middleware, bo:
 *   1. `pnpm patch` na `@medusajs/medusa` wiąże nas z układem plików dist
 *      upstreamu i wymaga rewizji przy każdym bumpie — koszt utrzymania rośnie
 *      z każdą wersją, a patch, który przestał się aplikować, bywa cicho
 *      pomijany (dokładnie ta klasa martwej ochrony, którą tu zamykamy);
 *   2. warstwa middleware jest miejscem, w którym progi dostępu tego repo już
 *      żyją (`cartMarketGuardMiddleware`, `paymentStatusRateLimitMiddleware`) —
 *      nie tworzymy drugiego mechanizmu obok istniejącego;
 *   3. dowód i jego kontrakt są w `lib/orders/guest-order-access.ts` i zostają
 *      JEDNYM źródłem prawdy dla obu tras. Patch upstreamu musiałby tę logikę
 *      powtórzyć.
 *
 * Rozejście z upstreamem jest ŚWIADOME i zaakceptowane, zgodnie z
 * `specs/constitution/upstream-policy.md`: **zero kontrybucji** do
 * `medusajs/*`, poprawka żyje w naszym forku.
 *
 * ── Kształt odmowy ──────────────────────────────────────────────────────────
 * Identyczny z `payment-status`, żeby dwie trasy tej samej powierzchni nie
 * uczyły klienta dwóch różnych rzeczy:
 *   - gość bez dowodu       → 401 (brak dowodu jest dla niego NAPRAWIALNY)
 *   - zalogowana z cudzym   → 404 (nie potwierdzamy istnienia cudzego zasobu)
 */

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import {
  assertOrderAccess,
  parseCartProof,
} from "../../lib/orders/guest-order-access"

type LoggerLike = {
  info?: (message: string, metadata?: Record<string, unknown>) => void
  warn?: (message: string, metadata?: Record<string, unknown>) => void
}

/** Kształt minimalny — dokładnie to, czego potrzebuje decyzja dostępu. */
type OrderRow = {
  id?: string
  customer_id?: string | null
}

/**
 * Wyciąga `:id` z trasy `/store/orders/:id` i jej podścieżek.
 *
 * Świadomie po ścieżce, nie po `req.params`: middleware jest rejestrowane na
 * matcherze, więc `params` bywa jeszcze niewypełnione w momencie wywołania.
 */
export function extractOrderId(req: MedusaRequest): string | null {
  const fromParams = (req.params as Record<string, string> | undefined)?.id
  if (typeof fromParams === "string" && fromParams.trim()) return fromParams.trim()

  const path = (req as { path?: string; originalUrl?: string; url?: string }).path
    ?? (req as { originalUrl?: string }).originalUrl
    ?? (req as { url?: string }).url
    ?? ""
  const match = /\/store\/orders\/([^/?#]+)/.exec(path)
  const raw = match?.[1]
  return raw ? decodeURIComponent(raw).trim() || null : null
}

export async function upstreamOrderAccessGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const orderId = extractOrderId(req)
  if (!orderId) {
    // Trasa listowa (`/store/orders`) ma własny próg upstreamowy i nie jest
    // przedmiotem tej decyzji — nie zgadujemy tu identyfikatora.
    next()
    return
  }

  const logger = resolveLogger(req)
  const customerId = (req as AuthenticatedMedusaRequest).auth_context?.actor_id ?? null
  const proof = parseCartProof((req.query as Record<string, unknown> | undefined)?.cart_id)

  // Bez sesji I bez dowodu nie ma czego sprawdzać — odmawiamy ZANIM dotkniemy
  // bazy. To takze granica kosztu: nieuwierzytelniony ruch nie generuje zapytań.
  if (!customerId && !proof) {
    deny(res, 401, "unauthorized", "Customer authentication required")
    return
  }

  let order: OrderRow | null = null
  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as {
      retrieveOrder: (id: string, config?: unknown) => Promise<OrderRow>
    }
    order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "customer_id"],
    })
  } catch {
    // Nieistniejące zamówienie i brak uprawnień MUSZĄ wyglądać tak samo,
    // inaczej trasa staje się wyrocznią istnienia `order_id`.
    deny(res, 404, "not_found", "Order not found")
    return
  }

  if (!order) {
    deny(res, 404, "not_found", "Order not found")
    return
  }

  const access = await assertOrderAccess({ req, order, orderId, customerId, proof })

  if (!access.granted) {
    logger?.warn?.(
      JSON.stringify({
        scope: `order:${orderId}`,
        outcome: "upstream_order_access_denied",
        reason: access.reason,
        // Sam POWÓD, nigdy identyfikatora kupującej ani wartości dowodu.
        timestamp: new Date().toISOString(),
      }),
    )
    if (access.reason === "no_proof") {
      deny(res, 401, "unauthorized", "Customer authentication required")
    } else {
      deny(res, 404, "not_found", "Order not found")
    }
    return
  }

  if (access.actor === "guest") {
    // Ten sam ślad, co na `payment-status`: odczyt przyznany na dowód posiadania
    // koszyka nie zostawia innego identyfikatora aktora do analizy powłamaniowej.
    logger?.info?.(
      JSON.stringify({
        actor: "guest",
        scope: `order:${orderId}`,
        outcome: "guest_order_access_granted",
        proof: access.proof,
        timestamp: new Date().toISOString(),
      }),
    )
  }

  next()
}

function deny(
  res: MedusaResponse,
  status: number,
  type: string,
  message: string,
): void {
  res.status(status).json({ type, message })
}

function resolveLogger(req: MedusaRequest): LoggerLike | undefined {
  try {
    return req.scope?.resolve(ContainerRegistrationKeys.LOGGER) as LoggerLike | undefined
  } catch {
    return undefined
  }
}
