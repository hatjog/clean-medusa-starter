/**
 * v1.16.0 Story 3.4 (FR-10, AD-33, AD-47, ADR-166, ADR-190, NFR-4, DW-15-201,
 * DW-15-318, DW-15-331) — rezerwacja transportu nie wyprzedza konsumpcji
 * biznesowej, na REALNYM PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-3-4-transport-reservation-pg`
 * Baza: izolowana `gp_story_3_4_test` (stack gp-test, port 55432); suita
 * odmawia startu na bazie bez sufiksu `_test`.
 *
 * Ścieżki są PRODUKCYJNE: route Path Y (`POST /webhooks/stripe/payment-intent`),
 * konsument Path Y (`liveIssueEntitlementsWithinTx`) i trasa natywna
 * (`StripePaymentAuditWorkflow.processMutation` = `POST /hooks/payment/stripe`
 * → `payment.captured`). Część 1 biegnie na tabelach tymczasowych w jednej
 * transakcji (kształt 1:1 z `stripe-payment-intent-owed-unit-ack-pg`); część 2
 * mierzy wspólną barierę na REALNYCH tabelach `public` pod rolą `medusa_store`.
 *
 *  AC1 porażka konsumpcji: rezerwacja natywna nie jest utrwalona (ROLLBACK
 *      całej tx), a rezerwacja Path Y przestaje blokować — stan porażki jest
 *      w ZAPISIE (`webhook_event_processed.envelope.owed_unit_settlement`).
 *  AC2 `cross-route-partial-ack-preserves-owed-unit-parity`: N=3, jedna
 *      porażka częściowa, retry drugą trasą ⇒ zbiór kluczy == zbiór skutków.
 *  AC3 quantity=2 jako kontrola ujemna kardynalności (bez nowego wsparcia).
 *  AC4 redelivery po porażce naprawia stan; odpowiedź nie jest `200 duplicate`
 *      zanim zbiory są równe; alarm niezgodności jest bramką (500 + zapis).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { createHmac } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"
import { Pool, type PoolClient } from "pg"

jest.mock("../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import {
  OWED_UNIT_RESERVATION_MISMATCH_ALARM,
  OWED_UNIT_SETTLEMENT_ENVELOPE_KEY,
  POST,
} from "../../api/webhooks/stripe/payment-intent/route"
import { STRIPE_SIGNATURE_HEADER } from "../../api/webhooks/stripe/payment-intent/helpers"
import { marketContextStorage } from "../../lib/market-context"
import {
  buildOwedUnitEffectBarrierInsert,
  OWED_UNIT_EFFECT_BARRIER_TABLE,
} from "../../lib/payment/owed-unit-effect-barrier"
import {
  buildOwedBusinessUnits,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../../lib/payment/stripe-webhook-barrier-contract"
import {
  LIVE_ISSUE_PATH,
  liveIssueEntitlementsWithinTx,
  PATH_Y_RECOVERY_PATH,
} from "../../workflows/entitlements/live-issue-from-payment-intent"
import {
  NATIVE_CAPTURED_PATH,
  StripePaymentAuditWorkflow,
} from "../../workflows/payment/stripe-payment-audit"
import { buildPathYRecoveryInput } from "../../subscribers/on-order-placed-stripe-retry"
import voucherLiveIssueSubscriber from "../../subscribers/voucher-live-issue"
import { _resetRingBuffer, getRingBuffer, injectLogger } from "../../lib/alert-emit"
import {
  OWED_UNIT_CONSUMER_FAILURE_SOURCE,
  OWED_UNIT_RECOVERY_CONSUMER_SUCCESS,
  OWED_UNIT_RECOVERY_DELIVERY_ACK,
  PATH_Y_CONSUMER_MAX_ATTEMPTS,
} from "../../lib/payment/stripe-payment-intent-transport"
import { Migration20261114140000SharedIdempotencyBarrier } from "../../migrations/Migration20261114140000SharedIdempotencyBarrier"

const INSTANCE_ID = "gp_test"
process.env.GP_INSTANCE_ID = INSTANCE_ID

const DATABASE_URL = process.env.DATABASE_URL
const enabled = !!DATABASE_URL

const SECRET = "whsec_3_4_transport_reservation"
const MARKET_ID = "bonbeauty"
const PI = "pi_3_4_partial"
const SESSION_ID = "payses_3_4_partial"
const COLLECTION_ID = "paycol_3_4_partial"
const ORDERS = ["order_3_4_a", "order_3_4_b", "order_3_4_c"] as const
const [ORDER_A, ORDER_B, ORDER_C] = ORDERS
const unit = (order: string) => `${PI}:${order}`

type FakeRes = {
  statusCode: number
  body: Record<string, unknown>
  status: (code: number) => FakeRes
  json: (body: Record<string, unknown>) => void
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    body: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
    },
  }
}

function stripeEvent(eventId: string) {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: 1_790_000_300,
    data: {
      object: {
        id: PI,
        amount: 45000,
        amount_received: 45000,
        currency: "pln",
        created: 1_790_000_300,
        metadata: { session_id: SESSION_ID },
      },
    },
  }
}

function signedHeader(rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac("sha256", SECRET)
    .update(Buffer.from(`${timestamp}.${rawBody}`))
    .digest("hex")
  return `t=${timestamp},v1=${signature}`
}

type QueuedEnvelope = {
  name: string
  data: {
    scope: { market_id: string; instance_id: string }
    payload: Parameters<typeof liveIssueEntitlementsWithinTx>[1]["payload"]
  }
}

/** Route Path Y; emit tylko kolejkuje (jak realny bus), konsumenta woła test. */
async function deliverPathY(client: PoolClient, queue: QueuedEnvelope[], eventId: string) {
  const rawBody = JSON.stringify(stripeEvent(eventId))
  const req = {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "__pg_pool__") {
          return {
            // Lustro hooka RLS: GUC ustawiany przy acquire z kontekstu ALS.
            connect: async () => {
              const ctx = marketContextStorage.getStore()
              if (ctx?.market_id && ctx.instance_id) {
                await client.query(`SELECT set_config('app.gp_market_id', $1, false)`, [ctx.market_id])
                await client.query(`SELECT set_config('app.gp_instance_id', $1, false)`, [ctx.instance_id])
              } else {
                await client.query(`RESET app.gp_market_id`)
                await client.query(`RESET app.gp_instance_id`)
              }
              return { query: client.query.bind(client), release: () => {} }
            },
          }
        }
        if (key === Modules.EVENT_BUS) {
          return { emit: async (delivery: QueuedEnvelope) => queue.push(delivery) }
        }
        throw new Error(`unresolved ${key}`)
      },
    },
  }
  const res = makeRes()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await POST(req as any, res as any)
  return res
}

/**
 * Konsument Path Y (subscriber `voucher-live-issue` ⇒ rdzeń produkcyjny) w
 * savepoincie — jak osobna tx subscribera. `failOrders` = AWARIA PRZEJŚCIOWA
 * po wystawieniu (np. utracone połączenie przed COMMIT): ROLLBACK.
 */
async function consumePathY(
  client: PoolClient,
  queue: QueuedEnvelope[],
  failOrders: string[] = []
): Promise<void> {
  for (const delivery of queue.splice(0)) {
    await client.query("SAVEPOINT story_3_4_consumer")
    try {
      await liveIssueEntitlementsWithinTx(
        client,
        { event_type: delivery.name, scope: delivery.data.scope, payload: delivery.data.payload },
        new Date("2026-11-15T12:00:00.000Z")
      )
      if (failOrders.includes(delivery.data.payload.order_id as string)) {
        throw new Error("awaria przejściowa konsumenta przed COMMIT")
      }
      await client.query("RELEASE SAVEPOINT story_3_4_consumer")
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT story_3_4_consumer")
    }
  }
}

/**
 * Konsument Path Y przez PRODUKCYJNY subscriber `voucher-live-issue` (fix
 * checkpointu PO): tx subscribera (BEGIN/COMMIT/ROLLBACK) mapowana na savepoint;
 * `failCommitFor` = awaria przejściowa przed COMMIT dla kopert tych zamówień.
 * Porażka jest rzucana dalej (jak do busa), test ją tylko zbiera.
 */
async function consumeViaSubscriber(
  client: PoolClient,
  queue: QueuedEnvelope[],
  failCommitFor: string[] = []
): Promise<string[]> {
  const failures: string[] = []
  for (const delivery of queue.splice(0)) {
    const orderId = delivery.data.payload.order_id as string
    const wrapped = {
      query: async (sql: string, values?: ReadonlyArray<unknown>) => {
        const text = sql.trim()
        if (text === "BEGIN") return client.query("SAVEPOINT story_3_4_subscriber_tx")
        if (text === "COMMIT") {
          if (failCommitFor.includes(orderId)) throw new Error("awaria przejściowa konsumenta przed COMMIT")
          return client.query("RELEASE SAVEPOINT story_3_4_subscriber_tx")
        }
        if (text === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT story_3_4_subscriber_tx")
        return client.query(sql, values as unknown[])
      },
      release: () => {},
    }
    const container = {
      resolve: (key: string) => {
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "__pg_pool__") return { connect: async () => wrapped }
        if (key === Modules.EVENT_BUS) return { emit: async () => undefined }
        throw new Error(`unresolved ${key}`)
      },
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await voucherLiveIssueSubscriber({ event: { name: delivery.name, data: delivery.data }, container } as any)
    } catch {
      failures.push(orderId)
    }
  }
  return failures
}

/**
 * Trasa natywna: `StripePaymentAuditWorkflow` na „puli”, której klient mapuje
 * BEGIN/COMMIT/ROLLBACK na savepoint (cała suita biegnie w jednej tx, bo
 * fixture to tabele tymczasowe `ON COMMIT DROP`). `failOn` = wstrzyknięta
 * awaria SQL (np. na `INSERT INTO voucher`).
 */
async function deliverNative(
  client: PoolClient,
  input: { event_id: string; order_id: string; failOn?: RegExp }
) {
  const wrapped = {
    query: async (sql: string, values?: ReadonlyArray<unknown>) => {
      const text = sql.trim()
      if (text === "BEGIN") return client.query("SAVEPOINT story_3_4_native_tx")
      if (text === "COMMIT") return client.query("RELEASE SAVEPOINT story_3_4_native_tx")
      if (text === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT story_3_4_native_tx")
      if (input.failOn?.test(text)) throw new Error("awaria przejściowa trasy natywnej")
      return client.query(sql, values as unknown[])
    },
    release: () => {},
  }
  const workflow = new StripePaymentAuditWorkflow(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { connect: async () => wrapped } as any,
    undefined,
    { info() {}, warn() {}, error() {} }
  )
  return workflow.processMutation("payment.captured", {
    event_id: input.event_id,
    request_id: `req_${input.event_id}`,
    payment_intent_id: PI,
    payment_id: `pay_${input.event_id}`,
    payment_method_type: "card",
    processing_country: "PL",
    order_id: input.order_id,
    market_id: MARKET_ID,
    currency: "PLN",
    amount_minor: 15000,
  })
}

async function state(client: PoolClient) {
  const barrier = await client.query<{ owed_business_unit_key: string; claimed_by_path: string }>(
    `SELECT owed_business_unit_key, claimed_by_path FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE}
      WHERE payment_intent_id = $1 ORDER BY owed_business_unit_key`,
    [PI]
  )
  const effects = await client.query<{ order_id: string; n: string }>(
    `SELECT order_id, count(*)::text AS n FROM entitlement_instance GROUP BY order_id ORDER BY order_id`
  )
  const reservations = await client.query<{ event_id: string; provider: string; envelope: Record<string, unknown> }>(
    `SELECT event_id, provider, envelope FROM webhook_event_processed ORDER BY event_id, provider`
  )
  return {
    barrier: barrier.rows.map((r) => r.owed_business_unit_key),
    claimedBy: Object.fromEntries(barrier.rows.map((r) => [r.owed_business_unit_key, r.claimed_by_path])),
    effectsPerOrder: Object.fromEntries(effects.rows.map((r) => [r.order_id, Number(r.n)])),
    effectUnits: effects.rows.map((r) => unit(r.order_id)).sort(),
    reservations: reservations.rows,
  }
}

const TEMP_TABLES = [
  `CREATE TEMP TABLE payment_session (id text PRIMARY KEY, payment_collection_id text NOT NULL, data jsonb,
     deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE order_payment_collection (order_id text NOT NULL, payment_collection_id text NOT NULL,
     deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE sales_channel (id text PRIMARY KEY, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE "order" (id text PRIMARY KEY, sales_channel_id text, metadata jsonb,
     deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE order_line_item (id text PRIMARY KEY, product_id text, unit_price numeric NOT NULL,
     title text, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE product (id text PRIMARY KEY, title text, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE product_product_seller_seller (product_id text NOT NULL, seller_id text NOT NULL,
     deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE seller (id text PRIMARY KEY, name text NOT NULL, handle text NOT NULL, status text,
     deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE voucher (code text PRIMARY KEY, market_id text, seller_id text NOT NULL,
     seller_name text NOT NULL, seller_handle text NOT NULL, product_title text NOT NULL,
     value_minor integer NOT NULL, currency_code text NOT NULL, status text NOT NULL,
     expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL) ON COMMIT DROP`,
  `CREATE TEMP TABLE order_item (order_id text NOT NULL, item_id text NOT NULL, quantity numeric NOT NULL DEFAULT 1,
     created_at timestamptz NOT NULL, deleted_at timestamptz) ON COMMIT DROP`,
  `CREATE TEMP TABLE webhook_event_processed (event_id text NOT NULL, provider text NOT NULL, market_id text,
     envelope jsonb NOT NULL, received_at timestamptz NOT NULL, PRIMARY KEY (event_id, provider)) ON COMMIT DROP`,
  `CREATE TEMP TABLE money_path_compensation_failure (failure_id text PRIMARY KEY, market_id text NOT NULL,
     compensation_kind text NOT NULL, delivery_path text NOT NULL, stripe_event_id text NOT NULL,
     payment_intent_id text NOT NULL, order_id text, purchase_correlation_key text NOT NULL,
     failure_code text NOT NULL, failure_detail text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
     attempt_count integer NOT NULL DEFAULT 1, last_attempt_at timestamptz NOT NULL DEFAULT now(),
     resolution_state text NOT NULL DEFAULT 'open', instance_id text, owner_type text, owner_id text,
     deadline timestamptz, closure_path text, provenance_kind text, provenance_source text,
     resolved_at timestamptz, resolved_by text) ON COMMIT DROP`,
  `CREATE TEMP TABLE money_path_compensation_failure_backfill_quarantine (source_failure_id text PRIMARY KEY,
     source_row jsonb NOT NULL, reason text NOT NULL, quarantined_at timestamptz NOT NULL DEFAULT now(),
     market_id text NOT NULL, instance_id text NOT NULL, instance_id_source text NOT NULL,
     backfill_state text NOT NULL, owner_type text NOT NULL, owner_id text NOT NULL,
     deadline timestamptz NOT NULL, closed_at timestamptz, closed_by text, closure_evidence jsonb) ON COMMIT DROP`,
  `CREATE TEMP TABLE event_processed (external_id text NOT NULL, event_type text NOT NULL,
     processed_at bigint NOT NULL, purchase_key text, market_id text, instance_id text,
     PRIMARY KEY (external_id, event_type)) ON COMMIT DROP`,
  // Lustro Migration20261114140000SharedIdempotencyBarrier (klucz bez event_type i bez provider).
  `CREATE TEMP TABLE owed_unit_effect_barrier (owed_business_unit_key text PRIMARY KEY,
     payment_intent_id text NOT NULL, order_id text NOT NULL, instance_id text NOT NULL,
     market_id text NOT NULL, claimed_by_path text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now(),
     CHECK (owed_business_unit_key = payment_intent_id || ':' || order_id)) ON COMMIT DROP`,
  // Kolumny pisane tylko przez Path Y (ISSUED) są tu NULL-owalne, bo trasa
  // natywna (ACTIVE) ich nie podaje — obie trasy piszą do TEJ SAMEJ tabeli.
  `CREATE TEMP TABLE entitlement_instance (id text PRIMARY KEY, entitlement_profile_id text NOT NULL,
     entitlement_type text NOT NULL, order_id text NOT NULL, line_item_id text, state text NOT NULL,
     policy_snapshot jsonb NOT NULL, market_id text, sales_channel_id text, vat_classification text,
     reference_price_minor integer, entitlement_dedupe_key text UNIQUE, recipient_index integer,
     recipient_customer_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
     claim_token text, expires_at timestamptz, UNIQUE (order_id, line_item_id)) ON COMMIT DROP`,
  `CREATE TEMP TABLE entitlement_choice_set_item (id text PRIMARY KEY, instance_id text NOT NULL,
     market_id text NOT NULL, label text, reference_amount_minor integer NOT NULL,
     remaining_minor integer NOT NULL, vat_classification text NOT NULL, status text NOT NULL,
     redemption_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL) ON COMMIT DROP`,
]

async function seed(client: PoolClient, quantities: Record<string, number>): Promise<void> {
  for (const sql of TEMP_TABLES) await client.query(sql)
  const orders = Object.keys(quantities)
  await client.query(`INSERT INTO payment_session (id, payment_collection_id, data) VALUES ($1, $2, $3::jsonb)`, [
    SESSION_ID,
    COLLECTION_ID,
    JSON.stringify({ id: PI }),
  ])
  const profile = {
    profile_id: "voucher-rezerwacja-otwarta",
    entitlement_type: "VOUCHER_SERVICE",
    currency: "PLN",
    policy: { validity_months: 12, vat_rate_uniqueness: true },
  }
  const productMetadata = JSON.stringify({ gp: { entitlement_profile: profile } })
  const lineMetadata = JSON.stringify({ entitlement_profile: profile })
  for (const [i, order] of orders.entries()) {
    const suffix = String.fromCharCode(97 + i)
    await client.query(`INSERT INTO sales_channel (id, metadata) VALUES ($1, $2::jsonb)`, [
      `sc_3_4_${suffix}`,
      JSON.stringify({ gp_market_id: MARKET_ID }),
    ])
    await client.query(`INSERT INTO "order" (id, sales_channel_id, metadata) VALUES ($1, $2, NULL)`, [
      order,
      `sc_3_4_${suffix}`,
    ])
    await client.query(`INSERT INTO order_payment_collection (order_id, payment_collection_id) VALUES ($1, $2)`, [
      order,
      COLLECTION_ID,
    ])
    await client.query(`INSERT INTO product (id, title, metadata) VALUES ($1, $2, $3::jsonb)`, [
      `prod_3_4_${suffix}`,
      `Voucher Salon 3.4 ${suffix}`,
      productMetadata,
    ])
    await client.query(`INSERT INTO seller (id, name, handle, status) VALUES ($1, $2, $3, 'open')`, [
      `sel_3_4_${suffix}`,
      `Salon 3.4 ${suffix}`,
      `salon-3-4-${suffix}`,
    ])
    await client.query(`INSERT INTO product_product_seller_seller (product_id, seller_id) VALUES ($1, $2)`, [
      `prod_3_4_${suffix}`,
      `sel_3_4_${suffix}`,
    ])
    await client.query(
      // Profil także w metadanych LINII: trasa natywna czyta go wyłącznie stąd
      // (`extractProfileFromMetadata`), Path Y — z linii albo produktu.
      `INSERT INTO order_line_item (id, product_id, unit_price, title, metadata) VALUES ($1, $2, 15000, $3, $4::jsonb)`,
      [`li_3_4_${suffix}`, `prod_3_4_${suffix}`, `Voucher Salon 3.4 ${suffix}`, lineMetadata]
    )
    await client.query(`INSERT INTO order_item (order_id, item_id, quantity, created_at) VALUES ($1, $2, $3, NOW())`, [
      order,
      `li_3_4_${suffix}`,
      quantities[order],
    ])
  }
}

const describeOrNotRun = enabled ? describe : describe.skip

if (!enabled) {
  describe("Story 3.4 — rezerwacja transportu nie wyprzedza konsumpcji (PostgreSQL)", () => {
    it("NOT_RUN: wymaga DATABASE_URL izolowanej bazy *_test", () => {
      console.warn("[NOT_RUN] Story 3.4: ustaw DATABASE_URL na gp_story_3_4_test")
    })
  })
}

describeOrNotRun("Story 3.4 — rezerwacja transportu nie wyprzedza konsumpcji (PostgreSQL)", () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    process.env.GP_INSTANCE_ID = INSTANCE_ID
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 })
    client = await pool.connect()
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 3.4 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
  })

  afterAll(async () => {
    await client?.query("ROLLBACK").catch(() => undefined)
    client?.release()
    await pool?.end()
  })

  describe("część 1 — trasy produkcyjne na tabelach tymczasowych", () => {
    beforeEach(async () => {
      await client.query("ROLLBACK").catch(() => undefined)
      await client.query("BEGIN")
    })

    it("AC1: porażka konsumpcji natywnej ⇒ rezerwacja transportu NIE jest utrwalona (ani bariera, ani skutek)", async () => {
      await seed(client, { [ORDER_A]: 1 })
      await expect(
        deliverNative(client, { event_id: "evt_3_4_native_fail", order_id: ORDER_A, failOn: /^INSERT INTO voucher/ })
      ).rejects.toThrow(/awaria przejściowa/)
      const after = await state(client)
      expect(after.reservations).toEqual([])
      expect(after.barrier).toEqual([])
      expect(after.effectsPerOrder).toEqual({})
      // ponowienie tej samej dostawy ⇒ naprawa (rezerwacja nie blokuje)
      const retry = await deliverNative(client, { event_id: "evt_3_4_native_fail", order_id: ORDER_A })
      expect(retry.deduplicated).toBe(false)
      const repaired = await state(client)
      expect(repaired.barrier).toEqual([unit(ORDER_A)])
      expect(repaired.claimedBy[unit(ORDER_A)]).toBe(NATIVE_CAPTURED_PATH)
      expect(repaired.effectsPerOrder).toEqual({ [ORDER_A]: 1 })
    })

    it("AC1+AC4: porażka konsumenta Path Y ⇒ stan porażki w ZAPISIE rezerwacji; redelivery naprawia, nie '200 duplicate'", async () => {
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const queue: QueuedEnvelope[] = []
      const first = await deliverPathY(client, queue, "evt_3_4_redelivery")
      expect(first.statusCode).toBe(200)
      expect(queue).toHaveLength(3)
      await consumePathY(client, queue, [ORDER_C])

      const failed = await state(client)
      expect(failed.barrier).toEqual([unit(ORDER_A), unit(ORDER_B)])
      expect(failed.reservations.map((r) => r.provider)).toEqual([STRIPE_PATH_Y_WEBHOOK_PROVIDER])
      // Ten przypadek woła rdzeń konsumenta wprost (bez subscribera), więc stempla
      // porażki konsumenta tu nie ma — ścieżkę subscribera mierzy test
      // „pierwsza dostawa 200, konsument pada, BEZ redelivery” niżej.
      expect(failed.reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toBeUndefined()

      // Redelivery: bramka (500 + alarm utrwalony) i naprawa (emisja WYŁĄCZNIE C).
      const retry = await deliverPathY(client, queue, "evt_3_4_redelivery")
      expect(retry.statusCode).toBe(500)
      expect(retry.body.duplicate).toBeUndefined()
      expect(retry.body).toMatchObject({
        type: "owed_unit_ack_incomplete",
        verdict: "FAIL",
        missing_units: [unit(ORDER_C)],
        alarm: OWED_UNIT_RESERVATION_MISMATCH_ALARM,
        alarm_persisted: true,
        repair_dispatched_units: [unit(ORDER_C)],
      })
      expect(queue.map((d) => d.data.payload.order_id)).toEqual([ORDER_C])
      const stamped = (await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]
      expect(stamped).toMatchObject({
        state: "unsettled",
        alarm: OWED_UNIT_RESERVATION_MISMATCH_ALARM,
        missing_units: [unit(ORDER_C)],
        repair_attempts: 1,
      })

      // Konsument przetwarza kopertę naprawy ⇒ stan naprawiony; dopiero teraz 200.
      await consumePathY(client, queue)
      const repaired = await state(client)
      expect(repaired.barrier).toEqual(ORDERS.map(unit))
      expect(repaired.effectsPerOrder).toEqual({ [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const ack = await deliverPathY(client, queue, "evt_3_4_redelivery")
      expect(ack.statusCode).toBe(200)
      expect(queue).toHaveLength(0)
      // Runda fix 2 (R-9): gałąź PASS zdejmuje stempel route'u, ślad prób zostaje.
      expect((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "settled",
        missing_units: [],
        recovered_units: [unit(ORDER_C)],
        recovered_by: OWED_UNIT_RECOVERY_DELIVERY_ACK,
        repair_attempts: 1,
      })
    })

    it("AC1 (fix checkpointu): pierwsza dostawa 200, konsument pada, BEZ redelivery ⇒ rezerwacja ostemplowana 'unsettled' + alarm", async () => {
      injectLogger({ info() {}, warn() {}, error() {} })
      _resetRingBuffer()
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const queue: QueuedEnvelope[] = []
      const first = await deliverPathY(client, queue, "evt_3_4_no_redelivery")
      expect(first.statusCode).toBe(200)
      expect(queue).toHaveLength(3)

      // Realny konsument; Stripe po 200 NIE ponawia — żadnej drugiej dostawy.
      expect(await consumeViaSubscriber(client, queue, [ORDER_C])).toEqual([ORDER_C])

      const after = await state(client)
      expect(after.barrier).toEqual([unit(ORDER_A), unit(ORDER_B)])
      expect(after.reservations).toHaveLength(1)
      // Rezerwacja NIE świadczy „przyjęte” — stan porażki jest w ZAPISIE.
      expect(after.reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "unsettled",
        alarm: OWED_UNIT_RESERVATION_MISMATCH_ALARM,
        source: OWED_UNIT_CONSUMER_FAILURE_SOURCE,
        consumer_failed_units: [unit(ORDER_C)],
        consumer_failure_attempts: 1,
        last_consumer_error: "Error",
      })
      const alarms = getRingBuffer().filter((a) => a.code === OWED_UNIT_RESERVATION_MISMATCH_ALARM)
      expect(alarms).toHaveLength(1)
      // Runda fix 2 (R-11): próba 1 z 5 jest przejściowa ⇒ WARN, nie CRITICAL.
      expect(alarms[0]).toMatchObject({
        severity: "WARN",
        context: {
          stripe_event_id: "evt_3_4_no_redelivery",
          owed_unit: unit(ORDER_C),
          stamp_persisted: true,
          unit_attempt: 1,
          final: false,
        },
      })

      // Kolejna próba busa (attempts:5) pada znowu ⇒ licznik rośnie, zbiór bez duplikatu.
      const retryEnvelope = (after.reservations[0].envelope as { envelopes: QueuedEnvelope["data"][] }).envelopes
        .find((e) => e.payload.order_id === ORDER_C)
      expect(retryEnvelope).toBeDefined()
      queue.push({ name: "gp.stripe.payment_intent_succeeded.v1", data: retryEnvelope as QueuedEnvelope["data"] })
      expect(await consumeViaSubscriber(client, queue, [ORDER_C])).toEqual([ORDER_C])
      expect((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        consumer_failed_units: [unit(ORDER_C)],
        consumer_failure_attempts: 2,
      })

      // Trasa natywna rozlicza jednostkę bez podwójnego skutku (bariera 3.3);
      // potem dostawa (resend) dostaje ACK, bo zbiory są równe.
      const nativeC = await deliverNative(client, { event_id: "evt_3_4_no_redelivery_native_c", order_id: ORDER_C })
      expect(nativeC.entitlements_all).toHaveLength(1)
      expect((await state(client)).effectsPerOrder).toEqual({ [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const resend = await deliverPathY(client, queue, "evt_3_4_no_redelivery")
      expect(resend.statusCode).toBe(200)
      expect(queue).toHaveLength(0)
      expect((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "settled",
        consumer_failed_units: [],
        consumer_failure_attempts: 2,
        recovered_by: OWED_UNIT_RECOVERY_DELIVERY_ACK,
      })
    })

    const retryEnvelopeFor = async (orderId: string): Promise<QueuedEnvelope> => {
      const envelope = ((await state(client)).reservations[0].envelope as { envelopes: QueuedEnvelope["data"][] })
        .envelopes.find((e) => e.payload.order_id === orderId)
      expect(envelope).toBeDefined()
      return { name: "gp.stripe.payment_intent_succeeded.v1", data: envelope as QueuedEnvelope["data"] }
    }

    it("R-9 (runda fix 2): próba 1 pada, próba 2 busa się udaje ⇒ stempel 'settled' + ślad prób, zero CRITICAL", async () => {
      injectLogger({ info() {}, warn() {}, error() {} })
      _resetRingBuffer()
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const queue: QueuedEnvelope[] = []
      expect((await deliverPathY(client, queue, "evt_3_4_self_heal")).statusCode).toBe(200)
      expect(await consumeViaSubscriber(client, queue, [ORDER_C])).toEqual([ORDER_C])
      expect((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "unsettled",
        consumer_failed_units: [unit(ORDER_C)],
      })

      // Druga próba busa TEJ SAMEJ koperty — bez awarii.
      queue.push(await retryEnvelopeFor(ORDER_C))
      expect(await consumeViaSubscriber(client, queue)).toEqual([])

      const after = await state(client)
      expect(after.barrier).toEqual(ORDERS.map(unit))
      const stamp = after.reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY] as Record<string, unknown>
      expect(stamp.state).not.toBe("unsettled")
      expect(stamp).toMatchObject({
        state: "settled",
        consumer_failed_units: [],
        consumer_unit_attempts: {},
        recovered_units: [unit(ORDER_C)],
        recovered_by: OWED_UNIT_RECOVERY_CONSUMER_SUCCESS,
        // Ślad prób zostaje — samonaprawa jest odróżnialna od dostawy bez porażki.
        consumer_failure_attempts: 1,
        last_consumer_error: "Error",
        source: OWED_UNIT_CONSUMER_FAILURE_SOURCE,
      })
      expect(typeof stamp.consumer_recovered_at).toBe("string")
      expect(typeof stamp.consumer_failed_at).toBe("string")
      const alarms = getRingBuffer().filter((a) => a.code === OWED_UNIT_RESERVATION_MISMATCH_ALARM)
      expect(alarms.map((a) => a.severity)).toEqual(["WARN"])
      // Resend po samonaprawie: 200 i stempel dalej 'settled'.
      expect((await deliverPathY(client, queue, "evt_3_4_self_heal")).statusCode).toBe(200)
      expect(((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY] as { state: string }).state)
        .toBe("settled")
    })

    it("R-9/R-11 (runda fix 2): porażka bez sukcesu ⇒ 'unsettled' zostaje; CRITICAL dopiero przy próbie ostatecznej", async () => {
      injectLogger({ info() {}, warn() {}, error() {} })
      _resetRingBuffer()
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const queue: QueuedEnvelope[] = []
      expect((await deliverPathY(client, queue, "evt_3_4_exhausted")).statusCode).toBe(200)
      expect(await consumeViaSubscriber(client, queue, [ORDER_C])).toEqual([ORDER_C])
      for (let attempt = 2; attempt <= PATH_Y_CONSUMER_MAX_ATTEMPTS; attempt += 1) {
        queue.push(await retryEnvelopeFor(ORDER_C))
        expect(await consumeViaSubscriber(client, queue, [ORDER_C])).toEqual([ORDER_C])
      }
      const after = await state(client)
      expect(after.barrier).toEqual([unit(ORDER_A), unit(ORDER_B)])
      expect(after.reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "unsettled",
        consumer_failed_units: [unit(ORDER_C)],
        consumer_failure_attempts: PATH_Y_CONSUMER_MAX_ATTEMPTS,
        consumer_unit_attempts: { [unit(ORDER_C)]: PATH_Y_CONSUMER_MAX_ATTEMPTS },
      })
      const alarms = getRingBuffer().filter((a) => a.code === OWED_UNIT_RESERVATION_MISMATCH_ALARM)
      expect(alarms.map((a) => a.severity)).toEqual([
        ...Array(PATH_Y_CONSUMER_MAX_ATTEMPTS - 1).fill("WARN"),
        "CRITICAL",
      ])
      expect(alarms[alarms.length - 1].context).toMatchObject({ final: true, unit_attempt: PATH_Y_CONSUMER_MAX_ATTEMPTS })
    })

    it("R-12 (runda fix 2): porażka przed głównym try (brak GP_INSTANCE_ID) też stempluje rezerwację", async () => {
      injectLogger({ info() {}, warn() {}, error() {} })
      _resetRingBuffer()
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const queue: QueuedEnvelope[] = []
      expect((await deliverPathY(client, queue, "evt_3_4_early_failure")).statusCode).toBe(200)
      const saved = process.env.GP_INSTANCE_ID
      let failures: string[]
      try {
        delete process.env.GP_INSTANCE_ID
        failures = await consumeViaSubscriber(client, queue)
      } finally {
        process.env.GP_INSTANCE_ID = saved
      }
      expect(failures.sort()).toEqual([...ORDERS].sort())
      expect((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "unsettled",
        source: OWED_UNIT_CONSUMER_FAILURE_SOURCE,
        consumer_failed_units: ORDERS.map(unit),
      })
    })

    it("R-12 (runda fix 2): koperta odrzucona przez toLiveIssueInput (z causation i id) też stempluje rezerwację", async () => {
      injectLogger({ info() {}, warn() {}, error() {} })
      _resetRingBuffer()
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const queue: QueuedEnvelope[] = []
      expect((await deliverPathY(client, queue, "evt_3_4_invalid_envelope")).statusCode).toBe(200)
      const broken = queue.filter((d) => d.data.payload.order_id === ORDER_B)
      queue.splice(0)
      const data = { ...broken[0].data, payload: { ...broken[0].data.payload, currency: undefined } }
      queue.push({ name: broken[0].name, data: data as unknown as QueuedEnvelope["data"] })
      expect(await consumeViaSubscriber(client, queue)).toEqual([ORDER_B])
      expect((await state(client)).reservations[0].envelope[OWED_UNIT_SETTLEMENT_ENVELOPE_KEY]).toMatchObject({
        state: "unsettled",
        consumer_failed_units: [unit(ORDER_B)],
      })
    })

    it("cross-route-partial-ack-preserves-owed-unit-parity", async () => {
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      const owed = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [...ORDERS] })
      const queue: QueuedEnvelope[] = []

      // Trasa 1 (Path Y): N=3 należne, jedna porażka częściowa (C) ⇒ częściowy ACK.
      expect((await deliverPathY(client, queue, "evt_3_4_cross")).statusCode).toBe(200)
      await consumePathY(client, queue, [ORDER_C])
      expect((await state(client)).barrier).toEqual([unit(ORDER_A), unit(ORDER_B)])

      // ACK sukcesu nie wyprzedza równości zbiorów.
      const early = await deliverPathY(client, queue, "evt_3_4_cross")
      expect(early.statusCode).toBe(500)
      expect(early.body.missing_units).toEqual([unit(ORDER_C)])
      const lostRepair = queue.splice(0) // bus gubi kopertę naprawy

      // Retry DRUGĄ trasą (natywna `payment.captured`): A już rozliczona ⇒ no-op,
      // C nierozliczona ⇒ skutek.
      const nativeA = await deliverNative(client, { event_id: "evt_3_4_native_a", order_id: ORDER_A })
      expect(nativeA.envelope.owed_unit_already_settled).toBe(unit(ORDER_A))
      expect(nativeA.entitlements_all).toBeUndefined()
      const nativeC = await deliverNative(client, { event_id: "evt_3_4_native_c", order_id: ORDER_C })
      expect(nativeC.entitlements_all).toHaveLength(1)

      // Spóźniona koperta naprawy Path Y dla C ⇒ no-op (bariera), bez duplikatu.
      queue.push(...lostRepair)
      await consumePathY(client, queue)

      const final = await state(client)
      expect(final.barrier).toEqual(owed)
      expect(final.effectUnits).toEqual(owed)
      expect(final.effectsPerOrder).toEqual({ [ORDER_A]: 1, [ORDER_B]: 1, [ORDER_C]: 1 })
      expect(final.claimedBy).toEqual({
        [unit(ORDER_A)]: LIVE_ISSUE_PATH,
        [unit(ORDER_B)]: LIVE_ISSUE_PATH,
        [unit(ORDER_C)]: NATIVE_CAPTURED_PATH,
      })

      // Dopiero przy równości zbiorów (bariera czytana przez route — R-4) ACK 200.
      const ack = await deliverPathY(client, queue, "evt_3_4_cross")
      expect(ack.statusCode).toBe(200)
      expect(ack.body.duplicate).toBe(true)
      expect(queue).toHaveLength(0)
    })

    it("AC3: quantity=2 — para dwóch należnych jednostek, kontrola ujemna na obu trasach (bez nowego wsparcia ilości)", async () => {
      await seed(client, { [ORDER_A]: 1, [ORDER_B]: 2 })
      const owed = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })
      expect(owed).toEqual([unit(ORDER_A), unit(ORDER_B)])
      const queue: QueuedEnvelope[] = []
      expect((await deliverPathY(client, queue, "evt_3_4_qty2")).statusCode).toBe(200)
      expect(queue).toHaveLength(2) // kardynalność kopert = liczba jednostek, nie sztuk
      await consumePathY(client, queue) // B: fail-loud quantity_per_line_unsupported ⇒ ROLLBACK

      const retry = await deliverPathY(client, queue, "evt_3_4_qty2")
      expect(retry.statusCode).toBe(500)
      expect(retry.body.missing_units).toEqual([unit(ORDER_B)])
      queue.splice(0)

      // Trasa natywna dla B: nazwana odmowa cofa rezerwację jednostki (savepoint).
      const native = await deliverNative(client, { event_id: "evt_3_4_qty2_native", order_id: ORDER_B })
      expect(native.envelope.entitlement_issue_blocked_reason).toBe("quantity_per_line_unsupported")
      const after = await state(client)
      expect(after.barrier).toEqual([unit(ORDER_A)])
      expect(after.effectsPerOrder).toEqual({ [ORDER_A]: 1 })
      const nativeRow = after.reservations.find((r) => r.event_id === "evt_3_4_qty2_native")
      expect(nativeRow?.envelope.entitlement_issue_blocked_reason).toBe("quantity_per_line_unsupported")

      // ACK nadal zabroniony: B nie jest rozliczone żadną trasą.
      const still = await deliverPathY(client, queue, "evt_3_4_qty2")
      expect(still.statusCode).toBe(500)
      expect(still.body.missing_units).toEqual([unit(ORDER_B)])
    })

    it("DW-15-331 p.3: odzysk Path Y zapisuje w barierze własną ścieżkę (claimed_by_path), nie LIVE_ISSUE_PATH", async () => {
      await seed(client, { [ORDER_A]: 1 })
      const input = buildPathYRecoveryInput(
        {
          event_id: "evt_3_4_recovery#deferred-issuance",
          provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
          market_id: MARKET_ID,
          payment_intent_id: PI,
          envelope: { psp_occurred_at: "2026-11-15T10:00:00.000Z" },
          amount_minor: "15000",
          currency: "PLN",
          payment_id: null,
        },
        ORDER_A
      )
      expect(input.claimed_by_path).toBe(PATH_Y_RECOVERY_PATH)
      await liveIssueEntitlementsWithinTx(client, input, new Date("2026-11-15T12:00:00.000Z"))
      expect((await state(client)).claimedBy).toEqual({ [unit(ORDER_A)]: PATH_Y_RECOVERY_PATH })
    })
  })

  describe("część 2 — wspólna bariera na realnych tabelach pod rolą medusa_store (DW-15-331 p.2)", () => {
    const RLS_PI = "pi_3_4_rls"
    const scope = { instance_id: INSTANCE_ID, market_id: MARKET_ID }

    function insertFor(order: string, path: string) {
      const key = `${RLS_PI}:${order}`
      return buildOwedUnitEffectBarrierInsert(
        { external_id: key, event_type: "payment.captured", processed_at: Date.now(), purchase_key: RLS_PI, ...scope },
        { owed_business_unit_key: key, payment_intent_id: RLS_PI, order_id: order, ...scope, claimed_by_path: path }
      )
    }

    beforeAll(async () => {
      await client.query("ROLLBACK").catch(() => undefined)
      // Migracja 3.3 zastosowana w bazie story (idempotentny `up()`).
      const statements: string[] = []
      const migration = Object.create(Migration20261114140000SharedIdempotencyBarrier.prototype) as {
        addSql: (sql: string) => void
        up: () => Promise<void>
      }
      migration.addSql = (sql: string) => statements.push(sql)
      await migration.up()
      for (const sql of statements) await client.query(sql)
    })

    beforeEach(async () => {
      await client.query("ROLLBACK").catch(() => undefined)
      await client.query(`DELETE FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1`, [RLS_PI])
      await client.query("DELETE FROM event_processed WHERE purchase_key = $1", [RLS_PI])
    })

    afterAll(async () => {
      await client.query("ROLLBACK").catch(() => undefined)
      await client.query(`DELETE FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1`, [RLS_PI])
      await client.query("DELETE FROM event_processed WHERE purchase_key = $1", [RLS_PI])
    })

    it("CTE bariery pod SET LOCAL ROLE medusa_store z kontekstem rynku i instancji: rowCount=1, potem 0 (druga trasa)", async () => {
      await client.query("BEGIN")
      try {
        await client.query("SET LOCAL ROLE medusa_store")
        await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [scope.instance_id])
        await client.query("SELECT set_config('app.gp_market_id', $1, true)", [scope.market_id])
        const first = insertFor("order_rls_a", NATIVE_CAPTURED_PATH)
        expect((await client.query(first.sql, first.params)).rowCount).toBe(1)
        const second = insertFor("order_rls_a", LIVE_ISSUE_PATH)
        expect((await client.query(second.sql, second.params)).rowCount).toBe(0)
        const visible = await client.query<{ claimed_by_path: string }>(
          `SELECT claimed_by_path FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1`,
          [RLS_PI]
        )
        expect(visible.rows).toEqual([{ claimed_by_path: NATIVE_CAPTURED_PATH }])
        await client.query("COMMIT")
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      }
      const markers = await client.query("SELECT event_type FROM event_processed WHERE purchase_key = $1", [RLS_PI])
      expect(markers.rows).toEqual([{ event_type: "payment.captured" }])
    })

    it("pod medusa_store obcy rynek NIE widzi jednostki i nie może jej zarezerwować (WITH CHECK)", async () => {
      const seedInsert = insertFor("order_rls_b", NATIVE_CAPTURED_PATH)
      await client.query(seedInsert.sql, seedInsert.params)
      await client.query("BEGIN")
      try {
        await client.query("SET LOCAL ROLE medusa_store")
        await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [scope.instance_id])
        await client.query("SELECT set_config('app.gp_market_id', $1, true)", ["mercur"])
        const seen = await client.query(
          `SELECT 1 FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1`,
          [RLS_PI]
        )
        expect(seen.rows).toEqual([])
        const foreign = insertFor("order_rls_c", NATIVE_CAPTURED_PATH)
        await expect(client.query(foreign.sql, foreign.params)).rejects.toThrow(/row-level security/)
      } finally {
        await client.query("ROLLBACK")
      }
    })
  })
})
