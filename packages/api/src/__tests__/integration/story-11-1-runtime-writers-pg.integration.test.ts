/**
 * Story 11.1 AI-Review-003 / AI-Review-005 — PRODUKCYJNI writerzy AC1/AC3 na
 * realnym PostgreSQL pod RLS (rola `medusa_store`, obie osie scope).
 *
 * W odróżnieniu od testów boundary/scope (bezpośredni SQL z ręcznie podanym
 * scope) tutaj zapis wykonują funkcje runtime:
 *   - `reserveClaimBinding` (claim route → voucher_claim_binding),
 *   - `appendClaimAudit` (claim route → voucher_claim_audit),
 *   - `liveIssueEntitlementsWithinTx` (issuance → event_processed, business dedupe).
 * Scope pochodzi z kontekstu runtime (`marketContextStorage`), a GUC sesji
 * odpowiada temu, co ustawia pool hook. Kontrole ujemne: brak scope ⇒ odmowa
 * w kodzie, rozjazd scope vs GUC ⇒ odmowa RLS w PostgreSQL.
 *
 * Wymaga bazy doprowadzonej do schematu 11.1 przez `pnpm run db:migrate:story-11-1`
 * (kontrola rewizji migracji w `mikro_orm_migrations`); wszystko w transakcji
 * zakończonej ROLLBACK.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import {
  appendClaimAudit,
  ClaimMarketContextRequiredError,
  reserveClaimBinding,
  type PgClientLike,
} from "../../api/store/vouchers/[code]/claim/helpers"
import { marketContextStorage } from "../../lib/market-context"
import { liveIssueEntitlementsWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"

const enabled = process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const STORY_11_1_MIGRATION = "1779016000000_runtime_recovery_rls_boundary"
const SCOPE_A = { instance_id: "instance-a", market_id: "market-a" }

class StopAfterFirstQuery extends Error {}

async function setGuc(client: PoolClient, instanceId: string, marketId: string): Promise<void> {
  await client.query("SELECT set_config('app.gp_instance_id', $1, true)", [instanceId])
  await client.query("SELECT set_config('app.gp_market_id', $1, true)", [marketId])
}

function asClaimClient(client: PoolClient): PgClientLike {
  return client as unknown as PgClientLike
}

describe("Story 11.1 — produkcyjni writerzy pod RLS na rzeczywistym PostgreSQL", () => {
  if (!enabled) {
    it("NOT_RUN: wymaga GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL", () => {
      console.warn("[NOT_RUN] Story 11.1 writerzy runtime: ustaw GP_RUN_MIGRATION_INTEGRATION=1 i DATABASE_URL")
      expect(enabled).toBe(false)
    })
    return
  }

  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    client = await pool.connect()
  })
  afterAll(async () => {
    client?.release()
    await pool?.end()
  })

  async function inRuntimeTx(work: () => Promise<void>): Promise<void> {
    await client.query("BEGIN")
    try {
      await client.query("SET LOCAL ROLE medusa_store")
      await setGuc(client, SCOPE_A.instance_id, SCOPE_A.market_id)
      await work()
    } finally {
      await client.query("ROLLBACK")
    }
  }

  it("baza jest izolowana i niesie rewizję migracji Story 11.1", async () => {
    const db = await client.query<{ name: string }>("SELECT current_database() AS name")
    expect(db.rows[0]?.name).toMatch(/_test$/)
    const revision = await client.query("SELECT 1 FROM mikro_orm_migrations WHERE name = $1", [STORY_11_1_MIGRATION])
    expect(revision.rowCount).toBe(1)
  })

  it("reserveClaimBinding zapisuje binding z obiema osiami z kontekstu runtime; obcy rynek go nie widzi", async () => {
    await inRuntimeTx(async () => {
      const result = await marketContextStorage.run(SCOPE_A, () =>
        reserveClaimBinding(asClaimClient(client), {
          idempotencyKey: "story-11-1-writer-binding",
          bindingHash: "story-11-1-writer-hash",
          code: "story-11-1-writer-code",
          claimedAt: "2026-11-14T12:00:00Z",
        })
      )
      expect(result).toEqual({ inserted: true })
      const own = await client.query<{ instance_id: string; market_id: string }>(
        "SELECT instance_id, market_id FROM voucher_claim_binding WHERE idempotency_key = 'story-11-1-writer-binding'"
      )
      expect(own.rows).toEqual([SCOPE_A])

      await setGuc(client, "instance-a", "market-b")
      const foreign = await client.query(
        "SELECT 1 FROM voucher_claim_binding WHERE idempotency_key = 'story-11-1-writer-binding'"
      )
      expect(foreign.rows).toEqual([])
    })
  })

  it("appendClaimAudit zapisuje audit z obiema osiami i łańcuchem hashy", async () => {
    await inRuntimeTx(async () => {
      await marketContextStorage.run(SCOPE_A, () =>
        appendClaimAudit(asClaimClient(client), {
          idempotency_key: "story-11-1-writer-audit",
          code: "story-11-1-writer-code",
          ip: "127.0.0.1",
          outcome: "ok",
          occurred_at: "2026-11-14T12:00:00Z",
        })
      )
      const rows = await client.query<{ instance_id: string; market_id: string; content_hash: string }>(
        "SELECT instance_id, market_id, content_hash FROM voucher_claim_audit WHERE idempotency_key = 'story-11-1-writer-audit'"
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]).toEqual(expect.objectContaining({ ...SCOPE_A, content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }))
    })
  })

  it("liveIssueEntitlementsWithinTx zapisuje business dedupe event_processed z obiema osiami", async () => {
    await inRuntimeTx(async () => {
      let calls = 0
      // Przepuszczamy do PostgreSQL wyłącznie PIERWSZY krok workflow (business
      // dedupe); dalsze kroki wymagają pełnego zamówienia i nie są przedmiotem AC.
      const firstStepOnly = {
        query: async (sql: string, params?: unknown[]) => {
          calls += 1
          if (calls > 1) throw new StopAfterFirstQuery()
          return client.query(sql, params as unknown[])
        },
      }
      await expect(
        liveIssueEntitlementsWithinTx(
          firstStepOnly as never,
          {
            event_type: "gp.stripe.payment_intent_succeeded.v1",
            payload: {
              payment_intent_id: "pi_story_11_1_writer",
              order_id: "order_story_11_1_writer",
              currency: "PLN",
              amount_minor: 1000,
              psp_occurred_at: "2026-11-14T12:00:00.000Z",
            },
            scope: SCOPE_A,
          } as never,
          new Date("2026-11-14T12:00:00Z")
        )
      ).rejects.toBeInstanceOf(StopAfterFirstQuery)
      const rows = await client.query<{ instance_id: string; market_id: string; purchase_key: string }>(
        "SELECT instance_id, market_id, purchase_key FROM event_processed WHERE external_id = 'pi_story_11_1_writer:order_story_11_1_writer'"
      )
      expect(rows.rows).toEqual([{ ...SCOPE_A, purchase_key: "pi_story_11_1_writer" }])
    })
  })

  it("kontrola ujemna: writer claimu bez scope w kontekście runtime odmawia przed zapisem", async () => {
    await inRuntimeTx(async () => {
      await expect(
        reserveClaimBinding(asClaimClient(client), {
          idempotencyKey: "story-11-1-writer-noscope",
          bindingHash: "h",
          code: "c",
          claimedAt: "2026-11-14T12:00:00Z",
        })
      ).rejects.toBeInstanceOf(ClaimMarketContextRequiredError)
      await expect(
        marketContextStorage.run({ market_id: "market-a" }, () =>
          appendClaimAudit(asClaimClient(client), {
            idempotency_key: "story-11-1-writer-noinstance",
            code: "c",
            ip: "127.0.0.1",
            outcome: "ok",
            occurred_at: "2026-11-14T12:00:00Z",
          })
        )
      ).rejects.toBeInstanceOf(ClaimMarketContextRequiredError)
      await expect(
        liveIssueEntitlementsWithinTx(
          client as never,
          {
            event_type: "gp.stripe.payment_intent_succeeded.v1",
            payload: { payment_intent_id: "pi_x", order_id: "order_x", currency: "PLN", amount_minor: 1, psp_occurred_at: "2026-11-14T12:00:00.000Z" },
            scope: { market_id: "market-a" },
          } as never,
          new Date()
        )
      ).rejects.toThrow(/instance_id nierozwiązywalny/)
    })
  })

  it("kontrola ujemna: scope runtime niezgodny z GUC sesji jest odmową RLS PostgreSQL", async () => {
    await inRuntimeTx(async () => {
      await setGuc(client, "instance-b", "market-a")
      await expect(
        marketContextStorage.run(SCOPE_A, () =>
          reserveClaimBinding(asClaimClient(client), {
            idempotencyKey: "story-11-1-writer-guc-mismatch",
            bindingHash: "h",
            code: "c",
            claimedAt: "2026-11-14T12:00:00Z",
          })
        )
      ).rejects.toThrow(/row-level security/i)
    })
  })
})
