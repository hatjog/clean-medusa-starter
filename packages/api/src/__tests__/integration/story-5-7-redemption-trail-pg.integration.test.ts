/**
 * v1.16.0 Story 5.7 (FR-19a, AD-34; D-36; ADR-245 `Proposed`) — ślad realizacji
 * i korekta na REALNYM PostgreSQL (baza `*_test`, profil
 * `test:integration:story-5-7-redemption-trail-pg`).
 *
 * Dowodzi:
 *   - migracja `1779020000000` (up idempotentny): CHECK stanu uprawnienia zna
 *     `REDEMPTION_REVERSED`; CHECK `resulting_state` przyjmuje go WYŁĄCZNIE dla
 *     `kind='REVERSAL'` (kontrola ujemna dla `REDEMPTION`);
 *   - AC1 atomowość (kontrola ujemna AD-34): wymuszona porażka zapisu
 *     `voucher_redemption` ⇒ stan uprawnienia i status vouchera BEZ ZMIANY;
 *     realizacja udana ⇒ ślad po kodzie (moment, aktor, rynek);
 *   - AC2 append-only: po korekcie DWA wiersze — `REDEMPTION` nienaruszony
 *     i `REVERSAL` z `reverses_redemption_id` = id pierwotnego; voucher znów
 *     realizowalny; druga korekta odmówiona; ponowna realizacja przechodzi.
 *
 * Dane: wiersze z unikalnym prefiksem przebiegu, sprzątane w `afterAll`
 * (suita KASUJE własne dane — dlatego profil `-pg`, nie unit).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1779020000000 } from "../../modules/voucher/migrations/1779020000000_add_redemption_reversed_correction_state"
import { VoucherService } from "../../modules/voucher/service"
import {
  createRedeemPartialOperationFromPool,
  RedeemEntitlementStateError,
  RedemptionCorrectionRefusedError,
} from "../../modules/voucher/workflows/redeem-partial-entitlement"
import { createPgRefundedScanner } from "../../jobs/voucher-ledger-reconciliation"
import { revokeEntitlementsOnRefund } from "../../workflows/entitlements/issue-entitlement"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const isTestDb = /\/[A-Za-z0-9_]*_test(\?|$)/.test(DATABASE_URL)
const maybe = DATABASE_URL && isTestDb ? describe : describe.skip

const RUN = `s57_${Date.now().toString(36)}`
const SELLER = `${RUN}_seller`
const GROSS = 24_900

function collectSql(direction: "up" | "down"): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1779020000000.prototype as any)[direction].call(fakeThis)
  return sqls
}

maybe("Story 5.7 — ślad realizacji i korekta na realnym PG", () => {
  let pool: Pool
  const service = new VoucherService()
  let failRedemptionInsert = false

  /** Pula dla producenta: każde `connect()` to realne połączenie z własną tx. */
  const producerPool = {
    connect: async () => {
      const client: PoolClient = await pool.connect()
      return {
        query: (text: string, values?: unknown[]) => {
          if (failRedemptionInsert && /^\s*INSERT INTO voucher_redemption/i.test(text)) {
            return Promise.reject(new Error("forced voucher_redemption write failure (AD-34 control)"))
          }
          return client.query(text, values as unknown[])
        },
        release: (err?: unknown) => client.release(err as Error | undefined),
      }
    },
  }

  const op = () =>
    createRedeemPartialOperationFromPool(producerPool as never, {
      async writeProjection(client, ctx) {
        const r = await service.redeemForSeller(SELLER, ctx.voucher_code, { now: ctx.now, client: client as never })
        if (r.status !== "redeemed") throw new Error(`projection refused: ${r.status}`)
      },
      async writeCorrectionProjection(client, ctx) {
        await service.restoreAfterCorrectionForSeller(SELLER, ctx.voucher_code, { client: client as never, now: ctx.now })
      },
    })

  async function seed(code: string, orderId: string | null = null): Promise<string> {
    const ent = `${code}_ent`
    await pool.query(
      `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle, product_title,
                            value_minor, currency_code, status)
       VALUES ($1, 'bonbeauty', $2, 'Salon', 'salon', 'Masaż', $3, 'PLN', 'idle')`,
      [code, SELLER, GROSS]
    )
    await pool.query(
      `INSERT INTO entitlement_instance (id, entitlement_profile_id, entitlement_type, state,
                                         policy_snapshot, market_id, vat_classification, order_id)
       VALUES ($1, 'prof_s57', 'VOUCHER_SERVICE', 'ACTIVE', $2::jsonb, 'bonbeauty', 'MPV', $3)`,
      [ent, JSON.stringify({ voucher_code: code, market_id: "bonbeauty", amount_minor: GROSS, currency_code: "PLN", transferability: "bearer" }), orderId]
    )
    return ent
  }

  async function snapshot(code: string, ent: string) {
    const e = await pool.query(`SELECT state FROM entitlement_instance WHERE id = $1`, [ent])
    const v = await pool.query(`SELECT status FROM voucher WHERE code = $1`, [code])
    const r = await pool.query(
      `SELECT kind, redemption_id, reverses_redemption_id, resulting_state, amount_minor, created_at
         FROM voucher_redemption WHERE entitlement_id = $1 ORDER BY created_at, kind`,
      [ent]
    )
    return { state: e.rows[0]?.state, status: v.rows[0]?.status, rows: r.rows }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
    service._testPool = pool as never
    for (const sql of collectSql("up")) await pool.query(sql)
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM voucher_redemption WHERE entitlement_id LIKE $1`, [`${RUN}%`])
    await pool.query(`DELETE FROM voucher_event WHERE voucher_code LIKE $1 OR entitlement_id LIKE $1`, [`${RUN}%`])
    await pool.query(`DELETE FROM entitlement_instance WHERE id LIKE $1`, [`${RUN}%`])
    await pool.query(`DELETE FROM voucher WHERE code LIKE $1`, [`${RUN}%`])
    await pool.end()
  })

  it("migracja: CHECK-i znają REDEMPTION_REVERSED, ale nie dla wiersza REDEMPTION", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      // Stan uprawnienia `REDEMPTION_REVERSED` przechodzi CHECK (wykonanie, nie lektura DDL).
      await client.query(
        `INSERT INTO entitlement_instance (id, entitlement_profile_id, entitlement_type, state, policy_snapshot)
         VALUES ('${RUN}_chk', 'prof_s57', 'VOUCHER_SERVICE', 'REDEMPTION_REVERSED', '{}'::jsonb)`
      )
      await client.query("SAVEPOINT neg")
      await expect(
        client.query(
          `INSERT INTO voucher_redemption (entitlement_id, idempotency_key, redemption_id, amount_minor,
             resulting_state, remaining_after_minor, issued_gross_minor, created_at, kind,
             reverses_redemption_id, market_id, purchase_market_id, redemption_market_id)
           VALUES ('${RUN}_neg', 'k', '${RUN}_neg_r', 1, 'REDEMPTION_REVERSED', 0, 1, 1, 'REDEMPTION', NULL,
                   'bonbeauty', 'bonbeauty', 'bonbeauty')`
        )
      ).rejects.toThrow(/voucher_redemption_resulting_state_check/)
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
    // up() idempotentny: drugie zastosowanie nie rzuca.
    for (const sql of collectSql("up")) await pool.query(sql)
  })

  it("AC1 atomowość: porażka zapisu śladu cofa akt (stan i status bez zmiany)", async () => {
    const code = `${RUN}_atomic`
    const ent = await seed(code)
    failRedemptionInsert = true
    try {
      await expect(
        op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-atomic-key-1", redemption_market_id: "bonbeauty", actor: "vendor" })
      ).rejects.toThrow(/forced voucher_redemption write failure/)
    } finally {
      failRedemptionInsert = false
    }
    const after = await snapshot(code, ent)
    expect(after).toEqual({ state: "ACTIVE", status: "idle", rows: [] })

    // Kontrola dodatnia: bez wymuszonej porażki akt i ślad powstają razem.
    await op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-atomic-key-1", redemption_market_id: "bonbeauty", actor: "vendor" })
    const ok = await snapshot(code, ent)
    expect(ok.state).toBe("REDEEMED_FULL")
    expect(ok.status).toBe("claimed")
    expect(ok.rows).toHaveLength(1)
    const trail = await service.getRedemptionTrailForSeller(SELLER, code)
    expect(trail).toEqual([
      { kind: "redemption", at: expect.any(String), actor: "own_seller", market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
    ])
    expect(await service.getRedemptionTrailForSeller(`${RUN}_other`, code)).toBeNull()
  })

  it("AC2 korekta: dwa wiersze append-only, voucher znów realizowalny, druga korekta odmówiona", async () => {
    const code = `${RUN}_corr`
    const ent = await seed(code)
    await op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-corr-key-1", redemption_market_id: "bonbeauty", actor: "vendor" })
    const before = await snapshot(code, ent)
    const original = before.rows[0]

    const res = await op().correct({ voucher_code: code, actor: "vendor" })
    expect(res.entitlement_state_after).toBe("REDEMPTION_REVERSED")
    const after = await snapshot(code, ent)
    expect(after.state).toBe("REDEMPTION_REVERSED")
    expect(after.state).not.toBe("ACTIVE")
    expect(after.status).toBe("idle")
    expect(after.rows).toHaveLength(2)
    expect(after.rows[0]).toEqual(original)
    expect(after.rows[1]).toEqual(
      expect.objectContaining({ kind: "REVERSAL", reverses_redemption_id: original.redemption_id, resulting_state: "REDEMPTION_REVERSED" })
    )

    await expect(op().correct({ voucher_code: code, actor: "vendor" })).rejects.toBeInstanceOf(
      RedemptionCorrectionRefusedError
    )
    expect((await snapshot(code, ent)).rows).toHaveLength(2)

    const trail = await service.getRedemptionTrailForSeller(SELLER, code)
    expect(trail?.map((t) => [t.kind, t.actor])).toEqual([
      ["redemption", "own_seller"],
      ["correction", "own_seller"],
    ])

    // D-36: ponowna realizacja po korekcie przechodzi.
    await op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-corr-key-2", redemption_market_id: "bonbeauty", actor: "vendor" })
    const again = await snapshot(code, ent)
    expect(again.state).toBe("REDEEMED_FULL")
    expect(again.status).toBe("claimed")
    expect(again.rows.map((r) => r.kind)).toEqual(["REDEMPTION", "REVERSAL", "REDEMPTION"])
  })

  it("Story 5.8 (DW-15-359 p.1): replay pierwotnego klucza PO korekcie ⇒ nazwana odmowa REDEMPTION_REVERSED, zero skutku", async () => {
    const code = `${RUN}_replay`
    const ent = await seed(code)
    const req = { voucher_code: code, redeem_full: true, idempotency_key_header: "s58-replay-key-1", redemption_market_id: "bonbeauty", actor: "vendor" } as const
    await op().redeem(req)
    await op().correct({ voucher_code: code, actor: "vendor" })
    const corrected = await snapshot(code, ent)

    const err = await op().redeem(req).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(RedeemEntitlementStateError)
    expect((err as RedeemEntitlementStateError).entitlement_state).toBe("REDEMPTION_REVERSED")
    const after = await snapshot(code, ent)
    expect(after.state).toBe("REDEMPTION_REVERSED")
    expect(after.status).toBe("idle")
    expect(after.rows).toEqual(corrected.rows)
  })

  /** Zwrot Stripe (`payment.refunded`) w jednej transakcji — jak `stripe-payment-audit`. */
  async function refund(orderId: string) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const out = await revokeEntitlementsOnRefund(client as never, orderId, new Date())
      await client.query("COMMIT")
      return out
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  it("runda fix 1 (HIGH AC2): realizacja → korekta → zwrot ⇒ REFUNDED i kod `refunded` (korekta ≠ zwrot)", async () => {
    const code = `${RUN}_corr_refund`
    const order = `${RUN}_order_a`
    const ent = await seed(code, order)
    await op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-cr-key-1", redemption_market_id: "bonbeauty", actor: "vendor" })
    await op().correct({ voucher_code: code, actor: "vendor" })
    expect((await snapshot(code, ent)).state).toBe("REDEMPTION_REVERSED")

    const out = await refund(order)
    expect(out.revoked_entitlement_ids).toEqual([ent])
    // Brak odwrócenia kwotowego: skorygowana realizacja nie jest „do zwrotu”.
    expect(out.reversal_redemption_ids).toEqual([])
    const after = await snapshot(code, ent)
    expect(after.state).toBe("REFUNDED")
    expect(after.status).toBe("refunded")
    // Ślad bez nowego wiersza: REDEMPTION + korekta, append-only.
    expect(after.rows.map((r) => [r.kind, r.resulting_state])).toEqual([
      ["REDEMPTION", "REDEEMED_FULL"],
      ["REVERSAL", "REDEMPTION_REVERSED"],
    ])
    // Voucher po zwrocie NIE jest realizowalny.
    await expect(
      op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-cr-key-2", redemption_market_id: "bonbeauty", actor: "vendor" })
    ).rejects.toThrow()
    expect((await snapshot(code, ent)).state).toBe("REFUNDED")

    // runda fix 1 (LOW reconciliation): wiersz KOREKTY nie jest odwróceniem
    // zwrotem — skaner nie może go liczyć jako `has_reversal_row` (inaczej
    // REFUNDED bez odwrócenia kwotowego trafia do noop zamiast alarmu M1).
    const scanned = await createPgRefundedScanner(pool as never).scanRefundedTerminal()
    expect(scanned.find((r) => r.entitlement_id === ent)).toEqual(
      expect.objectContaining({ entitlement_id: ent, has_reversal_row: false })
    )
  })

  it("runda fix 1 (HIGH AC2): realizacja → korekta → ponowna realizacja → zwrot ⇒ odwrócenie kwotowe TYLKO ponownej realizacji", async () => {
    const code = `${RUN}_corr_rr_refund`
    const order = `${RUN}_order_b`
    const ent = await seed(code, order)
    await op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-crr-key-1", redemption_market_id: "bonbeauty", actor: "vendor" })
    await op().correct({ voucher_code: code, actor: "vendor" })
    await op().redeem({ voucher_code: code, redeem_full: true, idempotency_key_header: "s57-crr-key-2", redemption_market_id: "bonbeauty", actor: "vendor" })
    const before = await snapshot(code, ent)
    expect(before.state).toBe("REDEEMED_FULL")
    const second = before.rows.filter((r) => r.kind === "REDEMPTION")[1]

    const out = await refund(order)
    expect(out.revoked_entitlement_ids).toEqual([ent])
    expect(out.reversal_redemption_ids).toHaveLength(1)
    const after = await snapshot(code, ent)
    expect(after.state).toBe("REFUNDED")
    expect(after.status).toBe("refunded")
    const refundReversals = after.rows.filter(
      (r) => r.kind === "REVERSAL" && r.resulting_state !== "REDEMPTION_REVERSED"
    )
    expect(refundReversals).toHaveLength(1)
    expect(refundReversals[0].reverses_redemption_id).toBe(second.redemption_id)
    expect(refundReversals[0].redemption_id).toBe(out.reversal_redemption_ids[0])
    // Kontrola dodatnia skanera: odwrócenie zwrotem JEST `has_reversal_row`.
    const scanned = await createPgRefundedScanner(pool as never).scanRefundedTerminal()
    expect(scanned.find((r) => r.entitlement_id === ent)).toEqual(
      expect.objectContaining({ entitlement_id: ent, has_reversal_row: true })
    )
  })
})
