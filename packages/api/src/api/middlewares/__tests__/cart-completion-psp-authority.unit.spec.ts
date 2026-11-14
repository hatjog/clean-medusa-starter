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
import { Client, Pool } from "pg"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  createCartCompletionPspAuthorityMiddleware,
  defaultAcquireConnection,
  createFenceAcquirer,
  CART_COMPLETE_LOCK_NAMESPACE,
  FENCE_APPLICATION_NAME,
  PSP_AUTHORITY_FENCE_CONNECTION_LOST,
  PSP_AUTHORITY_FENCE_SATURATED,
  PSP_AUTHORITY_ORPHAN_CEILING,
  PSP_AUTHORITY_UNLOCK_FAILED,
  TRY_LOCK_SQL,
  UNLOCK_SQL,
  type PspAuthorityDeps,
} from "../cart-completion-psp-authority"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const CART = "cart_story82_fence"

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
let releases = 0

const testReadQuery = async (_scope: unknown, sql: string, params: ReadonlyArray<unknown>) =>
  (await client.query(sql, params as unknown[])).rows

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
    readQuery: testReadQuery,
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
    await seedStripeSession(CART, "pi_story82_noconn")
    const middleware = createCartCompletionPspAuthorityMiddleware({
      readQuery: testReadQuery,
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

  async function lockIsFree(cartId: string): Promise<boolean> {
    const probe = new Client({ connectionString: DATABASE_URL })
    await probe.connect()
    try {
      const r = await probe.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [`${CART_COMPLETE_LOCK_NAMESPACE}${cartId}`]
      )
      return r.rows[0].locked === true
    } finally {
      await probe.end()
    }
  }

  it("fix 1/fix 2: koszyk BEZ sesji Stripe ⇒ przepuszczony bez blokady i BEZ otwierania połączenia blokady", async () => {
    const issued: string[] = []
    let acquired = 0
    const spy = {
      query: (sql: string, params?: ReadonlyArray<unknown>) => {
        issued.push(sql)
        return client.query(sql, params as unknown[])
      },
    }
    const middleware = createCartCompletionPspAuthorityMiddleware({
      readQuery: async (_s, sql, params) => (await spy.query(sql, params)).rows,
      acquireConnection: async () => {
        acquired++
        return { client: spy as never, release: () => void releases++ }
      },
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    const res = makeRes()
    let nextCalled = false
    await middleware({ params: { id: "cart_story82_nostripe" }, scope: {} } as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(issued).not.toContain(TRY_LOCK_SQL)
    expect(acquired).toBe(0)
    expect(releases).toBe(0)
    expect(await lockIsFree("cart_story82_nostripe")).toBe(true)
  })

  it("fix 1: nieudany unlock ⇒ połączenie NISZCZONE (destroy) + nazwany log, nie zwrot do puli", async () => {
    await seedStripeSession(CART, "pi_story82_unlockfail")
    const errors: string[] = []
    const releaseCalls: Array<{ destroy?: boolean } | undefined> = []
    const failingUnlock = {
      query: (sql: string, params?: ReadonlyArray<unknown>) =>
        sql === UNLOCK_SQL
          ? Promise.reject(new Error("connection reset"))
          : client.query(sql, params as unknown[]),
    }
    const middleware = createCartCompletionPspAuthorityMiddleware({
      readQuery: testReadQuery,
      acquireConnection: async () => ({
        client: failingUnlock as never,
        release: opts => void releaseCalls.push(opts),
      }),
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    const res = makeRes()
    let nextCalled = false
    const scope = {
      resolve: (k: string) => {
        if (k === "logger") return { error: (m: string) => errors.push(m) }
        throw new Error(`unregistered ${k}`)
      },
    }
    await middleware({ params: { id: CART }, scope } as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    res.emit("finish")
    await new Promise(r => setTimeout(r, 50))
    expect(releaseCalls).toEqual([{ destroy: true }])
    expect(errors.some(m => m.startsWith(PSP_AUTHORITY_UNLOCK_FAILED))).toBe(true)
  })

  it("fix 1: zerwanie połączenia klienta ('close') NIE zwalnia blokady, dopóki handler nie domknie odpowiedzi", async () => {
    await seedStripeSession(CART, "pi_story82_close")
    const first = await run({})
    expect(first.nextCalled).toBe(true)
    first.res.emit("close")
    await new Promise(r => setTimeout(r, 50))
    expect(await lockIsFree(CART)).toBe(false)
    expect(releases).toBe(0)
    // Saga kończy się, handler woła res.json/res.end mimo zerwanego klienta.
    first.res.end()
    await new Promise(r => setTimeout(r, 50))
    expect(releases).toBe(1)
    expect(await lockIsFree(CART)).toBe(true)
  })

  it("fix 1: osierocona blokada po 'close' zwalniana po nazwanym suficie", async () => {
    await seedStripeSession(CART, "pi_story82_ceiling")
    const warns: string[] = []
    const middleware = createCartCompletionPspAuthorityMiddleware({
      readQuery: testReadQuery,
      acquireConnection: async () => ({ client: client as never, release: () => void releases++ }),
      retrievePaymentIntentStatus: async () => "succeeded",
      orphanLockCeilingMs: 100,
    })
    const res = makeRes()
    const scope = { resolve: () => ({ warn: (m: string) => warns.push(m) }) }
    await middleware({ params: { id: CART }, scope } as never, res as never, () => {})
    res.emit("close")
    await new Promise(r => setTimeout(r, 30))
    expect(releases).toBe(0)
    await new Promise(r => setTimeout(r, 200))
    expect(releases).toBe(1)
    expect(warns.some(m => m.startsWith(PSP_AUTHORITY_ORPHAN_CEILING))).toBe(true)
  })
})

describe("Story 8.2 fix 1 — blokada NIE pochodzi z puli sagi (PG_CONNECTION)", () => {
  const SCHEMA = "story82_fence_fixture"
  let admin: Client
  let sagaPool: Pool
  let fixtureUrl: string

  beforeAll(async () => {
    const u = new URL(DATABASE_URL)
    u.searchParams.set("options", `-c search_path=${SCHEMA}`)
    fixtureUrl = u.toString()
    admin = new Client({ connectionString: DATABASE_URL })
    await admin.connect()
    await admin.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}."order" (id text PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.order_cart (order_id text, cart_id text, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.cart_payment_collection (cart_id text, payment_collection_id text, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.payment_session (payment_collection_id text, provider_id text, data jsonb, deleted_at timestamptz);
      INSERT INTO ${SCHEMA}.cart_payment_collection VALUES ('cart_pool_a','paycol_a',NULL),('cart_pool_b','paycol_b',NULL);
      INSERT INTO ${SCHEMA}.payment_session VALUES
        ('paycol_a','pp_stripe_stripe','{"id":"pi_pool_a"}',NULL),
        ('paycol_b','pp_stripe_stripe','{"id":"pi_pool_b"}',NULL);
    `)
    // Pula sagi o rozmiarze 2 — odpowiednik PG_CONNECTION (Medusa: domyślnie 10).
    sagaPool = new Pool({ connectionString: fixtureUrl, max: 2 })
  })

  afterAll(async () => {
    await sagaPool?.end()
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin?.end()
  })

  it("dwa równoległe complete trzymają blokady, a saga nadal dostaje połączenie z puli rozmiaru 2", async () => {
    const knexLike = {
      raw: () => Promise.reject(new Error("not used")),
      client: {
        acquireConnection: () => sagaPool.connect(),
        releaseConnection: (c: { release: () => void }) => c.release(),
      },
    }
    const scope = {
      resolve: (k: string) => {
        if (k === ContainerRegistrationKeys.PG_CONNECTION) return knexLike
        if (k === ContainerRegistrationKeys.CONFIG_MODULE) return { projectConfig: { databaseUrl: fixtureUrl } }
        if (k === "logger") return console
        throw new Error(`unregistered ${k}`)
      },
    }
    const middleware = createCartCompletionPspAuthorityMiddleware({
      acquireConnection: defaultAcquireConnection,
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    const resA = makeRes()
    const resB = makeRes()
    const passed: string[] = []
    await Promise.all(
      (["cart_pool_a", "cart_pool_b"] as const).map((id, i) =>
        middleware({ params: { id }, scope } as never, (i === 0 ? resA : resB) as never, () => {
          passed.push(id)
        })
      )
    )
    try {
      expect(passed.sort()).toEqual(["cart_pool_a", "cart_pool_b"])
      expect(await lockIsFreeOn(admin, "cart_pool_a")).toBe(false)
      expect(await lockIsFreeOn(admin, "cart_pool_b")).toBe(false)
      // Saga (zwykłe zapytanie z puli) MUSI dostać połączenie mimo trzymanych blokad.
      const saga = sagaPool.query("SELECT 1 AS ok")
      const outcome = await Promise.race([
        saga.then(r => (r.rows[0].ok === 1 ? "saga-ok" : "saga-bad")),
        new Promise<string>(r => setTimeout(() => r("saga-starved"), 3000)),
      ])
      expect(outcome).toBe("saga-ok")
    } finally {
      resA.emit("finish")
      resB.emit("finish")
      await new Promise(r => setTimeout(r, 100))
    }
    expect(await lockIsFreeOn(admin, "cart_pool_a")).toBe(true)
    expect(await lockIsFreeOn(admin, "cart_pool_b")).toBe(true)
  })
})

describe("Story 8.2 fix 2 — zerwanie sesji blokady i sufit połączeń", () => {
  let admin: Client
  const LOST_CART = "cart_story82_lost"

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL })
    await admin.connect()
  })
  afterAll(async () => {
    await admin?.end()
  })

  function scopeWith(logs: string[]) {
    const log = (m: string) => void logs.push(m)
    return {
      resolve: (k: string) => {
        if (k === ContainerRegistrationKeys.CONFIG_MODULE) return { projectConfig: { databaseUrl: DATABASE_URL } }
        if (k === "logger") return { error: log, warn: log }
        throw new Error(`unregistered ${k}`)
      },
    }
  }

  it("realne pg_terminate_backend sesji blokady ⇒ proces żyje, nazwany log, releaseAll nie rzuca", async () => {
    await seedStripeSession(LOST_CART, "pi_story82_lost")
    const logs: string[] = []
    const acquire = createFenceAcquirer({ maxConnections: 2 })
    const middleware = createCartCompletionPspAuthorityMiddleware({
      readQuery: testReadQuery,
      acquireConnection: acquire,
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    const res = makeRes()
    let nextCalled = false
    await middleware({ params: { id: LOST_CART }, scope: scopeWith(logs) } as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(acquire.inUse()).toBe(1)
    const pids = await admin.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
      [FENCE_APPLICATION_NAME]
    )
    expect(pids.rows).toHaveLength(1)
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => void uncaught.push(e)
    process.prependListener("uncaughtException", onUncaught)
    try {
      await admin.query("SELECT pg_terminate_backend($1)", [pids.rows[0].pid])
      await new Promise(r => setTimeout(r, 300))
    } finally {
      process.removeListener("uncaughtException", onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(logs.some(m => m.startsWith(PSP_AUTHORITY_FENCE_CONNECTION_LOST))).toBe(true)
    // Blokada odeszła razem z sesją (NFR-4: nazwane, nie ciche).
    expect(await lockIsFreeOn(admin, LOST_CART)).toBe(true)
    // Handler kończy odpowiedź: releaseAll nie rzuca i zwraca slot sufitu.
    expect(() => res.end()).not.toThrow()
    res.emit("finish")
    await new Promise(r => setTimeout(r, 100))
    expect(acquire.inUse()).toBe(0)
  })

  it("przekroczenie sufitu połączeń blokady ⇒ 503 completion_fence_saturated + nazwany log", async () => {
    await seedStripeSession("cart_story82_cap_a", "pi_story82_cap_a")
    await seedStripeSession("cart_story82_cap_b", "pi_story82_cap_b")
    const logs: string[] = []
    const acquire = createFenceAcquirer({ maxConnections: 1 })
    const middleware = createCartCompletionPspAuthorityMiddleware({
      readQuery: testReadQuery,
      acquireConnection: acquire,
      retrievePaymentIntentStatus: async () => "succeeded",
    })
    const scope = scopeWith(logs)
    const resA = makeRes()
    let passedA = false
    await middleware({ params: { id: "cart_story82_cap_a" }, scope } as never, resA as never, () => {
      passedA = true
    })
    expect(passedA).toBe(true)
    const resB = makeRes()
    let passedB = false
    await middleware({ params: { id: "cart_story82_cap_b" }, scope } as never, resB as never, () => {
      passedB = true
    })
    expect(passedB).toBe(false)
    expect(resB.statusCode).toBe(503)
    expect(resB.body?.type).toBe("completion_fence_saturated")
    expect(logs.some(m => m.startsWith(PSP_AUTHORITY_FENCE_SATURATED))).toBe(true)
    resA.emit("finish")
    await new Promise(r => setTimeout(r, 100))
    expect(acquire.inUse()).toBe(0)
    const resC = makeRes()
    let passedC = false
    await middleware({ params: { id: "cart_story82_cap_b" }, scope } as never, resC as never, () => {
      passedC = true
    })
    expect(passedC).toBe(true)
    resC.emit("finish")
    await new Promise(r => setTimeout(r, 100))
  })
})

async function lockIsFreeOn(c: Client, cartId: string): Promise<boolean> {
  const key = `${CART_COMPLETE_LOCK_NAMESPACE}${cartId}`
  const r = await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key])
  if (r.rows[0].locked === true) {
    await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
    return true
  }
  return false
}
