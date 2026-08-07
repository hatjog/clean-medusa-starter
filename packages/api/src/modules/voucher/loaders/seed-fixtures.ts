/**
 * voucher/loaders/seed-fixtures.ts — AC5 idempotent dev/test fixture seeder.
 *
 * Story v160-cleanup-25: runs on backend boot when NODE_ENV !== "production".
 * Idempotently upserts the 2 canonical E2E fixture vouchers so Story 8.8 AC6
 * Steps 5+6 (recipient claim page render) stay GREEN without needing a real
 * claim flow.
 *
 * Operator runbook (pre-prod DB rebuild per Story 1.8 doctrine):
 *   1. docker compose down && docker compose up -d postgres redis
 *   2. cd GP/backend && npx medusa db:migrate
 *   3. Backend boots → this loader fires → fixtures seeded automatically.
 *   To invalidate: psql -c "TRUNCATE voucher CASCADE" then restart backend
 *   (loader will re-seed with fresh rows).
 *
 * v1.15.0 Story 2.6 (FR-14e, AC2) — fixture'y DEKLARUJĄ RYNEK PER WIERSZ.
 * Do v1.14.0 obie fixture'y miały `market_id: null` („global voucher, E2E only",
 * migracja 1778112000000). Po włączeniu `FORCE ROW LEVEL SECURITY` na tabelach
 * modułu polityka `market_isolation` obejmuje TAKŻE właściciela tabel, czyli rolę
 * z `DATABASE_URL`, którą działa ten loader: `INSERT` z `market_id = NULL` jest
 * odrzucany przez `WITH CHECK`, a odczyty widziałyby zero wierszy. AC2 nie dawało
 * tu wyboru między naprawą fixture'ów a furtką `OR market_id IS NULL` w polityce:
 * furtka jest ZAKAZANA, więc naprawa idzie w fixture'ach.
 *
 * Loader ustawia `app.gp_market_id` NA SWOIM połączeniu (własna pula jest tu
 * wpisem allowlisty `_grow/db-connection-pool-allowlist.yaml`, nie wyjątkiem od
 * reguły) — inaczej sam by się nie przepuścił przez własną politykę. Rynek jest
 * JAWNY: `GP_VOUCHER_SEED_MARKET_ID` albo domyślnie `bonbeauty` (rynek, do którego
 * należą obaj fixture'owi sprzedawcy). Brak rynku = odmowa, nie `NULL`.
 */

import { Pool } from "pg"

/** Domyślny rynek fixture'ów — jawny, nie `NULL` (Story 2.6 AC2). */
const DEFAULT_FIXTURE_MARKET_ID = "bonbeauty"

/** Ten sam kształt identyfikatora, który przyjmuje hook RLS. */
const SAFE_MARKET_ID_RE = /^[a-zA-Z0-9_-]+$/

interface FixtureSeed {
  code: string
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: string
  expires_at: string | null
  events: Array<{ id: string; event_type: string; occurred_at: string }>
}

const E2E_FIXTURES: FixtureSeed[] = [
  {
    code: "E2E-IDLE-VOUCHER-001",
    seller_id: "sel_01CITYBEAUTY00000000000",
    seller_name: "City Beauty",
    seller_handle: "city-beauty",
    product_title: "Peeling kwasami",
    value_minor: 22000,
    currency_code: "PLN",
    status: "idle",
    expires_at: "2027-12-31T23:59:59Z",
    events: [
      { id: "evt-idle-001-created", event_type: "created", occurred_at: "2026-05-04T08:00:00Z" },
      { id: "evt-idle-001-sent", event_type: "sent", occurred_at: "2026-05-04T08:01:00Z" },
    ],
  },
  {
    code: "E2E-CLAIMED-VOUCHER-002",
    seller_id: "sel_01KREMIDOTYK0000000000",
    seller_name: "Kremidotyk",
    seller_handle: "kremidotyk",
    product_title: "Peeling węglowy",
    value_minor: 24000,
    currency_code: "PLN",
    status: "claimed",
    expires_at: "2027-12-31T23:59:59Z",
    events: [
      { id: "evt-claimed-002-created", event_type: "created", occurred_at: "2026-05-04T09:00:00Z" },
      { id: "evt-claimed-002-sent", event_type: "sent", occurred_at: "2026-05-04T09:01:00Z" },
      { id: "evt-claimed-002-opened", event_type: "opened", occurred_at: "2026-05-04T10:00:00Z" },
      { id: "evt-claimed-002-claimed", event_type: "claimed", occurred_at: "2026-05-04T10:05:00Z" },
    ],
  },
]

/**
 * Medusa 2 module loaders receive `({ container, options, ... })`. We accept
 * the arg loosely and ignore it — the seeder owns its own raw pg connection
 * to keep the contract explicit (no MikroORM coupling) and to remain
 * independent of MedusaService bootstrap order.
 *
 * Env guards (post-review F3 + F8):
 *   - production            → skip (never seed prod)
 *   - test (NODE_ENV=test)  → skip unless GP_VOUCHER_SEED_E2E=1 explicitly opt-in
 *   - dev / undefined       → seed
 *   - strict mode           → re-throw on error when GP_VOUCHER_SEED_STRICT=1
 *                             OR when running under NODE_ENV=test (so CI catches drift)
 */
export default async function voucherSeedFixturesLoader(
  _container?: unknown,
): Promise<void> {
  if (process.env.NODE_ENV === "production") return

  const isTest = process.env.NODE_ENV === "test"
  const optInE2E = process.env.GP_VOUCHER_SEED_E2E === "1"
  if (isTest && !optInE2E) {
    // Tests own their own DB state; never auto-seed.
    return
  }

  const strict = process.env.GP_VOUCHER_SEED_STRICT === "1" || isTest

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    const msg = "[voucher/seed-fixtures] DATABASE_URL not set — skipping fixture seed"
    if (strict) throw new Error(msg)
    console.warn(msg)
    return
  }

  // Story 2.6 AC2 — rynek fixture'ów jest JAWNY i walidowany kształtem, który
  // przyjmuje hook RLS. Wartość spoza tego kształtu zostałaby po cichu odrzucona
  // przez `set_config` + politykę, czyli wyglądałaby jak „seed nic nie zrobił".
  const marketId = process.env.GP_VOUCHER_SEED_MARKET_ID?.trim() || DEFAULT_FIXTURE_MARKET_ID
  if (!SAFE_MARKET_ID_RE.test(marketId)) {
    const msg =
      `[voucher/seed-fixtures] GP_VOUCHER_SEED_MARKET_ID='${marketId}' nie ma ` +
      "kształtu przyjmowanego przez politykę RLS — seed odmawia zamiast wstawiać " +
      "wiersze, których nikt potem nie zobaczy"
    if (strict) throw new Error(msg)
    console.warn(msg)
    return
  }

  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()
  try {
    // Bez tego loader nie przepuści SAM SIEBIE przez politykę `market_isolation`:
    // pod FORCE RLS właściciel tabel też jej podlega (Story 2.6, migracja
    // 1779000000000). Kontekst jest ustawiany na TYM połączeniu, na którym idą
    // INSERT-y — nie na puli, bo pula wydaje wiele połączeń.
    await client.query("SELECT set_config('app.gp_market_id', $1, false)", [marketId])

    for (const fx of E2E_FIXTURES) {
      await client.query(
        `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle, product_title, value_minor, currency_code, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         ON CONFLICT (code) DO NOTHING`,
        [
          fx.code,
          marketId,
          fx.seller_id,
          fx.seller_name,
          fx.seller_handle,
          fx.product_title,
          fx.value_minor,
          fx.currency_code,
          fx.status,
          fx.expires_at,
        ]
      )
      for (const evt of fx.events) {
        await client.query(
          `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [evt.id, fx.code, evt.event_type, evt.occurred_at]
        )
      }
    }
    console.log(
      `[voucher/seed-fixtures] E2E fixtures seeded (idempotent, market_id=${marketId})`
    )
  } catch (err) {
    console.error("[voucher/seed-fixtures] Seed error:", err)
    // Sprzątanie jest WYŁĄCZNIE w `finally` — `client.release()` wołany dwa razy
    // jest błędem `pg` ("Release called on client which has already been released").
    if (strict) throw err
  } finally {
    client.release()
    await pool.end().catch(() => {})
  }
}
