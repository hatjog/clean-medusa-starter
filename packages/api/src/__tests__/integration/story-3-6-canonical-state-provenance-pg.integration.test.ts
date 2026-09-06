import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import { Pool, type PoolClient } from "pg"

jest.mock("../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { POST } from "../../api/webhooks/stripe/payment-intent/route"
import { STRIPE_SIGNATURE_HEADER } from "../../api/webhooks/stripe/payment-intent/helpers"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../lib/payment/stripe-payment-intent-event"
import { Migration20260516000000StripePathYWebhookEventProcessed } from "../../migrations/Migration20260516000000StripePathYWebhookEventProcessed"
import { Migration1778112000000 } from "../../modules/voucher/migrations/1778112000000_create_voucher_and_voucher_event_tables"
import { Migration1778880672656 } from "../../modules/voucher/migrations/1778880672656_create_entitlement_profiles_section"
import { Migration1778925500000 } from "../../modules/voucher/migrations/1778925500000_add_line_item_id_to_entitlement_instance"
import { Migration1778926000000 } from "../../modules/voucher/migrations/1778926000000_extend_entitlement_instance_check_constraints"
import { Migration1778926100000 } from "../../modules/voucher/migrations/1778926100000_add_voucher_expired_status_and_recipient_columns"
import { Migration1778926200000 } from "../../modules/voucher/migrations/1778926200000_add_claim_token_to_entitlement_instance"
import { Migration1778928000000 } from "../../modules/voucher/migrations/1778928000000_create_event_processed_table"
import { Migration1778928100000 } from "../../modules/voucher/migrations/1778928100000_add_vat_classification_and_ontology_fk"
import { Migration1778928200000 } from "../../modules/voucher/migrations/1778928200000_add_entitlement_dedupe_key_and_recipient_index"
import { Migration1778928300000 } from "../../modules/voucher/migrations/1778928300000_tighten_sales_channel_scope_live_issue"
import { Migration1778930000000 } from "../../modules/voucher/migrations/1778930000000_add_claim_token_ttl_to_entitlement_instance"
import { Migration1778932000000 } from "../../modules/voucher/migrations/1778932000000_add_reference_price_and_choice_set"
import { Migration1779006000000 } from "../../modules/voucher/migrations/1779006000000_add_purchase_key_to_event_processed"
import { EntitlementInstanceState } from "../../modules/voucher/models/entitlement"
import { StripePaymentAuditWorkflow } from "../../workflows/payment/stripe-payment-audit"
import voucherLiveIssueSubscriber from "../../subscribers/voucher-live-issue"

const STORY_TEST_DATABASE_URL_ENV = "GP_STORY_3_6_TEST_DATABASE_URL"
const DATABASE_URL = process.env[STORY_TEST_DATABASE_URL_ENV]
const EVIDENCE_PATH = resolve(
  process.cwd(),
  "../../_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/3-6/canonical-state-provenance.json"
)

const FIXTURE = {
  orderId: "order_3_6_same_purchase",
  lineItemId: "li_3_6_same_purchase",
  lineOrdinal: 0,
  quantity: 1,
  marketId: "bonbeauty",
  purchaseMode: "gift",
  paymentIntentId: "pi_3_6_same_purchase",
  recipientId: "recipient_3_6_redacted",
  recipientHash: `sha256:${createHash("sha256")
    .update("story-3-6:recipient-fixture")
    .digest("hex")}`,
  eventTimes: {
    captured: "2026-09-06T00:00:00.000Z",
    pathY: "2026-09-06T00:01:00.000Z",
  },
} as const

const FIXTURE_PURCHASE_FINGERPRINT = `sha256:${createHash("sha256")
  .update(
    JSON.stringify({
      order_id: FIXTURE.orderId,
      line_item_id: FIXTURE.lineItemId,
      line_ordinal: FIXTURE.lineOrdinal,
      quantity: FIXTURE.quantity,
      market_id: FIXTURE.marketId,
      purchase_mode: FIXTURE.purchaseMode,
      recipient_hash: FIXTURE.recipientHash,
    })
  )
  .digest("hex")}`

const PROFILE = {
  profile_id: "voucher-kwotowy-365d",
  entitlement_type: "VOUCHER_SERVICE",
  policy: { validity_months: 12, vat_rate_uniqueness: true },
  currency: "PLN",
  amount_minor: 10000,
  line_item_id: FIXTURE.lineItemId,
  recipient_customer_id: FIXTURE.recipientId,
} as const

type Axis = {
  id: string
  timestamp: string
  producer: string
  consumer: string
  verdict: "observed"
}

type Measurement = {
  run_id: string
  route: string
  order_id: string
  line_item_id: string
  line_ordinal: number
  quantity: number
  instance_id: string
  market_id: string
  purchase_mode: string
  purchase_fingerprint: string
  transport_event_id: string
  transport_event_type: string
  producer: string
  consumer: string
  genesis: string
  entitlement_instance_state: string
  voucher_status: string | null
  gate_order: string[]
  transaction_id: string
  trigger: Axis
  effect: Axis & {
    table: "entitlement_instance"
    entitlement_state: string
    voucher_status: string | null
  }
}

type Trace = {
  transactionId: string | null
  sqlLabels: string[]
}

function collectUpSql(
  MigrationClass: { prototype: unknown },
  sessionLocalTables = false
): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (sql: string) => sqls.push(sql) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(MigrationClass.prototype as any).up.call(fakeThis)
  return sessionLocalTables
    ? sqls.map((sql) =>
        sql.replace(/\bCREATE TABLE IF NOT EXISTS\b/g, "CREATE TEMP TABLE IF NOT EXISTS")
      )
    : sqls
}

function hasTrustedStoryTestDatabaseUrl(
  value: string | undefined,
  configuredDatabaseUrl = process.env.DATABASE_URL
): boolean {
  if (!value || configuredDatabaseUrl !== value) return false
  try {
    const url = new URL(value)
    const databaseName = decodeURIComponent(url.pathname).replace(/^\//, "")
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      databaseName === "gp_story_3_6_test" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  } catch {
    return false
  }
}

const HAS_TRUSTED_STORY_TEST_DATABASE_URL = hasTrustedStoryTestDatabaseUrl(DATABASE_URL)
const runWithIsolatedDatabase = HAS_TRUSTED_STORY_TEST_DATABASE_URL ? describe : describe.skip

function purchaseFingerprint(): string {
  return FIXTURE_PURCHASE_FINGERPRINT
}

function signedHeader(rawBody: string): string {
  const timestamp = Math.floor(new Date(FIXTURE.eventTimes.pathY).getTime() / 1000)
  const signature = createHmac("sha256", "whsec_story_3_6")
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")
  return `t=${timestamp},v1=${signature}`
}

function makeResponse(): {
  statusCode: number
  body: Record<string, unknown>
  status: (code: number) => unknown
  json: (body: unknown) => void
} {
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

function stripeEvent() {
  return {
    id: "evt_3_6_path_y",
    type: "payment_intent.succeeded",
    created: Math.floor(new Date(FIXTURE.eventTimes.pathY).getTime() / 1000),
    data: {
      object: {
        id: FIXTURE.paymentIntentId,
        amount: PROFILE.amount_minor,
        amount_received: PROFILE.amount_minor,
        currency: "pln",
        created: Math.floor(new Date(FIXTURE.eventTimes.pathY).getTime() / 1000),
        metadata: { session_id: "payses_3_6_same_purchase" },
      },
    },
  }
}

function makeTrackedClient(client: PoolClient, trace: Trace): PoolClient {
  const originalQuery = client.query.bind(client)
  return {
    ...client,
    query: async (...args: Parameters<PoolClient["query"]>) => {
      const sql = String(args[0])
      const result = await originalQuery(...args)
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase()
      if (normalized === "begin") {
        const tx = await originalQuery("SELECT txid_current()::text AS txid")
        trace.transactionId = String((tx.rows as Array<{ txid: string }>)[0].txid)
      }
      if (normalized.includes("insert into entitlement_instance")) {
        trace.sqlLabels.push("entitlement_state_persist")
      }
      if (normalized.includes("insert into voucher")) {
        trace.sqlLabels.push("voucher_projection")
      }
      return result
    },
    release: client.release.bind(client),
  } as PoolClient
}

async function createFixtureSchema(client: PoolClient): Promise<void> {
  await client.query("BEGIN")
  await client.query(`
    CREATE TEMP TABLE sales_channel (
      id text PRIMARY KEY, metadata jsonb, deleted_at timestamptz
    );
    CREATE TEMP TABLE payment_session (
      id text PRIMARY KEY, payment_collection_id text NOT NULL, data jsonb,
      metadata jsonb, deleted_at timestamptz
    );
    CREATE TEMP TABLE order_payment_collection (
      order_id text NOT NULL, payment_collection_id text NOT NULL,
      deleted_at timestamptz
    );
    CREATE TEMP TABLE "order" (
      id text PRIMARY KEY, sales_channel_id text, metadata jsonb, deleted_at timestamptz
    );
    CREATE TEMP TABLE order_item (
      order_id text NOT NULL, item_id text NOT NULL,
      created_at timestamptz NOT NULL, deleted_at timestamptz
    );
    CREATE TEMP TABLE order_line_item (
      id text PRIMARY KEY, product_id text, unit_price numeric NOT NULL,
      title text, metadata jsonb, deleted_at timestamptz
    );
    CREATE TEMP TABLE product (
      id text PRIMARY KEY, title text, metadata jsonb, deleted_at timestamptz
    );
    CREATE TEMP TABLE product_product_seller_seller (
      product_id text NOT NULL, seller_id text NOT NULL, deleted_at timestamptz
    );
    CREATE TEMP TABLE seller (
      id text PRIMARY KEY, name text NOT NULL, handle text NOT NULL, deleted_at timestamptz
    );
  `)
  for (const MigrationClass of [
    Migration1778112000000,
    Migration1778880672656,
    Migration1778925500000,
    Migration1778926000000,
    Migration1778926100000,
    Migration1778926200000,
    Migration1778928000000,
    Migration1778928100000,
    Migration1778928200000,
    Migration1778928300000,
    Migration1778930000000,
    Migration1779006000000,
    Migration20260516000000StripePathYWebhookEventProcessed,
  ]) {
    for (const sql of collectUpSql(MigrationClass, true)) await client.query(sql)
  }
  // The production writer also persists this nullable snapshot column. Apply
  // the exact ALTER statement from its production migration without creating
  // the migration's unrelated global trigger/function in the test database.
  const referencePriceSql = collectUpSql(Migration1778932000000).find((sql) =>
    sql.includes("reference_price_minor")
  )
  expect(referencePriceSql).toBeDefined()
  await client.query(referencePriceSql as string)
  // The event_processed runtime writer carries market scope; retain that
  // existing runtime column while loading the table and index from production.
  await client.query(
    `ALTER TABLE event_processed
       ADD COLUMN IF NOT EXISTS market_id text NOT NULL`
  )
  await client.query(
    `INSERT INTO sales_channel (id, metadata) VALUES ('sc_3_6', $1::jsonb);
     INSERT INTO "order" (id, sales_channel_id, metadata) VALUES ($2, 'sc_3_6', $3::jsonb);
     INSERT INTO payment_session (id, payment_collection_id, data) VALUES ('payses_3_6_same_purchase', 'paycol_3_6', $4::jsonb);
     INSERT INTO order_payment_collection (order_id, payment_collection_id) VALUES ($2, 'paycol_3_6');
     INSERT INTO seller (id, name, handle) VALUES ('seller_3_6', 'Salon testowy', 'salon-testowy');
     INSERT INTO product (id, title, metadata) VALUES ('prod_3_6', 'Zabieg testowy', '{}'::jsonb);
     INSERT INTO product_product_seller_seller (product_id, seller_id) VALUES ('prod_3_6', 'seller_3_6');
     INSERT INTO order_line_item (id, product_id, unit_price, title, metadata) VALUES ($5, 'prod_3_6', $6, 'Zabieg testowy', $7::jsonb);
     INSERT INTO order_item (order_id, item_id, created_at) VALUES ($2, $5, $8);`,
    [
      JSON.stringify({ gp_market_id: FIXTURE.marketId }),
      FIXTURE.orderId,
      JSON.stringify({ gp: { market_id: FIXTURE.marketId }, purchase_mode: FIXTURE.purchaseMode }),
      JSON.stringify({ id: FIXTURE.paymentIntentId }),
      FIXTURE.lineItemId,
      PROFILE.amount_minor,
      JSON.stringify({
        entitlement_profile: {
          profile_id: PROFILE.profile_id,
          entitlement_type: PROFILE.entitlement_type,
          policy: PROFILE.policy,
          currency: PROFILE.currency,
          amount_minor: PROFILE.amount_minor,
        },
        recipients: [{ recipient_customer_id: FIXTURE.recipientId }],
      }),
      new Date("2026-09-06T00:00:00.000Z"),
    ]
  )
  await client.query("COMMIT")
}

async function makeFixtureClient(basePool: Pool): Promise<{
  client: PoolClient
  trace: Trace
}> {
  const rawClient = await basePool.connect()
  await createFixtureSchema(rawClient)
  const trace: Trace = { transactionId: null, sqlLabels: [] }
  return { client: makeTrackedClient(rawClient, trace), trace }
}

function workflowPool(client: PoolClient): { connect: () => Promise<PoolClient> } {
  return { connect: async () => client }
}

async function readMeasurement(
  client: PoolClient,
  trace: Trace,
  runId: string,
  route: string,
  eventId: string,
  eventType: string,
  producer: string,
  consumer: string,
  transition: Record<string, unknown>,
  triggerTimestamp: string
): Promise<Measurement> {
  const result = await client.query<{
    id: string
    state: string
    status: string | null
  }>(
    `SELECT ei.id, ei.state, v.status
       FROM entitlement_instance ei
       LEFT JOIN voucher v ON v.code = ei.policy_snapshot->>'voucher_code'
      WHERE ei.order_id = $1 AND ei.line_item_id = $2
      ORDER BY ei.created_at
      LIMIT 1`,
    [FIXTURE.orderId, FIXTURE.lineItemId]
  )
  const row = result.rows[0]
  expect(row).toBeDefined()
  const transitionPayload = transition.payload as {
    from_state: string
    to_state: string
    entitlement_id: string
    transitioned_at: string
  }
  expect(transitionPayload.entitlement_id).toBe(row.id)
  expect(transitionPayload.to_state).toBe(row.state)
  expect(trace.transactionId).toEqual(expect.any(String))
  const gateOrder = [
    transitionPayload.from_state === "__genesis__"
      ? "entitlement_genesis"
      : "entitlement_state_guard",
    ...trace.sqlLabels,
  ]
  expect(gateOrder).toEqual(
    expect.arrayContaining(["entitlement_state_persist", "voucher_projection"])
  )
  expect(new Set(gateOrder).size).toBe(gateOrder.length)

  const effect: Measurement["effect"] = {
    id: row.id,
    timestamp: transitionPayload.transitioned_at,
    producer: "entitlement-transition-wiring",
    consumer: "canonical-state-measurement",
    verdict: "observed",
    table: "entitlement_instance",
    entitlement_state: row.state,
    voucher_status: row.status,
  }
  const trigger: Axis = {
    id: eventId,
    timestamp: triggerTimestamp,
    producer,
    consumer,
    verdict: "observed",
  }
  return {
    run_id: runId,
    route,
    order_id: FIXTURE.orderId,
    line_item_id: FIXTURE.lineItemId,
    line_ordinal: FIXTURE.lineOrdinal,
    quantity: FIXTURE.quantity,
    instance_id: row.id,
    market_id: FIXTURE.marketId,
    purchase_mode: FIXTURE.purchaseMode,
    purchase_fingerprint: purchaseFingerprint(),
    transport_event_id: eventId,
    transport_event_type: eventType,
    producer,
    consumer,
    genesis: `${transitionPayload.from_state} -> ${transitionPayload.to_state}`,
    entitlement_instance_state: row.state,
    voucher_status: row.status,
    gate_order: gateOrder,
    transaction_id: trace.transactionId as string,
    trigger,
    effect,
  }
}

function assertMeasurementSet(rows: readonly Measurement[]): void {
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((row) => row.route))).toEqual(
    new Set(["POST /hooks/payment/stripe", "POST /webhooks/stripe/payment-intent"])
  )
  expect(new Set(rows.map((row) => row.transport_event_id)).size).toBe(2)
  expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(2)
  for (const row of rows) {
    expect(row.order_id).toBe(FIXTURE.orderId)
    expect(row.line_item_id).toBe(FIXTURE.lineItemId)
    expect(row.line_ordinal).toBe(FIXTURE.lineOrdinal)
    expect(row.quantity).toBe(FIXTURE.quantity)
    expect(row.purchase_fingerprint).toBe(FIXTURE_PURCHASE_FINGERPRINT)
    expect(row.instance_id).toBe(
      row.route === "POST /hooks/payment/stripe"
        ? "ent_051dfdb98d55c27bb4cae8d1"
        : "ent_47436bdc8f8c51557f87263b4279cc2ff2350392023db6dc2ea0130311662f4b"
    )
    expect(row.market_id).toBe(FIXTURE.marketId)
    expect(row.purchase_mode).toBe(FIXTURE.purchaseMode)
    expect(row.voucher_status).toBe("idle")
    expect(row.trigger.id).toBe(row.transport_event_id)
    expect(row.effect.id).not.toBe(row.trigger.id)
    expect(row.trigger.timestamp).toEqual(expect.any(String))
    expect(row.effect.timestamp).toEqual(expect.any(String))
    expect(row.trigger.verdict).toBe("observed")
    expect(row.effect.verdict).toBe("observed")
    expect(row.effect.table).toBe("entitlement_instance")
  }
  const captured = rows.find((row) => row.route === "POST /hooks/payment/stripe")
  const pathY = rows.find((row) => row.route === "POST /webhooks/stripe/payment-intent")
  expect(captured).toEqual(
    expect.objectContaining({
      transport_event_type: "payment.captured",
      consumer: "stripe-payment-audit",
      entitlement_instance_state: EntitlementInstanceState.ACTIVE,
      genesis: "ISSUED -> ACTIVE",
    })
  )
  expect(pathY).toEqual(
    expect.objectContaining({
      transport_event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
      consumer: "voucher-live-issue",
      entitlement_instance_state: EntitlementInstanceState.ISSUED,
      genesis: "__genesis__ -> ISSUED",
    })
  )
}

function assertEvidenceMatches(rows: readonly Measurement[]): void {
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
    fixture: Record<string, unknown>
    runs: Measurement[]
    differences: string[]
    verdict_code: string
    negative_controls: Record<string, string>
  }
  expect(evidence.fixture).toEqual(
    expect.objectContaining({
      purchase_fingerprint: FIXTURE_PURCHASE_FINGERPRINT,
      order_id: FIXTURE.orderId,
      line_item_id: FIXTURE.lineItemId,
      line_ordinal: FIXTURE.lineOrdinal,
      quantity: FIXTURE.quantity,
      market_id: FIXTURE.marketId,
      purchase_mode: FIXTURE.purchaseMode,
      recipient_hash: FIXTURE.recipientHash,
    })
  )
  expect(evidence.runs).toHaveLength(2)
  for (const row of rows) {
    const recorded = evidence.runs.find((candidate) => candidate.run_id === row.run_id)
    expect(recorded).toBeDefined()
    expect(recorded).toEqual({ ...row, transaction_id: "<runtime>" })
    expect(recorded?.transaction_id).toBe("<runtime>")
  }
  const expectedDifferences = [
    "route",
    "transport_event_id",
    "transport_event_type",
    "producer",
    "consumer",
    "genesis",
    "entitlement_instance_state",
    "gate_order",
  ]
  const derivedDifferences = Object.keys(rows[0]).filter((key) => {
    if (["run_id", "order_id", "line_item_id", "line_ordinal", "quantity", "instance_id", "market_id", "purchase_mode", "purchase_fingerprint", "voucher_status", "transaction_id", "trigger", "effect"].includes(key)) return false
    return rows[0][key as keyof Measurement] !== rows[1][key as keyof Measurement]
  })
  expect(evidence.differences).toEqual(expectedDifferences)
  expect(derivedDifferences).toEqual(expectedDifferences)
  expect(evidence.verdict_code).toBe("ROUTE_DEPENDENT_GENESIS_OBSERVED")
  expect(evidence.negative_controls).toEqual({
    route_mutation: "FAIL",
    missing_voucher_status: "FAIL",
    reversed_gate_order: "FAIL",
    purchase_identity_mutation: "FAIL",
    trigger_effect_axis_merge: "FAIL",
  })
}

function assertSerializedEvidence(value: string): void {
  const evidence = JSON.parse(value) as {
    fixture: Record<string, unknown>
    runs: Measurement[]
    differences: string[]
  }
  expect(evidence.fixture.purchase_fingerprint).toBe(FIXTURE_PURCHASE_FINGERPRINT)
  expect(evidence.fixture.order_id).toBe(FIXTURE.orderId)
  expect(evidence.fixture.line_item_id).toBe(FIXTURE.lineItemId)
  expect(evidence.runs).toHaveLength(2)
  expect(new Set(evidence.runs.map((run) => run.route))).toEqual(
    new Set(["POST /hooks/payment/stripe", "POST /webhooks/stripe/payment-intent"])
  )
  for (const run of evidence.runs) {
    expect(run.order_id).toBe(FIXTURE.orderId)
    expect(run.line_item_id).toBe(FIXTURE.lineItemId)
    expect(run.line_ordinal).toBe(FIXTURE.lineOrdinal)
    expect(run.quantity).toBe(FIXTURE.quantity)
    expect(run.purchase_fingerprint).toBe(FIXTURE_PURCHASE_FINGERPRINT)
    expect(run.voucher_status).toBe("idle")
    expect(run.trigger).toBeDefined()
    expect(run.effect).toBeDefined()
    expect(run.trigger.id).toBe(run.transport_event_id)
    expect(run.trigger.timestamp).toEqual(expect.any(String))
    expect(run.effect.id).not.toBe(run.trigger.id)
    expect(run.effect.timestamp).toEqual(expect.any(String))
    expect(run.effect.table).toBe("entitlement_instance")
    expect(run.effect.entitlement_state).toBe(run.entitlement_instance_state)
  }
  expect(evidence.differences).toEqual(expect.arrayContaining(["genesis", "gate_order"]))
}

runWithIsolatedDatabase("Story 3.6 AC1 — produkcyjne call-site'y na realnym PostgreSQL", () => {
  let basePool: Pool

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_story_3_6"
    basePool = new Pool({ connectionString: DATABASE_URL, max: 6 })
  })

  afterAll(async () => {
    await basePool?.end()
  })

  it("wykonuje oba call-site'y, odczytuje produkcyjne wiersze i zapisuje pełną proveniencję", async () => {
    const capturedFixture = await makeFixtureClient(basePool)
    const pathYFixture = await makeFixtureClient(basePool)
    try {
      const capturedEvents: unknown[] = []
      const capturedWorkflow = new StripePaymentAuditWorkflow(
        workflowPool(capturedFixture.client),
        { emit: async (event) => capturedEvents.push(event.data) },
        { info() {}, warn() {}, error() {} }
      )
      const capturedResult = await capturedWorkflow.process(
        "payment.captured",
        {
          event_id: "evt_3_6_captured_path",
          request_id: "req_3_6_captured_path",
          payment_intent_id: FIXTURE.paymentIntentId,
          payment_id: "pay_3_6_captured_path",
          order_id: FIXTURE.orderId,
          market_id: FIXTURE.marketId,
          payment_method_type: "card",
          processing_country: "PL",
          amount_minor: PROFILE.amount_minor,
          currency: PROFILE.currency,
          entitlement_profile: PROFILE,
        },
        new Date(FIXTURE.eventTimes.captured)
      )
      expect(capturedResult.deduplicated).toBe(false)
      expect(capturedResult.transition_events).toHaveLength(1)
      expect(capturedEvents).toHaveLength(1)

      const pathYEvents: unknown[] = []
      const subscriberContainer = {
        resolve: (key: string): unknown => {
          if (key === "__pg_pool__") return workflowPool(pathYFixture.client)
          if (key === "logger") return { info() {}, warn() {}, error() {} }
          if (key === Modules.EVENT_BUS) return { emit: async (event: unknown) => pathYEvents.push(event) }
          throw new Error(`unresolved ${key}`)
        },
      }
      const routeScope = {
        resolve: (key: string): unknown => {
          if (key === "__pg_pool__") return workflowPool(pathYFixture.client)
          if (key === "logger") return { info() {}, warn() {}, error() {} }
          if (key === Modules.EVENT_BUS) {
            return {
              emit: async (event: { name: string; data: unknown }) => {
                expect(event.name).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
                await voucherLiveIssueSubscriber({
                  event: { name: event.name, data: event.data },
                  container: subscriberContainer,
                } as never)
              },
            }
          }
          throw new Error(`unresolved ${key}`)
        },
      }
      const rawBody = JSON.stringify(stripeEvent())
      const response = makeResponse()
      await POST(
        {
          rawBody: Buffer.from(rawBody),
          headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
          scope: routeScope,
        } as never,
        response as never
      )
      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual(expect.objectContaining({ emitted: PAYMENT_INTENT_SUCCEEDED_EVENT }))
      expect(pathYEvents).toHaveLength(1)

      const captured = await readMeasurement(
        capturedFixture.client,
        capturedFixture.trace,
        "run_3_6_captured_path",
        "POST /hooks/payment/stripe",
        "evt_3_6_captured_path",
        "payment.captured",
        "Medusa native Stripe hook",
        "stripe-payment-audit",
        (capturedResult.transition_events as unknown as Array<Record<string, unknown>>)[0],
        FIXTURE.eventTimes.captured
      )
      const pathY = await readMeasurement(
        pathYFixture.client,
        pathYFixture.trace,
        "run_3_6_path_y",
        "POST /webhooks/stripe/payment-intent",
        "evt_3_6_path_y",
        PAYMENT_INTENT_SUCCEEDED_EVENT,
        "GP Path Y payment-intent webhook",
        "voucher-live-issue",
        (pathYEvents[0] as { data: Record<string, unknown> }).data,
        FIXTURE.eventTimes.pathY
      )
      const rows = [captured, pathY]
      assertMeasurementSet(rows)
      assertEvidenceMatches(rows)
    } finally {
      await capturedFixture.client.query("DROP TABLE IF EXISTS event_processed, webhook_event_processed, voucher_event, voucher, entitlement_instance, order_item, order_line_item, product_product_seller_seller, seller, product, payment_session, order_payment_collection, \"order\", sales_channel CASCADE")
      await pathYFixture.client.query("DROP TABLE IF EXISTS event_processed, webhook_event_processed, voucher_event, voucher, entitlement_instance, order_item, order_line_item, product_product_seller_seller, seller, product, payment_session, order_payment_collection, \"order\", sales_channel CASCADE")
      capturedFixture.client.release()
      pathYFixture.client.release()
    }
  })

})

describe("Story 3.6 AC1 — ujemne kontrole evidence", () => {
  it("odrzuca mutacje serializowanego evidence, tożsamości zakupu i zlania osi", () => {
    const raw = readFileSync(EVIDENCE_PATH, "utf8")
    const evidence = JSON.parse(raw) as Record<string, unknown>
    const runs = evidence.runs as Array<Record<string, unknown>>
    const routeMutant = JSON.parse(raw) as Record<string, unknown>
    ;(routeMutant.runs as Array<Record<string, unknown>>)[0].route = "POST /wrong"
    const missingLayerMutant = JSON.parse(raw) as Record<string, unknown>
    ;(missingLayerMutant.runs as Array<Record<string, unknown>>)[0].voucher_status = null
    const orderIdentityMutant = JSON.parse(raw) as Record<string, unknown>
    ;(orderIdentityMutant.fixture as Record<string, unknown>).line_item_id = "li_other_purchase"
    const axisMergeMutant = JSON.parse(raw) as Record<string, unknown>
    const axisMergeRun = (axisMergeMutant.runs as Array<Record<string, unknown>>)[0]
    const axisMergeEffect = axisMergeRun.effect as Record<string, unknown>
    const axisMergeTrigger = axisMergeRun.trigger as Record<string, unknown>
    axisMergeEffect.id = axisMergeTrigger.id
    expect(() => assertSerializedEvidence(JSON.stringify(routeMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(missingLayerMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(orderIdentityMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(axisMergeMutant))).toThrow()
    expect(runs).toHaveLength(2)
  })
})

describe("Story 3.6 AC1 — precondition PostgreSQL", () => {
  it("wymaga jawnego, lokalnego URL bazy tej story zgodnego z DATABASE_URL", () => {
    expect(HAS_TRUSTED_STORY_TEST_DATABASE_URL).toBe(true)
  })

  it("odrzuca produkcyjny host i obcą bazę testową", () => {
    const safe = "postgres://test_runner:secret@localhost:5432/gp_story_3_6_test"
    expect(hasTrustedStoryTestDatabaseUrl(safe, safe)).toBe(true)
    expect(
      hasTrustedStoryTestDatabaseUrl(
        "postgres://prod_role:secret@prod-db.internal:5432/gp_story_3_6_test",
        "postgres://prod_role:secret@prod-db.internal:5432/gp_story_3_6_test"
      )
    ).toBe(false)
    expect(
      hasTrustedStoryTestDatabaseUrl(
        "postgres://test_runner:secret@localhost:5432/gp_mercur_test",
        "postgres://test_runner:secret@localhost:5432/gp_mercur_test"
      )
    ).toBe(false)
  })
})
