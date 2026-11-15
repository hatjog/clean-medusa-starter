/**
 * cart-completion-psp-authority.retry.integration.test.ts — v1.16.0 Story 8.3 AC2
 * (FR-15, AD-18, NFR-4).
 *
 * Retry after an interrupted 3DS return must NOT create a second charge for
 * the same payment intent:
 *
 *  1. The interrupted completion (PSP read failed ⇒ 503) and its retry ask
 *     the PSP about the SAME `payment_intent_id`; the retry completes it.
 *  2. Re-initialising payment sessions (the path that makes Medusa create a
 *     NEW PaymentIntent) is refused while the existing intent is charged or
 *     `processing` ⇒ zero second PaymentIntent.
 *  3. Once the cart has an order, a further retry goes to the idempotent
 *     handler without asking the PSP ⇒ zero second order.
 *  4. Negation: a mutant guard that lets re-initialisation through makes the
 *     "no second PaymentIntent" assertion fail (in-test mutant control).
 *
 * Real PostgreSQL (`DATABASE_URL` on a `*_test` database); TEMP tables shadow
 * `order` / `order_cart` / `cart_payment_collection` / `payment_session` on
 * this session only. "Creating a new PaymentIntent" is modelled exactly as
 * Medusa's `createPaymentSessionsWorkflow` does it: soft-delete the existing
 * session and insert a new one with a new `pi_…` id.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals"
import { EventEmitter } from "node:events"
import { Client } from "pg"

import {
  createCartCompletionPspAuthorityMiddleware,
  type PspAuthorityDeps,
} from "../cart-completion-psp-authority"
import {
  createPaymentSessionReinitGuard,
  type PaymentSessionReinitGuardDeps,
} from "../payment-session-reinit-guard"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const CART = "cart_story83_retry"
const COLLECTION = `paycol_${CART}`
const FIRST_PI = "pi_story83_first"

type Res = EventEmitter & {
  statusCode: number
  body: Record<string, unknown> | null
  status: (code: number) => Res
  json: (body: Record<string, unknown>) => Res
  end: () => Res
}

function makeRes(): Res {
  const res = new EventEmitter() as Res
  res.statusCode = 200
  res.body = null
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: Record<string, unknown>) => {
    res.body = body
    return res
  }
  res.end = () => res
  return res
}

let client: Client
const readQuery = async (_scope: unknown, sql: string, params: ReadonlyArray<unknown>) =>
  (await client.query(sql, params as unknown[])).rows

/** PSP double: status per intent id; `asked` records every PSP read. */
function psp(statuses: Record<string, string | Error>) {
  const asked: string[] = []
  const retrieve = async ({ paymentIntentId }: { paymentIntentId: string }) => {
    asked.push(paymentIntentId)
    const s = statuses[paymentIntentId]
    if (s instanceof Error) throw s
    return s ?? "requires_payment_method"
  }
  return { asked, retrieve }
}

async function complete(retrieve: PspAuthorityDeps["retrievePaymentIntentStatus"]) {
  const mw = createCartCompletionPspAuthorityMiddleware({
    acquireConnection: async () => ({ client: client as never, release: () => undefined }),
    retrievePaymentIntentStatus: retrieve,
    readQuery,
  })
  const res = makeRes()
  let nextCalled = false
  await mw({ params: { id: CART }, scope: {} } as never, res as never, () => {
    nextCalled = true
  })
  res.emit("finish")
  return { res, nextCalled }
}

let piCounter = 0
/** What Medusa's createPaymentSessionsWorkflow does when it runs. */
async function medusaCreatePaymentSession(): Promise<string> {
  piCounter++
  const pi = `pi_story83_new_${piCounter}`
  await client.query(
    "UPDATE pg_temp.payment_session SET deleted_at = now() WHERE payment_collection_id = $1 AND deleted_at IS NULL",
    [COLLECTION]
  )
  await client.query(
    "INSERT INTO pg_temp.payment_session(payment_collection_id, provider_id, data) VALUES ($1, 'pp_stripe_stripe', $2)",
    [COLLECTION, JSON.stringify({ id: pi })]
  )
  return pi
}

async function reinit(guard: (req: never, res: never, next: () => void) => Promise<void>) {
  const res = makeRes()
  let created: string | null = null
  let nextCalled = false
  await guard({ params: { id: COLLECTION }, scope: {} } as never, res as never, () => {
    nextCalled = true
  })
  if (nextCalled) created = await medusaCreatePaymentSession()
  return { res, created }
}

async function liveIntentIds(): Promise<string[]> {
  const r = await client.query(
    "SELECT data->>'id' AS id FROM pg_temp.payment_session WHERE payment_collection_id = $1 AND deleted_at IS NULL ORDER BY id",
    [COLLECTION]
  )
  return r.rows.map(row => row.id as string)
}

async function allIntentIds(): Promise<string[]> {
  const r = await client.query(
    "SELECT data->>'id' AS id FROM pg_temp.payment_session WHERE payment_collection_id = $1",
    [COLLECTION]
  )
  return r.rows.map(row => row.id as string).sort()
}

/** The AC2 assertion: exactly one PaymentIntent ever existed for the purchase. */
async function assertNoSecondPaymentIntent() {
  expect(await allIntentIds()).toEqual([FIRST_PI])
  expect(await liveIntentIds()).toEqual([FIRST_PI])
}

function guardWith(retrieve: PaymentSessionReinitGuardDeps["retrievePaymentIntentStatus"]) {
  return createPaymentSessionReinitGuard({ readQuery, retrievePaymentIntentStatus: retrieve })
}

beforeAll(async () => {
  if (!/_test(\?|$)/.test(DATABASE_URL.split("/").pop() ?? "")) {
    throw new Error("cart-completion-psp-authority.retry wymaga DATABASE_URL na bazie *_test")
  }
  client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  await client.query(`
    CREATE TEMP TABLE "order" (id text PRIMARY KEY, deleted_at timestamptz);
    CREATE TEMP TABLE order_cart (order_id text, cart_id text, deleted_at timestamptz);
    CREATE TEMP TABLE cart_payment_collection (cart_id text, payment_collection_id text, deleted_at timestamptz);
    CREATE TEMP TABLE payment_session (payment_collection_id text, provider_id text, data jsonb, deleted_at timestamptz);
  `)
})

afterAll(async () => {
  await client?.end()
})

beforeEach(async () => {
  piCounter = 0
  await client.query("SELECT pg_advisory_unlock_all()")
  await client.query(
    'TRUNCATE pg_temp."order", pg_temp.order_cart, pg_temp.cart_payment_collection, pg_temp.payment_session'
  )
  await client.query(
    "INSERT INTO pg_temp.cart_payment_collection(cart_id, payment_collection_id) VALUES ($1, $2)",
    [CART, COLLECTION]
  )
  await client.query(
    "INSERT INTO pg_temp.payment_session(payment_collection_id, provider_id, data) VALUES ($1, 'pp_stripe_stripe', $2)",
    [COLLECTION, JSON.stringify({ id: FIRST_PI })]
  )
})

describe("Story 8.3 AC2 — ponowienie po przerwanym powrocie nie tworzy drugiego obciążenia", () => {
  it("przerwane domknięcie (503) i jego ponowienie pytają PSP o TEN SAM payment_intent_id", async () => {
    const down = psp({ [FIRST_PI]: new Error("stripe timeout") })
    const first = await complete(down.retrieve)
    expect(first.res.statusCode).toBe(503)
    expect(first.res.body?.type).toBe("psp_status_unavailable")
    expect(first.nextCalled).toBe(false)

    const up = psp({ [FIRST_PI]: "succeeded" })
    const retry = await complete(up.retrieve)
    expect(retry.nextCalled).toBe(true)
    expect(down.asked).toEqual([FIRST_PI])
    expect(up.asked).toEqual([FIRST_PI])
    await assertNoSecondPaymentIntent()
  })

  it.each(["succeeded", "requires_capture", "processing"])(
    "PI w stanie %s ⇒ ponowna inicjalizacja sesji odrzucona 409, zero drugiego PI",
    async status => {
      const { res, created } = await reinit(guardWith(psp({ [FIRST_PI]: status }).retrieve) as never)
      expect(res.statusCode).toBe(409)
      expect(res.body?.type).toBe("payment_intent_in_flight")
      expect(res.body?.payment_intent_ids).toEqual([FIRST_PI])
      expect(created).toBeNull()
      await assertNoSecondPaymentIntent()
    }
  )

  it("awaria odczytu PSP przy ponownej inicjalizacji ⇒ 503, zero drugiego PI (fail-closed)", async () => {
    const { res, created } = await reinit(
      guardWith(psp({ [FIRST_PI]: new Error("stripe down") }).retrieve) as never
    )
    expect(res.statusCode).toBe(503)
    expect(res.body?.type).toBe("psp_status_unavailable")
    expect(created).toBeNull()
    await assertNoSecondPaymentIntent()
  })

  it("kontrola dodatnia: PI nieobciążony (requires_payment_method) ⇒ nowa sesja dozwolona", async () => {
    const { res, created } = await reinit(
      guardWith(psp({ [FIRST_PI]: "requires_payment_method" }).retrieve) as never
    )
    expect(res.statusCode).toBe(200)
    expect(created).toBe("pi_story83_new_1")
    expect(await liveIntentIds()).toEqual(["pi_story83_new_1"])
  })

  it("po powstaniu zamówienia ponowienie idzie do handlera idempotentnego bez pytania PSP — zero drugiego zamówienia", async () => {
    await client.query(`INSERT INTO pg_temp."order"(id) VALUES ('order_story83_one')`)
    await client.query(
      "INSERT INTO pg_temp.order_cart(order_id, cart_id) VALUES ('order_story83_one', $1)",
      [CART]
    )
    const p = psp({ [FIRST_PI]: "succeeded" })
    const retry = await complete(p.retrieve)
    expect(retry.nextCalled).toBe(true)
    expect(p.asked).toEqual([])
    const orders = await client.query("SELECT order_id FROM pg_temp.order_cart WHERE cart_id = $1", [CART])
    expect(orders.rows).toHaveLength(1)
    await assertNoSecondPaymentIntent()
  })

  it("negacja: mutant przepuszczający ponowną inicjalizację tworzy drugi PI i czerwieni asercję AC2", async () => {
    const mutant = async (_req: never, _res: never, next: () => void) => next()
    const { created } = await reinit(mutant)
    expect(created).toBe("pi_story83_new_1")
    await expect(assertNoSecondPaymentIntent()).rejects.toThrow()
  })
})
