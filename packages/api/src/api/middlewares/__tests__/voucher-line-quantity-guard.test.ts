/**
 * Story 3.3 AC2 — runda fix 2 (ADR-242 §Decyzja p.5): krotność linii voucherowej
 * egzekwowana na trasach koszyka PRZED płatnością.
 *
 * Kontrola negatywna (mutant): zdjęcie odmowy w `voucherLineQuantityGuardMiddleware`
 * MUSI wywalić przypadki „quantity=2 ⇒ 400" na czerwono.
 */
import { describe, it, expect } from "@jest/globals"

import { voucherLineQuantityGuardMiddleware } from "../voucher-line-quantity-guard"
import { VOUCHER_LINE_QUANTITY_CART_REASON } from "../../../lib/payment/voucher-line-quantity"

const VOUCHER_PRODUCT_META = { gp: { entitlement_profile: { profile_id: "prof_1" } } }

function run(options: {
  url: string
  body: Record<string, unknown>
  row?: Record<string, unknown> | null
}) {
  const queries: Array<{ sql: string; bindings: unknown[] }> = []
  const db = {
    raw: async (sql: string, bindings: unknown[]) => {
      queries.push({ sql, bindings })
      return { rows: options.row ? [options.row] : [] }
    },
  }
  const state: { status?: number; json?: Record<string, unknown>; next: boolean } = {
    next: false,
  }
  const req = {
    originalUrl: options.url,
    body: options.body,
    scope: { resolve: () => db },
  }
  const res = {
    status(code: number) {
      state.status = code
      return this
    },
    json(payload: Record<string, unknown>) {
      state.json = payload
      return this
    },
  }
  return voucherLineQuantityGuardMiddleware(req as never, res as never, () => {
    state.next = true
  }).then(() => ({ ...state, queries }))
}

describe("Story 3.3 AC2 — voucherLineQuantityGuardMiddleware (trasa koszyka przed płatnością)", () => {
  it("POST line-items: voucher z quantity=2 ⇒ 400 z reason voucher_line_quantity_unsupported", async () => {
    const r = await run({
      url: "/store/carts/cart_1/line-items",
      body: { variant_id: "var_v", quantity: 2 },
      row: { product_metadata: VOUCHER_PRODUCT_META, existing_quantity: 0 },
    })
    expect(r.next).toBe(false)
    expect(r.status).toBe(400)
    expect(r.json?.reason).toBe(VOUCHER_LINE_QUANTITY_CART_REASON)
  })

  it("POST line-items: voucher z quantity=1 na pustym koszyku ⇒ przechodzi (200 trasy)", async () => {
    const r = await run({
      url: "/store/carts/cart_1/line-items",
      body: { variant_id: "var_v", quantity: 1 },
      row: { product_metadata: VOUCHER_PRODUCT_META, existing_quantity: 0 },
    })
    expect(r.next).toBe(true)
    expect(r.status).toBeUndefined()
  })

  it("POST line-items: ponowne dodanie tego samego vouchera (scalenie do quantity=2) ⇒ 400", async () => {
    const r = await run({
      url: "/store/carts/cart_1/line-items",
      body: { variant_id: "var_v", quantity: 1 },
      row: { product_metadata: VOUCHER_PRODUCT_META, existing_quantity: "1" },
    })
    expect(r.status).toBe(400)
    expect(r.json?.reason).toBe(VOUCHER_LINE_QUANTITY_CART_REASON)
  })

  it("POST line-items: produkt nie-voucherowy z quantity=2 ⇒ bez zmian (przechodzi)", async () => {
    const r = await run({
      url: "/store/carts/cart_1/line-items",
      body: { variant_id: "var_p", quantity: 2 },
      row: { product_metadata: { gp: { market_id: "m1" } }, existing_quantity: 0 },
    })
    expect(r.next).toBe(true)
    expect(r.status).toBeUndefined()
  })

  it("POST line-items: marker entitlement w metadanych linii (bez profilu produktu) ⇒ voucher, quantity=2 ⇒ 400", async () => {
    const r = await run({
      url: "/store/carts/cart_1/line-items",
      body: { variant_id: "var_x", quantity: 2, metadata: { entitlement_type: "VOUCHER" } },
      row: { product_metadata: null, existing_quantity: 0 },
    })
    expect(r.status).toBe(400)
  })

  it("POST line-items/:line_id: voucher quantity=2 ⇒ 400; quantity=1 ⇒ przechodzi; quantity=0 (usunięcie) ⇒ przechodzi", async () => {
    const row = { metadata: null, product_metadata: VOUCHER_PRODUCT_META }
    const bad = await run({ url: "/store/carts/cart_1/line-items/li_1", body: { quantity: 2 }, row })
    expect(bad.status).toBe(400)
    expect(bad.json?.reason).toBe(VOUCHER_LINE_QUANTITY_CART_REASON)
    expect(bad.queries[0].bindings).toEqual(["li_1", "cart_1"])
    const ok = await run({ url: "/store/carts/cart_1/line-items/li_1", body: { quantity: 1 }, row })
    expect(ok.next).toBe(true)
    const del = await run({ url: "/store/carts/cart_1/line-items/li_1", body: { quantity: 0 }, row })
    expect(del.next).toBe(true)
  })

  it("POST line-items/:line_id: linia nie-voucherowa quantity=3 ⇒ bez zmian", async () => {
    const r = await run({
      url: "/store/carts/cart_1/line-items/li_2",
      body: { quantity: 3 },
      row: { metadata: {}, product_metadata: {} },
    })
    expect(r.next).toBe(true)
  })
})

describe("Story 3.3 AC2 — wpięcie strażnika w obie trasy koszyka", () => {
  it("middlewares.ts rejestruje voucherLineQuantityGuardMiddleware dla POST line-items i line-items/:line_id", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const src = readFileSync(join(__dirname, "..", "..", "middlewares.ts"), "utf8")
    for (const matcher of ["/store/carts/:id/line-items", "/store/carts/:id/line-items/:line_id"]) {
      const re = new RegExp(
        `matcher: "${matcher.replace(/[/:]/g, (c) => `\\${c}`)}",\\s*middlewares: \\[voucherLineQuantityGuardMiddleware\\]`
      )
      expect({ matcher, wired: re.test(src) }).toEqual({ matcher, wired: true })
    }
  })
})
