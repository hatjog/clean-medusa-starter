/**
 * Regresja F2 na prawdziwym PostgreSQL: jedna payment_collection wskazuje dwa
 * zamówienia sellerów. Test przechodzi przez route, rzeczywiste zapytania SQL
 * rezolwera i rzeczywisty rdzeń issuance. Używa wyłącznie izolowanej bazy
 * testowej wskazanej przez DATABASE_URL; całość jest wycofywana przez ROLLBACK.
 * Nie wolno kierować tego testu do współdzielonej bazy dev.
 */
import { createHmac } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import { Pool, type PoolClient } from "pg"

jest.mock("../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { POST } from "../../api/webhooks/stripe/payment-intent/route"
import { STRIPE_SIGNATURE_HEADER } from "../../api/webhooks/stripe/payment-intent/helpers"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../lib/payment/stripe-payment-intent-event"
import { buildEventProcessedPurchaseQuery } from "../../modules/voucher/models/event-processed"
import { liveIssueEntitlementsWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const SECRET = "whsec_f2_real_pg"
const EVENT_ID = "evt_f2_multi_seller"
const PAYMENT_INTENT_ID = "pi_f2_multi_seller"
const SESSION_ID = "payses_f2_multi_seller"
const COLLECTION_ID = "paycol_f2_multi_seller"
const MARKET_ID = "bonbeauty"
const ORDER_A = "order_f2_seller_a"
const ORDER_B = "order_f2_seller_b"
const PRODUCT_A = "prod_f2_seller_a"
const PRODUCT_B = "prod_f2_seller_b"

type FakeRes = {
  statusCode: number
  body: Record<string, unknown>
  status: (code: number) => FakeRes
  json: (body: unknown) => void
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
      this.body = (body ?? {}) as Record<string, unknown>
    },
  }
}

function stripeEvent(
  eventId = EVENT_ID,
  sessionId = SESSION_ID,
  paymentIntentId = PAYMENT_INTENT_ID,
  extraMetadata: Record<string, string> = {}
) {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: 1_785_000_000,
    data: {
      object: {
        id: paymentIntentId,
        amount: 42000,
        amount_received: 42000,
        currency: "pln",
        created: 1_785_000_000,
        metadata: { session_id: sessionId, ...extraMetadata },
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

async function postThroughRealPath(client: PoolClient, event: unknown) {
  const rawBody = JSON.stringify(event)
  const emitted: unknown[] = []
  const warnings: string[] = []
  const req = {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
    scope: {
      resolve: (key: string) => {
        if (key === "logger") {
          return {
            info() {},
            warn(message: string) {
              warnings.push(message)
            },
            error() {},
          }
        }
        if (key === "__pg_pool__") {
          return {
            connect: async () => ({
              query: client.query.bind(client),
              release() {},
            }),
          }
        }
        if (key === Modules.EVENT_BUS) {
          return {
            emit: async (delivery: { name: string; data: unknown }) => {
              emitted.push(delivery.data)
              const envelope = delivery.data as {
                scope: { market_id: string }
                payload: Parameters<typeof liveIssueEntitlementsWithinTx>[1]["payload"]
              }
              await liveIssueEntitlementsWithinTx(
                client,
                {
                  event_type: delivery.name,
                  scope: envelope.scope,
                  payload: envelope.payload,
                },
                new Date("2026-07-28T12:00:00.000Z")
              )
            },
          }
        }
        throw new Error(`unresolved ${key}`)
      },
    },
  }
  const res = makeRes()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await POST(req as any, res as any)
  return { res, emitted, warnings }
}

runOrSkip("F2 — multi-seller na realnej ścieżce PostgreSQL", () => {
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
    await client.query("ROLLBACK")
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
         updated_at timestamptz NOT NULL, UNIQUE (order_id, line_item_id)
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

  it("jedna kolekcja ⇒ issuance obu zamówień, replay bez duplikatów", async () => {
    const first = await postThroughRealPath(client, stripeEvent())
    expect(first.res.statusCode).toBe(200)
    expect(first.res.body.emitted_count).toBe(2)
    expect(first.res.body.order_ids).toEqual([ORDER_A, ORDER_B])
    expect(first.emitted).toHaveLength(2)

    expect(
      (await client.query(`SELECT order_id FROM entitlement_instance ORDER BY order_id`))
        .rows.map((row) => row.order_id)
    ).toEqual([ORDER_A, ORDER_B])
    expect(
      (
        await client.query(
          `SELECT order_id, (policy_snapshot->>'amount_minor')::integer AS amount_minor
             FROM entitlement_instance
            ORDER BY order_id`
        )
      ).rows
    ).toEqual([
      { order_id: ORDER_A, amount_minor: 22000 },
      { order_id: ORDER_B, amount_minor: 20000 },
    ])
    expect(
      (await client.query(`SELECT external_id FROM event_processed ORDER BY external_id`))
        .rows.map((row) => row.external_id)
    ).toEqual([
      `${PAYMENT_INTENT_ID}:${ORDER_A}`,
      `${PAYMENT_INTENT_ID}:${ORDER_B}`,
    ])

    const sameEvent = await postThroughRealPath(client, stripeEvent())
    expect(sameEvent.res.statusCode).toBe(200)
    expect(sameEvent.res.body.duplicate).toBe(true)
    expect(sameEvent.emitted).toHaveLength(0)

    const differentEvent = await postThroughRealPath(
      client,
      stripeEvent("evt_f2_multi_seller_retry")
    )
    expect(differentEvent.res.statusCode).toBe(200)
    expect(differentEvent.emitted).toHaveLength(2)
    expect(
      Number((await client.query(`SELECT COUNT(*) AS count FROM entitlement_instance`)).rows[0].count)
    ).toBe(2)
    expect(
      Number((await client.query(`SELECT COUNT(*) AS count FROM event_processed`)).rows[0].count)
    ).toBe(2)
  })

  it(
    "Story 3.3 AC1/AC2 — metadata z order_id PIERWSZEGO zamówienia nie zjada drugiego: " +
      "dwa RÓŻNE idempotency_key, dwa wiersze event_processed, wspólny purchase_key",
    async () => {
      // Realny kształt defektu: checkout zdążył ostemplować metadata JEDNYM
      // order_id, a zakup obejmuje dwóch sprzedawców. Przed 3.3 obie iteracje
      // pętli dostawały order_A ⇒ identyczny idempotency_key ⇒ dedupe zjadał
      // drugą kopertę i seller B nie dostawał wystawienia.
      const delivery = await postThroughRealPath(
        client,
        stripeEvent(EVENT_ID, SESSION_ID, PAYMENT_INTENT_ID, { order_id: ORDER_A })
      )

      expect(delivery.res.statusCode).toBe(200)
      expect(delivery.res.body.emitted_count).toBe(2)
      expect(delivery.emitted).toHaveLength(2)

      const envelopes = delivery.emitted as Array<{
        idempotency_key: string
        correlation_id: string
        payload: { order_id: string; payment_intent_id: string; amount_minor: number }
      }>

      // AC1: rezolucja linku wygrywa z metadanymi ⇒ RÓŻNE klucze idempotencji.
      expect(new Set(envelopes.map((e) => e.idempotency_key)).size).toBe(2)
      expect(envelopes.map((e) => e.idempotency_key).sort()).toEqual([
        `${MARKET_ID}:${PAYMENT_INTENT_ID}:${ORDER_A}:payment_intent_succeeded`,
        `${MARKET_ID}:${PAYMENT_INTENT_ID}:${ORDER_B}:payment_intent_succeeded`,
      ])
      // ...i różne, skalarne `payload.order_id` (żadnej tablicy — payload v1).
      expect(envelopes.map((e) => e.payload.order_id).sort()).toEqual(
        [ORDER_A, ORDER_B].sort()
      )
      for (const envelope of envelopes) {
        expect(typeof envelope.payload.order_id).toBe("string")
        // AC2: correlation_id niesie payment_intent_id, nie order_id.
        expect(envelope.correlation_id).toBe(PAYMENT_INTENT_ID)
        // ADR-166 pkt 6: kwota to pełna kwota PaymentIntenta, NIE alokacja —
        // sumowanie amount_minor pozostaje zakazane.
        expect(envelope.payload.amount_minor).toBe(42000)
      }

      // AC1: dwa wiersze event_processed po konsumpcji (drugi NIE zjedzony).
      expect(
        (await client.query(`SELECT external_id FROM event_processed ORDER BY external_id`))
          .rows.map((row) => row.external_id)
      ).toEqual([
        `${PAYMENT_INTENT_ID}:${ORDER_A}`,
        `${PAYMENT_INTENT_ID}:${ORDER_B}`,
      ])

      // AC2: korelacja zakupu PO KOLUMNIE (realne zapytanie, zero parsowania
      // `external_id` po separatorze).
      const purchaseQuery = buildEventProcessedPurchaseQuery(PAYMENT_INTENT_ID)
      const correlated = await client.query<{
        external_id: string
        purchase_key: string
      }>(purchaseQuery.sql, purchaseQuery.params)
      expect(correlated.rows.map((row) => row.external_id)).toEqual([
        `${PAYMENT_INTENT_ID}:${ORDER_A}`,
        `${PAYMENT_INTENT_ID}:${ORDER_B}`,
      ])
      expect(new Set(correlated.rows.map((row) => row.purchase_key))).toEqual(
        new Set([PAYMENT_INTENT_ID])
      )

      // Oba zamówienia realnie wystawione — seller B nie został bez vouchera.
      expect(
        (await client.query(`SELECT order_id FROM entitlement_instance ORDER BY order_id`))
          .rows.map((row) => row.order_id)
      ).toEqual([ORDER_A, ORDER_B])
    }
  )

  it("rozjazd metadata ↔ rezolucja NIE jest cichy (Story 3.3 AC1)", async () => {
    const delivery = await postThroughRealPath(
      client,
      stripeEvent(EVENT_ID, SESSION_ID, PAYMENT_INTENT_ID, {
        order_id: "order_obcy_stempel",
      })
    )

    expect(delivery.res.statusCode).toBe(200)
    expect(delivery.res.body.emitted_count).toBe(2)
    const mismatch = delivery.warnings.find((line) =>
      line.includes("metadata_order_mismatch")
    )
    expect(mismatch).toBeDefined()
    expect(mismatch).toContain(`payment_intent_id=${PAYMENT_INTENT_ID}`)
    expect(mismatch).toContain("metadata.order_id=order_obcy_stempel")
    expect(mismatch).toContain(`resolved_order_ids=[${ORDER_A},${ORDER_B}]`)
  })

  it("brak zamówień zachowuje osobną klasę link_unresolved", async () => {
    const delivery = await postThroughRealPath(
      client,
      stripeEvent(
        "evt_f2_unresolved",
        "payses_bez_zamowien",
        "pi_bez_zamowien"
      )
    )
    expect(delivery.res.statusCode).toBe(400)
    expect(delivery.res.body.type).toBe("unresolved_link")
    expect(delivery.res.body.reason).toBe("link_unresolved")
    expect(delivery.emitted).toHaveLength(0)
    expect(
      Number((await client.query(`SELECT COUNT(*) AS count FROM entitlement_instance`)).rows[0].count)
    ).toBe(0)
  })

  it("soft-deleted order w kolekcji nie blokuje aktywnych zamówień", async () => {
    await client.query(
      `INSERT INTO "order" (id, sales_channel_id, metadata, deleted_at)
       VALUES ('order_f2_usuniete', 'sc_seller_a', NULL, NOW())`
    )
    await client.query(
      `INSERT INTO order_payment_collection (order_id, payment_collection_id)
       VALUES ('order_f2_usuniete', $1)`,
      [COLLECTION_ID]
    )

    const delivery = await postThroughRealPath(client, stripeEvent())

    expect(delivery.res.statusCode).toBe(200)
    expect(delivery.res.body.emitted_count).toBe(2)
    expect(delivery.res.body.order_ids).toEqual([ORDER_A, ORDER_B])
  })
})
