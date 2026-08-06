/**
 * cart-completion-authorization-guard.ts — v1.15.0 Story 3.5, review-fix cyklu 1
 * (FR-6c, NFR-3, AD-22; AC4 pozycja 4 — EC-43).
 *
 * ── Co to zamyka ──────────────────────────────────────────────────────────
 * `authorizePaymentSessionStep` z `@medusajs/core-flows` ma DWA defekty
 * potwierdzone odczytem zainstalowanego pakietu (`dist/payment/steps/
 * authorize-payment-session.js`): jego funkcja kompensująca (a) wychodzi
 * WCZEŚNIE przy `REQUIRES_MORE`, nie anulując niczego, oraz (b) połyka błąd
 * `cancelPayment` do loga. Gdy `completeCartWithSplitOrdersWorkflow` pada po
 * autoryzacji, saga kasuje zamówienia, a OBCIĄŻENIE ZOSTAJE — to jest
 * udokumentowane źródło orphaned charge z v1.11.0, jedynego zdarzenia w tym
 * repo, w którym klientka realnie straciła pieniądze.
 *
 * AC4 dopuszcza dla tej pozycji DOKŁADNIE dwa zakończenia: lokalny `pnpm patch`
 * ALBO **opakowanie po naszej stronie wykrywające nieodwrócone obciążenie** —
 * nigdy zgłoszenie do upstream i nigdy odłożenie. Ten plik jest tym drugim.
 *
 * Dlaczego opakowanie, a nie patch: `pnpm patch` mutuje zainstalowane
 * `node_modules`, które w worktree fali są współdzielone z równoległymi
 * agentami. Opakowanie NIE dotyka `node_modules` w ogóle — jest kodem GP
 * w `packages/api/src`, dokładnie tego samego rodzaju, co
 * `money-path-compensation-registry.ts`.
 *
 * ── Czego to opakowanie NIE robi ──────────────────────────────────────────
 * NIE anuluje obciążenia. Anulowanie wymagałoby wejścia w semantykę sagi
 * (`DW-15-089`) i podjęcia w imieniu klientki decyzji nieodwracalnej na
 * podstawie stanu odczytanego PO fakcie. Robi rzecz, której AC1 wymaga
 * i której dziś nie ma: sprawia, że nieodwrócone obciążenie przestaje być
 * zdarzeniem PRYWATNYM procesu — dostaje TRWAŁY wiersz w rejestrze i ALARM.
 * Cisza przestaje być możliwym zakończeniem; anulowanie jest osobną decyzją.
 */
import type { PaymentLinkQueryClient } from "./stripe-payment-intent-link"
import {
  buildPurchaseCorrelationKey,
  reportCompensationFailure,
  type CompensationFailureRecord,
} from "./money-path-compensation-registry"

/** `webhook_event_processed.provider`-owy odpowiednik dla tej ścieżki. */
export const CART_COMPLETION_DELIVERY_PATH = "cart_completion_workflow"

/** Kod porażki — stabilny, cytowalny w runbooku i w rejestrze. */
export const UNREVERSED_AUTHORIZATION_FAILURE_CODE =
  "cart_completion_failed_authorization_not_reversed"

/**
 * Sesje płatności koszyka, które są AUTORYZOWANE albo POBRANE i którym NIE
 * odpowiada żadne żyjące zamówienie.
 *
 * To jest dokładnie sygnatura orphaned charge: pieniądze po stronie Stripe'a
 * zarezerwowane albo pobrane, a po stronie GP nie ma zamówienia, które by je
 * uzasadniało. `status IN ('authorized','captured')` jest celowo szersze niż
 * sam `authorized` — defekt (b) z EC-43 połyka błąd anulowania niezależnie od
 * tego, jak daleko zaszła płatność.
 */
export const DETECT_UNREVERSED_AUTHORIZATION_SQL = `
  SELECT ps.id                      AS payment_session_id,
         ps.status                  AS status,
         ps.payment_collection_id   AS payment_collection_id,
         ps.data ->> 'id'           AS payment_intent_id,
         c.sales_channel_id         AS sales_channel_id
    FROM cart_payment_collection cpc
    JOIN payment_session ps
      ON ps.payment_collection_id = cpc.payment_collection_id
     AND ps.deleted_at IS NULL
    JOIN cart c
      ON c.id = cpc.cart_id
     AND c.deleted_at IS NULL
    LEFT JOIN order_payment_collection opc
      ON opc.payment_collection_id = cpc.payment_collection_id
     AND opc.deleted_at IS NULL
    LEFT JOIN "order" o
      ON o.id = opc.order_id
     AND o.deleted_at IS NULL
   WHERE cpc.cart_id = $1
     AND cpc.deleted_at IS NULL
     AND ps.status IN ('authorized', 'captured')
     AND o.id IS NULL
`

export type UnreversedAuthorizationRow = {
  payment_session_id: string
  status: string
  payment_collection_id: string
  payment_intent_id: string | null
  sales_channel_id: string | null
}

export async function findUnreversedAuthorizations(
  client: PaymentLinkQueryClient,
  cartId: string
): Promise<UnreversedAuthorizationRow[]> {
  const result = await client.query<UnreversedAuthorizationRow>(
    DETECT_UNREVERSED_AUTHORIZATION_SQL,
    [cartId]
  )
  return result.rows ?? []
}

/**
 * Pełne opakowanie: wykryj nieodwrócone obciążenie i odnotuj je TRWALE.
 *
 * Zwraca liczbę odnotowanych pozycji. `0` znaczy „nic nie wisi" — a nie
 * „nie sprawdzono": brak możliwości sprawdzenia RZUCA, żeby wołający miał
 * co przekazać dalej zamiast cichego zera.
 */
export async function reportUnreversedAuthorizations(input: {
  scope: { resolve: (key: string) => unknown }
  client: PaymentLinkQueryClient
  cartId: string
  marketId: string | null
  failureDetail: string
}): Promise<{ detected: number; persisted: boolean }> {
  const rows = await findUnreversedAuthorizations(input.client, input.cartId)
  if (rows.length === 0) {
    return { detected: 0, persisted: true }
  }

  const records: CompensationFailureRecord[] = rows.map((row) => {
    // `market_id` jest w tej tabeli NOT NULL (AD-22). Kontekst rynku z ALS jest
    // pierwszym źródłem; gdy go nie ma, bierzemy kanał sprzedaży koszyka —
    // wpis BEZ rynku byłby odrzucony przez bazę, a wtedy stracilibyśmy ślad
    // dokładnie tam, gdzie jest najbardziej potrzebny.
    const marketId = input.marketId ?? row.sales_channel_id ?? "unknown"
    const paymentIntentId = row.payment_intent_id ?? row.payment_session_id
    return {
      market_id: marketId,
      compensation_kind: "cart_payment_authorization_cancel",
      delivery_path: CART_COMPLETION_DELIVERY_PATH,
      // Nie ma tu `evt_…` od Stripe'a — tożsamość zdarzenia niesie koszyk
      // i sesja płatności. Para (cart, payment_session) jest stabilna, więc
      // `failure_id` pozostaje deterministyczny i ponowienie nie mnoży wierszy.
      stripe_event_id: `cart:${input.cartId}:${row.payment_session_id}`,
      payment_intent_id: paymentIntentId,
      order_id: null,
      purchase_correlation_key: buildPurchaseCorrelationKey(paymentIntentId),
      failure_code: UNREVERSED_AUTHORIZATION_FAILURE_CODE,
      failure_detail:
        `sesja platnosci ${row.payment_session_id} ma status ${row.status}, ` +
        `a koszyk ${input.cartId} NIE ma zyjacego zamowienia — obciazenie ` +
        `nie zostalo odwrocone (EC-43). Kontekst: ${input.failureDetail}`,
    }
  })

  const reported = await reportCompensationFailure(
    input.scope,
    input.client,
    records
  )
  return { detected: rows.length, persisted: reported.persisted }
}
