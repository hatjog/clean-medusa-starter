import { getOrderDetailWorkflow } from "@medusajs/core-flows"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import type { MedusaRequest } from "@medusajs/framework/http"

export type OrderModuleLike = {
  retrieveOrder: (id: string, options?: Record<string, unknown>) => Promise<{
    id?: string
    customer_id?: string | null
    payment_status?: string | null
    status?: string | null
    created_at?: string | Date | null
    sales_channel_id?: string | null
  } | null>
}

export type RetrievedOrder = Awaited<ReturnType<OrderModuleLike["retrieveOrder"]>>

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

export function resolveOrderModule(req: MedusaRequest): OrderModuleLike {
  return req.scope.resolve(Modules.ORDER) as OrderModuleLike
}

export async function resolveOrderByCartId(
  req: MedusaRequest,
  cartId: string
): Promise<string | null> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  try {
    // Link koszyk→zamówienie mieszka w `order_cart`; tabela `order` NIE ma
    // kolumny `cart_id`, więc poprzednie zapytanie rzucało błąd SQL, a `catch`
    // poniżej zamieniał go w ciche `null` — fallback był martwy od początku.
    const result = await db.raw(
      `
        SELECT o.id
        FROM order_cart oc
        JOIN "order" o ON o.id = oc.order_id
        WHERE oc.cart_id = ?
          AND oc.deleted_at IS NULL
          AND o.deleted_at IS NULL
        ORDER BY o.created_at DESC
        LIMIT 1
      `,
      [cartId]
    )
    const row = result.rows?.[0] as Record<string, unknown> | undefined
    return typeof row?.id === "string" ? row.id : null
  } catch {
    return null
  }
}

type OrderDetailWorkflowLike = {
  run: (args: {
    input: { fields: string[]; order_id: string; filters?: Record<string, unknown> }
  }) => Promise<{ result?: Record<string, unknown> | null }>
}

/**
 * `payment_status` jest property WYLICZANYM z kolekcji płatności, a nie kolumną
 * zamówienia — i nie liczy go ani `orderModule.retrieveOrder(..., { select })`,
 * ani `query.graph` (oba oddają w tym polu `undefined`; graph zwraca same
 * `payment_collections`). Trasa mapowała więc opłacone zamówienie na
 * `pending_psp_confirmation` i zostawiała kupującą w nieskończonym pollingu
 * (w logu: `unknown Medusa payment_status: "undefined"`).
 *
 * Liczy go dopiero `getOrderDetailWorkflow` — ta sama droga, którą czyta core
 * `GET /store/orders/:id`, czyli to samo źródło, które widzi strona
 * potwierdzenia. Świadomie NIE wyprowadzamy statusu z `payment_collections`
 * samodzielnie: byłby to drugi, niezależnie dryfujący SSOT stanu finansowego.
 */
async function resolveComputedPaymentStatus(
  req: MedusaRequest,
  orderId: string,
  logger?: { warn?: (msg: string) => void }
): Promise<string | null> {
  try {
    const workflow = getOrderDetailWorkflow(req.scope) as unknown as OrderDetailWorkflowLike
    const { result } = await workflow.run({
      input: {
        fields: ["id", "payment_status"],
        order_id: orderId,
        filters: { is_draft_order: false },
      },
    })
    const status = (result as { payment_status?: unknown } | null)?.payment_status
    return typeof status === "string" ? status : null
  } catch (err) {
    // Świadoma degradacja: brak odczytu zostawia pole puste, a trasa wybiera
    // bezpieczny stan `pending`. Nigdy nie zgadujemy `paid`. Przyczyna MUSI
    // trafić do logu — inaczej systemowa awaria workflow jest nieodróżnialna
    // od „moduł nic nie zwrócił" i każde opłacone zamówienie cicho wisi.
    logger?.warn?.(`[payment-status] getOrderDetailWorkflow failed for ${orderId}: ${String(err)}`)
    return null
  }
}

/**
 * Wołane dopiero PO rozstrzygnięciu dostępu: workflow order-detail jest drogi,
 * a odpytywany jest w każdym cyklu pollingu. Żądanie bez uprawnień nie ma prawa
 * go uruchamiać — inaczej sam czas odpowiedzi staje się wyrocznią istnienia
 * zamówienia, mimo jednolitego kodu 401.
 */
export async function withComputedPaymentStatus(
  req: MedusaRequest,
  order: RetrievedOrder,
  logger?: { warn?: (msg: string) => void }
): Promise<RetrievedOrder> {
  if (!order || typeof order.payment_status === "string") {
    return order
  }
  const payment_status = await resolveComputedPaymentStatus(req, order.id ?? "", logger)
  return payment_status ? { ...order, payment_status } : order
}

/**
 * `retrieveOrder` RZUCA `MedusaError.NOT_FOUND` dla nieznanego id — nie zwraca
 * `null`. Bez tego opakowania fallback cart_id→order był martwy, a każdy URL
 * z identyfikatorem koszyka (return_url ze Stripe) kończył się 503
 * „awaria backendu" zamiast statusem albo uczciwym 401/404.
 */
async function retrieveOrderOrNull(
  orderModule: OrderModuleLike,
  id: string,
  options: Record<string, unknown>
): Promise<RetrievedOrder> {
  try {
    return await orderModule.retrieveOrder(id, options)
  } catch (err) {
    const type = (err as { type?: string } | null)?.type
    if (type === MedusaError.Types.NOT_FOUND || type === MedusaError.Types.INVALID_DATA) {
      return null
    }
    throw err
  }
}

export async function retrieveOrderByStatusIdentifier(
  req: MedusaRequest,
  orderModule: OrderModuleLike,
  statusIdentifier: string
): Promise<RetrievedOrder> {
  const options = {
    select: ["id", "customer_id", "payment_status", "status", "created_at", "sales_channel_id"],
  }
  const directOrder = await retrieveOrderOrNull(orderModule, statusIdentifier, options)
  if (directOrder) {
    return directOrder
  }

  const resolvedOrderId = await resolveOrderByCartId(req, statusIdentifier)
  if (!resolvedOrderId || resolvedOrderId === statusIdentifier) {
    return null
  }

  return retrieveOrderOrNull(orderModule, resolvedOrderId, options)
}
