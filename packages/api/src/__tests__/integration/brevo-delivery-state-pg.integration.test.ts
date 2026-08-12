/**
 * Story 4.2 — atomowa zmiana stanu dostawy na prawdziwym PostgreSQL-u.
 *
 * Suity nie uruchamiają się bez DATABASE_URL: brak bazy jest SKIP, nigdy
 * fałszywie zielonym PASS. DDL pochodzi bezpośrednio z klas migracji, a test
 * używa PgDispatchLedger z knex.raw — bez ręcznego klona SQL produkcyjnego.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

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
})
