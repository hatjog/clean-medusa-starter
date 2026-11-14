/**
 * Story 4.2 — atomowa zmiana stanu dostawy na prawdziwym PostgreSQL-u.
 *
 * Suity nie uruchamiają się bez DATABASE_URL: brak bazy jest SKIP, nigdy
 * fałszywie zielonym PASS. DDL pochodzi bezpośrednio z klas migracji, a test
 * używa PgDispatchLedger z knex.raw — bez ręcznego klona SQL produkcyjnego.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import brevoDeliveryTracker from "../../subscribers/brevo-delivery-tracker"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"
import {
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { Migration1778933000000 } from "../../modules/voucher/migrations/1778933000000_create_voucher_delivery_dispatch"
import { Migration1778935000000 } from "../../modules/voucher/migrations/1778935000000_preserve_voucher_delivery_first_failure"
import { Migration1778936000000 } from "../../modules/voucher/migrations/1778936000000_limit_voucher_delivery_configuration_recovery"
import { Migration1778937000000 } from "../../modules/voucher/migrations/1778937000000_add_provider_response_to_voucher_delivery_dispatch"
import { Migration1778938000000 } from "../../modules/voucher/migrations/1778938000000_add_correlation_token_to_voucher_delivery_dispatch"
import { Migration1778939000000 } from "../../modules/voucher/migrations/1778939000000_add_voucher_delivery_provider_error_kind"
import { Migration1779012000000 } from "../../modules/voucher/migrations/1779012000000_add_voucher_delivery_attribution_and_escalation"
import { Migration1779014000000 } from "../../modules/voucher/migrations/1779014000000_add_delivery_measurement_context"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip
const TEST_SCHEMA = "story_4_2_recovery"
const RECIPIENT = hashRecipientEmail("story-4-2@example.test")
const PROVIDER_MESSAGE_ID = "brevo-test-message-4-2"

type MigrationLike = { up(): Promise<void> }
type MigrationCtor = { prototype: MigrationLike }

async function migrationSql(ctor: MigrationCtor): Promise<string[]> {
  const statements: string[] = []
  const instance = Object.create(ctor.prototype) as MigrationLike & {
    addSql: (sql: string) => void
  }
  instance.addSql = (sql) => statements.push(sql)
  await instance.up()
  return statements
}

const MIGRATIONS: MigrationCtor[] = [
  Migration1778933000000,
  Migration1778935000000,
  Migration1778936000000,
  Migration1778937000000,
  Migration1778938000000,
  Migration1778939000000,
  Migration1779012000000,
  Migration1779014000000,
]

runOrSkip("Story 4.2 — Brevo delivery state na REALNYM PostgreSQL-u", () => {
  let db: Knex

  beforeAll(async () => {
    db = knexFactory({
      client: "pg",
      connection: DATABASE_URL as string,
      pool: { min: 0, max: 4 },
      searchPath: [TEST_SCHEMA, "public"],
    })
    await db.raw(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`)
    for (const migration of MIGRATIONS) {
      for (const sql of await migrationSql(migration)) await db.raw(sql)
    }
  })

  afterAll(async () => {
    if (!db) return
    await db.raw(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`)
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw(`TRUNCATE ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE}`)
    await db.raw(`TRUNCATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)
  })

  async function seedSentRow(): Promise<void> {
    const ledger = new PgDispatchLedger(db, {
      now: () => new Date("2026-08-12T10:00:00.000Z"),
      uuid: () => "dispatch-4-2",
    })
    const reserved = await ledger.reserveDispatch({
      entitlement_id: "entitlement-4-2",
      template_key: "voucher_purchase_confirmation",
      recipient_hash: RECIPIENT,
      env: "test",
      instance_id: "integration-4-2",
      market_id: "bonbeauty",
      flow_id: "voucher_purchase_delivery",
      locale: "pl-PL",
    })
    expect(reserved.outcome).toBe("reserved")
    await expect(
      ledger.markSent({
        dispatch_id: "dispatch-4-2",
        provider: "brevo",
        provider_message_id: PROVIDER_MESSAGE_ID,
      }),
    ).resolves.toBe(true)
  }

  it("dwa niezależne ledgery dają jedną zmianę i jeden audit transition", async () => {
    await seedSentRow()
    const dbA = knexFactory({ client: "pg", connection: DATABASE_URL as string, pool: { min: 0, max: 1 }, searchPath: [TEST_SCHEMA, "public"] })
    const dbB = knexFactory({ client: "pg", connection: DATABASE_URL as string, pool: { min: 0, max: 1 }, searchPath: [TEST_SCHEMA, "public"] })
    try {
      const [first, second] = await Promise.all([
        new PgDispatchLedger(dbA).applyProviderDeliveryState({
          provider_event_id: PROVIDER_MESSAGE_ID,
          provider: "brevo",
          status: "delivered",
        }),
        new PgDispatchLedger(dbB).applyProviderDeliveryState({
          provider_event_id: PROVIDER_MESSAGE_ID,
          provider: "brevo",
          status: "delivered",
        }),
      ])
      expect([first.outcome, second.outcome].sort()).toEqual(["duplicate", "updated"])
      const { rows } = await db.raw(
        `SELECT status, count(*) OVER ()::int AS n FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
      )
      const audit = await db.raw(
        `SELECT count(*)::int AS n FROM ${VOUCHER_DELIVERY_DISPATCH_AUDIT_TABLE}
          WHERE dispatch_id = 'dispatch-4-2' AND to_status = 'delivered'`,
      )
      expect(rows[0]).toMatchObject({ status: "delivered", n: 1 })
      expect(audit.rows[0].n).toBe(1)
    } finally {
      await dbA.destroy()
      await dbB.destroy()
    }
  })

  it("rozróżnia sierotę i powtórzenie po stanie delivered", async () => {
    await seedSentRow()
    const ledger = new PgDispatchLedger(db)
    await expect(
      ledger.applyProviderDeliveryState({
        provider_event_id: "missing-provider-message",
        status: "delivered",
      }),
    ).resolves.toMatchObject({ outcome: "orphan" })
    await expect(
      ledger.applyProviderDeliveryState({
        provider_event_id: PROVIDER_MESSAGE_ID,
        status: "delivered",
      }),
    ).resolves.toMatchObject({ outcome: "updated" })
    await expect(
      ledger.applyProviderDeliveryState({
        provider_event_id: PROVIDER_MESSAGE_ID,
        status: "delivered",
      }),
    ).resolves.toMatchObject({ outcome: "duplicate" })
  })

  /**
   * Story 6.6 AC4 (DW-15-120): webhook odbicia aktualizuje TEN wiersz, a trwale
   * odbicie eskaluje ta sama droga co wyczerpanie budzetu odbiorcy.
   */
  it("trwale odbicie domyka budzet raz, wiersz jest zajmowany do eskalacji; replay nie zmienia budzetu", async () => {
    await seedSentRow()
    const ledger = new PgDispatchLedger(db)
    const before = await db.raw(
      `SELECT attempt_count, non_recipient_failure_count FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
    )
    const hardBounce = {
      provider_event_id: PROVIDER_MESSAGE_ID,
      provider: "brevo",
      status: "failed" as const,
      error_code: "HARD_BOUNCE",
      exhaust_recipient_budget: { max_attempt_count: 5 },
    }
    await expect(ledger.applyProviderDeliveryState(hardBounce)).resolves.toMatchObject({
      outcome: "updated",
      dispatch_id: "dispatch-4-2",
    })
    const after = await db.raw(
      `SELECT status, error_code, attempt_count, non_recipient_failure_count
         FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
    )
    expect(after.rows[0]).toMatchObject({ status: "failed", error_code: "HARD_BOUNCE" })
    expect(
      Number(after.rows[0].attempt_count) - Number(after.rows[0].non_recipient_failure_count),
    ).toBe(5)
    expect(Number(after.rows[0].attempt_count)).toBeGreaterThanOrEqual(
      Number(before.rows[0].attempt_count),
    )

    await expect(ledger.applyProviderDeliveryState(hardBounce)).resolves.toMatchObject({
      outcome: "duplicate",
    })
    const replay = await db.raw(`SELECT attempt_count FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)
    expect(replay.rows[0].attempt_count).toBe(after.rows[0].attempt_count)

    const claimed = await ledger.claimAttemptPolicyEscalations({
      max_attempt_count: 5,
      max_total_attempt_count: 40,
      created_after: "2026-01-01T00:00:00.000Z",
      limit: 10,
    })
    expect(claimed.map((row) => row.dispatch_id)).toEqual(["dispatch-4-2"])
    expect(claimed[0].error_code).toBe("HARD_BOUNCE")
  })

  it("chwilowe odbicie NIE domyka budzetu i NIE eskaluje — wiersz zostaje do ponowienia", async () => {
    await seedSentRow()
    const ledger = new PgDispatchLedger(db)
    await expect(
      ledger.applyProviderDeliveryState({
        provider_event_id: PROVIDER_MESSAGE_ID,
        provider: "brevo",
        status: "failed",
        error_code: "SOFT_BOUNCE",
      }),
    ).resolves.toMatchObject({ outcome: "updated" })
    const claimed = await ledger.claimAttemptPolicyEscalations({
      max_attempt_count: 5,
      max_total_attempt_count: 40,
      created_after: "2026-01-01T00:00:00.000Z",
      limit: 10,
    })
    expect(claimed).toEqual([])
    const row = await db.raw(
      `SELECT status, escalated_at FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
    )
    expect(row.rows[0]).toMatchObject({ status: "failed", escalated_at: null })
  })

  /**
   * R-3 (checkpoint 6.6): wszystkie klasy odbicia mapuja sie na `failed`.
   * Trwale odbicie PO soft bounce albo blocked trafialo w `WHERE status <> 'failed'`
   * = 0 wierszy => `duplicate`, bez domkniecia budzetu i bez eskalacji.
   */
  for (const earlier of ["SOFT_BOUNCE", "BLOCKED"] as const) {
    it(`R-3: trwale odbicie po ${earlier} domyka budzet i eskaluje (status juz failed)`, async () => {
      await seedSentRow()
      const ledger = new PgDispatchLedger(db)
      await expect(
        ledger.applyProviderDeliveryState({
          provider_event_id: PROVIDER_MESSAGE_ID,
          provider: "brevo",
          status: "failed",
          error_code: earlier,
        }),
      ).resolves.toMatchObject({ outcome: "updated" })

      const hardBounce = {
        provider_event_id: PROVIDER_MESSAGE_ID,
        provider: "brevo",
        status: "failed" as const,
        error_code: "HARD_BOUNCE",
        exhaust_recipient_budget: { max_attempt_count: 5 },
      }
      await expect(ledger.applyProviderDeliveryState(hardBounce)).resolves.toMatchObject({
        outcome: "updated",
        dispatch_id: "dispatch-4-2",
      })
      const after = await db.raw(
        `SELECT status, error_code, attempt_count, non_recipient_failure_count
           FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
      )
      expect(after.rows[0]).toMatchObject({ status: "failed", error_code: "HARD_BOUNCE" })
      expect(
        Number(after.rows[0].attempt_count) - Number(after.rows[0].non_recipient_failure_count),
      ).toBe(5)

      // Replay trwalego odbicia: budzet juz domkniety => dopiero teraz duplicate.
      await expect(ledger.applyProviderDeliveryState(hardBounce)).resolves.toMatchObject({
        outcome: "duplicate",
      })

      const claimed = await ledger.claimAttemptPolicyEscalations({
        max_attempt_count: 5,
        max_total_attempt_count: 40,
        created_after: "2026-01-01T00:00:00.000Z",
        limit: 10,
      })
      expect(claimed.map((row) => row.dispatch_id)).toEqual(["dispatch-4-2"])
      expect(claimed[0].error_code).toBe("HARD_BOUNCE")
    })
  }

  /**
   * R-2 (checkpoint 6.6): `lookupDispatch` (sciezka `db.raw`) na REALNYM
   * schemacie voucher_delivery_dispatch. Projekcja z nieistniejacymi kolumnami
   * dawala 42703 => DISPATCH_LOOKUP_FAILED => dispatch=null, a zdarzenie bez
   * `market_id` nie odzyskiwalo rynku z wiersza.
   */
  it("R-2: tracker odzyskuje rynek z wiersza dispatchu przez realne zapytanie i zapisuje stan", async () => {
    await seedSentRow()
    const previousInstance = process.env.GP_INSTANCE_ID
    process.env.GP_INSTANCE_ID = "gp-test"
    const sqlSeen: string[] = []
    const pg = {
      // Jedyna atrapa: odczyt hamulca (tabela konfiguracji rynku nie nalezy do
      // tego schematu testowego). Kazde inne zapytanie idzie do REALNEGO PG.
      raw: async (sql: string, bindings?: readonly unknown[]) => {
        sqlSeen.push(sql)
        if (sql.includes("market_runtime_config")) {
          return { rows: [{ money_path_brakes: { fr_9_delivery_idempotency: "released" } }] }
        }
        return bindings === undefined ? db.raw(sql) : db.raw(sql, bindings as never)
      },
    }
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const envelopes: Array<Record<string, unknown>> = []
    const container = {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "__pg_connection__") return pg
        if (key === "notification_delivery_audit_sink") {
          return { record: async (e: Record<string, unknown>) => void envelopes.push(e) }
        }
        if (key === "brevo_delivery_event_verifier") {
          return { verify: async () => ({ outcome: "confirmed", statistics_event: "hardBounces" }) }
        }
        throw new Error(`Unknown container key: ${key}`)
      },
    }
    try {
      await brevoDeliveryTracker({
        event: {
          name: "notification.hard_bounce",
          // Bez market_id w ladunku: rynek MUSI przyjsc z wiersza dispatchu.
          data: {
            provider_id: "brevo",
            provider_event_id: PROVIDER_MESSAGE_ID,
            event_type: "hard_bounce",
          },
        },
        container,
      } as never)
    } finally {
      if (previousInstance === undefined) delete process.env.GP_INSTANCE_ID
      else process.env.GP_INSTANCE_ID = previousInstance
    }

    expect(sqlSeen.some((sql) => sql.includes("FROM voucher_delivery_dispatch"))).toBe(true)
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("DISPATCH_LOOKUP_FAILED"),
    )
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]).toMatchObject({ market_id: "bonbeauty", dispatch_id: "dispatch-4-2" })
    const row = await db.raw(
      `SELECT status, error_code FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}`,
    )
    expect(row.rows[0]).toMatchObject({ status: "failed", error_code: "HARD_BOUNCE" })
  })
})
