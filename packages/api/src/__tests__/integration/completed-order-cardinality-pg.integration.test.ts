/**
 * v1.15.0 Story 3.6 (FR-7, AD-16) — OGNIWO 2 kontraktu powrotu 3DS wykonane na
 * REALNYM Postgresie, przez REALNY sterownik i REALNY handler trasy.
 *
 * ── Dlaczego realny PG, a nie atrapa knexa ─────────────────────────────────
 * Mierzona własność to LICZNOŚĆ wyniku zapytania. Atrapa query-buildera zwraca
 * to, co jej każe test, więc „dwa zamówienia" byłoby założeniem przepisanym w
 * asercję, a nie pomiarem. Tu wykonuje się prawdziwy JOIN po `order_cart` na
 * prawdziwym silniku, a handler jest importowany z trasy — nie kopiowany.
 *
 * ── Kontrola negatywna ─────────────────────────────────────────────────────
 * Ta suita PĘKA po przywróceniu `.first()` w `route.ts`: `orders` ma wtedy
 * jeden element zamiast dwóch. Przebieg czerwony/zielony jest zapisany w
 * `evidence/3-6/`.
 *
 * ── DDL ────────────────────────────────────────────────────────────────────
 * `order`, `order_cart`, `order_group`, `order_group_order` to tabele rdzenia
 * Medusy/Mercura — nie ma w tym repo migracji, z której dałoby się je odtworzyć
 * (patrz `vendor-replay-guard-pg.integration.test.ts`, gdzie migracja lokalna
 * istnieje i jest przechwytywana). Dlatego DDL jest tutaj MINIMALNY: wyłącznie
 * kolumny, których dotyka zapytanie trasy. To świadomie zawężony fixture, nie
 * odwzorowanie schematu rdzenia.
 *
 * v1.16.0 Story 8.6: fixture żyje w OSOBNYM schemacie (`search_path`), bo na
 * zmigrowanej bazie `*_test` tabele rdzenia istnieją w `public` z kluczami
 * obcymi i `TRUNCATE` na nich odmawiał (zastana czerwień 7/7 z baseline).
 *
 * ── Uruchomienie ───────────────────────────────────────────────────────────
 *   DATABASE_URL=postgres://… pnpm test:integration:completed-order-pg
 * Bez `DATABASE_URL` suita jest POMIJANA (`describe.skip`) — nie „zielona".
 * Kieruj wyłącznie na IZOLOWANĄ bazę testową: test tworzy i kasuje tabele.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import { GET } from "../../api/store/carts/[id]/completed-order/route"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const CART_TWO_SELLERS = "cart_01STORY36TWOSELLERS"
const CART_ONE_SELLER = "cart_01STORY36ONESELLER"
const CART_EMPTY = "cart_01STORY36NOORDERS"

const ORDER_A = "order_01STORY36SELLERA"
const ORDER_B = "order_01STORY36SELLERB"
const ORDER_SOLO = "order_01STORY36SOLO"
const GROUP_ID = "ordgrp_01STORY36GROUP"
const FIXTURE_SCHEMA = "story36_completed_order_fixture"

type CapturedResponse = {
  statusCode: number
  body: unknown
}

/** Minimalny dubler `MedusaResponse` — zapamiętuje to, co handler realnie odesłał. */
function makeResponse(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined }
  const res = {
    status(code: number) {
      captured.statusCode = code
      return res
    },
    json(payload: unknown) {
      captured.body = payload
      return res
    },
  }
  return { res, captured }
}

/**
 * Dubler `MedusaRequest` niosący REALNE połączenie knex. Kontener Medusy nie
 * jest tu podnoszony — trasa potrzebuje z niego wyłącznie `PG_CONNECTION`.
 */
function makeRequest(db: Knex, cartId: string | undefined): any {
  return {
    params: { id: cartId },
    scope: { resolve: () => db },
  }
}

async function callRoute(db: Knex, cartId: string | undefined): Promise<CapturedResponse> {
  const { res, captured } = makeResponse()
  await GET(makeRequest(db, cartId), res)
  return captured
}

runOrSkip("Story 3.6 — endpoint mostkowy niesie KOLEKCJĘ zamówień (realny PG)", () => {
  let db: Knex

  beforeAll(async () => {
    db = knexFactory({
      client: "pg",
      connection: DATABASE_URL as string,
      searchPath: [FIXTURE_SCHEMA],
      pool: { min: 0, max: 2 },
    })

    await db.raw(`
      CREATE SCHEMA IF NOT EXISTS ${FIXTURE_SCHEMA};
      CREATE TABLE IF NOT EXISTS ${FIXTURE_SCHEMA}."order" (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      );
      CREATE TABLE IF NOT EXISTS ${FIXTURE_SCHEMA}.order_cart (
        order_id text NOT NULL,
        cart_id text NOT NULL,
        deleted_at timestamptz NULL
      );
      CREATE TABLE IF NOT EXISTS ${FIXTURE_SCHEMA}.order_group (
        id text PRIMARY KEY,
        cart_id text NULL
      );
      CREATE TABLE IF NOT EXISTS ${FIXTURE_SCHEMA}.order_group_order (
        order_id text NOT NULL,
        order_group_id text NOT NULL,
        deleted_at timestamptz NULL
      );
      CREATE TABLE IF NOT EXISTS ${FIXTURE_SCHEMA}.payment_collection (
        id text PRIMARY KEY,
        status text NOT NULL,
        deleted_at timestamptz NULL
      );
      CREATE TABLE IF NOT EXISTS ${FIXTURE_SCHEMA}.order_payment_collection (
        order_id text NOT NULL,
        payment_collection_id text NOT NULL,
        deleted_at timestamptz NULL
      );
    `)
  })

  afterAll(async () => {
    await db.raw(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`)
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw(
      `TRUNCATE order_payment_collection, payment_collection, order_group_order, order_group, order_cart, "order"`
    )

    // Koszyk DWUSPRZEDAWCOWY: dwa zamówienia w jednej grupie, różne `created_at`
    // — bo to sortowanie po `created_at` wybierało dotąd jedno z nich.
    await db("order").insert([
      { id: ORDER_A, created_at: new Date("2026-08-06T10:00:00Z") },
      { id: ORDER_B, created_at: new Date("2026-08-06T10:00:02Z") },
      { id: ORDER_SOLO, created_at: new Date("2026-08-06T10:00:05Z") },
    ])
    await db("order_cart").insert([
      { order_id: ORDER_A, cart_id: CART_TWO_SELLERS },
      { order_id: ORDER_B, cart_id: CART_TWO_SELLERS },
      { order_id: ORDER_SOLO, cart_id: CART_ONE_SELLER },
    ])
    await db("order_group").insert([{ id: GROUP_ID, cart_id: CART_TWO_SELLERS }])
    await db("order_group_order").insert([
      { order_id: ORDER_A, order_group_id: GROUP_ID },
      { order_id: ORDER_B, order_group_id: GROUP_ID },
    ])
  })

  it("koszyk z DWOMA sprzedawcami → DWA identyfikatory zamówień w `orders`", async () => {
    const captured = await callRoute(db, CART_TWO_SELLERS)

    expect(captured.statusCode).toBe(200)
    const body = captured.body as {
      orders: Array<{ order_id: string; order_group_id: string | null }>
      order_count: number
    }

    // Zbiór NAZW, nie licznik — licznik przepuszcza podmianę elementu.
    expect(new Set(body.orders.map((entry) => entry.order_id))).toEqual(
      new Set([ORDER_A, ORDER_B])
    )
    expect(body.order_count).toBe(2)
    expect(body.orders.every((entry) => entry.order_group_id === GROUP_ID)).toBe(true)
  })

  it("kolejność kolekcji jest stabilna między odczytami (bez wyboru elementu)", async () => {
    const first = (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string }>
    }
    const second = (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string }>
    }

    expect(first.orders.map((e) => e.order_id)).toEqual(second.orders.map((e) => e.order_id))
    expect(first.orders[0].order_id).toBe(ORDER_A)
  })

  /**
   * review-fix (LOW): zgodność wsteczna skalara jest SEMANTYCZNA, nie kształtowa.
   *
   * Przed Story 3.6 zapytanie kończyło się `.orderBy("o.created_at","desc").first()`
   * — `order_id` był NAJNOWSZYM zamówieniem koszyka. Posortowanie kolekcji rosnąco
   * i wzięcie `orders[0]` przerzuciło skalar na NAJSTARSZE zamówienie: dla N=1 bez
   * różnicy, dla N≥2 storefront sprzed v1.15.0 (jedyny konsument tego pola) dostaje
   * INNE zamówienie niż dotąd.
   *
   * Ten test PĘKA po powrocie do `orders[0]`.
   */
  it("skalar zgodności wstecznej zachowuje znaczenie sprzed 3.6: NAJNOWSZE zamówienie", async () => {
    const body = (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string }>
      order_id: string
      order_group_id: string | null
    }

    // Kolekcja pozostaje rosnąca (stabilny, odtwarzalny odczyt)…
    expect(body.orders.map((e) => e.order_id)).toEqual([ORDER_A, ORDER_B])
    // …a skalar wskazuje na NAJNOWSZE, czyli ORDER_B (created_at 10:00:02),
    // dokładnie tak jak `.orderBy("desc").first()` przed tą story.
    expect(body.order_id).toBe(ORDER_B)
    expect(body.order_id).not.toBe(body.orders[0].order_id)
    expect(body.order_group_id).toBe(GROUP_ID)
  })

  it("N=1: koszyk jednosprzedawcowy nadal działa i zwraca kolekcję jednoelementową", async () => {
    const captured = await callRoute(db, CART_ONE_SELLER)

    expect(captured.statusCode).toBe(200)
    const body = captured.body as {
      orders: Array<{ order_id: string; order_group_id: string | null }>
      order_id: string
      order_count: number
    }
    expect(body.orders.map((e) => e.order_id)).toEqual([ORDER_SOLO])
    expect(body.order_count).toBe(1)
    // Skalar zgodności wstecznej (drill-down z powierzchni pokazującej całość).
    expect(body.order_id).toBe(ORDER_SOLO)
    expect(body.orders[0].order_group_id).toBeNull()
  })

  it("zamówienia skasowane (`deleted_at`) nie wchodzą do kolekcji", async () => {
    await db("order").where({ id: ORDER_B }).update({ deleted_at: new Date() })

    const body = (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string }>
      order_count: number
    }
    expect(body.orders.map((e) => e.order_id)).toEqual([ORDER_A])
    expect(body.order_count).toBe(1)
  })

  it("koszyk bez zamówień → 404 z nazwanym typem, nie pusta kolekcja z 200", async () => {
    const captured = await callRoute(db, CART_EMPTY)

    expect(captured.statusCode).toBe(404)
    expect(captured.body).toMatchObject({ type: "not_found" })
  })

  // ── v1.16.0 Story 8.6 (AC1, AC2) — zbiór identyfikatorów i stan per zamówienie ──
  it("8.6 AC2: wszystkie zamówienia terminalne ⇒ zbiór oczekiwany == otrzymany, `purchase_state` complete", async () => {
    await db("payment_collection").insert([
      { id: "pc_a", status: "authorized" },
      { id: "pc_b", status: "completed" },
    ])
    await db("order_payment_collection").insert([
      { order_id: ORDER_A, payment_collection_id: "pc_a" },
      { order_id: ORDER_B, payment_collection_id: "pc_b" },
    ])
    const body = (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string; terminal: boolean }>
      expected_order_ids: string[]
      open_order_ids: string[]
      purchase_state: string
    }
    expect(new Set(body.expected_order_ids)).toEqual(new Set([ORDER_A, ORDER_B]))
    expect(body.orders.every((o) => o.terminal)).toBe(true)
    expect(body.open_order_ids).toEqual([])
    expect(body.purchase_state).toBe("complete")
  })

  it("8.6 AC2: zgodna LICZBA, różny ZBIÓR id ⇒ nie `complete`, brakujący element nazwany", async () => {
    // Grupa zakupu oczekuje {A, C}; koszyk wyprodukował {A, B}. 2 == 2, zbiory różne.
    const ORDER_C = "order_01STORY86SELLERC"
    await db("order").insert([{ id: ORDER_C, created_at: new Date("2026-08-06T10:00:03Z") }])
    await db("order_group_order").where({ order_id: ORDER_B }).delete()
    await db("order_group_order").insert([{ order_id: ORDER_C, order_group_id: GROUP_ID }])

    const body = (await callRoute(db, CART_TWO_SELLERS)).body as {
      order_count: number
      expected_order_ids: string[]
      open_order_ids: string[]
      purchase_state: string
    }
    expect(body.order_count).toBe(2)
    expect(body.expected_order_ids.length).toBe(2)
    expect(new Set(body.expected_order_ids)).toEqual(new Set([ORDER_A, ORDER_C]))
    expect(body.open_order_ids).toEqual([ORDER_C])
    expect(body.purchase_state).toBe("incomplete")
  })

  it("8.6 AC1: jedno zamówienie order-setu nieterminalne ⇒ `incomplete` i wskazane otwarte zamówienie", async () => {
    await db("payment_collection").insert([
      { id: "pc_a", status: "authorized" },
      { id: "pc_b", status: "awaiting" },
    ])
    await db("order_payment_collection").insert([
      { order_id: ORDER_A, payment_collection_id: "pc_a" },
      { order_id: ORDER_B, payment_collection_id: "pc_b" },
    ])
    const body = (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string; terminal: boolean }>
      open_order_ids: string[]
      purchase_state: string
    }
    expect(body.orders.find((o) => o.order_id === ORDER_A)?.terminal).toBe(true)
    expect(body.orders.find((o) => o.order_id === ORDER_B)?.terminal).toBe(false)
    expect(body.open_order_ids).toEqual([ORDER_B])
    expect(body.purchase_state).toBe("incomplete")
  })

  // 8.6 review-fix (MEDIUM): lista DOZWOLONYCH statusów płatności. Mutant
  // „powrót do listy zakazanej" czerwieni przypadki partially_authorized i nieznany.
  async function stateFor(statusA: string, statusB: string) {
    await db("payment_collection").insert([
      { id: "pc_a", status: statusA },
      { id: "pc_b", status: statusB },
    ])
    await db("order_payment_collection").insert([
      { order_id: ORDER_A, payment_collection_id: "pc_a" },
      { order_id: ORDER_B, payment_collection_id: "pc_b" },
    ])
    return (await callRoute(db, CART_TWO_SELLERS)).body as {
      orders: Array<{ order_id: string; terminal: boolean; terminal_reason: string }>
      open_order_ids: string[]
      purchase_state: string
    }
  }

  it("8.6 fix: `partially_authorized` (wspólna kolekcja, jeden PI otwarty) ⇒ `incomplete`, powód nazwany", async () => {
    const body = await stateFor("partially_authorized", "partially_authorized")
    expect(body.orders.every((o) => o.terminal === false)).toBe(true)
    expect(body.orders.map((o) => o.terminal_reason)).toEqual([
      "payment_status_non_terminal",
      "payment_status_non_terminal",
    ])
    expect(new Set(body.open_order_ids)).toEqual(new Set([ORDER_A, ORDER_B]))
    expect(body.purchase_state).toBe("incomplete")
  })

  it("8.6 fix: status płatności nieznany ⇒ nieterminalny z powodem `payment_status_unknown`", async () => {
    const body = await stateFor("authorized", "some_future_status")
    const b = body.orders.find((o) => o.order_id === ORDER_B)
    expect(b?.terminal).toBe(false)
    expect(b?.terminal_reason).toBe("payment_status_unknown")
    expect(body.open_order_ids).toEqual([ORDER_B])
    expect(body.purchase_state).toBe("incomplete")
  })

  it("8.6 fix: `partially_captured` ⇒ nieterminalny (fail-closed)", async () => {
    const body = await stateFor("authorized", "partially_captured")
    expect(body.orders.find((o) => o.order_id === ORDER_B)?.terminal).toBe(false)
    expect(body.purchase_state).toBe("incomplete")
  })

  it("8.6 fix: `authorized` i `completed` ⇒ terminalne, `purchase_state` complete", async () => {
    const body = await stateFor("authorized", "completed")
    expect(body.orders.every((o) => o.terminal && o.terminal_reason === "terminal")).toBe(true)
    expect(body.open_order_ids).toEqual([])
    expect(body.purchase_state).toBe("complete")
  })

  it("brak identyfikatora koszyka → 400 `invalid_request`", async () => {
    const captured = await callRoute(db, undefined)

    expect(captured.statusCode).toBe(400)
    expect(captured.body).toMatchObject({ type: "invalid_request" })
  })
})
