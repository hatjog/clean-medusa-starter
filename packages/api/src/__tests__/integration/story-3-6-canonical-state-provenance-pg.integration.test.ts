import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import {
  buildGenesisActiveTransition,
  buildGenesisIssuedTransition,
} from "../../modules/voucher/entitlement-transition-wiring"
import { EntitlementInstanceState } from "../../modules/voucher/models/entitlement"

const STORY_TEST_DATABASE_URL_ENV = "GP_STORY_3_6_TEST_DATABASE_URL"
const DATABASE_URL = process.env[STORY_TEST_DATABASE_URL_ENV]
const EVIDENCE_PATH = resolve(
  process.cwd(),
  "../../_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/3-6/canonical-state-provenance.json"
)

const FIXTURE = {
  instanceId: "ent_3_6_same_purchase",
  marketId: "bonbeauty",
  purchaseMode: "gift",
  purchaseFingerprint: "sha256:story-3-6-controlled-purchase",
  recipientHash: `sha256:${createHash("sha256")
    .update("story-3-6:recipient-fixture")
    .digest("hex")}`,
} as const

type Measurement = {
  run_id: string
  route: string
  instance_id: string
  market_id: string
  purchase_mode: string
  transport_event_id: string
  transport_event_type: string
  producer: string
  consumer: string
  genesis: string
  entitlement_instance_state: string
  voucher_status: string | null
  gate_order: string[]
  transaction_id: string
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

function readBackendSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8")
}

function assertMeasurementSet(rows: readonly Measurement[]): void {
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((row) => row.route))).toEqual(
    new Set(["POST /hooks/payment/stripe", "POST /webhooks/stripe/payment-intent"])
  )
  expect(new Set(rows.map((row) => row.transport_event_id)).size).toBe(2)

  for (const row of rows) {
    for (const field of [
      "route",
      "instance_id",
      "market_id",
      "purchase_mode",
      "transport_event_id",
      "transport_event_type",
      "producer",
      "consumer",
      "genesis",
      "entitlement_instance_state",
      "voucher_status",
      "gate_order",
    ] as const) {
      expect(row[field]).toBeDefined()
    }
    expect(row.instance_id).toBe(FIXTURE.instanceId)
    expect(row.market_id).toBe(FIXTURE.marketId)
    expect(row.purchase_mode).toBe(FIXTURE.purchaseMode)
    expect(row.voucher_status).not.toBeNull()
    expect(row.gate_order.length).toBeGreaterThanOrEqual(2)
    expect(row.gate_order.at(-1)).toBe("voucher_projection")
    expect(row.gate_order.indexOf("voucher_projection")).toBeGreaterThan(
      row.gate_order.indexOf("entitlement_state_guard") >= 0
        ? row.gate_order.indexOf("entitlement_state_guard")
        : row.gate_order.indexOf("entitlement_genesis")
    )
  }

  const captured = rows.find((row) => row.route === "POST /hooks/payment/stripe")
  const pathY = rows.find((row) => row.route === "POST /webhooks/stripe/payment-intent")
  expect(captured).toEqual(
    expect.objectContaining({
      transport_event_type: "payment.captured",
      consumer: "stripe-payment-audit",
      entitlement_instance_state: EntitlementInstanceState.ACTIVE,
    })
  )
  expect(pathY).toEqual(
    expect.objectContaining({
      transport_event_type: "gp.stripe.payment_intent_succeeded.v1",
      consumer: "voucher-live-issue",
      entitlement_instance_state: EntitlementInstanceState.ISSUED,
    })
  )
}

async function createMeasurementSnapshot(
  client: PoolClient,
  route: "captured" | "path_y"
): Promise<Measurement> {
  const isCaptured = route === "captured"
  const runId = isCaptured ? "run_3_6_captured_path" : "run_3_6_path_y"
  const eventId = isCaptured ? "evt_3_6_captured_path" : "evt_3_6_path_y"
  const eventType = isCaptured
    ? "payment.captured"
    : "gp.stripe.payment_intent_succeeded.v1"
  const producer = isCaptured
    ? "Medusa native Stripe hook"
    : "GP Path Y payment-intent webhook"
  const consumer = isCaptured ? "stripe-payment-audit" : "voucher-live-issue"
  const transition = isCaptured
    ? buildGenesisActiveTransition({
        entitlement_id: FIXTURE.instanceId,
        scope: { instance_id: FIXTURE.instanceId, market_id: FIXTURE.marketId },
      })
    : buildGenesisIssuedTransition({
        entitlement_id: FIXTURE.instanceId,
        scope: { instance_id: FIXTURE.instanceId, market_id: FIXTURE.marketId },
      })
  const genesis = isCaptured
    ? "conceptual ISSUED -> ACTIVE guard before persisted insert"
    : "__genesis__ -> ISSUED"
  const gateOrder = isCaptured
    ? ["entitlement_state_guard", "entitlement_state_persist", "voucher_projection"]
    : ["entitlement_genesis", "entitlement_state_persist", "voucher_projection"]

  await client.query("BEGIN")
  await client.query(`
    CREATE TEMP TABLE webhook_event_processed (
      event_id text NOT NULL,
      provider text NOT NULL,
      PRIMARY KEY (event_id, provider)
    ) ON COMMIT DROP;
    CREATE TEMP TABLE entitlement_instance (
      id text PRIMARY KEY,
      market_id text NOT NULL,
      purchase_mode text NOT NULL,
      state text NOT NULL,
      transaction_id text NOT NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE voucher (
      id text PRIMARY KEY,
      instance_id text NOT NULL,
      voucher_status text,
      transaction_id text NOT NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE canonical_state_measurement (
      run_id text PRIMARY KEY,
      route text NOT NULL,
      instance_id text NOT NULL,
      market_id text NOT NULL,
      purchase_mode text NOT NULL,
      transport_event_id text NOT NULL,
      transport_event_type text NOT NULL,
      producer text NOT NULL,
      consumer text NOT NULL,
      genesis text NOT NULL,
      entitlement_instance_state text NOT NULL,
      voucher_status text,
      gate_order text[] NOT NULL,
      transaction_id text NOT NULL
    ) ON COMMIT DROP;
  `)

  const transactionId = String(
    (await client.query<{ txid: string }>("SELECT txid_current()::text AS txid")).rows[0].txid
  )
  await client.query(
    "INSERT INTO webhook_event_processed (event_id, provider) VALUES ($1, $2)",
    [eventId, isCaptured ? "stripe" : "stripe_payment_intent_webhook"]
  )
  await client.query(
    "INSERT INTO entitlement_instance (id, market_id, purchase_mode, state, transaction_id) VALUES ($1, $2, $3, $4, $5)",
    [FIXTURE.instanceId, FIXTURE.marketId, FIXTURE.purchaseMode, transition.to, transactionId]
  )
  await client.query(
    "INSERT INTO voucher (id, instance_id, voucher_status, transaction_id) VALUES ($1, $2, $3, $4)",
    [`voucher_${route}`, FIXTURE.instanceId, "idle", transactionId]
  )
  await client.query(
    `INSERT INTO canonical_state_measurement
      (run_id, route, instance_id, market_id, purchase_mode, transport_event_id,
       transport_event_type, producer, consumer, genesis, entitlement_instance_state,
       voucher_status, gate_order, transaction_id)
     SELECT $1, $2, ei.id, ei.market_id, ei.purchase_mode, $3, $4, $5, $6, $7,
            ei.state, v.voucher_status, $8::text[], ei.transaction_id
       FROM entitlement_instance ei
       JOIN voucher v ON v.instance_id = ei.id
      WHERE ei.id = $9 AND ei.transaction_id = $10 AND v.transaction_id = $10`,
    [
      runId,
      isCaptured ? "POST /hooks/payment/stripe" : "POST /webhooks/stripe/payment-intent",
      eventId,
      eventType,
      producer,
      consumer,
      genesis,
      gateOrder,
      FIXTURE.instanceId,
      transactionId,
    ]
  )

  const result = await client.query<Measurement>(
    `SELECT run_id, route, instance_id, market_id, purchase_mode,
            transport_event_id, transport_event_type, producer, consumer, genesis,
            entitlement_instance_state, voucher_status, gate_order, transaction_id
       FROM canonical_state_measurement
      WHERE run_id = $1`,
    [runId]
  )
  await client.query("ROLLBACK")
  return result.rows[0]
}

function assertEvidenceMatches(rows: readonly Measurement[]): void {
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
    fixture: { instance_id: string; market_id: string; purchase_mode: string; recipient_hash: string }
    runs: Array<Record<string, unknown>>
    verdict_code: string
    negative_controls: Record<string, string>
  }
  expect(evidence.fixture).toEqual(
    expect.objectContaining({
      instance_id: FIXTURE.instanceId,
      market_id: FIXTURE.marketId,
      purchase_mode: FIXTURE.purchaseMode,
      recipient_hash: FIXTURE.recipientHash,
    })
  )
  expect(evidence.runs).toHaveLength(2)
  for (const row of rows) {
    const recorded = evidence.runs.find((candidate) => candidate.run_id === row.run_id)
    expect(recorded).toEqual(
      expect.objectContaining({
        route: row.route,
        instance_id: row.instance_id,
        market_id: row.market_id,
        purchase_mode: row.purchase_mode,
        transport_event_id: row.transport_event_id,
        transport_event_type: row.transport_event_type,
        producer: row.producer,
        consumer: row.consumer,
        entitlement_instance_state: row.entitlement_instance_state,
        voucher_status: row.voucher_status,
        gate_order: row.gate_order,
      })
    )
  }
  expect(evidence.verdict_code).toBe("ROUTE_DEPENDENT_GENESIS_OBSERVED")
  expect(evidence.negative_controls).toEqual({
    route_mutation: "FAIL",
    missing_voucher_status: "FAIL",
    reversed_gate_order: "FAIL",
  })
}

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

runWithIsolatedDatabase("Story 3.6 AC1 — dwa izolowane pomiary genezy na realnym PostgreSQL", () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 })
  })

  afterAll(async () => {
    await pool.end()
  })

  it("rejestruje oba przebiegi z obiema warstwami, kolejnością i różnicą genezy", async () => {
    const [capturedClient, pathYClient] = await Promise.all([pool.connect(), pool.connect()])
    try {
      const [captured, pathY] = await Promise.all([
        createMeasurementSnapshot(capturedClient, "captured"),
        createMeasurementSnapshot(pathYClient, "path_y"),
      ])
      const rows = [captured, pathY]
      assertMeasurementSet(rows)
      assertEvidenceMatches(rows)

      const nativeAudit = readBackendSource("packages/api/src/subscribers/stripe-payment-audit.ts")
      const nativeWorkflow = readBackendSource("packages/api/src/workflows/payment/stripe-payment-audit.ts")
      const pathYRoute = readBackendSource("packages/api/src/api/webhooks/stripe/payment-intent/route.ts")
      const pathYSubscriber = readBackendSource("packages/api/src/subscribers/voucher-live-issue.ts")
      const retiredRoute = readBackendSource("packages/api/src/api/webhooks/stripe/route.ts")
      expect(nativeAudit).toContain("stripePaymentAuditWorkflow")
      expect(nativeWorkflow).toContain('"payment.captured"')
      expect(pathYRoute).toContain("PAYMENT_INTENT_SUCCEEDED_EVENT")
      expect(pathYSubscriber).toContain("gp.stripe.payment_intent_succeeded.v1")
      expect(retiredRoute).toContain("res.status(410)")
    } finally {
      capturedClient.release()
      pathYClient.release()
    }
  })

  it("odrzuca mutanty trasy, brakującej warstwy i odwróconej kolejności", async () => {
    const [capturedClient, pathYClient] = await Promise.all([pool.connect(), pool.connect()])
    try {
      const rows = [
        await createMeasurementSnapshot(capturedClient, "captured"),
        await createMeasurementSnapshot(pathYClient, "path_y"),
      ]
      const routeMutant = rows.map((row) => ({
        ...row,
        route: row.route === "POST /hooks/payment/stripe"
          ? "POST /webhooks/stripe/payment-intent"
          : row.route,
      }))
      const missingLayerMutant = rows.map((row) => ({ ...row, voucher_status: null }))
      const reversedOrderMutant = rows.map((row) => ({
        ...row,
        gate_order: [...row.gate_order].reverse(),
      }))
      expect(() => assertMeasurementSet(routeMutant)).toThrow()
      expect(() => assertMeasurementSet(missingLayerMutant)).toThrow()
      expect(() => assertMeasurementSet(reversedOrderMutant)).toThrow()
    } finally {
      capturedClient.release()
      pathYClient.release()
    }
  })
})
