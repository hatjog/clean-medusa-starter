/**
 * guest-order-access.ts — „guest order access proof" dla powierzchni post-payment.
 *
 * ── Pojęcie ─────────────────────────────────────────────────────────────────
 * Kupująca bez konta nie ma sesji, a mimo to musi zobaczyć stan WŁASNEGO
 * zamówienia zaraz po zapłacie. Dowodem uprawnienia jest **posiadanie
 * identyfikatora koszyka**, który to zamówienie wyprodukował: cart_id jest
 * ULID-em znanym wyłącznie tej przeglądarce, a powiązanie cart → order jest
 * zapisane w bazie (`order_cart`), więc dowód jest weryfikowalny po stronie
 * serwera i nie da się go zgadnąć.
 *
 * Ten sam wzorzec jest już w repo: `GET /store/carts/:id/completed-order`
 * (`api/store/carts/[id]/completed-order/route.ts`) oddaje order_id każdemu,
 * kto zna cart_id. Ten moduł nazywa tę regułę i wystawia ją jako JEDEN punkt
 * decyzyjny, żeby kolejne powierzchnie (zwroty, faktura) nie odtwarzały jej
 * na własną rękę — trzeci niezależny wariant tej reguły byłby dziurą.
 *
 * ── Dlaczego `proof`, a nie `cartId` w sygnaturze ───────────────────────────
 * Dowód „bearer" oparty na cart_id to świadomy kompromis: kto ma identyfikator,
 * ten widzi zamówienie. Jeśli kiedyś zastąpimy go podpisanym tokenem per-order,
 * zmiana ma zostać W TYM pliku — trasy przekazują nieprzezroczysty `proof`
 * i nie wiedzą, czym on jest.
 *
 * ── Czego ten moduł NIE robi ────────────────────────────────────────────────
 * Nie sprawdza rynku (market guard należy do trasy, bo zależy od
 * `marketContextStorage`) i nie decyduje o kodach HTTP — zwraca decyzję,
 * mapowanie na 401/404 jest odpowiedzialnością trasy.
 */

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaRequest } from "@medusajs/framework/http"

import { toKnexPositionalSql } from "../knex-positional-sql"

/**
 * Nieprzezroczysty dla wołającego dowód uprawnienia gościa.
 *
 * `values` jest LISTĄ, bo jedno cookie obsługuje kilka kolejnych zakupów tej
 * samej przeglądarki: drugi zakup nie może odbierać dostępu do statusu
 * pierwszego, wciąż rozliczanego zamówienia.
 */
export type OrderAccessProof = { type: "cart"; values: string[] }

/** Górna granica liczby dowodów w jednym żądaniu — nie odpytujemy bazy w nieskończoność. */
const MAX_PROOFS = 5
/** Górna granica długości pojedynczego identyfikatora — ULID-y są krótkie. */
const MAX_PROOF_LENGTH = 100

export type OrderAccessDecision =
  | { granted: true; actor: "customer" }
  | { granted: true; actor: "guest"; proof: "cart" }
  /** Brak jakiegokolwiek dowodu — trasa odpowiada 401. */
  | { granted: false; reason: "no_proof" }
  /** Dowód/sesja istnieje, ale nie dotyczy tego zamówienia — trasa odpowiada 404. */
  | { granted: false; reason: "not_owner" }

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

type AccessibleOrder = {
  id?: string
  customer_id?: string | null
}

/**
 * Normalizuje wartość z query stringu do dowodu. Express przy powtórzonym
 * parametrze (`?cart_id=a&cart_id=b`) oddaje tablicę — taki kształt odrzucamy
 * zamiast zgadywać, który element jest „prawdziwy".
 */
export function parseCartProof(raw: unknown): OrderAccessProof | null {
  if (typeof raw !== "string") {
    return null
  }
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_PROOF_LENGTH)
    .slice(0, MAX_PROOFS)

  return values.length > 0 ? { type: "cart", values } : null
}

/**
 * Czy `cartId` wyprodukował `orderId`.
 *
 * Test PRZYNALEŻNOŚCI, nie „rozwiąż koszyk na zamówienie". Koszyk multi-seller
 * w Mercurze rodzi po jednym zamówieniu na sprzedawcę (w `gp_mercur` są takie
 * koszyki), więc zapytanie typu `SELECT ... WHERE cart_id = ? LIMIT 1` przyznaje
 * dostęp wyłącznie do najnowszego z rodzeństwa, a resztę własnych zamówień
 * kupującej odcina.
 */
async function cartProducedOrder(
  req: MedusaRequest,
  orderId: string,
  cartIds: string[]
): Promise<boolean> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  // Placeholdery rozwijane jawnie: `toKnexPositionalSql` celowo odrzuca tablicę
  // w bindingach, bo Knex rozwinąłby ją w listę i rozjechał licznik.
  const placeholders = cartIds.map((_value, index) => `$${index + 2}`).join(", ")
  const { text, bindings } = toKnexPositionalSql(
    `
      SELECT 1
      FROM order_cart
      WHERE order_id = $1
        AND cart_id IN (${placeholders})
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [orderId, ...cartIds]
  )

  try {
    const result = await db.raw(text, bindings)
    return (result.rows?.length ?? 0) > 0
  } catch {
    // Awaria zapytania to ODMOWA, nie wyjątek lecący na 503: dostęp musi być
    // rozstrzygnięciem deterministycznym, a nie „awarią backendu".
    return false
  }
}

/**
 * Jedyny punkt decyzyjny dostępu do zamówienia na powierzchni post-payment.
 *
 * Kolejność jest istotna: zalogowana właścicielka wygrywa bez odpytywania bazy,
 * a dowód gościa jest sprawdzany tylko wtedy, gdy sesja niczego nie rozstrzyga.
 */
export async function assertOrderAccess(args: {
  req: MedusaRequest
  order: AccessibleOrder
  orderId: string
  customerId?: string | null
  proof?: OrderAccessProof | null
}): Promise<OrderAccessDecision> {
  const { req, order, orderId, customerId, proof } = args

  if (customerId && order.customer_id === customerId) {
    return { granted: true, actor: "customer" }
  }

  if (proof?.type === "cart" && proof.values.length > 0) {
    const belongs = await cartProducedOrder(req, order.id ?? orderId, proof.values)
    if (belongs) {
      return { granted: true, actor: "guest", proof: "cart" }
    }
  }

  // Zalogowana kupująca z cudzym zamówieniem dostaje 404 (zachowanie zastane),
  // gość bez ważnego dowodu — 401, bo dla niego brak dowodu jest naprawialny.
  return customerId ? { granted: false, reason: "not_owner" } : { granted: false, reason: "no_proof" }
}
