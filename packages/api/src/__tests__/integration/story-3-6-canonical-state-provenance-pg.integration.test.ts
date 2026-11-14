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
import { Migration1778925265229 } from "../../modules/voucher/migrations/1778925265229_add_booking_pointer_to_entitlement_instance"
import { Migration1778925346721 } from "../../modules/voucher/migrations/1778925346721_add_voucher_policy_extension"
import { Migration1778925400000AddMarketIdToEntitlementInstance } from "../../modules/voucher/migrations/1778925400000_add_market_id_to_entitlement_instance"
import { Migration1778925500000 } from "../../modules/voucher/migrations/1778925500000_add_line_item_id_to_entitlement_instance"
import { Migration1778926000000 } from "../../modules/voucher/migrations/1778926000000_extend_entitlement_instance_check_constraints"
import { Migration1778926100000 } from "../../modules/voucher/migrations/1778926100000_add_voucher_expired_status_and_recipient_columns"
import { Migration1778926200000 } from "../../modules/voucher/migrations/1778926200000_add_claim_token_to_entitlement_instance"
import { Migration1778928100000 } from "../../modules/voucher/migrations/1778928100000_add_vat_classification_and_ontology_fk"
import { Migration1778928200000 } from "../../modules/voucher/migrations/1778928200000_add_entitlement_dedupe_key_and_recipient_index"
import { Migration1778928300000 } from "../../modules/voucher/migrations/1778928300000_tighten_sales_channel_scope_live_issue"
import { Migration1778930000000 } from "../../modules/voucher/migrations/1778930000000_add_claim_token_ttl_to_entitlement_instance"
import { Migration1778932000000 } from "../../modules/voucher/migrations/1778932000000_add_reference_price_and_choice_set"
import { Migration1779000000000 } from "../../modules/voucher/migrations/1779000000000_enable_rls_on_voucher_module_tables"
import { Migration1779008000000 } from "../../modules/voucher/migrations/1779008000000_add_voucher_refunded_status"
import { EntitlementInstanceState } from "../../modules/voucher/models/entitlement"
import voucherLiveIssueSubscriber from "../../subscribers/voucher-live-issue"
import { createStripePaymentAuditWorkflowFromScope } from "../../workflows/payment/stripe-payment-audit"

const STORY_TEST_DATABASE_URL_ENV = "GP_STORY_3_6_TEST_DATABASE_URL"
const TRUSTED_STORY_TEST_DATABASE_NAMES = new Set([
  "gp_story_3_6_test",
  "gp_story_3_6_c4_test",
  "gp_story_3_6_c5_test",
])
const DATABASE_URL = process.env[STORY_TEST_DATABASE_URL_ENV]
const EVIDENCE_PATH = resolve(
  process.cwd(),
  "../../_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/3-6/canonical-state-provenance.json"
)

const FIXTURE_INSTANCE_ID = "instance_3_6"
const PATH_Y_EFFECT_TIME = "2026-09-06T00:01:00.001Z"
const NON_DATE_TIMERS = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const

const FIXTURE = {
  orderId: "order_3_6_same_purchase",
  lineItemId: "li_3_6_same_purchase",
  lineOrdinal: 0,
  quantity: 1,
  marketId: "bonbeauty",
  purchaseMode: "gift",
  paymentIntentId: "pi_3_6_same_purchase",
  recipientId: "recipient_3_6_redacted",
  recipientHash: `sha256:${createHash("sha256").update("recipient_3_6_redacted").digest("hex")}`,
  eventTimes: {
    captured: "2026-09-06T00:00:00.000Z",
    pathY: "2026-09-06T00:01:00.000Z",
  },
} as const

type PurchaseIdentity = {
  order_id: string
  line_item_id: string
  line_ordinal: number
  quantity: number
  market_id: string
  purchase_mode: string
  recipient_hash: string
}

function purchaseFingerprint(identity: PurchaseIdentity): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
}

const FIXTURE_PURCHASE_FINGERPRINT = purchaseFingerprint({
  order_id: FIXTURE.orderId,
  line_item_id: FIXTURE.lineItemId,
  line_ordinal: FIXTURE.lineOrdinal,
  quantity: FIXTURE.quantity,
  market_id: FIXTURE.marketId,
  purchase_mode: FIXTURE.purchaseMode,
  recipient_hash: FIXTURE.recipientHash,
})

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

async function collectUpSql(
  MigrationClass: { prototype: object },
  sessionLocalTables = false
): Promise<string[]> {
  const sqls: string[] = []
  const migration = Object.create(MigrationClass.prototype) as {
    addSql: (sql: string) => void
    up: () => Promise<void>
  }
  migration.addSql = (sql) => sqls.push(sql)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migration.up()
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
      TRUSTED_STORY_TEST_DATABASE_NAMES.has(databaseName) &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  } catch {
    return false
  }
}

const HAS_TRUSTED_STORY_TEST_DATABASE_URL = hasTrustedStoryTestDatabaseUrl(DATABASE_URL)
const runWithIsolatedDatabase = HAS_TRUSTED_STORY_TEST_DATABASE_URL ? describe : describe.skip

function signedHeader(rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac("sha256", "story_3_6_test_webhook_secret")
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

function stripeEvent(eventId = "evt_3_6_path_y") {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: Math.floor(new Date(FIXTURE.eventTimes.pathY).getTime() / 1000),
    data: {
      object: {
        id: FIXTURE.paymentIntentId,
        amount: PROFILE.amount_minor,
        amount_received: PROFILE.amount_minor,
        currency: "pln",
        created: Math.floor(new Date(FIXTURE.eventTimes.pathY).getTime() / 1000),
        metadata: {
          instance_id: "instance_3_6",
          session_id: "payses_3_6_same_purchase",
        },
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
      if (normalized === "begin" && trace.transactionId === null) {
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
    release: () => undefined,
  } as PoolClient
}

async function createFixtureSchema(client: PoolClient): Promise<void> {
  const publicEventProcessed = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'event_processed'
      ORDER BY ordinal_position`
  )
  expect(publicEventProcessed.rows.map((row) => row.column_name)).toEqual(
    expect.arrayContaining(["external_id", "event_type", "purchase_key", "market_id", "instance_id"])
  )
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
    Migration1778925265229,
    Migration1778925346721,
    Migration1778925400000AddMarketIdToEntitlementInstance,
    Migration1778925500000,
    Migration1778926000000,
    Migration1778926100000,
    Migration1778926200000,
    Migration1778928100000,
    Migration1778928200000,
    Migration1778928300000,
    Migration1778930000000,
    Migration1778932000000,
    Migration1779000000000,
    Migration1779008000000,
    Migration20260516000000StripePathYWebhookEventProcessed,
  ]) {
    for (const sql of await collectUpSql(MigrationClass, true)) await client.query(sql)
  }
  await client.query(`
    CREATE TEMP TABLE money_path_compensation_failure (
      failure_id text PRIMARY KEY,
      market_id text,
      compensation_kind text NOT NULL,
      delivery_path text NOT NULL,
      stripe_event_id text NOT NULL,
      payment_intent_id text NOT NULL,
      order_id text,
      purchase_correlation_key text NOT NULL,
      failure_code text NOT NULL,
      failure_detail text NOT NULL,
      occurred_at timestamptz NOT NULL,
      attempt_count integer NOT NULL,
      last_attempt_at timestamptz NOT NULL,
      resolution_state text NOT NULL
    )
  `)
  await client.query("INSERT INTO sales_channel (id, metadata) VALUES ('sc_3_6', $1::jsonb)", [
    JSON.stringify({ gp_market_id: FIXTURE.marketId }),
  ])
  await client.query(
    "INSERT INTO \"order\" (id, sales_channel_id, metadata) VALUES ($1, 'sc_3_6', $2::jsonb)",
    [
      FIXTURE.orderId,
      JSON.stringify({ gp: { market_id: FIXTURE.marketId }, purchase_mode: FIXTURE.purchaseMode }),
    ]
  )
  await client.query(
    "INSERT INTO payment_session (id, payment_collection_id, data) VALUES ('payses_3_6_same_purchase', 'paycol_3_6', $1::jsonb)",
    [JSON.stringify({ id: FIXTURE.paymentIntentId })]
  )
  await client.query(
    "INSERT INTO order_payment_collection (order_id, payment_collection_id) VALUES ($1, 'paycol_3_6')",
    [FIXTURE.orderId]
  )
  await client.query("INSERT INTO seller (id, name, handle) VALUES ('seller_3_6', 'Salon testowy', 'salon-testowy')")
  await client.query("INSERT INTO product (id, title, metadata) VALUES ('prod_3_6', 'Zabieg testowy', '{}'::jsonb)")
  await client.query("INSERT INTO product_product_seller_seller (product_id, seller_id) VALUES ('prod_3_6', 'seller_3_6')")
  await client.query(
    "INSERT INTO order_line_item (id, product_id, unit_price, title, metadata) VALUES ($1, 'prod_3_6', $2, 'Zabieg testowy', $3::jsonb)",
    [
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
        gp_purchase: { line_ordinal: FIXTURE.lineOrdinal, quantity: FIXTURE.quantity },
      }),
    ]
  )
  await client.query("INSERT INTO order_item (order_id, item_id, created_at) VALUES ($1, $2, $3)", [
    FIXTURE.orderId,
    FIXTURE.lineItemId,
    new Date("2026-09-06T00:00:00.000Z"),
  ])
  await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pg_temp TO medusa_store")
  await client.query("SET ROLE medusa_store")
  await client.query("SELECT set_config('app.gp_market_id', $1, false)", [FIXTURE.marketId])
  await client.query("SELECT set_config('app.gp_instance_id', $1, false)", ["instance_3_6"])
  await client.query("COMMIT")
}

async function makeFixtureClient(basePool: Pool): Promise<{
  client: PoolClient
  trace: Trace
  release: () => void
}> {
  const rawClient = await basePool.connect()
  try {
    await createFixtureSchema(rawClient)
  } catch (error) {
    rawClient.release()
    throw error
  }
  const trace: Trace = { transactionId: null, sqlLabels: [] }
  return { client: makeTrackedClient(rawClient, trace), trace, release: rawClient.release.bind(rawClient) }
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
    order_id: string
    line_item_id: string
    market_id: string
    recipient_customer_id: string | null
    order_metadata: { purchase_mode?: unknown }
    line_metadata: { gp_purchase?: { line_ordinal?: unknown; quantity?: unknown } }
    created_at: Date
  }>(
    `SELECT ei.id, ei.state, v.status, ei.order_id, ei.line_item_id, ei.market_id,
            ei.recipient_customer_id, o.metadata AS order_metadata,
            oli.metadata AS line_metadata, ei.created_at
       FROM entitlement_instance ei
       LEFT JOIN voucher v ON v.code = ei.policy_snapshot->>'voucher_code'
       JOIN "order" o ON o.id = ei.order_id
       JOIN order_line_item oli ON oli.id = ei.line_item_id
      WHERE ei.order_id = $1 AND ei.line_item_id = $2
      ORDER BY ei.created_at`,
    [FIXTURE.orderId, FIXTURE.lineItemId]
  )
  expect(result.rowCount).toBe(1)
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
  expect(typeof row.order_metadata.purchase_mode).toBe("string")
  expect(typeof row.line_metadata.gp_purchase?.line_ordinal).toBe("number")
  expect(typeof row.line_metadata.gp_purchase?.quantity).toBe("number")
  expect(row.recipient_customer_id).toEqual(expect.any(String))
  const purchaseIdentity: PurchaseIdentity = {
    order_id: row.order_id,
    line_item_id: row.line_item_id,
    line_ordinal: row.line_metadata.gp_purchase?.line_ordinal as number,
    quantity: row.line_metadata.gp_purchase?.quantity as number,
    market_id: row.market_id,
    purchase_mode: row.order_metadata.purchase_mode as string,
    recipient_hash: `sha256:${createHash("sha256").update(row.recipient_customer_id as string).digest("hex")}`,
  }
  const gateOrder = [
    transitionPayload.from_state === "__genesis__"
      ? "entitlement_genesis"
      : "entitlement_state_guard",
    ...trace.sqlLabels,
  ]
  expect(gateOrder).toEqual([
    transitionPayload.from_state === "__genesis__"
      ? "entitlement_genesis"
      : "entitlement_state_guard",
    "entitlement_state_persist",
    "voucher_projection",
  ])

  const effect: Measurement["effect"] = {
    id: row.id,
    timestamp: row.created_at.toISOString(),
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
    order_id: purchaseIdentity.order_id,
    line_item_id: purchaseIdentity.line_item_id,
    line_ordinal: purchaseIdentity.line_ordinal,
    quantity: purchaseIdentity.quantity,
    instance_id: row.id,
    market_id: purchaseIdentity.market_id,
    purchase_mode: purchaseIdentity.purchase_mode,
    purchase_fingerprint: purchaseFingerprint(purchaseIdentity),
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
  expect(captured).toBeDefined()
  expect(pathY).toBeDefined()
  for (const field of [
    "order_id",
    "line_item_id",
    "line_ordinal",
    "quantity",
    "market_id",
    "purchase_mode",
    "purchase_fingerprint",
  ] as const) {
    expect(captured?.[field]).toBe(pathY?.[field])
  }
  for (const row of rows) {
    expect(Date.parse(row.effect.timestamp)).toBeGreaterThanOrEqual(Date.parse(row.trigger.timestamp))
  }
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

function assertEvidenceMatches(
  rows: readonly Measurement[],
  serialized: string = readFileSync(EVIDENCE_PATH, "utf8")
): void {
  const evidence = JSON.parse(serialized) as {
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
      isolation: expect.stringContaining("two independent PostgreSQL sessions"),
      transaction_scope: expect.stringContaining("runtime transaction_id"),
    })
  )
  expect(evidence.runs).toHaveLength(2)
  for (const row of rows) {
    const recorded = evidence.runs.find((candidate) => candidate.run_id === row.run_id)
    expect(recorded).toBeDefined()
    expect(recorded).toEqual(
      expect.objectContaining({
        ...row,
        transaction_id: "<runtime>",
        effect: expect.objectContaining({ ...row.effect }),
      })
    )
    expect(recorded?.transaction_id).toBe("<runtime>")
    // 3-6-C5-N001: the serialized effect timestamp must equal the persisted entitlement_instance.created_at.
    expect(recorded?.effect.timestamp).toBe(row.effect.timestamp)
    expect(Date.parse(recorded?.effect.timestamp ?? "")).toBeGreaterThanOrEqual(
      Date.parse(recorded?.trigger.timestamp ?? "")
    )
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
    adr_219_status: string
    decision: string
    measurement_status: string
    sensitive_data: string
    fixture: Record<string, unknown>
    runs: Measurement[]
    differences: string[]
  }
  expect(Object.keys(evidence).sort()).toEqual([
    "adr_219_status",
    "decision",
    "differences",
    "fixture",
    "measurement_status",
    "negative_controls",
    "release",
    "runs",
    "sensitive_data",
    "story",
    "verdict_code",
  ])
  expect(evidence.measurement_status).toBe("observed")
  expect(evidence.adr_219_status).toBe("proposed")
  expect(evidence.decision).toBe("not_ratified")
  expect(evidence.sensitive_data).toBe(
    "recipient represented only by hash; no raw recipient, token, provider secret or email stored"
  )
  expect(evidence.fixture.purchase_fingerprint).toBe(FIXTURE_PURCHASE_FINGERPRINT)
  expect(evidence.fixture.order_id).toBe(FIXTURE.orderId)
  expect(evidence.fixture.line_item_id).toBe(FIXTURE.lineItemId)
  expect(evidence.fixture.recipient_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(evidence.fixture.isolation).toBe(
    "two independent PostgreSQL sessions; production event_processed schema is migrated in the isolated database, while voucher fixtures load production voucher DDL into session-local tables and each runs one production call-site transaction"
  )
  expect(evidence.fixture.transaction_scope).toBe("runtime transaction_id is captured by the integration test; the serialized artifact keeps the run-scoped marker <runtime>")
  expect(Object.keys(evidence.fixture).sort()).toEqual([
    "isolation",
    "line_item_id",
    "line_ordinal",
    "market_id",
    "order_id",
    "purchase_fingerprint",
    "purchase_mode",
    "quantity",
    "recipient_hash",
    "transaction_scope",
  ])
  expect(evidence.runs).toHaveLength(2)
  expect(new Set(evidence.runs.map((run) => run.route))).toEqual(
    new Set(["POST /hooks/payment/stripe", "POST /webhooks/stripe/payment-intent"])
  )
  for (const run of evidence.runs) {
    expect(Object.keys(run).sort()).toEqual([
      "consumer",
      "effect",
      "entitlement_instance_state",
      "gate_order",
      "genesis",
      "instance_id",
      "line_item_id",
      "line_ordinal",
      "market_id",
      "order_id",
      "producer",
      "purchase_fingerprint",
      "purchase_mode",
      "quantity",
      "route",
      "run_id",
      "transaction_id",
      "transport_event_id",
      "transport_event_type",
      "trigger",
      "voucher_status",
    ])
    expect(run.order_id).toBe(FIXTURE.orderId)
    expect(run.line_item_id).toBe(FIXTURE.lineItemId)
    expect(run.line_ordinal).toBe(FIXTURE.lineOrdinal)
    expect(run.quantity).toBe(FIXTURE.quantity)
    expect(run.purchase_fingerprint).toBe(FIXTURE_PURCHASE_FINGERPRINT)
    expect(run.voucher_status).toBe("idle")
    expect(run.trigger).toBeDefined()
    expect(run.effect).toBeDefined()
    expect(Object.keys(run.trigger).sort()).toEqual(["consumer", "id", "producer", "timestamp", "verdict"])
    expect(Object.keys(run.effect).sort()).toEqual([
      "consumer",
      "entitlement_state",
      "id",
      "producer",
      "table",
      "timestamp",
      "verdict",
      "voucher_status",
    ])
    expect(run.trigger.id).toBe(run.transport_event_id)
    expect(run.trigger.timestamp).toEqual(expect.any(String))
    expect(run.effect.id).not.toBe(run.trigger.id)
    expect(run.effect.timestamp).toEqual(expect.any(String))
    expect(Date.parse(run.effect.timestamp)).toBeGreaterThanOrEqual(Date.parse(run.trigger.timestamp))
    expect(run.effect.table).toBe("entitlement_instance")
    expect(run.effect.entitlement_state).toBe(run.entitlement_instance_state)
    expect(run.gate_order).toEqual([
      run.genesis.startsWith("__genesis__") ? "entitlement_genesis" : "entitlement_state_guard",
      "entitlement_state_persist",
      "voucher_projection",
    ])
  }
  expect(evidence.differences).toEqual(expect.arrayContaining(["genesis", "gate_order"]))
}

runWithIsolatedDatabase("Story 3.6 AC1 — produkcyjne call-site'y na realnym PostgreSQL", () => {
  let basePool: Pool
  let previousInstanceId: string | undefined

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "story_3_6_test_webhook_secret"
    // Story 3.1 C3-SEC-002: Path Y refuses (500 instance_unconfigured) without a
    // server-side GP_INSTANCE_ID; the harness sets the fixture instance explicitly.
    previousInstanceId = process.env.GP_INSTANCE_ID
    process.env.GP_INSTANCE_ID = FIXTURE_INSTANCE_ID
    basePool = new Pool({ connectionString: DATABASE_URL, max: 6 })
  })

  afterAll(async () => {
    if (previousInstanceId === undefined) delete process.env.GP_INSTANCE_ID
    else process.env.GP_INSTANCE_ID = previousInstanceId
    await basePool?.end()
  })

  it("wykonuje oba call-site'y, odczytuje produkcyjne wiersze i zapisuje pełną proveniencję", async () => {
    const capturedFixture = await makeFixtureClient(basePool)
    const pathYFixture = await makeFixtureClient(basePool)
    try {
      const capturedEvents: unknown[] = []
      const capturedWorkflow = createStripePaymentAuditWorkflowFromScope({
        resolve: (key: string): unknown => {
          if (key === "__pg_pool__") return workflowPool(capturedFixture.client)
          if (key === Modules.EVENT_BUS) return { emit: async (event: { data: unknown }) => capturedEvents.push(event.data) }
          if (key === "logger") return { info() {}, warn() {}, error() {} }
          throw new Error(`unresolved ${key}`)
        },
      })
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
      expect(capturedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event_type: "gp.entitlements.entitlement_state_changed.v1" }),
        ])
      )
      const capturedReplay = await capturedWorkflow.process(
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
      expect(capturedReplay.deduplicated).toBe(true)

      const pathYEvents: unknown[] = []
      const pathYLogs: string[] = []
      const pathYLogger = {
        info(message: unknown) {
          pathYLogs.push(`info: ${String(message)}`)
        },
        warn(message: unknown) {
          pathYLogs.push(`warn: ${String(message)}`)
        },
        error(message: unknown) {
          pathYLogs.push(`error: ${String(message)}`)
        },
      }
      const subscriberContainer = {
        resolve: (key: string): unknown => {
          if (key === "__pg_pool__") return workflowPool(pathYFixture.client)
          if (key === "logger") return pathYLogger
          if (key === Modules.EVENT_BUS) return { emit: async (event: unknown) => pathYEvents.push(event) }
          throw new Error(`unresolved ${key}`)
        },
      }
      const routeScope = {
        resolve: (key: string): unknown => {
          if (key === "__pg_pool__") return workflowPool(pathYFixture.client)
          if (key === "logger") return pathYLogger
          if (key === Modules.EVENT_BUS) {
            return {
              emit: async (event: { name: string; data: unknown }) => {
                expect(event.name).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
                // 3-6-C5-N001: the subscriber stamps entitlement_instance.created_at
                // from `new Date()`; freeze only Date so the persisted effect time is
                // deterministic and comparable byte-for-byte with serialized evidence.
                jest.useFakeTimers({ now: new Date(PATH_Y_EFFECT_TIME), doNotFake: NON_DATE_TIMERS })
                try {
                  await voucherLiveIssueSubscriber({
                    event: { name: event.name, data: event.data },
                    container: subscriberContainer,
                  } as never)
                } finally {
                  jest.useRealTimers()
                }
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
      if (response.statusCode !== 200) {
        throw new Error(
          `Path Y returned ${response.statusCode}: ${JSON.stringify(response.body)}; ` +
            `logs=${JSON.stringify(pathYLogs)}`
        )
      }
      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual(expect.objectContaining({ emitted: PAYMENT_INTENT_SUCCEEDED_EVENT }))
      expect(pathYEvents).toHaveLength(1)
      const businessReplayRawBody = JSON.stringify(stripeEvent("evt_3_6_path_y_business_replay"))
      const businessReplayResponse = makeResponse()
      await POST(
        {
          rawBody: Buffer.from(businessReplayRawBody),
          headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(businessReplayRawBody) },
          scope: routeScope,
        } as never,
        businessReplayResponse as never
      )
      expect(businessReplayResponse.statusCode).toBe(200)
      expect(businessReplayResponse.body).toEqual(
        expect.objectContaining({ emitted: PAYMENT_INTENT_SUCCEEDED_EVENT })
      )
      expect(pathYEvents).toHaveLength(1)
      const businessDedupe = await pathYFixture.client.query<{
        instance_id: string
        market_id: string
        purchase_key: string
      }>(
        `SELECT instance_id, market_id, purchase_key
           FROM public.event_processed
          WHERE external_id = $1 AND event_type = $2`,
        [`${FIXTURE.paymentIntentId}:${FIXTURE.orderId}`, PAYMENT_INTENT_SUCCEEDED_EVENT]
      )
      expect(businessDedupe.rows).toEqual([
        {
          instance_id: "instance_3_6",
          market_id: FIXTURE.marketId,
          purchase_key: FIXTURE.paymentIntentId,
        },
      ])

      await pathYFixture.client.query("BEGIN")
      try {
        await pathYFixture.client.query("SELECT set_config('app.gp_market_id', $1, true)", ["other-market"])
        const foreignRead = await pathYFixture.client.query(
          `SELECT external_id FROM public.event_processed
            WHERE external_id = $1 AND event_type = $2`,
          [`${FIXTURE.paymentIntentId}:${FIXTURE.orderId}`, PAYMENT_INTENT_SUCCEEDED_EVENT]
        )
        expect(foreignRead.rows).toHaveLength(0)
        await expect(
          pathYFixture.client.query(
            `INSERT INTO public.event_processed
              (external_id, event_type, processed_at, purchase_key, instance_id, market_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              "pi_3_6_cross_market:order_3_6_cross_market",
              PAYMENT_INTENT_SUCCEEDED_EVENT,
              Date.now(),
              "pi_3_6_cross_market",
              "instance_3_6",
              FIXTURE.marketId,
            ]
          )
        ).rejects.toThrow(/row-level security/)
      } finally {
        await pathYFixture.client.query("ROLLBACK")
      }
      const replayResponse = makeResponse()
      await POST(
        {
          rawBody: Buffer.from(rawBody),
          headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
          scope: routeScope,
        } as never,
        replayResponse as never
      )
      expect(replayResponse.statusCode).toBe(200)
      expect(replayResponse.body).toEqual(expect.objectContaining({ duplicate: true }))
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
      // 3-6-C5-N001 mutant: a shifted effect date in serialized evidence must turn the comparison red.
      const effectDateMutant = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as { runs: Measurement[] }
      const mutatedEffect = effectDateMutant.runs[0].effect
      mutatedEffect.timestamp = new Date(Date.parse(mutatedEffect.timestamp) + 1000).toISOString()
      expect(() => assertEvidenceMatches(rows, JSON.stringify(effectDateMutant))).toThrow()
    } finally {
      await capturedFixture.client.query("RESET ROLE")
      await pathYFixture.client.query("RESET ROLE")
      await pathYFixture.client.query(
        `DELETE FROM event_processed
          WHERE external_id = $1 AND event_type = $2`,
        [`${FIXTURE.paymentIntentId}:${FIXTURE.orderId}`, PAYMENT_INTENT_SUCCEEDED_EVENT]
      )
      await capturedFixture.client.query("DROP TABLE IF EXISTS webhook_event_processed, voucher_event, voucher, entitlement_instance, order_item, order_line_item, product_product_seller_seller, seller, product, payment_session, order_payment_collection, \"order\", sales_channel CASCADE")
      await pathYFixture.client.query("DROP TABLE IF EXISTS webhook_event_processed, voucher_event, voucher, entitlement_instance, order_item, order_line_item, product_product_seller_seller, seller, product, payment_session, order_payment_collection, \"order\", sales_channel CASCADE")
      capturedFixture.release()
      pathYFixture.release()
    }
  })

})

describe("Story 3.6 AC1 — ujemne kontrole evidence", () => {
  it("odrzuca mutacje serializowanego evidence, tożsamości zakupu, kolejności i wycieków", () => {
    const raw = readFileSync(EVIDENCE_PATH, "utf8")
    const evidence = JSON.parse(raw) as Record<string, unknown>
    const runs = evidence.runs as Array<Record<string, unknown>>
    const routeMutant = JSON.parse(raw) as Record<string, unknown>
    ;(routeMutant.runs as Array<Record<string, unknown>>)[0].route = "POST /wrong"
    const missingLayerMutant = JSON.parse(raw) as Record<string, unknown>
    ;(missingLayerMutant.runs as Array<Record<string, unknown>>)[0].voucher_status = null
    const orderIdentityMutant = JSON.parse(raw) as Record<string, unknown>
    ;(orderIdentityMutant.fixture as Record<string, unknown>).line_item_id = "li_other_purchase"
    const isolationMutant = JSON.parse(raw) as Record<string, unknown>
    ;(isolationMutant.fixture as Record<string, unknown>).isolation = "shared database state"
    const axisMergeMutant = JSON.parse(raw) as Record<string, unknown>
    const axisMergeRun = (axisMergeMutant.runs as Array<Record<string, unknown>>)[0]
    const axisMergeEffect = axisMergeRun.effect as Record<string, unknown>
    const axisMergeTrigger = axisMergeRun.trigger as Record<string, unknown>
    axisMergeEffect.id = axisMergeTrigger.id
    const gateOrderMutant = JSON.parse(raw) as Record<string, unknown>
    const gateOrder = (gateOrderMutant.runs as Array<Record<string, unknown>>)[0].gate_order as string[]
    ;[gateOrder[0], gateOrder[2]] = [gateOrder[2], gateOrder[0]]
    const piiMutant = JSON.parse(raw) as Record<string, unknown>
    ;(piiMutant.runs as Array<Record<string, unknown>>)[0].recipient_email = "recipient@example.test"
    const fixturePiiMutant = JSON.parse(raw) as Record<string, unknown>
    ;(fixturePiiMutant.fixture as Record<string, unknown>).recipient_email = "recipient@example.test"
    const effectSecretMutant = JSON.parse(raw) as Record<string, unknown>
    ;((effectSecretMutant.runs as Array<Record<string, unknown>>)[0].effect as Record<string, unknown>).provider_secret = "not-a-secret"
    const adrStatusMutant = JSON.parse(raw) as Record<string, unknown>
    adrStatusMutant.adr_219_status = "ratified"
    const decisionMutant = JSON.parse(raw) as Record<string, unknown>
    decisionMutant.decision = "ratified"
    const sensitiveDataMutant = JSON.parse(raw) as Record<string, unknown>
    sensitiveDataMutant.sensitive_data = "raw recipient email retained"
    const recipientHashMutant = JSON.parse(raw) as Record<string, unknown>
    ;(recipientHashMutant.fixture as Record<string, unknown>).recipient_hash = "recipient@example.test"
    expect(() => assertSerializedEvidence(JSON.stringify(routeMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(missingLayerMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(orderIdentityMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(isolationMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(axisMergeMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(gateOrderMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(piiMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(fixturePiiMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(effectSecretMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(adrStatusMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(decisionMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(sensitiveDataMutant))).toThrow()
    expect(() => assertSerializedEvidence(JSON.stringify(recipientHashMutant))).toThrow()
    expect(runs).toHaveLength(2)
  })
})

describe("Story 3.6 AC1 — precondition PostgreSQL", () => {
  it("wymaga jawnego, lokalnego URL bazy tej story zgodnego z DATABASE_URL", () => {
    expect(HAS_TRUSTED_STORY_TEST_DATABASE_URL).toBe(true)
  })

  it("odrzuca produkcyjny host i obcą bazę testową", () => {
    const historicalSafe = "postgres://test_runner@localhost:5432/gp_story_3_6_test"
    const cycleFourSafe = "postgres://test_runner@localhost:5432/gp_story_3_6_c4_test"
    expect(hasTrustedStoryTestDatabaseUrl(historicalSafe, historicalSafe)).toBe(true)
    expect(hasTrustedStoryTestDatabaseUrl(cycleFourSafe, cycleFourSafe)).toBe(true)
    expect(
      hasTrustedStoryTestDatabaseUrl(
        "postgres://prod_role@prod-db.internal:5432/gp_story_3_6_test",
        "postgres://prod_role@prod-db.internal:5432/gp_story_3_6_test"
      )
    ).toBe(false)
    expect(
      hasTrustedStoryTestDatabaseUrl(
        "postgres://test_runner@localhost:5432/gp_mercur_test",
        "postgres://test_runner@localhost:5432/gp_mercur_test"
      )
    ).toBe(false)
    expect(
      hasTrustedStoryTestDatabaseUrl(
        "postgres://test_runner@localhost:5432/gp_story_3_6_c4_test_extra",
        "postgres://test_runner@localhost:5432/gp_story_3_6_c4_test_extra"
      )
    ).toBe(false)
  })
})

describe("Story 3.6 AC1 — odrzucenie transportu Path Y", () => {
  it("odrzuca brak lub naruszenie podpisu oraz podpisany payload bez wymaganych identyfikatorów", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "story_3_6_test_webhook_secret"
    const rawBody = JSON.stringify(stripeEvent())
    const missingSignatureResponse = makeResponse()
    await POST(
      { rawBody: Buffer.from(rawBody), headers: {}, scope: { resolve() { throw new Error("scope must not be used") } } } as never,
      missingSignatureResponse as never
    )
    expect(missingSignatureResponse.statusCode).toBe(400)
    expect(missingSignatureResponse.body).toEqual(expect.objectContaining({ type: "invalid_signature" }))

    const tamperedBody = JSON.stringify({
      ...stripeEvent(),
      data: { object: { ...stripeEvent().data.object, amount: PROFILE.amount_minor + 1 } },
    })
    const tamperedResponse = makeResponse()
    await POST(
      {
        rawBody: Buffer.from(tamperedBody),
        headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
        scope: { resolve() { throw new Error("scope must not be used") } },
      } as never,
      tamperedResponse as never
    )
    expect(tamperedResponse.statusCode).toBe(400)
    expect(tamperedResponse.body).toEqual(expect.objectContaining({ type: "invalid_signature" }))

    const malformedBody = JSON.stringify({ ...stripeEvent(), id: "" })
    const malformedResponse = makeResponse()
    await POST(
      {
        rawBody: Buffer.from(malformedBody),
        headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(malformedBody) },
        scope: { resolve() { throw new Error("scope must not be used") } },
      } as never,
      malformedResponse as never
    )
    expect(malformedResponse.statusCode).toBe(400)
    expect(malformedResponse.body).toEqual(expect.objectContaining({ reason: "stripe_event_id_missing" }))

    const missingPaymentIntentBody = JSON.stringify({
      ...stripeEvent(),
      data: { object: { ...stripeEvent().data.object, id: "" } },
    })
    const missingPaymentIntentResponse = makeResponse()
    await POST(
      {
        rawBody: Buffer.from(missingPaymentIntentBody),
        headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(missingPaymentIntentBody) },
        scope: { resolve() { throw new Error("scope must not be used") } },
      } as never,
      missingPaymentIntentResponse as never
    )
    expect(missingPaymentIntentResponse.statusCode).toBe(400)
    expect(missingPaymentIntentResponse.body).toEqual(
      expect.objectContaining({ reason: "payment_intent_id_missing" })
    )
  })
})
