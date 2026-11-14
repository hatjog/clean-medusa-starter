/**
 * Story 3.3 AC2 — runda fix 2 (ADR-242 §Decyzja p.5, AR-03).
 *
 * Punkt egzekwowania krotności linii voucherowej PRZED płatnością: trasy
 * `POST /store/carts/:id/line-items` oraz `POST /store/carts/:id/line-items/:line_id`.
 * Linia voucherowa (kryterium wystawcy: marker w metadanych linii ALBO
 * `product.metadata.gp.entitlement_profile`) może mieć wyłącznie quantity=1.
 * Inna krotność ⇒ 400 z maszynowym `reason` = `voucher_line_quantity_unsupported`.
 *
 * Dodanie wariantu, który już leży w koszyku, scala się w Medusie w tę samą
 * linię (quantity rośnie) — dlatego krotność wynikowa = istniejąca + żądana.
 * `quantity=0` na trasie aktualizacji to usunięcie linii — dozwolone.
 * Produkt nie-voucherowy przechodzi bez zmian.
 */
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import {
  isSupportedVoucherLineQuantity,
  isVoucherLine,
  VOUCHER_LINE_QUANTITY_CART_REASON,
} from "../../lib/payment/voucher-line-quantity"

type Meta = Record<string, unknown> | null

function readBody(req: MedusaRequest): Record<string, unknown> {
  const body = (req as unknown as { body?: unknown }).body
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

// jsonb z node-pg przychodzi jako obiekt; inna postać nie niesie markera.
function parseJson(value: unknown): Meta {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pathSegments(req: MedusaRequest): string[] {
  const raw = (req as unknown as { originalUrl?: string; url?: string; path?: string })
  const p = raw.originalUrl ?? raw.url ?? raw.path ?? ""
  return p.split("?")[0].split("/").filter(Boolean)
}

export function rejectVoucherLineQuantity(res: MedusaResponse, quantity: unknown): void {
  res.status(400).json({
    type: "invalid_data",
    reason: VOUCHER_LINE_QUANTITY_CART_REASON,
    message:
      `Voucher line items support quantity=1 only (requested ${String(quantity)}). ` +
      "Add another voucher as a separate purchase.",
  })
}

export async function voucherLineQuantityGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  const segs = pathSegments(req)
  const cartsIdx = segs.indexOf("carts")
  const cartId = cartsIdx >= 0 ? segs[cartsIdx + 1] : undefined
  if (!cartId || segs[cartsIdx + 2] !== "line-items") {
    next()
    return
  }
  const lineId = segs[cartsIdx + 3]
  const body = readBody(req)
  const requested = body.quantity === undefined ? 1 : body.quantity
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex

  if (lineId) {
    if (requested === 0) {
      next()
      return
    }
    const r = await db.raw(
      `SELECT cli.metadata, p.metadata AS product_metadata
         FROM cart_line_item cli
         LEFT JOIN product p ON p.id = cli.product_id
        WHERE cli.id = ? AND cli.cart_id = ? AND cli.deleted_at IS NULL
        LIMIT 1`,
      [lineId, cartId]
    )
    const row = (r as { rows?: Array<Record<string, unknown>> }).rows?.[0]
    if (
      row &&
      isVoucherLine(parseJson(row.metadata), parseJson(row.product_metadata)) &&
      !isSupportedVoucherLineQuantity(requested)
    ) {
      rejectVoucherLineQuantity(res, requested)
      return
    }
    next()
    return
  }

  const variantId = typeof body.variant_id === "string" ? body.variant_id : null
  if (!variantId) {
    next()
    return
  }
  const r = await db.raw(
    `SELECT p.metadata AS product_metadata,
            (SELECT COALESCE(SUM(cli.quantity), 0)
               FROM cart_line_item cli
              WHERE cli.cart_id = ? AND cli.variant_id = pv.id
                AND cli.deleted_at IS NULL) AS existing_quantity
       FROM product_variant pv
       JOIN product p ON p.id = pv.product_id
      WHERE pv.id = ? AND pv.deleted_at IS NULL
      LIMIT 1`,
    [cartId, variantId]
  )
  const row = (r as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!row || !isVoucherLine(parseJson(body.metadata), parseJson(row.product_metadata))) {
    next()
    return
  }
  const existing = Number(row.existing_quantity ?? 0)
  const effective = typeof requested === "number" ? existing + requested : requested
  if (!isSupportedVoucherLineQuantity(effective)) {
    rejectVoucherLineQuantity(res, effective)
    return
  }
  next()
}
