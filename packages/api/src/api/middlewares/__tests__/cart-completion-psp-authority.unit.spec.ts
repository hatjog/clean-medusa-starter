/**
 * cart-completion-psp-authority.unit.spec.ts — v1.16.0 Story 8.2
 * (ADR-233, DW-15-236). Three POSITIVE controls named by ADR-233:
 *
 *  1. `redirect_status=succeeded` from the client does not matter: a
 *     PaymentIntent WITHOUT a terminal state ⇒ completion REFUSED (409).
 *  2. Two concurrent `complete` calls for one cart from TWO PROCESSES ⇒
 *     exactly one passes. The second process is a real child `node` process
 *     holding the advisory lock on its own PostgreSQL session.
 *  3. Process restart between attempts ⇒ the fence still holds: after the
 *     child dies its lock is gone, but the cart already has an `order_cart`
 *     row in the database, so the request goes to the idempotent handler
 *     (existing order) and the PSP is not asked again.
 *
 * Real PostgreSQL (`DATABASE_URL`, `*_test`), TEMP tables shadow
 * `order_cart` / `order` / `cart_payment_collection` / `payment_session`
 * on the test session only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals"
import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { Client } from "pg"

import {
  createCartCompletionPspAuthorityMiddleware,
  CART_COMPLETE_LOCK_NAMESPACE,
  type PspAuthorityDeps,
} from "../cart-completion-psp-authority"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const CART = "cart_story82_fence"

type Res = EventEmitter & {
  statusCode: number
  body: Record<string, unknown> | null
  status: (code: number) => Res
  json: (body: Record<string, unknown>) => Res
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
  return res
}

let client: Client
let releases = 0

async function run(
  deps: Partial<PspAuthorityDeps>,
  cartId = CART
): Promise<{ res: Res; nextCalled: boolean }> {
  const middleware = createCartCompletionPspAuthorityMiddleware({
    acquireConnection: async () => ({
      client: client as never,
      release: () => {
        releases++
      },
    }),
    retrievePaymentIntentStatus: async () => "succeeded",
    ...deps,
  } as PspAuthorityDeps)
  const res = makeRes()
  let nextCalled = false
  await middleware(
    { params: { id: cartId }, scope: {} } as never,
    res as never,
    () => {
      nextCalled = true
    }
  )
  return { res, nextCalled }
}

async function seedStripeSession(cartId: string, intentId: string) {
  await client.query(
    "INSERT INTO pg_temp.cart_payment_collection(cart_id, payment_collection_id) VALUES ($1, $2)",
    [cartId, `paycol_${cartId}`]
  )
  await client.query(
    "INSERT INTO pg_temp.payment_session(payment_collection_id, provider_id, data) VALUES ($1, 'pp_stripe_stripe', $2)",
    [`paycol_${cartId}`, JSON.stringify({ id: intentId })]
  )
}

function holdLockInChild(cartId: string): Promise<ChildProcess> {
  const script = `
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [process.argv[1]]);
      process.stdout.write(r.rows[0].locked ? "LOCKED\\n" : "BUSY\\n");
      setInterval(() => {}, 1000);
    })().catch(e => { process.stdout.write("ERR " + e.message + "\\n"); process.exit(1); });
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, `${CART_COMPLETE_LOCK_NAMESPACE}${cartId}`], {
      env: process.env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
    })
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes("LOCKED")) resolve(child)
      else reject(new Error(`child lock: ${text.trim()}`))
    })
    child.on("error", reject)
  })
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.on("exit", () => resolve())
    child.kill("SIGKILL")
  })
}

beforeAll(async () => {
  if (!/_test(\?|$)/.test(DATABASE_URL.split("/").pop() ?? "")) {
    throw new Error("cart-completion-psp-authority wymaga DATABASE_URL na bazie *_test")
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
  releases = 0
  // Blokady sesyjne są re-entrant w obrębie JEDNEJ sesji; testy dzielą sesję,
  // więc każdy przypadek startuje bez blokad poprzedniego.
  await client.query("SELECT pg_advisory_unlock_all()")
  await client.query(
    'TRUNCATE pg_temp."order", pg_temp.order_cart, pg_temp.cart_payment_collection, pg_temp.payment_session'
  )
})

describe("Story 8.2 — autorytet PSP dla POST /store/carts/:id/complete (ADR-233)", () => {
  it("kontrola 1: PI bez stanu terminalnego ⇒ 409 payment_not_terminal (redirect_status z URL nie uczestniczy)", async () => {
    await seedStripeSession(CART, "pi_story82_requires_action")
    const asked: string[] = []
    const { res, nextCalled } = await run({
      retrievePaymentIntentStatus: async ({ paymentIntentId }) => {
        asked.push(paymentIntentId)
        return "requires_action"
      },
    })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(409)
    expect(res.body?.type).toBe("payment_not_terminal")
    expect(asked).toEqual(["pi_story82_requires_action"])
    expect(releases).toBe(1)
  })

  it.each(["succeeded", "requires_capture"])("PI w stanie %s ⇒ przepuszczone do handlera", async status => {
    await seedStripeSession(CART, "pi_story82_ok")
    const { res, nextCalled } = await run({ retrievePaymentIntentStatus: async () => status })
    expect(nextCalled).toBe(true)
    expect(res.body).toBeNull()
    res.emit("finish")
    await new Promise(r => setTimeout(r, 50))
    expect(releases).toBe(1)
  })

  it("awaria odczytu Stripe ⇒ 503 psp_status_unavailable, nie ciche przejście", async () => {
    await seedStripeSession(CART, "pi_story82_err")
    const { res, nextCalled } = await run({
      retrievePaymentIntentStatus: async () => {
        throw new Error("stripe down")
      },
    })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(503)
    expect(res.body?.type).toBe("psp_status_unavailable")
  })

  it("brak połączenia PG ⇒ 503 psp_authority_unavailable", async () => {
    const middleware = createCartCompletionPspAuthorityMiddleware({
      acquireConnection: async () => null,
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    const res = makeRes()
    let nextCalled = false
    await middleware({ params: { id: CART }, scope: {} } as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(503)
  })

  it("koszyk bez sesji Stripe ⇒ ścieżka innych dostawców nietknięta", async () => {
    let asked = 0
    const { res, nextCalled } = await run({
      retrievePaymentIntentStatus: async () => {
        asked++
        return "requires_action"
      },
    })
    expect(nextCalled).toBe(true)
    expect(asked).toBe(0)
    res.emit("finish")
  })

  it("kontrola 2: drugi PROCES trzyma blokadę koszyka ⇒ 409 completion_in_progress, zero odczytu PSP", async () => {
    await seedStripeSession(CART, "pi_story82_fence")
    const child = await holdLockInChild(CART)
    try {
      let asked = 0
      const { res, nextCalled } = await run({
        retrievePaymentIntentStatus: async () => {
          asked++
          return "succeeded"
        },
      })
      expect(nextCalled).toBe(false)
      expect(res.statusCode).toBe(409)
      expect(res.body?.type).toBe("completion_in_progress")
      expect(asked).toBe(0)
    } finally {
      await killChild(child)
    }
  })

  it("kontrola 3: restart procesu między próbami — trwały order_cart prowadzi do istniejącego zamówienia bez drugiego odczytu PSP", async () => {
    await seedStripeSession(CART, "pi_story82_restart")
    const child = await holdLockInChild(CART)
    // Pierwsza próba (proces dziecka) „domyka” koszyk i umiera.
    await client.query("INSERT INTO pg_temp.\"order\"(id) VALUES ('order_story82_a')")
    await client.query(
      "INSERT INTO pg_temp.order_cart(order_id, cart_id) VALUES ('order_story82_a', $1)",
      [CART]
    )
    await killChild(child)
    // Po restarcie: blokada sesyjna zniknęła, ale PI w Stripe mógłby już być
    // w dowolnym stanie — middleware nie pyta PSP, przepuszcza do handlera,
    // który zwraca ISTNIEJĄCE zamówienie (Medusa: koszyk z completed_at).
    let asked = 0
    let acquired = false
    for (let i = 0; i < 20 && !acquired; i++) {
      const { res, nextCalled } = await run({
        retrievePaymentIntentStatus: async () => {
          asked++
          return "requires_action"
        },
      })
      if (nextCalled) {
        acquired = true
        res.emit("finish")
      } else {
        expect(res.body?.type).toBe("completion_in_progress")
        await new Promise(r => setTimeout(r, 100))
      }
    }
    expect(acquired).toBe(true)
    expect(asked).toBe(0)
  })

  it("blokada jest zwalniana po zakończeniu odpowiedzi — kolejna próba w tym samym procesie przechodzi", async () => {
    await seedStripeSession(CART, "pi_story82_seq")
    const first = await run({})
    expect(first.nextCalled).toBe(true)
    const concurrent = await new Client({ connectionString: DATABASE_URL })
    await concurrent.connect()
    try {
      const busy = await concurrent.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [`${CART_COMPLETE_LOCK_NAMESPACE}${CART}`]
      )
      expect(busy.rows[0].locked).toBe(false)
      first.res.emit("finish")
      await new Promise(r => setTimeout(r, 50))
      const free = await concurrent.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [`${CART_COMPLETE_LOCK_NAMESPACE}${CART}`]
      )
      expect(free.rows[0].locked).toBe(true)
    } finally {
      await concurrent.end()
    }
  })
})
