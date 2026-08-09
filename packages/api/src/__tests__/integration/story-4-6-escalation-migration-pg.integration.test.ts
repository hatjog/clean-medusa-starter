/**
 * story-4-6-escalation-migration-pg.integration.test.ts — Story 4.6, review-fix
 * cyklu 1, finding M5.
 *
 * ── Czego to jest naprawa ───────────────────────────────────────────────────
 * Migracja `1779012000000` była JEDYNYM wpisem rejestru migracji tego wydania
 * bez dowodu wykonania. Cały dowód SQL-a szedł przez asercje na PODCIĄGACH
 * tekstu zapytania (`expect(sql).toContain("FOR UPDATE SKIP LOCKED")`), czyli
 * mierzył, że zapytanie da się SFORMATOWAĆ, a nie że Postgres da się je
 * WYKONAĆ. Niepokryte wykonaniem były przy tym konstrukcje, na których stoi
 * cała niepowtarzalność eskalacji (AC1).
 *
 * Ten test wykonuje na REALNYM PostgreSQL:
 *   - `up()` na tabeli z ISTNIEJĄCYMI wierszami (`NOT NULL DEFAULT 0`
 *     + dwa `CHECK`-i, w tym międzykolumnowy z review-fixa M1);
 *   - budowę indeksu częściowego z predykatem na trzech `status <>`;
 *   - `UPDATE … WHERE dispatch_id IN (SELECT … FOR UPDATE SKIP LOCKED)` —
 *     realne zapytanie zajęcia z `dispatch-ledger.ts`, wraz z oknem z M4;
 *   - kontrolę niepowtarzalności: DRUGIE wywołanie zajmuje ZERO wierszy;
 *   - kontrolę `CHECK`-a M1: budżet odbiorcy nie może zejść poniżej zera;
 *   - `down()` (asymetryczne — zostawia `non_recipient_failure_count`).
 *
 * POSTURE (spójnie z `story-3-3-purchase-key-migration-pg.integration.test.ts`):
 * opt-in, gate `GP_RUN_MIGRATION_INTEGRATION=1` + `DATABASE_URL`; bez gate'a
 * `describe.skip`, więc quick-gate w worktree bez docker-compose zostaje
 * zielony. NON-DESTRUKCYJNY: całość w `BEGIN … ROLLBACK` na TYMCZASOWEJ tabeli
 * (`ON COMMIT DROP`) — zero trwałych zapisów, bezpieczne na współdzielonej bazie.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1779012000000 } from "../../modules/voucher/migrations/1779012000000_add_voucher_delivery_attribution_and_escalation"

function collectSql(direction: "up" | "down"): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1779012000000.prototype as any)[direction].call(fakeThis)
  return sqls
}

const runIntegration =
  process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const maybe = runIntegration ? describe : describe.skip

/**
 * Zapytanie zajęcia — PRZEPISANE z `dispatch-ledger.ts`
 * (`claimAttemptPolicyEscalations`) w dialekcie `$N`, bo tam żyje w składni
 * konwertowanej dla Knexa, a tu potrzebujemy sterownika `pg`.
 *
 * Przepisanie jest świadome i ograniczone: test pilnuje WYKONYWALNOŚCI
 * konstrukcji na Postgresie, a jej treść (progi, predykat parkowania, okno)
 * jest osobno asertowana w teście dialektu na produkcyjnym zapytaniu.
 */
const CLAIM_SQL = `
  UPDATE voucher_delivery_dispatch AS d
     SET escalated_at = $1,
         updated_at = $1
   WHERE d.dispatch_id IN (
           SELECT p.dispatch_id
             FROM voucher_delivery_dispatch AS p
            WHERE (
                    p.attempt_count - p.non_recipient_failure_count >= $2
                 OR p.attempt_count >= $3
                  )
              AND p.status NOT IN ('sent', 'delivered', 'degraded')
              AND p.escalated_at IS NULL
              AND p.created_at >= $4
            ORDER BY p.first_failed_at ASC NULLS LAST, p.dispatch_id ASC
            LIMIT $5
              FOR UPDATE SKIP LOCKED
         )
  RETURNING d.dispatch_id, d.attempt_count, d.non_recipient_failure_count
`

maybe("Story 4.6 M5 — migracja 1779012000000 na realnym PG", () => {
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

  /** Odpowiednik `\d voucher_delivery_dispatch` na tabeli tymczasowej. */
  async function describeTable(c: PoolClient): Promise<string[]> {
    const rows = await c.query<{
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'voucher_delivery_dispatch'
          AND table_schema LIKE 'pg_temp_%'
        ORDER BY ordinal_position`
    )
    return rows.rows.map(
      (row) => `${row.column_name} ${row.data_type} nullable=${row.is_nullable}`
    )
  }

  it("up() na tabeli z WIERSZAMI, indeks częściowy, zajęcie SKIP LOCKED, CHECK budżetu, down()", async () => {
    await client.query("BEGIN")
    try {
      // ── Stan ZASTANY: tabela sprzed migracji 4.6, z wierszami ─────────────
      // `NOT NULL DEFAULT 0` i `CHECK` dokładane na PUSTEJ tabeli nie mierzą
      // nic — populacja zastana jest jedynym interesującym przypadkiem.
      await client.query(`
        CREATE TEMP TABLE voucher_delivery_dispatch (
          dispatch_id     text PRIMARY KEY,
          entitlement_id  text NOT NULL,
          template_key    text NOT NULL,
          recipient_hash  text NOT NULL,
          market_id       text NULL,
          status          text NOT NULL,
          error_code      text NULL,
          first_error_code text NULL,
          attempt_count   integer NOT NULL DEFAULT 0,
          first_failed_at timestamptz NULL,
          created_at      timestamptz NOT NULL DEFAULT NOW(),
          updated_at      timestamptz NOT NULL DEFAULT NOW()
        ) ON COMMIT DROP
      `)
      await client.query(`
        INSERT INTO voucher_delivery_dispatch
          (dispatch_id, entitlement_id, template_key, recipient_hash, market_id,
           status, error_code, first_error_code, attempt_count, first_failed_at)
        VALUES
          ('d1','e1','voucher_purchase_confirmation','h1','bonbeauty',
           'failed','BREVO_PROVIDER_ERROR','BREVO_PROVIDER_ERROR',40,NOW() - interval '2 hours'),
          ('d2','e2','voucher_purchase_confirmation','h2','bonbeauty',
           'failed','BREVO_PROVIDER_ERROR','BREVO_PROVIDER_ERROR',40,NOW() - interval '1 hour'),
          ('d3','e3','voucher_purchase_confirmation','h3','bonbeauty',
           'sent',NULL,NULL,1,NULL)
      `)

      const before = await describeTable(client)
      // eslint-disable-next-line no-console
      console.log("\\d voucher_delivery_dispatch PRZED up():\n  " + before.join("\n  "))
      expect(before.some((l) => l.startsWith("non_recipient_failure_count"))).toBe(false)
      expect(before.some((l) => l.startsWith("escalated_at"))).toBe(false)

      // ── up() ───────────────────────────────────────────────────────────────
      for (const sql of collectSql("up")) await client.query(sql)

      const afterUp = await describeTable(client)
      // eslint-disable-next-line no-console
      console.log("\\d voucher_delivery_dispatch PO up():\n  " + afterUp.join("\n  "))
      expect(
        afterUp.some((l) => l.startsWith("non_recipient_failure_count integer nullable=NO"))
      ).toBe(true)
      expect(afterUp.some((l) => l.startsWith("escalated_at"))).toBe(true)

      // Backfill defaultem na wierszach zastanych — bez tego `CHECK`
      // międzykolumnowy nie miałby czego pilnować.
      const backfilled = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM voucher_delivery_dispatch
          WHERE non_recipient_failure_count = 0 AND escalated_at IS NULL`
      )
      expect(backfilled.rows[0].n).toBe("3")

      // Indeks CZĘŚCIOWY realnie zbudowany (predykat na trzech `status <>`).
      const idx = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'voucher_delivery_dispatch'
            AND indexname = 'voucher_delivery_dispatch_escalation_pending_idx'`
      )
      expect(idx.rowCount).toBe(1)
      // eslint-disable-next-line no-console
      console.log("indexdef:\n  " + idx.rows[0].indexdef)
      // review-fix cyklu 1 (L2): kluczem jest PORZĄDEK zapytania, nie
      // `attempt_count` — inaczej `LIMIT 50` i tak schodzi z sortowania.
      expect(idx.rows[0].indexdef).toMatch(/\(first_failed_at, dispatch_id\)/)
      expect(idx.rows[0].indexdef).toContain("escalated_at IS NULL")

      // ── CHECK z review-fixa M1: budżet odbiorcy nie schodzi poniżej zera ──
      await client.query("SAVEPOINT przed_ujemnym_budzetem")
      await expect(
        client.query(
          `UPDATE voucher_delivery_dispatch
              SET non_recipient_failure_count = attempt_count + 1
            WHERE dispatch_id = 'd1'`
        )
      ).rejects.toThrow(/recipient_budget_nonneg/)
      await client.query("ROLLBACK TO SAVEPOINT przed_ujemnym_budzetem")

      await client.query("SAVEPOINT przed_ujemnym_licznikiem")
      await expect(
        client.query(
          `UPDATE voucher_delivery_dispatch
              SET non_recipient_failure_count = -1 WHERE dispatch_id = 'd1'`
        )
      ).rejects.toThrow(/non_recipient_failure_count/)
      await client.query("ROLLBACK TO SAVEPOINT przed_ujemnym_licznikiem")

      // ── Zajęcie: konstrukcja, na której stoi CAŁA niepowtarzalność (AC1) ──
      const nowIso = new Date().toISOString()
      const windowStart = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
      const claimed = await client.query<{ dispatch_id: string }>(CLAIM_SQL, [
        nowIso,
        5,
        40,
        windowStart,
        50,
      ])
      // eslint-disable-next-line no-console
      console.log(
        "zajęte w 1. przebiegu: " +
          JSON.stringify(claimed.rows.map((r) => r.dispatch_id))
      )
      // `d3` jest `sent` — wykluczony predykatem stanów domkniętych.
      expect(claimed.rows.map((r) => r.dispatch_id)).toEqual(["d1", "d2"])

      // AC1 — DRUGI przebieg NIE produkuje drugiej eskalacji.
      const again = await client.query(CLAIM_SQL, [nowIso, 5, 40, windowStart, 50])
      // eslint-disable-next-line no-console
      console.log("zajęte w 2. przebiegu: " + String(again.rowCount))
      expect(again.rowCount).toBe(0)

      // M4 — wiersz SPRZED okna nie jest zajmowany (nawet po zwolnieniu zajęcia).
      await client.query(
        `UPDATE voucher_delivery_dispatch
            SET escalated_at = NULL, created_at = NOW() - interval '400 days'`
      )
      const outOfWindow = await client.query(CLAIM_SQL, [
        nowIso,
        5,
        40,
        windowStart,
        50,
      ])
      // eslint-disable-next-line no-console
      console.log("zajęte spoza okna: " + String(outOfWindow.rowCount))
      expect(outOfWindow.rowCount).toBe(0)

      // ── down() — asymetryczne z zapisanego powodu ─────────────────────────
      for (const sql of collectSql("down")) await client.query(sql)
      const afterDown = await describeTable(client)
      // eslint-disable-next-line no-console
      console.log("\\d voucher_delivery_dispatch PO down():\n  " + afterDown.join("\n  "))
      // `escalated_at` znika (odtwarzalny), licznik atrybucji PRZEŻYWA — jego
      // utrata przywróciłaby stan, w którym awaria dostawcy kasuje vouchery.
      expect(afterDown.some((l) => l.startsWith("escalated_at"))).toBe(false)
      expect(
        afterDown.some((l) => l.startsWith("non_recipient_failure_count"))
      ).toBe(true)
      const idxAfterDown = await client.query(
        `SELECT 1 FROM pg_indexes
          WHERE tablename = 'voucher_delivery_dispatch'
            AND indexname = 'voucher_delivery_dispatch_escalation_pending_idx'`
      )
      expect(idxAfterDown.rowCount).toBe(0)
    } finally {
      await client.query("ROLLBACK")
    }
  })
})
