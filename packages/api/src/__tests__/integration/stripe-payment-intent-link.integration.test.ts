/**
 * stripe-payment-intent-link.integration.test.ts — Story 5.1 AC4 (v1.14.0).
 *
 * Test łańcucha (`api/webhooks/stripe/payment-intent/__tests__/link-resolution-chain.test.ts`)
 * dowodzi ZACHOWANIA na fixture'owym silniku SQL — nie wykryje literówki
 * w nazwie kolumny ani dryfu schematu. Ten plik zamyka dokładnie tę lukę:
 * uruchamia **te same, eksportowane stałe SQL** na ŻYWEJ bazie.
 *
 * ── Wyłącznie odczyt ────────────────────────────────────────────────────────
 * Żadnego INSERT/UPDATE/DELETE. Istnienie kolumn `webhook_event_processed`
 * sprawdzamy przez `information_schema`, nie przez próbny zapis — baza dev jest
 * nośnikiem dowodu z realnego zakupu i nie wolno jej mutować z testu.
 *
 * ── Opt-in ──────────────────────────────────────────────────────────────────
 *   GP_RUN_STRIPE_LINK_CHECK=1 DATABASE_URL=postgres://… \
 *     npx jest packages/api/src/__tests__/integration/stripe-payment-intent-link
 *
 * Opcjonalnie, żeby zweryfikować rozwiązanie na KONKRETNEJ płatności:
 *   GP_STRIPE_LINK_PAYMENT_INTENT_ID=pi_…   (albo GP_STRIPE_LINK_SESSION_ID=payses_…)
 *   GP_STRIPE_LINK_EXPECTED_ORDER_ID=order_…
 *
 * Bez tych zmiennych sprawdzamy sam kontrakt schematu (zapytania wykonują się
 * i zwracają zero wierszy dla nieistniejących identyfikatorów) — to wystarcza,
 * by złapać dryf nazw tabel i kolumn.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool } from "pg"

import {
  resolvePaymentIntentLink,
  RESOLVE_ORDER_BY_PAYMENT_LINK_SQL,
  RESOLVE_ORDER_MARKET_CONTEXT_SQL,
} from "../../lib/payment/stripe-payment-intent-link"

const ENABLED = process.env.GP_RUN_STRIPE_LINK_CHECK === "1"
const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = ENABLED && DATABASE_URL ? describe : describe.skip

runOrSkip("Story 5.1 AC4 — SQL rozwiązania powiązania działa na realnym schemacie", () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 })
  })

  afterAll(async () => {
    await pool.end()
  })

  it("zapytanie o powiązanie płatność→zamówienie wykonuje się na żywym schemacie", async () => {
    const result = await pool.query(RESOLVE_ORDER_BY_PAYMENT_LINK_SQL, [
      null,
      "pi_nieistniejacy_kontrola_schematu",
    ])
    expect(Array.isArray(result.rows)).toBe(true)
    expect(result.rows).toHaveLength(0)
  })

  it("zapytanie o kontekst rynkowy zamówienia wykonuje się i zwraca zadeklarowane kolumny", async () => {
    const result = await pool.query(RESOLVE_ORDER_MARKET_CONTEXT_SQL, [
      "order_nieistniejacy_kontrola_schematu",
    ])
    expect(result.rows).toHaveLength(0)
    // `fields` opisuje kształt zwracany przez planer — działa też przy 0 wierszy.
    expect(result.fields.map((f) => f.name).sort()).toEqual([
      "order_id",
      "order_metadata",
      "sales_channel_id",
      "sales_channel_market_id",
    ])
  })

  it("tabela webhook_event_processed ma kolumny wymagane przez rezerwację dostawy", async () => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'webhook_event_processed'`
    )
    const columns = new Set(result.rows.map((row) => row.column_name))
    for (const required of ["event_id", "provider", "market_id", "envelope", "received_at"]) {
      expect(columns.has(required)).toBe(true)
    }
  })

  it("mapa sales_channel → market_id jest odpytywalna (źródło market_id, nie wartość domyślna)", async () => {
    const result = await pool.query<{ id: string; market_id: string | null }>(
      `SELECT id, metadata->>'gp_market_id' AS market_id
         FROM sales_channel
        WHERE metadata->>'gp_market_id' IS NOT NULL
        LIMIT 5`
    )
    expect(Array.isArray(result.rows)).toBe(true)
  })

  const paymentIntentId = process.env.GP_STRIPE_LINK_PAYMENT_INTENT_ID
  const sessionId = process.env.GP_STRIPE_LINK_SESSION_ID
  const expectedOrderId = process.env.GP_STRIPE_LINK_EXPECTED_ORDER_ID
  const caseOrSkip = paymentIntentId || sessionId ? it : it.skip

  caseOrSkip(
    "rozwiązuje wskazaną płatność do zamówienia i rynku (dowód na realnych danych)",
    async () => {
      const resolution = await resolvePaymentIntentLink(
        {
          query: async <T = Record<string, unknown>>(
            text: string,
            values: ReadonlyArray<unknown> = []
          ) => {
            const result = await pool.query(text, values as unknown[])
            return { rows: result.rows as T[], rowCount: result.rowCount }
          },
        },
        {
          payment_intent_id: paymentIntentId ?? "pi_nieznany",
          session_id: sessionId ?? null,
        }
      )

      // Diagnostyka trafia do wyjścia testu: gdy rozwiązanie się nie uda,
      // powód ma być czytelny bez zaglądania do bazy.
      expect({
        ok: resolution.ok,
        detail: resolution.ok
          ? resolution.orders.map((order) => order.source)
          : resolution.detail,
      }).toEqual(expect.objectContaining({ ok: true }))

      if (resolution.ok && expectedOrderId) {
        expect(resolution.orders.map((order) => order.order_id)).toContain(
          expectedOrderId
        )
        expect(resolution.orders.every((order) => Boolean(order.market_id))).toBe(true)
      }
    }
  )
})
