/**
 * stripe-payment-intent-owed-unit-ack-pg.integration.test.ts — Story 3.1 AC3
 * (v1.16.0, Epic 3; AD-47, ADR-166, ADR-190) na REALNYM PostgreSQL.
 *
 * Scenariusz „częściowy ACK" na prawdziwej ścieżce (route Path Y + konsument
 * `liveIssueEntitlementsWithinTx` + prawdziwe SQL na tabelach tymczasowych):
 *   1. dostawa 1 dla PI z DWOMA zamówieniami ⇒ 200, dwie koperty w kolejce;
 *   2. konsument rozlicza TYLKO zamówienie A (B ginie) ⇒ w `event_processed`
 *      jest jedna jednostka; kontrakt: FAIL, brak `pi:order_B`;
 *   3. ponowienie Stripe (ten sam event.id) ⇒ route odmawia ACK przez `500`,
 *      z widocznym werdyktem `FAIL` i brakującą jednostką;
 *   4. domknięcie B ⇒ PASS; ponowienie ⇒ 200 zgodne z kontraktem.
 *
 * Fixture (tabele tymczasowe) jest kopią 1:1 z
 * `stripe-payment-intent-multi-order-pg.integration.test.ts` — celowo, żeby
 * kontrakt ACK był mierzony na TYM SAMYM kształcie danych co kontrakt ADR-166.
 * Wymaga `DATABASE_URL` (opcjonalnie zgodnego `GP_STORY_3_1_TEST_DATABASE_URL`) do IZOLOWANEJ DB `*_test` z tabelą `money_path_compensation_failure`
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
import { marketContextStorage } from "../../lib/market-context"
import { installRlsPoolHook, RlsMarketContextRequiredError } from "../../lib/rls-pool-hook"
import {
  queryUnderMarketContext,
  RLS_CONTEXT_NOT_APPLIED,
  RlsScopedReadError,
} from "../../lib/payment/stripe-payment-intent-transport"
import {
  ackStatusForVerdict,
  buildOwedBusinessUnits,
  evaluateOwedUnitAck,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../../lib/payment/stripe-webhook-barrier-contract"

// Story 3.1 C3-SEC-002: instancja RLS wyłącznie ze źródła serwerowego (GP_INSTANCE_ID),
// bez domyślnego "gp" — testy ustawiają ją jawnie.
process.env.GP_INSTANCE_ID = "gp-test"

const STORY_TEST_DATABASE_URL_ENV = "GP_STORY_3_1_TEST_DATABASE_URL"
// Story 11.1 C5-PG-001: profil przyjmuje każdą izolowaną bazę spełniającą wspólną
// straż suity (integration-tests/setup.js, Story 7.2): lokalny PostgreSQL, nazwa
// z sufiksem `_test`, odrębna od baz deweloperskich. Opcjonalny URL tej story,
// jeśli podany, musi być identyczny z DATABASE_URL (jedno źródło celu).
const DATABASE_URL = process.env[STORY_TEST_DATABASE_URL_ENV] ?? process.env.DATABASE_URL
const DEVELOPMENT_DATABASES = new Set(["gp_mercur", "gp_core", "gp_portal"])

function hasTrustedStoryTestDatabaseUrl(
  value: string | undefined,
  configuredDatabaseUrl = process.env.DATABASE_URL
): boolean {
  if (!value) return false
  if (configuredDatabaseUrl !== value) return false
  try {
    const url = new URL(value)
    const databaseName = decodeURIComponent(url.pathname).replace(/^\//, "")
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      /_test$/.test(databaseName) &&
      !DEVELOPMENT_DATABASES.has(databaseName) &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  } catch {
    return false
  }
}

const HAS_TRUSTED_STORY_TEST_DATABASE_URL = hasTrustedStoryTestDatabaseUrl(DATABASE_URL)

describe("Story 3.1 AC3 — precondition PostgreSQL", () => {
  it("wymaga jawnego URL tej story, zgodnego z DATABASE_URL; brak nie może dać PASS przez skip", () => {
    expect(HAS_TRUSTED_STORY_TEST_DATABASE_URL).toBe(true)
  })

  it("przyjmuje izolowaną bazę innej story spełniającą wspólną straż suity (C5-PG-001)", () => {
    for (const name of ["gp_story_3_1_test", "gp_story_11_1_w0_test", "gp_mercur_test"]) {
      const url = `postgres://test_runner@localhost:55432/${name}`
      expect(hasTrustedStoryTestDatabaseUrl(url, url)).toBe(true)
    }
  })

  it("odrzuca bazę deweloperską, nazwę bez sufiksu _test, obcy host i rozjazd z DATABASE_URL", () => {
    for (const name of ["gp_mercur", "gp_core", "gp_portal", "gp_story_11_1_w0", "postgres"]) {
      const url = `postgres://test_runner@localhost:55432/${name}`
      expect(hasTrustedStoryTestDatabaseUrl(url, url)).toBe(false)
    }
    const remote = "postgres://prod_role@prod-db.internal:5432/gp_story_3_1_test"
    expect(hasTrustedStoryTestDatabaseUrl(remote, remote)).toBe(false)
    const safe = "postgres://test_runner@localhost:5432/gp_story_3_1_test"
    expect(hasTrustedStoryTestDatabaseUrl(safe, "postgres://test_runner@localhost:5432/other_test")).toBe(false)
    expect(hasTrustedStoryTestDatabaseUrl(undefined, safe)).toBe(false)
  })
})

const runWithIsolatedDatabase = HAS_TRUSTED_STORY_TEST_DATABASE_URL ? describe : describe.skip

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
            // Lustro hooka RLS: GUC rynku/instancji ustawiany W CHWILI acquire
            // z kontekstu ALS (jak `installRlsPoolHook`); bez kontekstu — RESET.
            // Tabele tymczasowe nie mają polityk, więc realny RLS mierzy osobny
            // `describe` niżej na prawdziwej tabeli `event_processed`.
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
         order_id text NOT NULL, item_id text NOT NULL, quantity numeric NOT NULL DEFAULT 1,
         created_at timestamptz NOT NULL, deleted_at timestamptz
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE webhook_event_processed (
         event_id text NOT NULL, provider text NOT NULL, market_id text,
         envelope jsonb NOT NULL, received_at timestamptz NOT NULL,
         PRIMARY KEY (event_id, provider)
       ) ON COMMIT DROP`,
      // Story 3.1 fix C3-AC2-001: rejestr kompensacji (czytany w gałęzi duplikatu)
      // nie istnieje w gp_story_3_1_test — kształt 1:1 z multi-order.
      `CREATE TEMP TABLE money_path_compensation_failure (
         failure_id text PRIMARY KEY,
         market_id text NOT NULL,
         compensation_kind text NOT NULL,
         delivery_path text NOT NULL,
         stripe_event_id text NOT NULL,
         payment_intent_id text NOT NULL,
         order_id text,
         purchase_correlation_key text NOT NULL,
         failure_code text NOT NULL,
         failure_detail text NOT NULL,
         occurred_at timestamptz NOT NULL DEFAULT now(),
         attempt_count integer NOT NULL DEFAULT 1,
         last_attempt_at timestamptz NOT NULL DEFAULT now(),
         resolution_state text NOT NULL DEFAULT 'open',
         instance_id text,
         owner_type text,
         owner_id text,
         deadline timestamptz,
         closure_path text,
         provenance_kind text,
         provenance_source text,
         resolved_at timestamptz,
         resolved_by text
       ) ON COMMIT DROP`,
      // Story 4.2 (ADR-238 §7): FIND_OPEN_COMPENSATION_FAILURES_SQL czyta też
      // kwarantannę zastanych wierszy — kształt lustrzany wobec migracji
      // Migration20261114120000 (cf-create-quarantine).
      `CREATE TEMP TABLE money_path_compensation_failure_backfill_quarantine (
         source_failure_id text PRIMARY KEY,
         source_row jsonb NOT NULL,
         reason text NOT NULL,
         quarantined_at timestamptz NOT NULL DEFAULT now(),
         market_id text NOT NULL,
         instance_id text NOT NULL,
         instance_id_source text NOT NULL,
         backfill_state text NOT NULL,
         owner_type text NOT NULL,
         owner_id text NOT NULL,
         deadline timestamptz NOT NULL,
         closed_at timestamptz,
         closed_by text,
         closure_evidence jsonb
       ) ON COMMIT DROP`,
      // `purchase_key` = kolumna klucza zakupu (Story 3.3 / AD-16 / ADR-190,
      // migracja 1779006000000). Kształt lustrzany wobec migracji modułu.
      `CREATE TEMP TABLE event_processed (
         external_id text NOT NULL, event_type text NOT NULL,
         processed_at bigint NOT NULL,
         purchase_key text CHECK (purchase_key IS NULL OR char_length(purchase_key) > 0),
         market_id text, instance_id text,
         PRIMARY KEY (external_id, event_type)
       ) ON COMMIT DROP`,
      `CREATE TEMP TABLE owed_unit_effect_barrier (
         -- Story 3.3: lustro Migration20261114140000SharedIdempotencyBarrier (klucz bez event_type).
         owed_business_unit_key text PRIMARY KEY, payment_intent_id text NOT NULL,
         order_id text NOT NULL, instance_id text NOT NULL, market_id text NOT NULL,
         claimed_by_path text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now()
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

  it("częściowa konsumpcja ⇒ FAIL (brak pi:order_B); ponowienie odmawia ACK z widocznym powodem", async () => {
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

    // 3. ponowienie Stripe (ten sam event.id): kontrakt żąda nie-2xx, route odmawia ACK.
    const retry = await deliver(client, queue)
    // Story 3.4 (AC4): ponowienie emituje ponownie WYŁĄCZNIE kopertę brakującej
    // jednostki B (naprawa); ACK nadal wstrzymany do równości zbiorów.
    expect(queue.map((d) => d.data.payload.order_id)).toEqual([ORDER_B])
    expect(retry.statusCode).toBe(ackStatusForVerdict(afterPartial.verdict))
    expect(retry.statusCode).toBeGreaterThanOrEqual(500)
    expect(retry.body).toMatchObject({
      type: "owed_unit_ack_incomplete",
      reason: "owed_units_unsettled",
      verdict: "FAIL",
      missing_units: [`${PAYMENT_INTENT_ID}:${ORDER_B}`],
      unexpected_units: [],
    })
    // Jednostka B nadal NIE istnieje, więc Stripe zachowuje retry zamiast ACK.
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
    // poprzednim teście (odmawia ACK przy braku jednostki). Ten scenariusz
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


// ── Story 3.1 fix C3-SEC-001 — odczyt poziomu 2 na REALNEJ tabeli z RLS ───────
//
// `event_processed` w bazie testowej ma FORCE ROW LEVEL SECURITY z polityką
// `market_isolation` (instance_id + market_id vs GUC). Hook RLS jest tu
// instalowany na prawdziwym sterowniku (pg Pool), więc test mierzy ten sam
// mechanizm co produkcja: GUC ustawiany wyłącznie przy acquire połączenia.
runWithIsolatedDatabase("Story 3.1 fix C3-SEC-001 — odczyt jednostek pod kontekstem RLS na realnym PostgreSQL", () => {
  const PROBE_PI = "pi_3_1_rls_probe"
  const ROWS = [
    { external_id: `${PROBE_PI}:order_bb`, market_id: "bonbeauty", instance_id: "gp-test" },
    { external_id: `${PROBE_PI}:order_mercur`, market_id: "mercur", instance_id: "gp-test" },
    { external_id: `${PROBE_PI}:order_other_instance`, market_id: "bonbeauty", instance_id: "gp-other" },
  ]
  let pool: Pool
  let scope: { resolve: (key: string) => unknown }
  let driver: {
    acquireConnection: () => Promise<PoolClient>
    releaseConnection: (c: PoolClient) => Promise<void>
    destroyRawConnection: (c: PoolClient) => Promise<void>
  }

  async function cleanup() {
    await pool.query(`DELETE FROM event_processed WHERE purchase_key = $1`, [PROBE_PI])
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 })
    await cleanup()
    for (const row of ROWS) {
      await pool.query(
        `INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, market_id, instance_id)
         VALUES ($1, 'payment_intent_succeeded', 1790000000, $2, $3, $4)`,
        [row.external_id, PROBE_PI, row.market_id, row.instance_id]
      )
    }
    driver = {
      acquireConnection: () => pool.connect(),
      releaseConnection: async (c) => c.release(),
      destroyRawConnection: async (c) => c.release(true),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installRlsPoolHook({ client: driver as any })
    scope = {
      resolve: (key: string) => {
        if (key === "__pg_pool__") throw new Error("unresolved __pg_pool__")
        return { raw: async () => ({ rows: [] }), client: driver }
      },
    }
  })

  afterAll(async () => {
    await cleanup().catch(() => undefined)
    await pool?.end()
  })

  const purchaseQuery = () => buildEventProcessedPurchaseQuery(PROBE_PI)

  it("kontekst bonbeauty/gp-test widzi WYŁĄCZNIE własną jednostkę (cross-market i cross-instance odfiltrowane)", async () => {
    const q = purchaseQuery()
    const result = await queryUnderMarketContext<{ external_id: string }>(
      scope,
      { market_id: "bonbeauty", instance_id: "gp-test" },
      q.sql,
      q.params
    )
    expect(result.rows.map((r) => r.external_id)).toEqual([`${PROBE_PI}:order_bb`])
  })

  it("kontekst obcego rynku (mercur) NIE widzi jednostki bonbeauty", async () => {
    const q = purchaseQuery()
    const result = await queryUnderMarketContext<{ external_id: string }>(
      scope,
      { market_id: "mercur", instance_id: "gp-test" },
      q.sql,
      q.params
    )
    expect(result.rows.map((r) => r.external_id)).toEqual([`${PROBE_PI}:order_mercur`])
  })

  it("kontekst obcej instancji (cross-instance) NIE widzi jednostek gp-test", async () => {
    const q = purchaseQuery()
    const result = await queryUnderMarketContext<{ external_id: string }>(
      scope,
      { market_id: "bonbeauty", instance_id: "gp-other" },
      q.sql,
      q.params
    )
    expect(result.rows.map((r) => r.external_id)).toEqual([`${PROBE_PI}:order_other_instance`])
  })

  it("połączenie pobrane PRZED kontekstem (stary błąd) jest odmową hooka, nie odczytem bez filtra", async () => {
    // Hookowany sterownik: acquire bez kontekstu ALS ⇒ odmowa nazwanym błędem.
    await expect(driver.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
  })

  it("połączenie wzięte w kontekście A i użyte w kontekście B nie zmienia GUC (dlatego acquire musi być W kontekście)", async () => {
    const conn = await marketContextStorage.run({ market_id: "mercur", instance_id: "gp-test" }, () =>
      driver.acquireConnection()
    )
    try {
      const q = purchaseQuery()
      const rows = await marketContextStorage.run({ market_id: "bonbeauty", instance_id: "gp-test" }, () =>
        conn.query<{ external_id: string }>(q.sql, q.params)
      )
      // To jest zmierzona luka C3-SEC-001: owinięcie zapytania w `run` po
      // acquire nie przestawia kontekstu — sesja nadal widzi rynek A.
      expect(rows.rows.map((r) => r.external_id)).toEqual([`${PROBE_PI}:order_mercur`])
    } finally {
      await driver.releaseConnection(conn)
    }
  })

  it("ścieżka BEZ hooka (surowa pula) ⇒ odmowa fail-closed rls_context_not_applied", async () => {
    const rawScope = {
      resolve: (key: string) => {
        if (key === "__pg_pool__") return { connect: () => pool.connect() }
        throw new Error(`unresolved ${key}`)
      },
    }
    const q = purchaseQuery()
    const attempt = queryUnderMarketContext(rawScope, { market_id: "bonbeauty", instance_id: "gp-test" }, q.sql, q.params)
    await expect(attempt).rejects.toBeInstanceOf(RlsScopedReadError)
    await expect(
      queryUnderMarketContext(rawScope, { market_id: "bonbeauty", instance_id: "gp-test" }, q.sql, q.params)
    ).rejects.toMatchObject({ code: RLS_CONTEXT_NOT_APPLIED })
  })
})
