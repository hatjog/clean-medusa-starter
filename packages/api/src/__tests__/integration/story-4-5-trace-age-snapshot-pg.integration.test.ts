/**
 * v1.16.0 Story 4.5 AC2 (FR-12, AD-32) — wiek śladu liczony w BAZIE z jednej
 * migawki, na realnym PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-4-5-trace-age-pg`
 * Baza: izolowana `gp_story_4_5_test` (stack gp-test, port 55432); odmowa
 * startu na bazie bez sufiksu `_test`.
 *
 * Populacja z `psp_occurred_at` postarzonym w SQL (`now() - interval`) po obu
 * stronach progu z `recovery-config.ts`; selekcja ponad progiem to jedno
 * zapytanie ze `statement_timestamp()`; przesunięty zegar procesu Node (fake
 * timers na `Date`) NIE zmienia wyniku.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration20261114100000DeferredIssuanceTraceTable } from "../../migrations/Migration20261114100000DeferredIssuanceTraceTable"
import {
  listDeferredIssuanceTracesOverAgeThreshold,
  recordDeferredIssuanceTrace,
} from "../../lib/recovery/deferred-issuance-trace"
import {
  DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD,
  DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS,
  DEFERRED_ISSUANCE_TRACE_SLA_SECONDS,
} from "../../lib/recovery/recovery-config"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const SCOPE_A = { instance_id: "gp_inst_4_5", market_id: "mkt_4_5_a" }
const SCOPE_B = { instance_id: "gp_inst_4_5", market_id: "mkt_4_5_b" }

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

const describeOrNotRun = enabled ? describe : describe.skip

if (!enabled) {
  describe("Story 4.5 — wiek śladu z jednej migawki bazy", () => {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 4.5: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
    })
  })
}

describeOrNotRun("Story 4.5 — wiek śladu z jednej migawki bazy", () => {
  let pool: Pool
  let client: PoolClient

  async function seed(eventId: string, ageOffsetSeconds: number, scope = SCOPE_A, state = "awaiting_order") {
    await asRuntime(client, scope, () =>
      recordDeferredIssuanceTrace(client, {
        stripe_event_id: eventId,
        payment_intent_id: `pi_${eventId}`,
        instance_id: scope.instance_id,
        market_id: scope.market_id,
        psp_occurred_at: "2026-11-14T10:00:00.000Z",
        sla_seconds: DEFERRED_ISSUANCE_TRACE_SLA_SECONDS,
      })
    )
    // Postarzenie w SQL: wiek względem zegara BAZY, nie procesu.
    await client.query(
      `UPDATE deferred_issuance_trace
          SET psp_occurred_at = now() - make_interval(secs => $2::double precision)
        WHERE stripe_event_id = $1`,
      [eventId, DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS + ageOffsetSeconds]
    )
    if (state !== "awaiting_order") {
      await client.query(
        `UPDATE deferred_issuance_trace SET state = $2 WHERE stripe_event_id = $1`,
        [eventId, state]
      )
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    client = await pool.connect()
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 4.5 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
    for (const sql of await collectSql("down")) await client.query(sql)
    for (const sql of await collectSql("up")) await client.query(sql)
  })

  afterAll(async () => {
    jest.useRealTimers()
    if (client) {
      for (const sql of await collectSql("down")) await client.query(sql)
      client.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    jest.useRealTimers()
    await client.query("DELETE FROM deferred_issuance_trace")
    await seed("evt_4_5_old", 3600) // próg + 1 h → ponad progiem
    await seed("evt_4_5_young", -3600) // próg − 1 h → pod progiem
    await seed("evt_4_5_old_escalated", 7200, SCOPE_A, "escalated") // nie awaiting_order
    await seed("evt_4_5_old_other_market", 3600, SCOPE_B) // obcy rynek (RLS)
  })

  it("selekcja ponad progiem: tylko stary ślad awaiting_order własnego rynku; wiek liczy baza", async () => {
    const out = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracesOverAgeThreshold(client))
    expect(out.threshold_seconds).toBe(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD.seconds)
    expect(out.rows.map((r) => r.stripe_event_id)).toEqual(["evt_4_5_old"])
    const age = Number(out.rows[0].age_seconds)
    expect(age).toBeGreaterThanOrEqual(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS + 3600)
    expect(age).toBeLessThan(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS + 3600 + 120)
    expect(out.rows[0].age_source).toBe("database_now_minus_occurred_at")
  })

  it("jedna migawka: measured_at i wiek pochodzą z tego samego statement_timestamp()", async () => {
    const out = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracesOverAgeThreshold(client))
    const check = await client.query<{ diff: string }>(
      `SELECT EXTRACT(EPOCH FROM ($1::timestamptz - psp_occurred_at))::bigint AS diff
         FROM deferred_issuance_trace WHERE stripe_event_id = 'evt_4_5_old'`,
      [out.rows[0].measured_at]
    )
    expect(Number(check.rows[0].diff)).toBe(Number(out.rows[0].age_seconds))
  })

  it("przesunięty zegar procesu Node (fake Date) NIE zmienia wyniku", async () => {
    const baseline = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracesOverAgeThreshold(client))
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
    })
    for (const shifted of ["2030-01-01T00:00:00Z", "2001-01-01T00:00:00Z"]) {
      jest.setSystemTime(new Date(shifted))
      expect(new Date().toISOString().slice(0, 4)).toBe(shifted.slice(0, 4))
      const out = await asRuntime(client, SCOPE_A, () => listDeferredIssuanceTracesOverAgeThreshold(client))
      expect(out.rows.map((r) => r.stripe_event_id)).toEqual(baseline.rows.map((r) => r.stripe_event_id))
    }
    jest.useRealTimers()
  })

  it("mutant progu: próg podniesiony ponad wiek starego śladu daje pustą populację", async () => {
    const out = await asRuntime(client, SCOPE_A, () =>
      listDeferredIssuanceTracesOverAgeThreshold(client, {
        ...DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD,
        seconds: DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS + 7200,
      })
    )
    expect(out.rows).toEqual([])
  })
})
