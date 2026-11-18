/**
 * v1.16.0 Story 8.7 — hook RLS (`installRlsPoolHook`) na REALNYM PostgreSQL
 * (baza `*_test`, profil `test:integration:story-8-7-rls-hook-pg`).
 *
 *  - DW-15-370 (retro E5-X-4): odmowa w `acquireConnection` (brak kontekstu
 *    rynku) nie może wyczerpać puli Knexa. Pula `max = n`, n+1 odmów hooka,
 *    potem zapytanie Z kontekstem rynku musi zakończyć się w czasie.
 *
 * Bez `DATABASE_URL` na bazie `*_test` suita jest SKIP-owana — nigdy fałszywy PASS.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import { installRlsPoolHook, RlsMarketContextRequiredError } from "../../lib/rls-pool-hook"
import { marketContextStorage } from "../../lib/market-context"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const isTestDb = /\/[A-Za-z0-9_]*_test(\?|$)/.test(DATABASE_URL)
const maybe = DATABASE_URL && isTestDb ? describe : describe.skip

const POOL_MAX = 2
const ACQUIRE_TIMEOUT_MS = 3_000

maybe("Story 8.7 DW-15-370 — odmowy hooka RLS nie wyczerpują puli (PG)", () => {
  let knex: Knex
  const logs: string[] = []
  const logger = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
  }

  beforeAll(() => {
    knex = knexFactory({
      client: "pg",
      connection: DATABASE_URL,
      pool: { min: 0, max: POOL_MAX },
      acquireConnectionTimeout: ACQUIRE_TIMEOUT_MS,
    })
    installRlsPoolHook(knex as never, logger)
  })

  afterAll(async () => {
    await knex?.destroy()
  })

  it(`pula max=${POOL_MAX}: ${POOL_MAX + 1} odmów hooka, potem zapytanie z kontekstem rynku kończy się w czasie`, async () => {
    for (let i = 0; i < POOL_MAX + 1; i += 1) {
      await expect(knex.raw("SELECT 1 AS one")).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = (knex.client as any).pool
    // Zasób odmówionego połączenia NIE może zostać zaliczony jako „w użyciu".
    expect(pool.numUsed()).toBe(0)

    const started = Date.now()
    const result = await marketContextStorage.run(
      { market_id: "bonbeauty", instance_id: "gp_test" } as never,
      async () => await knex.raw<{ rows: Array<{ market: string; who: string }> }>(
        "SELECT current_setting('app.gp_market_id', true) AS market, current_user AS who"
      )
    )
    const elapsed = Date.now() - started
    expect(result.rows[0]).toEqual({ market: "bonbeauty", who: "medusa_store" })
    expect(elapsed).toBeLessThan(ACQUIRE_TIMEOUT_MS)
    expect(pool.numUsed()).toBe(0)
  })
})
