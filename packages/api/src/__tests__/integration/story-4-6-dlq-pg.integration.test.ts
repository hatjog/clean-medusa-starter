/**
 * Story 4.6 AC1/AC2 — nośnik DLQ na realnym PostgreSQL (ADR-239).
 *
 * Realny konsument: domyślny eksport `on-order-placed-stripe-retry`. Jedynym
 * podstawionym zapytaniem jest ODCZYT źródła (`FIND_DEFERRED_CAPTURES_SQL`) —
 * zwraca skonstruowany marker, bo pełne zamówienie/płatność nie są przedmiotem
 * AC. Każde inne zapytanie konsumenta (savepoint, GUC, INSERT DLQ) idzie do
 * PostgreSQL jako rola `medusa_store` (bez BYPASSRLS) — granica RLS z 11.1.
 * Migracja `1779018600000` jest wykonywana z klasy migracji w transakcji testu;
 * całość kończy ROLLBACK.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1779018600000 } from "../../modules/voucher/migrations/1779018600000_create_mor_policy_dlq_entry"
import onOrderPlacedStripeRetry, {
  FIND_DEFERRED_CAPTURES_SQL,
  MARK_DEFERRED_RESOLVED_SQL,
  STRIPE_RETRY_DLQ_SOURCE,
} from "../../subscribers/on-order-placed-stripe-retry"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const SCOPE_A = { instance_id: "instance-a", market_id: "market-a" }

type Behaviour = { findRows?: unknown[]; findError?: Error; otherError?: Error }

async function migrationSql(): Promise<string[]> {
  const out: string[] = []
  await Migration1779018600000.prototype.up.call({ addSql: (s: string) => out.push(s) })
  return out
}

function pathYRow(eventId: string, envelope: Record<string, unknown>) {
  return {
    event_id: eventId,
    provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    market_id: SCOPE_A.market_id,
    envelope,
    amount: 1000,
    currency_code: "pln",
    payment_id: "pay_46",
    payment_intent_id: "pi_46",
  }
}

describe("Story 4.6 — DLQ na rzeczywistym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 4.6 DLQ: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
      expect(enabled).toBe(false)
    })
    return
  }

  let pool: Pool
  let client: PoolClient
  const sent: string[] = []
  let behaviour: Behaviour = {}
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

  /** Pool-like: transakcja konsumenta = savepoint w transakcji testu, rola runtime. */
  const consumerPool = {
    connect: async () => ({
      release: () => undefined,
      query: async (sql: string, values: unknown[] = []) => {
        sent.push(sql)
        if (sql === "BEGIN") {
          await client.query("SAVEPOINT consumer_tx")
          await client.query("SET LOCAL ROLE medusa_store")
          return { rows: [], rowCount: 0 }
        }
        if (sql === "COMMIT") return client.query("RELEASE SAVEPOINT consumer_tx")
        if (sql === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT consumer_tx")
        if (sql === FIND_DEFERRED_CAPTURES_SQL) {
          if (behaviour.findError) throw behaviour.findError
          const rows = behaviour.findRows ?? []
          return { rows, rowCount: rows.length }
        }
        const passthrough = /SAVEPOINT|set_config|current_setting|mor_policy_dlq_entry/.test(sql)
        if (!passthrough && behaviour.otherError) throw behaviour.otherError
        return client.query(sql, values)
      },
    }),
  }

  async function runConsumer(orderId: string): Promise<void> {
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: orderId } },
      container: {
        logger,
        resolve: (key: string) => {
          if (key === "__pg_pool__") return consumerPool
          throw new Error(`unexpected resolve(${key})`)
        },
      },
    })
    await client.query("RESET ROLE")
  }

  async function dlqRows(scope: { instance_id: string; market_id: string }, eventId: string) {
    await client.query("SAVEPOINT read_scope")
    await client.query("SET LOCAL ROLE medusa_store")
    await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [scope.instance_id])
    await client.query("SELECT set_config('app.gp_market_id', $1, true)", [scope.market_id])
    const r = await client.query(
      "SELECT instance_id, market_id, reason, event_class, classification, owner_id, state FROM mor_policy_dlq_entry WHERE event_id = $1",
      [eventId]
    )
    await client.query("ROLLBACK TO SAVEPOINT read_scope")
    return r.rows
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    client = await pool.connect()
    await client.query("BEGIN")
    for (const s of await migrationSql()) await client.query(s)
    process.env.GP_INSTANCE_ID = SCOPE_A.instance_id
  })
  afterAll(async () => {
    await client?.query("ROLLBACK")
    client?.release()
    await pool?.end()
  })
  beforeEach(() => {
    sent.length = 0
    behaviour = {}
  })

  it("baza jest izolowana (*_test), a rola runtime nie ma BYPASSRLS", async () => {
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    expect(db.rows[0]?.name).toMatch(/_test$/)
    const role = await client.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'medusa_store'")
    expect(role.rows).toEqual([{ rolbypassrls: false }])
    const rls = await client.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'mor_policy_dlq_entry'"
    )
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
  })

  it("AC1: trwała wada danych w realnym konsumencie kończy się JEDNYM wierszem DLQ, nie pętlą", async () => {
    behaviour = { findRows: [pathYRow("evt_46_perm#deferred-issuance", { entitlement_issue_deferred_reason: "x" })] }
    await runConsumer("order_46_perm")
    await runConsumer("order_46_perm")

    const own = await dlqRows(SCOPE_A, "evt_46_perm#deferred-issuance")
    expect(own).toHaveLength(1)
    expect(own[0]).toEqual(
      expect.objectContaining({
        ...SCOPE_A,
        event_class: "permanent_data_defect",
        classification: "terminal",
        owner_id: "ops-recovery",
        state: "dlq_pending_ops_review",
      })
    )
    expect(String(own[0]?.reason)).toMatch(/^permanent_data_defect:path_y_marker_psp_occurred_at/)
    expect(sent).not.toContain(MARK_DEFERRED_RESOLVED_SQL)
  })

  it("AC1: wiersz DLQ jest widoczny tylko pod własnym market_id (market_isolation)", async () => {
    behaviour = { findRows: [pathYRow("evt_46_rls#deferred-issuance", {})] }
    await runConsumer("order_46_rls")
    expect(await dlqRows(SCOPE_A, "evt_46_rls#deferred-issuance")).toHaveLength(1)
    expect(await dlqRows({ ...SCOPE_A, market_id: "market-b" }, "evt_46_rls#deferred-issuance")).toEqual([])
    expect(await dlqRows({ ...SCOPE_A, instance_id: "instance-b" }, "evt_46_rls#deferred-issuance")).toEqual([])
  })

  it("AC1: nieznany błąd to nazwana klasa fail-closed w DLQ, nie ponowienie", async () => {
    behaviour = {
      findRows: [{ ...pathYRow("evt_46_unknown#deferred-issuance", {}), provider: "stripe" }],
      otherError: new Error("unexpected consumer failure"),
    }
    await runConsumer("order_46_unknown")
    const own = await dlqRows(SCOPE_A, "evt_46_unknown#deferred-issuance")
    expect(own).toHaveLength(1)
    expect(own[0]).toEqual(expect.objectContaining({ event_class: "unknown_fail_closed", classification: "terminal" }))
  })

  it("AC2: wada przejściowa nie tworzy wiersza DLQ i zostawia marker do ponowienia", async () => {
    behaviour = {
      findRows: [{ ...pathYRow("evt_46_transient#deferred-issuance", {}), provider: "stripe" }],
      otherError: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    }
    await runConsumer("order_46_transient")
    expect(await dlqRows(SCOPE_A, "evt_46_transient#deferred-issuance")).toEqual([])
    expect(sent).not.toContain(MARK_DEFERRED_RESOLVED_SQL)
    const all = await client.query("SELECT count(*)::int AS n FROM mor_policy_dlq_entry WHERE event_id = $1", [
      "evt_46_transient#deferred-issuance",
    ])
    expect(all.rows[0]).toEqual({ n: 0 })
  })

  it("AC2: nośnik odrzuca wiersz klasy transient_retry na poziomie schematu", async () => {
    await client.query("SAVEPOINT bad_insert")
    await expect(
      client.query(
        `INSERT INTO mor_policy_dlq_entry (dlq_entry_id, instance_id, market_id, state, owner_type, owner_id, deadline,
          occurred_at, closure_path, provenance_kind, provenance_source, tier, classification, failure_mode,
          is_retryable, reason, source_job, event_class, event_id, subject_id)
         VALUES ('x','i','m','dlq_pending_ops_review','operator_role','ops-recovery',now(),now(),'not_closed',
          'runtime_observed',$1,'dlq_pending_ops_review','terminal','FM-71-RT-2',false,'r',$1,'transient_retry','e','o')`,
        [STRIPE_RETRY_DLQ_SOURCE]
      )
    ).rejects.toMatchObject({ code: "23514" })
    await client.query("ROLLBACK TO SAVEPOINT bad_insert")
  })
})
