/**
 * cart-completion-authorization-guard.ts (middleware) — v1.15.0 Story 3.5,
 * review-fix cyklu 1 (FR-6c, NFR-3, AD-22; AC4 pozycja 4 — EC-43).
 *
 * Wpięcie opakowania z `lib/payment/cart-completion-authorization-guard.ts`
 * w REALNĄ ścieżkę: `POST /store/carts/:id/complete`, czyli HTTP-owe wejście
 * do `completeCartWithSplitOrdersWorkflow`. Bramka, która istnieje, a nie
 * odpala się na realnej ścieżce, nie mierzy niczego — dlatego opakowanie
 * siedzi na trasie, a nie w bibliotece czekającej na wołającego.
 *
 * Uruchamiamy się PO odpowiedzi (`res.on("finish")`) i WYŁĄCZNIE dla
 * zakończeń nieudanych. Dwa powody, oba istotne:
 *  * detekcja czyta stan, który ustala się dopiero po zakończeniu sagi;
 *  * sprawdzenie nie może opóźnić ani wywrócić odpowiedzi dla klientki.
 *
 * AD-21/ADR-177: to jest powierzchnia HTTP, więc kontekst rynku niesie
 * istniejący `marketContextStorage` — nie zakładamy nowego nośnika i nie
 * dopisujemy się do inwentarza powierzchni zastanych.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { marketContextStorage } from "../../lib/market-context"
import { reportUnreversedAuthorizations } from "../../lib/payment/cart-completion-authorization-guard"
import {
  COMPENSATION_FAILURE_STDERR_PREFIX,
  type CompensationKind,
} from "../../lib/payment/money-path-compensation-registry"
import { acquireFreshPgConnection } from "../../lib/payment/stripe-payment-intent-transport"

type LoggerLike = {
  info?: (msg: string) => void
  error?: (msg: string) => void
}

const KIND: CompensationKind = "cart_payment_authorization_cancel"

export async function cartCompletionAuthorizationGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: (err?: unknown) => void
): Promise<void> {
  const cartId = (req.params as Record<string, string> | undefined)?.id
  if (!cartId) {
    next()
    return
  }

  const marketId = marketContextStorage.getStore()?.market_id ?? null
  const scope = req.scope
  const logger = (() => {
    try {
      return scope.resolve("logger") as LoggerLike
    } catch {
      return {} as LoggerLike
    }
  })()

  let statusCode = 200
  const originalStatus = res.status.bind(res)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(res as any).status = (code: number) => {
    statusCode = code
    return originalStatus(code)
  }

  res.on("finish", () => {
    if (statusCode < 400) {
      return
    }
    void runGuard({ scope, cartId, marketId, statusCode, logger })
  })

  next()
}

async function runGuard(input: {
  scope: { resolve: (key: string) => unknown }
  cartId: string
  marketId: string | null
  statusCode: number
  logger: LoggerLike
}): Promise<void> {
  let release: (() => void) | null = null
  try {
    const handle = await acquireFreshPgConnection(input.scope)
    if (!handle) {
      throw new Error("brak dostepu do PG — nie da sie sprawdzic obciazenia")
    }
    release = handle.release

    const result = await reportUnreversedAuthorizations({
      scope: input.scope,
      client: handle.client,
      cartId: input.cartId,
      marketId: input.marketId,
      failureDetail: `completion koszyka zakonczony kodem ${input.statusCode}`,
    })

    if (result.detected > 0) {
      input.logger.error?.(
        `[carts/complete] NIEODWROCONE OBCIAZENIE: koszyk ${input.cartId} — ` +
          `${result.detected} sesji platnosci autoryzowanych/pobranych bez ` +
          `zyjacego zamowienia (EC-43); rejestr zapisany: ${result.persisted}`
      )
    }
  } catch (err) {
    // Ostatnie ogniwo: nie udało się nawet SPRAWDZIĆ. To NIE MOŻE być cisza —
    // brak pomiaru jest tu informacją, a nie jej brakiem. Nośnik out-of-band
    // przeżywa brak wstrzykniętego loggera i brak bazy.
    const detail = (err as Error).message
    input.logger.error?.(
      `[carts/complete] kontrola nieodwroconego obciazenia dla koszyka ` +
        `${input.cartId} NIE DOSZLA DO SKUTKU: ${detail}`
    )
    try {
      process.stderr.write(
        `${COMPENSATION_FAILURE_STDERR_PREFIX} ${JSON.stringify({
          compensation_kind: KIND,
          cart_id: input.cartId,
          market_id: input.marketId,
          failure_code: "unreversed_authorization_probe_failed",
          failure_detail: detail,
          registry_persisted: false,
        })}\n`
      )
    } catch {
      /* nośnik ostatniej szansy niedostępny — wyżej stoi logger */
    }
  } finally {
    release?.()
  }
}
