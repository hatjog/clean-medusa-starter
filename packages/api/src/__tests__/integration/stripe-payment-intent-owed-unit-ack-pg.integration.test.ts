/**
 * stripe-payment-intent-owed-unit-ack-pg.integration.test.ts — Story 3.1 AC3
 * (v1.16.0, Epic 3; AD-47, ADR-166, ADR-190) na REALNYM PostgreSQL.
 *
 * Scenariusz „częściowy ACK" na prawdziwej ścieżce (route Path Y + konsument
 * `liveIssueEntitlementsWithinTx` + prawdziwe SQL na tabelach tymczasowych):
 *   1. dostawa 1 dla PI z DWOMA zamówieniami ⇒ 200, dwie koperty w kolejce;
 *   2. konsument rozlicza TYLKO zamówienie A (B ginie) ⇒ w `event_processed`
 *      jest jedna jednostka; kontrakt: FAIL, brak `pi:order_B`;
 *   3. ponowienie Stripe (ten sam event.id) ⇒ route odpowiada `200 duplicate`
 *      (LUKA AC3 — mierzona jako rozbieżność z werdyktem, nie akceptowana);
 *   4. domknięcie B ⇒ PASS; ponowienie ⇒ 200 zgodne z kontraktem.
 *
 * Fixture (tabele tymczasowe) jest kopią 1:1 z
 * `stripe-payment-intent-multi-order-pg.integration.test.ts` — celowo, żeby
 * kontrakt ACK był mierzony na TYM SAMYM kształcie danych co kontrakt ADR-166.
 * Wymaga `DATABASE_URL` do IZOLOWANEJ DB z tabelą `money_path_compensation_failure`
 * (route czyta rejestr kompensacji w gałęzi duplikatu). Bez izolowanego
 * `DATABASE_URL` suita kończy się błędem precondition — `skip` nie jest
 * wynikiem bramki AC3.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals"
import { createHmac } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"
import { Pool, type PoolClient } from "pg"

jest.mock("../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { POST } from "../../api/webhooks/stripe/payment-intent/route"
import { STRIPE_SIGNATURE_HEADER } from "../../api/webhooks/stripe/payment-intent/helpers"
import { buildEventProcessedPurchaseQuery } from "../../modules/voucher/models/event-processed"
import { liveIssueEntitlementsWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"
import {
  ackStatusForVerdict,
  buildOwedBusinessUnits,
  evaluateOwedUnitAck,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../../lib/payment/stripe-webhook-barrier-contract"

const DATABASE_URL = process.env.DATABASE_URL

function hasIsolatedDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const databaseName = decodeURIComponent(new URL(value).pathname).replace(/^\//, "")
    return /_test$/i.test(databaseName)
  } catch {
    return false
  }
}

const HAS_ISOLATED_DATABASE_URL = hasIsolatedDatabaseUrl(DATABASE_URL)

describe("Story 3.1 AC3 — precondition PostgreSQL", () => {
  it("wymaga DATABASE_URL do izolowanej bazy *_test; brak nie może dać PASS przez skip", () => {
    expect(HAS_ISOLATED_DATABASE_URL).toBe(true)
  })
})

const runWithIsolatedDatabase = HAS_ISOLATED_DATABASE_URL ? describe : describe.skip

const SECRET = "whsec_3_1_owed_unit_ack"
const EVENT_ID = "evt_3_1_owed_unit_ack"
const PAYMENT_INTENT_ID = "pi_3_1_owed_unit_ack"
const SESSION_ID = "payses_3_1_owed_unit_ack"
const COLLECTION_ID = "paycol_3_1_owed_unit_ack"
const MARKET_ID = "bonbeauty"
const ORDER_A = "order_3_1_ack_a"
const ORDER_B = "order_3_1_ack_b"
const PRODUCT_A = "prod_3_1_ack_a"
const PRODUCT_B = "prod_3_1_ack_b"

type FakeRes = {
  statusCode: number
  body: unknown
  status: (code: number) => FakeRes
  json: (body: unknown) => void
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
    },
  }
}

function stripeEvent(eventId = EVENT_ID) {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: 1_790_000_200,
    data: {
      object: {
        id: PAYMENT_INTENT_ID,
        amount: 42000,
        amount_received: 42000,
        currency: "pln",
        created: 1_790_000_200,
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
    scope: { market_id: string }
    payload: Parameters<typeof liveIssueEntitlementsWithinTx>[1]["payload"]
  }
}

/**
 * Route + kolejka. Emit TYLKO kolejkuje (jak realny event bus); konsumenta
 * uruchamia test — dla wybranych zamówień — przez `consume()`.
 */
async function deliver(client: PoolClient, queue: QueuedEnvelope[], event = stripeEvent()) {
  const rawBody = JSON.stringify(event)
  const req = {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "__pg_pool__") {
          return {
            connect: async () => ({ query: client.query.bind(client), release: () => {} }),
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

async function consume(client: PoolClient, queue: QueuedEnvelope[], onlyOrders: string[]) {
  for (const delivery of queue.splice(0)) {
    if (!onlyOrders.includes(delivery.data.payload.order_id)) continue
    await liveIssueEntitlementsWithinTx(
      client,
      { event_type: delivery.name, scope: delivery.data.scope, payload: delivery.data.payload },
      new Date("2026-09-06T12:00:00.000Z")
    )
  }
}

async function settledUnits(client: PoolClient): Promise<string[]> {
  const purchaseQuery = buildEventProcessedPurchaseQuery(PAYMENT_INTENT_ID)
  const rows = await client.query<{ external_id: string }>(purchaseQuery.sql, purchaseQuery.params)
  return rows.rows.map((row) => row.external_id).sort()
}

runWithIsolatedDatabase("Story 3.1 AC3 — kontrakt ACK vs jednostki należne na realnym PostgreSQL", () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 })
    client = await pool.connect()
  })

  afterAll(async () => {
    client?.release()
    await pool?.end()
  })

  beforeEach(async () => {
    await client.query("ROLLBACK").catch(() => undefined)
    await client.query("BEGIN")
    const statements = [
      `CREATE TEMP TABLE payment_session (
         id text PRIMARY KEY, payment_collection_id text NOT NULL, data jsonb,
         deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE order_payment_collection (
         order_id text NOT NULL, payment_collection_id text NOT NULL,
         deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE sales_channel (
         id text PRIMARY KEY, metadata jsonb, deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE "order" (
         id text PRIMARY KEY, sales_channel_id text, metadata jsonb,
         deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE order_line_item (
         id text PRIMARY KEY, product_id text, unit_price numeric NOT NULL,
         title text, metadata jsonb, deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE product (
         id text PRIMARY KEY, title text, metadata jsonb, deleted_at timestamptz
       ) ON COMMIT DROP`,
      // Rdzeń issuance wiąże linię ze sprzedawcą (LEFT JOIN
      // product_product_seller_seller → seller) i wystawia wiersz `voucher`
      // z fail-loud na brak danych salonu — fixture musi te relacje mieć,
      // inaczej ścieżka kończy się 500 zanim dojdzie do kluczy idempotencji.
      `CREATE TEMP TABLE product_product_seller_seller (
         product_id text NOT NULL, seller_id text NOT NULL, deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE seller (
         id text PRIMARY KEY, name text NOT NULL, handle text NOT NULL,
         status text, deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE voucher (
         code text PRIMARY KEY, market_id text, seller_id text NOT NULL,
         seller_name text NOT NULL, seller_handle text NOT NULL,
         product_title text NOT NULL, value_minor integer NOT NULL,
         currency_code text NOT NULL, status text NOT NULL,
         expires_at timestamptz, created_at timestamptz NOT NULL,
         updated_at timestamptz NOT NULL
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE order_item (
         order_id text NOT NULL, item_id text NOT NULL,
         created_at timestamptz NOT NULL, deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE webhook_event_processed (
         event_id text NOT NULL, provider text NOT NULL, market_id text,
         envelope jsonb NOT NULL, received_at timestamptz NOT NULL,
         PRIMARY KEY (event_id, provider)
       ) ON COMMIT DROP`,
      // `purchase_key` = kolumna klucza zakupu (Story 3.3 / AD-16 / ADR-190,
      // migracja 1779006000000). Kształt lustrzany wobec migracji modułu.
      `CREATE TEMP TABLE event_processed (
         external_id text NOT NULL, event_type text NOT NULL,
         processed_at bigint NOT NULL,
         purchase_key text CHECK (purchase_key IS NULL OR char_length(purchase_key) > 0),
         PRIMARY KEY (external_id, event_type)
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE entitlement_instance (
         id text PRIMARY KEY, entitlement_profile_id text NOT NULL,
         entitlement_type text NOT NULL, order_id text NOT NULL,
         line_item_id text NOT NULL, state text NOT NULL, policy_snapshot jsonb NOT NULL,
         market_id text NOT NULL, sales_channel_id text NOT NULL,
         vat_classification text NOT NULL, reference_price_minor integer,
         entitlement_dedupe_key text NOT NULL UNIQUE, recipient_index integer NOT NULL,
         recipient_customer_id text, created_at timestamptz NOT NULL,
         updated_at timestamptz NOT NULL,
         claim_token text, expires_at timestamptz,
         UNIQUE (order_id, line_item_id)
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE entitlement_choice_set_item (
         id text PRIMARY KEY, instance_id text NOT NULL, market_id text NOT NULL,
         label text, reference_amount_minor integer NOT NULL,
         remaining_minor integer NOT NULL, vat_classification text NOT NULL,
         status text NOT NULL, redemption_id text, created_at timestamptz NOT NULL,
         updated_at timestamptz NOT NULL
       ) ON COMMIT DROP`,
    ]
    for (const statement of statements) await client.query(statement)
    // Parity gate: źródłem typu jest migracja Medusa (model.bigNumber() → numeric).
    expect(
      (
        await client.query(
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema LIKE 'pg_temp_%'
              AND table_name = 'order_line_item'
              AND column_name = 'unit_price'`
        )
      ).rows[0]?.data_type
    ).toBe("numeric")

    await client.query(
      `INSERT INTO payment_session (id, payment_collection_id, data)
       VALUES ($1, $2, $3::jsonb)`,
      [SESSION_ID, COLLECTION_ID, JSON.stringify({ id: PAYMENT_INTENT_ID })]
    )
    await client.query(
      `INSERT INTO sales_channel (id, metadata) VALUES
       ('sc_seller_a', $1::jsonb), ('sc_seller_b', $1::jsonb)`,
      [JSON.stringify({ gp_market_id: MARKET_ID })]
    )
    await client.query(
      `INSERT INTO "order" (id, sales_channel_id, metadata) VALUES
       ($1, 'sc_seller_a', NULL), ($2, 'sc_seller_b', NULL)`,
      [ORDER_A, ORDER_B]
    )
    await client.query(
      `INSERT INTO order_payment_collection (order_id, payment_collection_id) VALUES
       ($1, $3), ($2, $3)`,
      [ORDER_A, ORDER_B, COLLECTION_ID]
    )
    const productMetadata = JSON.stringify({
      gp: {
        entitlement_profile: {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          currency: "PLN",
          policy: { validity_months: 12, vat_rate_uniqueness: true },
        },
      },
    })
    await client.query(
      `INSERT INTO product (id, title, metadata) VALUES
       ($1, 'Voucher Salon A', $3::jsonb), ($2, 'Voucher Salon B', $3::jsonb)`,
      [PRODUCT_A, PRODUCT_B, productMetadata]
    )
    await client.query(
      `INSERT INTO seller (id, name, handle, status) VALUES
       ('sel_a', 'Salon A', 'salon-a', 'open'),
       ('sel_b', 'Salon B', 'salon-b', 'open')`
    )
    await client.query(
      `INSERT INTO product_product_seller_seller (product_id, seller_id) VALUES
       ($1, 'sel_a'), ($2, 'sel_b')`,
      [PRODUCT_A, PRODUCT_B]
    )
    await client.query(
      `INSERT INTO order_line_item (id, product_id, unit_price, title, metadata) VALUES
       ('li_seller_a', $1, 22000, 'Voucher Salon A', NULL),
       ('li_seller_b', $2, 20000, 'Voucher Salon B', NULL)`,
      [PRODUCT_A, PRODUCT_B]
    )
    await client.query(
      `INSERT INTO order_item (order_id, item_id, created_at) VALUES
       ($1, 'li_seller_a', NOW()), ($2, 'li_seller_b', NOW())`,
      [ORDER_A, ORDER_B]
    )
  })

  it("częściowa konsumpcja ⇒ FAIL (brak pi:order_B); ponowienie dostaje 200 duplicate — LUKA mierzona, nie akceptowana", async () => {
    const queue: QueuedEnvelope[] = []
    const owed = buildOwedBusinessUnits({ payment_intent_id: PAYMENT_INTENT_ID, order_ids: [ORDER_A, ORDER_B] })

    // 1. dostawa: rezerwacja poziomu 1 + dwie koperty w kolejce.
    const first = await deliver(client, queue)
    expect(first.statusCode).toBe(200)
    expect(queue.map((d) => d.data.payload.order_id).sort()).toEqual([ORDER_A, ORDER_B])
    const reserved = await client.query<{ event_id: string; provider: string }>(
      `SELECT event_id, provider FROM webhook_event_processed ORDER BY event_id`
    )
    expect(reserved.rows).toEqual([{ event_id: EVENT_ID, provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER }])

    // 2. konsument rozlicza TYLKO A — B ginie (pad subscribera / utrata kolejki).
    await consume(client, queue, [ORDER_A])
    const afterPartial = evaluateOwedUnitAck({ owed_units: owed, settled_units: await settledUnits(client) })
    expect(afterPartial.verdict).toBe("FAIL")
    expect(afterPartial.missing_units).toEqual([`${PAYMENT_INTENT_ID}:${ORDER_B}`])
    expect(
      (await client.query<{ order_id: string }>(`SELECT order_id FROM entitlement_instance ORDER BY order_id`)).rows.map(
        (r) => r.order_id
      )
    ).toEqual([ORDER_A])

    // 3. ponowienie Stripe (ten sam event.id): kontrakt żąda nie-2xx, route daje 200 duplicate.
    const retry = await deliver(client, queue)
    expect(queue).toHaveLength(0)
    expect(retry.statusCode).toBe(200)
    expect((retry.body as { duplicate?: boolean }).duplicate).toBe(true)
    expect(retry.statusCode).not.toBe(ackStatusForVerdict(afterPartial.verdict))
    // Po ACK jednostka B nadal NIE istnieje ani w event_processed, ani w entitlement_instance.
    expect(await settledUnits(client)).toEqual([`${PAYMENT_INTENT_ID}:${ORDER_A}`])
    expect(
      (await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM entitlement_instance WHERE order_id = $1`, [ORDER_B]))
        .rows[0].n
    ).toBe("0")
  })

  it("odrębna nowa dostawa może ręcznie domknąć brak ⇒ PASS; to NIE jest retry tego samego event.id", async () => {
    const queue: QueuedEnvelope[] = []
    const owed = buildOwedBusinessUnits({ payment_intent_id: PAYMENT_INTENT_ID, order_ids: [ORDER_A, ORDER_B] })

    await deliver(client, queue)
    await consume(client, queue, [ORDER_A])
    expect(evaluateOwedUnitAck({ owed_units: owed, settled_units: await settledUnits(client) }).verdict).toBe("FAIL")

    // To celowo ODRĘBNA dostawa dla tego samego PI z innym event.id. Nie nazywamy
    // jej Stripe resend: prawdziwy retry zachowuje event.id i jest zmierzony w
    // poprzednim teście (obecnie ujawnia lukę 200 duplicate). Ten scenariusz
    // pokazuje wyłącznie ręczny recovery, który Stories 3.3–3.4 mają zastąpić
    // bezpiecznym retry tego samego eventu.
    const redelivery = await deliver(client, queue, stripeEvent(`${EVENT_ID}_redelivery`))
    expect(redelivery.statusCode).toBe(200)
    expect(queue).toHaveLength(2)
    await consume(client, queue, [ORDER_A, ORDER_B])

    const complete = evaluateOwedUnitAck({ owed_units: owed, settled_units: await settledUnits(client) })
    expect(complete.verdict).toBe("PASS")
    expect(complete.missing_units).toEqual([])
    // ZBIORY, nie liczniki: dokładnie jedna jednostka na zamówienie, A nie zdublowane.
    expect(await settledUnits(client)).toEqual([`${PAYMENT_INTENT_ID}:${ORDER_A}`, `${PAYMENT_INTENT_ID}:${ORDER_B}`])
    expect(
      (await client.query<{ order_id: string }>(`SELECT order_id FROM entitlement_instance ORDER BY order_id`)).rows.map(
        (r) => r.order_id
      )
    ).toEqual([ORDER_A, ORDER_B])

    const retry = await deliver(client, queue)
    expect(retry.statusCode).toBe(ackStatusForVerdict(complete.verdict))
    expect((retry.body as { duplicate?: boolean }).duplicate).toBe(true)
  })

  it("stan nieznany (odczyt jednostek padł) ⇒ UNKNOWN — kontrakt zabrania ACK, choć dziś nikt go nie pyta", async () => {
    const owed = buildOwedBusinessUnits({ payment_intent_id: PAYMENT_INTENT_ID, order_ids: [ORDER_A, ORDER_B] })
    let settled: string[] | null
    try {
      // Tabela celowo nieistniejąca — symulacja awarii odczytu poziomu 2.
      await client.query("SAVEPOINT unknown_probe")
      await client.query(`SELECT external_id FROM event_processed_nie_istnieje`)
      settled = []
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT unknown_probe")
      settled = null
    }
    const v = evaluateOwedUnitAck({ owed_units: owed, settled_units: settled })
    expect(v.verdict).toBe("UNKNOWN")
    expect(ackStatusForVerdict(v.verdict)).not.toBe(200)
  })
})
