/**
 * v1.16.0 Story 4.4 (FR-12, AD-32, NFR-3, NFR-5) — ślad płatności bez
 * zamówienia jako TRWAŁY REKORD, na realnym PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-4-4-deferred-trace-pg`
 * Baza: izolowana `gp_story_4_4_test` (stack gp-test, port 55432). Suita
 * odmawia startu na bazie, której nazwa nie kończy się na `_test`.
 *
 *  AC1 (a) zapis przy wykryciu: rekord z instance_id, market_id, occurred_at,
 *          właścicielem ops-recovery, deadline, state='awaiting_order';
 *      (b) negacja: zmiana/usunięcie markera `webhook_event_processed` nie
 *          zmienia populacji (populacja = jedna tabela, nie join);
 *      (c) RLS: rola runtime `medusa_store` (NOBYPASSRLS) nie widzi i nie
 *          może zapisać wiersza obcego rynku (polityka `market_isolation`).
 *  AC2 domknięcie: `issued_after_link`, closure_path ≠ not_closed, niepuste
 *      evidence, version+1; wiersz czytelny po domknięciu z occurred_at
 *      i pierwotnym właścicielem; mutant „domknięcie bez evidence" = odmowa.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration20261114100000DeferredIssuanceTraceTable } from "../../migrations/Migration20261114100000DeferredIssuanceTraceTable"
import { marketContextStorage } from "../../lib/market-context"
import {
  CLOSE_DEFERRED_ISSUANCE_TRACE_SQL,
  closeDeferredIssuanceTrace,
  closeDeferredIssuanceTraceGuarded,
  DEFERRED_ISSUANCE_TRACE_OWNER,
  listDeferredIssuanceTracePopulation,
  recordDeferredIssuanceTrace,
  runDeferredIssuanceTraceBackfill,
} from "../../lib/recovery/deferred-issuance-trace"
import { persistDeferredIssuanceTraceRecord } from "../../lib/recovery/deferred-issuance-trace-runtime"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL

const SCOPE_A = { instance_id: "gp_inst_4_4", market_id: "mkt_4_4_a" }
const SCOPE_B = { instance_id: "gp_inst_4_4", market_id: "mkt_4_4_b" }
const SLA_ENV = { GP_DEFERRED_ISSUANCE_TRACE_SLA_SECONDS: "3600" }

function collectSql(direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = []
  const migration = Object.create(
    Migration20261114100000DeferredIssuanceTraceTable.prototype
  ) as Migration20261114100000DeferredIssuanceTraceTable & { addSql: (sql: string) => void }
  migration.addSql = (sql: string) => {
    statements.push(sql)
  }
  return Promise.resolve(migration[direction]()).then(() => statements)
}

async function asRuntime<T>(
  client: PoolClient,
  scope: { instance_id: string; market_id: string },
  work: () => Promise<T>
): Promise<T> {
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL ROLE medusa_store")
    await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [scope.instance_id])
    await client.query("SELECT set_config('app.gp_market_id', $1, true)", [scope.market_id])
    const result = await work()
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  }
}

function traceInput(eventId: string, scope = SCOPE_A) {
  return {
    stripe_event_id: eventId,
    payment_intent_id: `pi_${eventId}`,
    instance_id: scope.instance_id,
    market_id: scope.market_id,
    psp_occurred_at: "2026-11-14T10:00:00.000Z",
    sla_seconds: 3600,
  }
}

const describeOrNotRun = enabled ? describe : describe.skip

if (!enabled) {
  describe("Story 4.4 — rekord deferred_issuance_trace na rzeczywistym PostgreSQL", () => {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 4.4: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
    })
  })
}

describeOrNotRun("Story 4.4 — rekord deferred_issuance_trace na rzeczywistym PostgreSQL", () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    client = await pool.connect()
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 4.4 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
    for (const sql of await collectSql("down")) await client.query(sql)
    for (const sql of await collectSql("up")) await client.query(sql)
  })

  afterAll(async () => {
    if (client) {
      await client.query(
        "DELETE FROM webhook_event_processed WHERE event_id LIKE 'evt_4_4_%'"
      )
      for (const sql of await collectSql("down")) await client.query(sql)
      client.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    await client.query("DELETE FROM deferred_issuance_trace")
    await client.query("DELETE FROM deferred_issuance_trace_backfill_quarantine")
    await client.query("DELETE FROM webhook_event_processed WHERE event_id LIKE 'evt_4_4_%'")
  })

  it("migracja: tabela + kwarantanna z ENABLE/FORCE RLS i polityką market_isolation dla medusa_store", async () => {
    const rls = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('deferred_issuance_trace','deferred_issuance_trace_backfill_quarantine')
        ORDER BY relname`
    )
    expect(rls.rows).toEqual([
      { relname: "deferred_issuance_trace", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "deferred_issuance_trace_backfill_quarantine", relrowsecurity: true, relforcerowsecurity: true },
    ])
    const policy = await client.query<{ policyname: string; roles: string[] }>(
      `SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = 'deferred_issuance_trace'`
    )
    expect(policy.rows).toEqual([{ policyname: "market_isolation", roles: ["medusa_store"] }])
    const role = await client.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'medusa_store'"
    )
    expect(role.rows[0]?.rolbypassrls).toBe(false)
    const privileges = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'deferred_issuance_trace' AND grantee = 'medusa_store'
        ORDER BY privilege_type`
    )
    // Bez DELETE: historia rekordu nie może zniknąć z rąk runtime.
    expect(privileges.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"])
  })

  it("AC1(a): wykrycie przez route-owy zapis pod kontekstem rynku tworzy trwały rekord z właścicielem", async () => {
    // Fałszywa pula emuluje hook RLS: połączenie wzięte WEWNĄTRZ kontekstu
    // rynku dostaje rolę runtime i GUC (to samo robi `lib/rls-pool-hook.ts`).
    const scope = {
      resolve: (key: string) => {
        if (key !== "__pg_pool__") throw new Error(`brak ${key}`)
        return {
          connect: async () => {
            const conn = await pool.connect()
            const ctx = marketContextStorage.getStore()
            await conn.query("SET ROLE medusa_store")
            await conn.query("SELECT set_config('app.gp_market_id', $1, false)", [ctx?.market_id ?? ""])
            await conn.query("SELECT set_config('app.gp_instance_id', $1, false)", [ctx?.instance_id ?? ""])
            return {
              query: conn.query.bind(conn),
              release: () => {
                void conn.query("RESET ROLE").finally(() => conn.release())
              },
            }
          },
        }
      },
    }

    // Rynek z KOSZYKA płatności (zamówienia jeszcze nie ma): seed w transakcji
    // czytającego, wycofany po teście.
    const reader = await pool.connect()
    try {
      await reader.query("BEGIN")
      await reader.query(
        `INSERT INTO sales_channel (id, name, metadata) VALUES ('sc_4_4', 'sc 4.4', $1::jsonb)`,
        [JSON.stringify({ gp_market_id: SCOPE_A.market_id })]
      )
      await reader.query(
        `INSERT INTO cart (id, currency_code, sales_channel_id) VALUES ('cart_4_4', 'pln', 'sc_4_4')`
      )
      await reader.query(
        `INSERT INTO payment_collection (id, currency_code, amount, raw_amount)
         VALUES ('paycol_4_4', 'pln', 100, '{"value":"100","precision":20}'::jsonb)`
      )
      await reader.query(
        `INSERT INTO cart_payment_collection (id, cart_id, payment_collection_id)
         VALUES ('cpc_4_4', 'cart_4_4', 'paycol_4_4')`
      )
      await reader.query(
        `INSERT INTO payment_session (id, currency_code, amount, raw_amount, provider_id, payment_collection_id, data)
         VALUES ('payses_4_4', 'pln', 100, '{"value":"100","precision":20}'::jsonb, 'pp_stripe', 'paycol_4_4', '{}'::jsonb)`
      )
      const outcome = await persistDeferredIssuanceTraceRecord(
        scope,
        reader,
        {
          stripe_event_id: "evt_4_4_route",
          payment_intent_id: "pi_4_4_route",
          instance_id: SCOPE_A.instance_id,
          session_id: "payses_4_4",
          metadata_market_id: null,
          psp_occurred_at: "2026-11-14T10:00:00.000Z",
        },
        SLA_ENV
      )
      expect(outcome).toEqual({
        ok: true,
        created: true,
        market_id: SCOPE_A.market_id,
        trace_id: "evt_4_4_route#deferred-issuance",
      })

      // Ponowienie tego samego zdarzenia nie mnoży rekordów.
      const again = await persistDeferredIssuanceTraceRecord(
        scope,
        reader,
        {
          stripe_event_id: "evt_4_4_route",
          payment_intent_id: "pi_4_4_route",
          instance_id: SCOPE_A.instance_id,
          session_id: "payses_4_4",
          metadata_market_id: null,
          psp_occurred_at: "2026-11-14T10:00:00.000Z",
        },
        SLA_ENV
      )
      expect(again).toMatchObject({ ok: true, created: false })

      // Bez SLA w konfiguracji = nazwana odmowa, nie wartość domyślna.
      const noSla = await persistDeferredIssuanceTraceRecord(
        scope,
        reader,
        {
          stripe_event_id: "evt_4_4_nosla",
          payment_intent_id: "pi_4_4_nosla",
          instance_id: SCOPE_A.instance_id,
          session_id: "payses_4_4",
          metadata_market_id: null,
          psp_occurred_at: "2026-11-14T10:00:00.000Z",
        },
        {}
      )
      expect(noSla).toEqual({ ok: false, reason: "trace_sla_unconfigured" })

      // Rozjazd rynku metadata ↔ koszyk = odmowa, nie wybór jednego z nich.
      const ambiguous = await persistDeferredIssuanceTraceRecord(
        scope,
        reader,
        {
          stripe_event_id: "evt_4_4_amb",
          payment_intent_id: "pi_4_4_amb",
          instance_id: SCOPE_A.instance_id,
          session_id: "payses_4_4",
          metadata_market_id: SCOPE_B.market_id,
          psp_occurred_at: "2026-11-14T10:00:00.000Z",
        },
        SLA_ENV
      )
      expect(ambiguous).toEqual({ ok: false, reason: "market_ambiguous" })
    } finally {
      await reader.query("ROLLBACK")
      reader.release()
    }

    const row = await client.query(
      `SELECT trace_id, instance_id, market_id, state, owner_type, owner_id, closure_path,
              resolution_evidence, version, retry_count, provenance_kind, stripe_event_id,
              payment_intent_id, deferral_reason, age_source,
              occurred_at IS NOT NULL AS has_occurred_at,
              (deadline - occurred_at) = interval '3600 seconds' AS deadline_from_sla
         FROM deferred_issuance_trace`
    )
    expect(row.rows).toEqual([
      {
        trace_id: "evt_4_4_route#deferred-issuance",
        instance_id: SCOPE_A.instance_id,
        market_id: SCOPE_A.market_id,
        state: "awaiting_order",
        owner_type: DEFERRED_ISSUANCE_TRACE_OWNER.owner_type,
        owner_id: "ops-recovery",
        closure_path: "not_closed",
        resolution_evidence: null,
        version: 1,
        retry_count: 0,
        provenance_kind: "runtime_recorded",
        stripe_event_id: "evt_4_4_route",
        payment_intent_id: "pi_4_4_route",
        deferral_reason: "webhook_before_order",
        age_source: "database_now_minus_occurred_at",
        has_occurred_at: true,
        deadline_from_sla: true,
      },
    ])
  })

  it("AC1(b): populacja czyta rekord, nie join — usunięcie/zmiana markera webhook_event_processed jej nie zmienia", async () => {
    await client.query(
      `INSERT INTO webhook_event_processed (event_id, provider, market_id, envelope, received_at)
       VALUES ('evt_4_4_neg#deferred-issuance', $1, NULL, $2::jsonb, now())`,
      [
        STRIPE_PATH_Y_WEBHOOK_PROVIDER,
        JSON.stringify({
          scope: "payment_intent:pi_evt_4_4_neg",
          event_type: "payment.captured",
          entitlement_issue_deferred_reason: "webhook_before_order",
        }),
      ]
    )
    await asRuntime(client, SCOPE_A, () => recordDeferredIssuanceTrace(client, traceInput("evt_4_4_neg")))

    const before = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracePopulation(client))
    expect(before.map((r) => r.trace_id)).toEqual(["evt_4_4_neg#deferred-issuance"])

    await client.query(
      `UPDATE webhook_event_processed
          SET envelope = envelope - 'entitlement_issue_deferred_reason' || '{"scope":"payment_intent:zmienione"}'::jsonb
        WHERE event_id = 'evt_4_4_neg#deferred-issuance'`
    )
    const afterUpdate = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracePopulation(client))
    await client.query("DELETE FROM webhook_event_processed WHERE event_id = 'evt_4_4_neg#deferred-issuance'")
    const afterDelete = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracePopulation(client))

    expect(afterUpdate).toEqual(before)
    expect(afterDelete).toEqual(before)
  })

  it("AC1(c): RLS — runtime nie widzi rekordu obcego rynku i nie może zapisać rekordu pod cudzym rynkiem", async () => {
    await asRuntime(client, SCOPE_A, () => recordDeferredIssuanceTrace(client, traceInput("evt_4_4_rls_a")))
    await asRuntime(client, SCOPE_B, () =>
      recordDeferredIssuanceTrace(client, traceInput("evt_4_4_rls_b", SCOPE_B))
    )

    const seenByA = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracePopulation(client))
    const seenByB = await asRuntime(client, SCOPE_B, () => listDeferredIssuanceTracePopulation(client))
    expect(seenByA.map((r) => r.trace_id)).toEqual(["evt_4_4_rls_a#deferred-issuance"])
    expect(seenByB.map((r) => r.trace_id)).toEqual(["evt_4_4_rls_b#deferred-issuance"])

    // WITH CHECK: zapis z market_id = B w sesji rynku A jest odmową bazy.
    await expect(
      asRuntime(client, SCOPE_A, () => recordDeferredIssuanceTrace(client, traceInput("evt_4_4_rls_x", SCOPE_B)))
    ).rejects.toThrow(/row-level security/)

    // Domknięcie z kontekstu rynku A nie dosięga rekordu rynku B.
    const crossClose = await asRuntime(client, SCOPE_A, async () => {
      await client.query("SELECT set_config('app.gp_market_id', $1, true)", [SCOPE_A.market_id])
      return client.query(CLOSE_DEFERRED_ISSUANCE_TRACE_SQL, [
        "evt_4_4_rls_b#deferred-issuance",
        "order_placed_retry",
        JSON.stringify({ order_id: "order_x", orders: ["order_x"] }),
        "order_x",
      ])
    })
    expect(crossClose.rowCount).toBe(0)

    // Bez kontekstu (brak GUC) runtime nie widzi nic — fail-closed.
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE medusa_store")
    const none = await listDeferredIssuanceTracePopulation(client)
    await client.query("ROLLBACK")
    expect(none).toEqual([])
  })

  it("AC2: domknięcie po order.placed — stan terminalny, ścieżka, evidence, version+1, historia czytelna", async () => {
    await asRuntime(client, SCOPE_A, () => recordDeferredIssuanceTrace(client, traceInput("evt_4_4_close")))
    const original = await client.query(
      "SELECT occurred_at, owner_type, owner_id FROM deferred_issuance_trace WHERE trace_id = 'evt_4_4_close#deferred-issuance'"
    )

    // Subscriber woła w SWOJEJ transakcji runtime (GUC ustawia sam close).
    const closed = await asRuntime(client, { instance_id: "", market_id: "" }, () =>
      closeDeferredIssuanceTraceGuarded(client, {
        stripe_event_id: "evt_4_4_close",
        instance_id: SCOPE_A.instance_id,
        market_id: SCOPE_A.market_id,
        order_id: "order_4_4_a",
        closure_path: "order_placed_retry",
        evidence: { resolver: "subscriber:on-order-placed-stripe-retry", entitlements_issued: 1 },
      })
    )
    expect(closed).toEqual({ ok: true, version: 2 })

    // Drugie zamówienie tego samego PI (ADR-166) dopisuje się do evidence.
    const second = await asRuntime(client, { instance_id: "", market_id: "" }, () =>
      closeDeferredIssuanceTrace(client, {
        stripe_event_id: "evt_4_4_close",
        instance_id: SCOPE_A.instance_id,
        market_id: SCOPE_A.market_id,
        order_id: "order_4_4_b",
        closure_path: "order_placed_retry",
        evidence: { resolver: "subscriber:on-order-placed-stripe-retry", entitlements_issued: 1 },
      })
    )
    expect(second).toBe(3)
    // Powtórka tego samego zamówienia jest no-opem.
    const repeat = await asRuntime(client, { instance_id: "", market_id: "" }, () =>
      closeDeferredIssuanceTrace(client, {
        stripe_event_id: "evt_4_4_close",
        instance_id: SCOPE_A.instance_id,
        market_id: SCOPE_A.market_id,
        order_id: "order_4_4_b",
        closure_path: "order_placed_retry",
        evidence: { resolver: "x" },
      })
    )
    expect(repeat).toBeNull()

    const after = await asRuntime(client, SCOPE_A, () =>
      client.query(
        `SELECT state, closure_path, resolution_evidence, version, occurred_at, owner_type, owner_id
           FROM deferred_issuance_trace WHERE trace_id = 'evt_4_4_close#deferred-issuance'`
      )
    )
    expect(after.rows).toHaveLength(1)
    const row = after.rows[0]
    expect(row.state).toBe("issued_after_link")
    expect(row.closure_path).toBe("order_placed_retry")
    expect(row.closure_path).not.toBe("not_closed")
    expect(row.resolution_evidence).toMatchObject({
      resolver: "subscriber:on-order-placed-stripe-retry",
      orders: ["order_4_4_a", "order_4_4_b"],
    })
    expect(row.version).toBe(3)
    expect(row.occurred_at).toEqual(original.rows[0].occurred_at)
    expect(row.owner_type).toBe(original.rows[0].owner_type)
    expect(row.owner_id).toBe("ops-recovery")

    // Populacja otwarta już go nie zawiera, ale historia jest czytelna.
    const open = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracePopulation(client))
    expect(open).toEqual([])

    // Runtime nie ma prawa DELETE.
    await expect(
      asRuntime(client, SCOPE_A, () => client.query("DELETE FROM deferred_issuance_trace"))
    ).rejects.toThrow(/permission denied/)
  })

  it("AC2 mutant: domknięcie bez evidence (NULL albo {}) albo ze ścieżką not_closed jest odmową bazy", async () => {
    await asRuntime(client, SCOPE_A, () => recordDeferredIssuanceTrace(client, traceInput("evt_4_4_mut")))
    for (const [evidence, path] of [
      [null, "order_placed_retry"],
      ["{}", "order_placed_retry"],
      [JSON.stringify({ order_id: "o" }), "not_closed"],
    ] as const) {
      await expect(
        asRuntime(client, SCOPE_A, () =>
          client.query(
            `UPDATE deferred_issuance_trace
                SET state = 'issued_after_link', closure_path = $2, resolution_evidence = $3::jsonb,
                    version = version + 1
              WHERE trace_id = $1`,
            ["evt_4_4_mut#deferred-issuance", path, evidence]
          )
        )
      ).rejects.toThrow(/deferred_issuance_trace_closure_check/)
    }
  })

  it("T3 backfill: zastane markery z certyfikowanymi faktami → rekord; bez faktów → kwarantanna; ponowny przebieg idempotentny", async () => {
    const envelope = (pi: string) =>
      JSON.stringify({
        scope: `payment_intent:${pi}`,
        event_type: "payment.captured",
        entitlement_issue_deferred_reason: "webhook_before_order",
        payment_intent_id: pi,
        psp_occurred_at: "2026-11-01T10:00:00.000Z",
      })
    await client.query(
      `INSERT INTO webhook_event_processed (event_id, provider, market_id, envelope, received_at) VALUES
         ('evt_4_4_bf_ok#deferred-issuance', $1, $2, $3::jsonb, now()),
         ('evt_4_4_bf_noowner#deferred-issuance', $1, $2, $4::jsonb, now()),
         ('evt_4_4_bf_nomarket#deferred-issuance', $1, NULL, $5::jsonb, now())`,
      [
        STRIPE_PATH_Y_WEBHOOK_PROVIDER,
        SCOPE_A.market_id,
        envelope("pi_bf_ok"),
        envelope("pi_bf_noowner"),
        envelope("pi_bf_nomarket"),
      ]
    )
    // Rekord zapisany już przez runtime nie może zostać zdublowany przez backfill.
    await asRuntime(client, SCOPE_A, () => recordDeferredIssuanceTrace(client, traceInput("evt_4_4_bf_live")))
    await client.query(
      `INSERT INTO webhook_event_processed (event_id, provider, market_id, envelope, received_at)
       VALUES ('evt_4_4_bf_live#deferred-issuance', $1, $2, $3::jsonb, now())`,
      [STRIPE_PATH_Y_WEBHOOK_PROVIDER, SCOPE_A.market_id, envelope("pi_bf_live")]
    )

    const mapping = [{ market_id: SCOPE_A.market_id, instance_id: SCOPE_A.instance_id }]
    const provenance = [
      "evt_4_4_bf_ok#deferred-issuance",
      "evt_4_4_bf_nomarket#deferred-issuance",
      "evt_4_4_bf_live#deferred-issuance",
    ].map((event_id) => ({
      event_id,
      owner_type: "operator_role",
      owner_id: "ops-recovery",
      deadline: "2026-11-15T10:00:00.000Z",
    }))
    // Operator (właściciel migracji), nie runtime: transakcja wołającego.
    await client.query("BEGIN")
    await runDeferredIssuanceTraceBackfill(client, mapping, provenance)
    await client.query("COMMIT")
    await client.query("BEGIN")
    await runDeferredIssuanceTraceBackfill(client, mapping, provenance)
    await client.query("COMMIT")

    const traces = await client.query<{ trace_id: string; provenance_kind: string }>(
      "SELECT trace_id, provenance_kind FROM deferred_issuance_trace WHERE trace_id LIKE 'evt_4_4_bf_%' ORDER BY trace_id"
    )
    expect(traces.rows).toEqual([
      { trace_id: "evt_4_4_bf_live#deferred-issuance", provenance_kind: "runtime_recorded" },
      { trace_id: "evt_4_4_bf_ok#deferred-issuance", provenance_kind: "backfilled_verified" },
    ])
    const quarantine = await client.query<{ source_event_id: string }>(
      "SELECT source_event_id FROM deferred_issuance_trace_backfill_quarantine ORDER BY source_event_id"
    )
    expect(quarantine.rows.map((r) => r.source_event_id)).toEqual([
      "evt_4_4_bf_nomarket#deferred-issuance",
      "evt_4_4_bf_noowner#deferred-issuance",
    ])
  })
})
