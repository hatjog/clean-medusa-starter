/**
 * v1.8.0 Story 1.10.1 — Stripe payment-audit → entitlement_instance creation investigation.
 *
 * Investigation scope (per `_bmad-output/releases/v1.8.0/planning-artifacts/
 * 1-10-1-investigation-finding-2026-05-23.md`):
 *
 *   Story 1.10 C1 evidence shows order_01KS8ZME5GBMSGR67EBPJ2V2NA paid OK but
 *   entitlement_count = 0. The Wave B agent (now reverted) misdirected the fix
 *   to gp_core legacy. Real System 2 path is:
 *
 *     Stripe payment_intent.succeeded
 *       → @medusajs/payment-stripe → PaymentActions.SUCCESSFUL
 *       → core-flows capturePaymentWorkflow → emit "payment.captured"
 *       → src/subscribers/stripe-payment-audit.ts hydrate payload
 *       → src/workflows/payment/stripe-payment-audit.ts processMutation
 *       → INSERT webhook_event_processed (dedup)
 *       → issueEntitlementWithinPaymentTransaction (src/workflows/entitlements/)
 *       → resolveEntitlementProfile(payload + order_line_item.metadata)
 *       → INSERT entitlement_instance (state=ACTIVE)
 *
 * The gap identified by this investigation is at the metadata-resolution
 * boundary: order_line_item.metadata does NOT carry an
 * `entitlement_profile_id` / `entitlement_type` / `entitlement_policy` triad
 * for live BonBeauty checkouts, because no code path (storefront addToCart,
 * gp-config-sync-catalog, product seeders, Mercur middlewares) writes those
 * fields. So `resolveEntitlementProfile` returns null/undefined →
 * `MissingEntitlementProfileError` is thrown → caught + warned by the
 * subscriber → audit row persisted WITHOUT an entitlement_instance.
 *
 * This file provides two layers of evidence:
 *
 *   1. SYNTHETIC FAKE-DB test (always runs): re-asserts that the workflow
 *      code path is CORRECT given a properly enriched payload. This proves
 *      the workflow is not broken — the input is.
 *
 *   2. REAL-DB read-only diagnostic (opt-in via
 *      GP_RUN_ENTITLEMENT_INVESTIGATION=1): inspects the production / dev
 *      database (DATABASE_URL must point to gp_mercur or test isolate) to
 *      enumerate orders whose line_item.metadata lacks entitlement_profile.
 *      The diagnostic is read-only — no INSERTs / UPDATEs / DELETEs.
 *
 * Tests intentionally do not exercise the live Stripe webhook surface; that
 * is Sprint 5 e2e gate territory (see
 * `packages/api/src/__tests__/e2e/stripe-path-y-sprint5-gates.integration.spec.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool } from "pg"

import {
  MissingEntitlementProfileError,
  issueEntitlementWithinPaymentTransaction,
  type IssueEntitlementInput,
  type PgClient,
} from "../../workflows/entitlements/issue-entitlement"

// ---------------------------------------------------------------------------
// Layer 1 — synthetic FakeClient assertions (always run)
//
// Re-prove the four canonical branches of issueEntitlementWithinPaymentTransaction
// so a future refactor doesn't silently regress the contract:
//
//   (a) idempotency  — second call with same order_id returns existing row id
//   (b) inline payload — entitlement_profile passed in payload satisfies
//                        resolveEntitlementProfile without DB lookup
//   (c) metadata fallback — payload has no profile, but order_line metadata
//                           carries (entitlement_profile_id, entitlement_type,
//                           entitlement_policy) triad and resolution succeeds
//   (d) missing profile — neither payload nor metadata carries a profile,
//                         MissingEntitlementProfileError is thrown (the real
//                         Story 1.10 production behavior)
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown>

class FakeClient implements PgClient {
  public readonly queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []
  public existingEntitlementId: string | null = null
  public orderLineMetadata: Record<string, unknown> | null = null
  public insertedEntitlementInstance: FakeRow | null = null

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    this.queries.push({ sql, params })
    const normalized = sql.replace(/\s+/g, " ").trim()

    if (
      normalized.startsWith("SELECT id FROM entitlement_instance") ||
      normalized.startsWith("SELECT id, line_item_id FROM entitlement_instance")
    ) {
      if (this.existingEntitlementId) {
        return {
          rows: [
            { id: this.existingEntitlementId, line_item_id: null },
          ] as unknown as T[],
          rowCount: 1,
        }
      }
      return { rows: [] as T[], rowCount: 0 }
    }

    if (normalized.includes("FROM order_item")) {
      // v1.9.0 wf5 H-6 fix: issueEntitlementsForAllLineItems issues per-line
      // and expects rows with both `line_item_id` AND `metadata`. The legacy
      // single-line test path sets `orderLineMetadata`; emulate the new shape
      // by synthesizing one row with a synthetic line_item_id.
      if (this.orderLineMetadata === null) {
        return { rows: [] as T[], rowCount: 0 }
      }
      return {
        rows: [
          {
            line_item_id: "line_item_synthetic",
            metadata: this.orderLineMetadata,
          },
        ] as unknown as T[],
        rowCount: 1,
      }
    }

    if (normalized.startsWith("INSERT INTO entitlement_instance")) {
      // v1.9.0 wf5 H-6: INSERT params are now [id, profile_id,
      // entitlement_type, order_id, line_item_id, state, policy_snapshot,
      // market_id, created_at] (9 params; line_item_id added at index 4).
      this.insertedEntitlementInstance = {
        id: params[0],
        entitlement_profile_id: params[1],
        entitlement_type: params[2],
        order_id: params[3],
        line_item_id: params[4],
        state: params[5],
        policy_snapshot: params[6],
        market_id: params[7],
        created_at: params[8],
      }
      return { rows: [] as T[], rowCount: 1 }
    }

    throw new Error(`FakeClient received unexpected SQL: ${normalized}`)
  }
}

function buildInput(
  overrides: Partial<IssueEntitlementInput> = {}
): IssueEntitlementInput {
  return {
    event_id: "evt_invtest_001",
    order_id: "order_invtest_001",
    payment_id: "pay_invtest_001",
    payment_intent_id: "pi_invtest_001",
    market_id: "bonbeauty",
    amount_minor: 18000,
    currency: "PLN",
    ...overrides,
  }
}

describe("Story 1.10.1 — entitlement_instance creation contract (FakeClient layer)", () => {
  it("(a) idempotent — returns existing entitlement_id when order_id already has one", async () => {
    const client = new FakeClient()
    client.existingEntitlementId = "ent_existing_abc"

    const result = await issueEntitlementWithinPaymentTransaction(
      client,
      buildInput(),
      new Date("2026-05-23T00:00:00Z")
    )

    expect(result.idempotent).toBe(true)
    expect(result.entitlement_id).toBe("ent_existing_abc")
    expect(client.insertedEntitlementInstance).toBeNull()
  })

  it("(b) inline payload — entitlement_profile passed in payload is used without DB lookup", async () => {
    const client = new FakeClient()
    // Intentionally do NOT set orderLineMetadata: resolution must succeed via
    // the inline payload short-circuit at issue-entitlement.ts:123-128.

    const result = await issueEntitlementWithinPaymentTransaction(
      client,
      buildInput({
        entitlement_profile: {
          profile_id: "voucher-kwotowy-365d",
          entitlement_type: "VOUCHER_AMOUNT",
          policy: { validity_months: 12 },
          currency: "PLN",
          amount_minor: 18000,
        },
      }),
      new Date("2026-05-23T00:00:00Z")
    )

    expect(result.idempotent).toBe(false)
    expect(result.entitlement_id).toMatch(/^ent_[0-9a-f]{24}$/)
    expect(client.insertedEntitlementInstance).toMatchObject({
      entitlement_profile_id: "voucher-kwotowy-365d",
      entitlement_type: "VOUCHER_AMOUNT",
      order_id: "order_invtest_001",
      state: "ACTIVE",
      market_id: "bonbeauty",
    })
    // No SELECT against order_item should happen when inline payload is complete.
    expect(
      client.queries.some(({ sql }) => sql.includes("FROM order_item"))
    ).toBe(false)
  })

  it("(c) metadata fallback — order_line_item.metadata triad resolves the profile", async () => {
    const client = new FakeClient()
    client.orderLineMetadata = {
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      entitlement_policy: { validity_months: 12, cancellation: { cutoff_hours: 12 } },
      currency: "PLN",
      amount_minor: 18000,
    }

    const result = await issueEntitlementWithinPaymentTransaction(
      client,
      buildInput({ entitlement_profile: null }),
      new Date("2026-05-23T00:00:00Z")
    )

    expect(result.idempotent).toBe(false)
    expect(client.insertedEntitlementInstance).toMatchObject({
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      order_id: "order_invtest_001",
      state: "ACTIVE",
    })
    expect(
      client.queries.some(({ sql }) => sql.includes("FROM order_item"))
    ).toBe(true)
  })

  it("(d) missing profile — empty payload + empty order_line metadata throws MissingEntitlementProfileError (the real Story 1.10 path)", async () => {
    const client = new FakeClient()
    // Default: orderLineMetadata = null → query returns 0 rows
    //          ↔ matches the actual order_01KS8ZME5GBMSGR67EBPJ2V2NA shape
    //            (line_item.metadata = '{}')

    await expect(
      issueEntitlementWithinPaymentTransaction(
        client,
        buildInput({ entitlement_profile: null }),
        new Date("2026-05-23T00:00:00Z")
      )
    ).rejects.toBeInstanceOf(MissingEntitlementProfileError)

    expect(client.insertedEntitlementInstance).toBeNull()
  })

  it("(d') missing profile — order_line metadata present but lacking the resolver triad still throws", async () => {
    const client = new FakeClient()
    // Simulates the actual production payload of order_01KS8ZME5GBMSGR67EBPJ2V2NA
    // and similar live BonBeauty orders: line_item metadata exists but only
    // carries seller/purchase_mode keys (no entitlement_profile triad).
    client.orderLineMetadata = {
      selected_seller_id: "sel_studio-nova",
      selected_seller_name: "Studio Nova",
      selected_seller_handle: "studio-nova",
      purchase_mode: "self",
      is_gift: false,
    }

    await expect(
      issueEntitlementWithinPaymentTransaction(
        client,
        buildInput({ entitlement_profile: null }),
        new Date("2026-05-23T00:00:00Z")
      )
    ).rejects.toBeInstanceOf(MissingEntitlementProfileError)

    expect(client.insertedEntitlementInstance).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Story 1.10.1 GAP #1 fix verification — BonBeauty MVP profile (voucher-
  // rezerwacja-otwarta) end-to-end propagation. Simulates the post-fix state:
  // gp-config-sync-catalog wrote product.metadata.gp.entitlement_profile from
  // products.yaml entitlement_profile_id cross-ref → storefront cart echoed it
  // to line_item.metadata.entitlement_profile (embedded form) → backend resolver
  // short-circuits the DB-scan branch and issues entitlement_instance.
  //
  // This is the regression gate: if this test fails, the storefront write
  // contract has drifted away from the backend resolver contract.
  // ---------------------------------------------------------------------------
  it("(e) Story 1.10.1 fix — BonBeauty voucher-rezerwacja-otwarta propagation issues entitlement_instance", async () => {
    const client = new FakeClient()
    // The post-fix line_item metadata SHAPE produced by storefront
    // `buildEntitlementLineItemMetadata` (GP/storefront/src/lib/voucher/
    // entitlement-metadata.ts) for the canonical BonBeauty MVP service voucher.
    // Mirror specs/contracts/config/fixtures/markets/bonbeauty/market.bonbeauty.yaml
    // lines 218-252 (voucher-rezerwacja-otwarta profile).
    client.orderLineMetadata = {
      // Storefront echoes BOTH the embedded form (resolver fast-path) and the
      // destructured triad (analytics readers).
      entitlement_profile: {
        profile_id: "voucher-rezerwacja-otwarta",
        entitlement_type: "VOUCHER_SERVICE",
        policy: {
          validity_months: 12,
          extension: {
            allowed: true,
            paid: false,
            fee_pct: 0,
            max_extension_months: 3,
          },
          cancellation: { cutoff_hours: 12, fee_pct: 10, deduct_method: "charge_card" },
          no_show: { policy: "forfeit_voucher", charge_pct: 0 },
          refund_channel: "original_payment",
          auto_redeem: { enabled: true, trigger: "on_service_complete" },
        },
        currency: "PLN",
        amount_minor: 18000,
      },
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      entitlement_policy: { validity_months: 12 },
      currency: "PLN",
      amount_minor: 18000,
      // Non-entitlement keys (seller / purchase_mode) must coexist — the post-fix
      // storefront write spreads BOTH legacy + entitlement fragments into
      // line_item.metadata (see GP/storefront/src/lib/data/cart.ts addToCart).
      selected_seller_id: "sel_studio-nova",
      selected_seller_name: "Studio Nova",
      selected_seller_handle: "studio-nova",
      purchase_mode: "self",
      is_gift: false,
    }

    const result = await issueEntitlementWithinPaymentTransaction(
      client,
      buildInput({ entitlement_profile: null }), // payload-side empty → resolver falls back to metadata
      new Date("2026-05-23T00:00:00Z")
    )

    expect(result.idempotent).toBe(false)
    expect(result.entitlement_id).toMatch(/^ent_[0-9a-f]{24}$/)
    expect(client.insertedEntitlementInstance).toMatchObject({
      entitlement_profile_id: "voucher-rezerwacja-otwarta",
      entitlement_type: "VOUCHER_SERVICE",
      order_id: "order_invtest_001",
      state: "ACTIVE",
      market_id: "bonbeauty",
    })
    // policy_snapshot is JSONB stringified by the workflow; verify the per-key
    // shape from market.yaml flows through end-to-end.
    const snapshot = JSON.parse(
      client.insertedEntitlementInstance!.policy_snapshot as string
    ) as Record<string, unknown>
    expect(snapshot).toMatchObject({
      validity_months: 12,
      refund_channel: "original_payment",
      currency: "PLN",
    })
    expect((snapshot.auto_redeem as Record<string, unknown>).enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — read-only real-DB diagnostic (opt-in)
//
// Gate: GP_RUN_ENTITLEMENT_INVESTIGATION=1 + DATABASE_URL set.
//
// This block performs ZERO writes. It only enumerates:
//   1. how many orders since 2026-05-01 have a payment_collection_status =
//      "completed" but no entitlement_instance row.
//   2. for each such order, whether its order_line_item.metadata carries any
//      entitlement_profile* keys.
//
// The expectation (as of this investigation): the vast majority lack the
// metadata triad, confirming the catalog-propagation gap. If this assertion
// flips (some live orders carry the triad), that is itself a useful finding
// (someone wired the propagation path).
//
// SAFETY: this block opens a PG pool but does not start a transaction and
// never issues UPDATE/INSERT/DELETE. Run against dev DB only when you want
// to refresh the finding-doc numbers.
// ---------------------------------------------------------------------------

const runRealDb = process.env.GP_RUN_ENTITLEMENT_INVESTIGATION === "1"
const maybeRealDb = runRealDb ? describe : describe.skip

maybeRealDb("Story 1.10.1 — live DB diagnostic (read-only)", () => {
  let pool: Pool

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "GP_RUN_ENTITLEMENT_INVESTIGATION=1 requires DATABASE_URL pointing to gp_mercur (read-only diagnostic)"
      )
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    if (pool) {
      await pool.end()
    }
  })

  it("counts completed-payment orders since 2026-05-01 and their entitlement_instance presence", async () => {
    const summary = await pool.query<{
      total_completed: string
      with_entitlement: string
      without_entitlement: string
    }>(
      `
        WITH completed_orders AS (
          SELECT o.id AS order_id
          FROM "order" o
          JOIN order_payment_collection opc ON opc.order_id = o.id
          JOIN payment_collection pc ON pc.id = opc.payment_collection_id
          WHERE pc.status = 'completed'
            AND o.created_at >= '2026-05-01'
            AND o.deleted_at IS NULL
        )
        SELECT
          COUNT(*) AS total_completed,
          COUNT(ei.id) AS with_entitlement,
          COUNT(*) - COUNT(ei.id) AS without_entitlement
        FROM completed_orders co
        LEFT JOIN entitlement_instance ei ON ei.order_id = co.order_id
      `
    )
    const row = summary.rows[0]
    // No assertion on the *content* — the diagnostic just emits the numbers
    // so the finding doc can be refreshed by hand from the test log output.
    // eslint-disable-next-line no-console
    console.log(
      `[1-10-1 diagnostic] completed orders since 2026-05-01: total=${row.total_completed} with_entitlement=${row.with_entitlement} without_entitlement=${row.without_entitlement}`
    )
    expect(Number(row.total_completed)).toBeGreaterThanOrEqual(0)
  })

  it("enumerates orders without entitlement and reports their line_item metadata shape", async () => {
    const rows = await pool.query<{
      order_id: string
      line_item_metadata: Record<string, unknown> | null
      has_entitlement_profile: boolean
      has_entitlement_profile_id: boolean
    }>(
      `
        WITH completed_orders AS (
          SELECT o.id AS order_id, o.created_at
          FROM "order" o
          JOIN order_payment_collection opc ON opc.order_id = o.id
          JOIN payment_collection pc ON pc.id = opc.payment_collection_id
          WHERE pc.status = 'completed'
            AND o.created_at >= '2026-05-01'
            AND o.deleted_at IS NULL
        ),
        first_lines AS (
          SELECT
            co.order_id,
            (SELECT oli.metadata
               FROM order_item oi
               JOIN order_line_item oli ON oli.id = oi.item_id
              WHERE oi.order_id = co.order_id
                AND oi.deleted_at IS NULL
                AND oli.deleted_at IS NULL
              ORDER BY oi.created_at ASC
              LIMIT 1) AS metadata
          FROM completed_orders co
        )
        SELECT
          fl.order_id,
          fl.metadata AS line_item_metadata,
          (fl.metadata ? 'entitlement_profile') AS has_entitlement_profile,
          (fl.metadata ? 'entitlement_profile_id') AS has_entitlement_profile_id
        FROM first_lines fl
        LEFT JOIN entitlement_instance ei ON ei.order_id = fl.order_id
        WHERE ei.id IS NULL
        ORDER BY fl.order_id ASC
        LIMIT 25
      `
    )
    // Emit per-row evidence for finding-doc refresh.
    for (const row of rows.rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[1-10-1 diagnostic] order=${row.order_id} ` +
          `has_entitlement_profile=${row.has_entitlement_profile} ` +
          `has_entitlement_profile_id=${row.has_entitlement_profile_id} ` +
          `metadata_keys=${
            row.line_item_metadata
              ? Object.keys(row.line_item_metadata).sort().join(",") || "<empty-object>"
              : "<null>"
          }`
      )
    }
    expect(rows.rows.length).toBeGreaterThanOrEqual(0)
  })
})

