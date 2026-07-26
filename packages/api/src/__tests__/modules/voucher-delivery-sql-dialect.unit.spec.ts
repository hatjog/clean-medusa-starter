/**
 * voucher-delivery-sql-dialect.unit.spec.ts — Story 2.3, R-2.3-H1.
 *
 * Ten test istnieje, bo warstwa atrap była z definicji ŚLEPA na dialekt
 * bindingów: `FakeDispatchSql` mapowała wartości pozycyjnie i zieleniła się
 * niezależnie od tego, czy SQL jest wykonywalny przez realny sterownik. Tymczasem
 * produkcyjny `ContainerRegistrationKeys.PG_CONNECTION` to **instancja Knexa**,
 * której formatter liczy wyłącznie `?`/`??` i przy `$N` rzuca
 * `Expected N bindings, saw 0` — czyli KAŻDA realna wysyłka failowała przed
 * wysłaniem maila.
 *
 * Tu przepuszczamy KAŻDE zapytanie ledgera i readera locale przez **prawdziwy
 * formatter Knexa** (`knex({ client: "pg" }).raw(...).toSQL()`) — bez bazy, bez
 * sieci, bez połączenia. Regresja dialektu zapala się natychmiast.
 *
 * `knex` nie jest deklarowany w `package.json` backendu, ale jest dostępny
 * płasko w `node_modules` (`.npmrc`: `shamefully-hoist=true`) jako zależność
 * Medusy — to ten sam moduł, który dostaje produkcja z kontenera.
 */

import { knex, type Knex } from "knex"

import { createMarketLocalesReader } from "../../lib/read-market-locales"
import { toKnexPositionalSql, SqlDialectError } from "../../lib/knex-positional-sql"
import {
  PgDispatchLedger,
  VOUCHER_DELIVERY_DISPATCH_TABLE,
  type DispatchLedgerSql,
} from "../../modules/voucher-delivery/dispatch-ledger"
import { hashRecipientEmail } from "../../modules/voucher-delivery/recipient-hash"

type Call = { sql: string; bindings: readonly unknown[] }

const RECIPIENT_HASH = hashRecipientEmail("kupujaca@example.com")

function baseRow(status: string): Record<string, unknown> {
  return {
    dispatch_id: "dispatch-1",
    entitlement_id: "ent_1",
    template_key: "voucher_purchase_confirmation",
    recipient_hash: RECIPIENT_HASH,
    market_id: "bonbeauty",
    flow_id: "voucher_purchase_delivery",
    locale: "pl",
    status,
    provider: null,
    provider_message_id: null,
    error_code: status === "failed" ? "BREVO_TEMPLATE_NOT_CONFIGURED" : null,
    attempt_count: 1,
    queued_at: "2026-07-26T10:00:00.000Z",
  }
}

/** Nagrywa wywołania sterownika i oddaje wiersze wg scenariusza. */
class RecordingSql implements DispatchLedgerSql {
  readonly calls: Call[] = []

  constructor(private readonly rowsFor: (sql: string) => unknown[]) {}

  async raw(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
    this.calls.push({ sql, bindings })
    return { rows: this.rowsFor(sql) }
  }
}

let client: Knex

beforeAll(() => {
  // Bez `connection` — instancja służy WYŁĄCZNIE do formatowania SQL-a.
  client = knex({ client: "pg" })
})

afterAll(async () => {
  await client.destroy()
})

/** Odpala realny formatter Knexa; rzuca dokładnie tak, jak zrobiłby to sterownik. */
function formatWithKnex(call: Call): Knex.Sql {
  return client.raw(call.sql, [...call.bindings] as Knex.RawBinding[]).toSQL()
}

async function recordLedgerCalls(): Promise<Call[]> {
  const calls: Call[] = []

  // 1. Rezerwacja świeża: INSERT zwraca wiersz.
  const fresh = new RecordingSql((sql) =>
    sql.includes(`INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_TABLE}`)
      ? [baseRow("queued")]
      : [],
  )
  const identity = {
    entitlement_id: "ent_1",
    template_key: "voucher_purchase_confirmation",
    recipient_hash: RECIPIENT_HASH,
    market_id: "bonbeauty",
    flow_id: "voucher_purchase_delivery",
    locale: "pl",
  }
  await new PgDispatchLedger(fresh).reserveDispatch(identity)
  calls.push(...fresh.calls)

  // 2. Rezerwacja po konflikcie: INSERT pusty → SELECT (`failed`) → UPDATE retry.
  const retry = new RecordingSql((sql) => {
    if (sql.trim().startsWith("SELECT")) return [baseRow("failed")]
    if (sql.includes("SET status = 'queued'")) return [baseRow("queued")]
    return []
  })
  await new PgDispatchLedger(retry).reserveDispatch(identity)
  calls.push(...retry.calls)

  // 3. Tranzycje domykające.
  const sent = new RecordingSql((sql) =>
    sql.includes("SET status = 'sent'") ? [baseRow("sent")] : [],
  )
  await new PgDispatchLedger(sent).markSent({
    dispatch_id: "dispatch-1",
    provider: "brevo",
    provider_message_id: "brevo-msg-1",
  })
  calls.push(...sent.calls)

  const failed = new RecordingSql((sql) =>
    sql.includes("SET status = 'failed'") ? [baseRow("failed")] : [],
  )
  await new PgDispatchLedger(failed).markFailed({
    dispatch_id: "dispatch-1",
    error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
    provider: "brevo",
  })
  calls.push(...failed.calls)

  return calls
}

describe("R-2.3-H1 — SQL ledgera jest wykonywalny przez REALNY formatter Knexa", () => {
  let calls: Call[]

  beforeAll(async () => {
    calls = await recordLedgerCalls()
  })

  it("pokrywa wszystkie zapytania ledgera (INSERT, SELECT, 3× UPDATE, audit)", () => {
    // 2 (insert + audit) + 3 (insert-pusty, select, update+audit → 4) + 2 + 2
    expect(calls.length).toBeGreaterThanOrEqual(9)
  })

  it("żadne zapytanie nie trafia do sterownika z placeholderem `$N`", () => {
    for (const call of calls) {
      expect(call.sql).not.toMatch(/\$\d+/)
    }
  })

  it("każde zapytanie przechodzi przez formatter Knexa bez błędu bindingów", () => {
    for (const call of calls) {
      expect(() => formatWithKnex(call)).not.toThrow()
      expect(formatWithKnex(call).bindings).toHaveLength(call.bindings.length)
    }
  })

  it("test-the-test: ten sam SQL w składni `$N` ROZBIJA formatter Knexa", () => {
    expect(() =>
      client
        .raw(
          `INSERT INTO ${VOUCHER_DELIVERY_DISPATCH_TABLE} (dispatch_id) VALUES ($1)`,
          ["dispatch-1"],
        )
        .toSQL(),
    ).toThrow(/Expected \d+ bindings/)
  })
})

/**
 * Story 2.5 — skan luk, licznik granicy H1 i przejęcie porzuconego `queued`
 * dołączają do tego samego gate'u dialektu. Skan jest tu najwrażliwszy: buduje
 * placeholdery DYNAMICZNIE (`CROSS JOIN (VALUES …)` + `IN (…)` × 2), więc
 * literówka w numeracji `$N` nie zapaliłaby się w atrapie SQL — tylko tutaj.
 */
async function recordSweepScanCalls(): Promise<Call[]> {
  const calls: Call[] = []

  const scan = new RecordingSql(() => [])
  await new PgDispatchLedger(scan).scanDeliveryGaps({
    // Dwa szablony ŚWIADOMIE: wariant jednoelementowy nie wykryłby przesunięcia
    // numeracji przy rozwiniętej liście wartości (przyszłe 2.4).
    template_keys: ["voucher_purchase_confirmation", "voucher_handoff_link"],
    source_states: ["ISSUED", "ACTIVE"],
    created_before: "2026-07-26T11:30:00.000Z",
    stale_queued_before: "2026-07-26T11:45:00.000Z",
    limit: 200,
  })
  calls.push(...scan.calls)

  const count = new RecordingSql(() => [{ gap_count: 0 }])
  await new PgDispatchLedger(count).countGapsBeyondSourceStates({
    template_keys: ["voucher_purchase_confirmation"],
    source_states: ["ISSUED", "ACTIVE"],
    created_before: "2026-07-26T11:30:00.000Z",
    created_after: "2026-07-19T12:00:00.000Z",
  })
  calls.push(...count.calls)

  const abandon = new RecordingSql((sql) =>
    sql.includes("SET status = 'failed'") ? [baseRow("failed")] : [],
  )
  await new PgDispatchLedger(abandon).abandonStaleQueued({
    dispatch_id: "dispatch-1",
    stale_queued_before: "2026-07-26T11:45:00.000Z",
    error_code: "VOUCHER_DELIVERY_QUEUED_ABANDONED",
  })
  calls.push(...abandon.calls)

  return calls
}

describe("Story 2.5 — SQL sweepa jest wykonywalny przez REALNY formatter Knexa", () => {
  let calls: Call[]

  beforeAll(async () => {
    calls = await recordSweepScanCalls()
  })

  it("pokrywa skan luk, licznik granicy H1 i przejęcie `queued` (+ audit)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(4)
  })

  it("żadne zapytanie nie trafia do sterownika z placeholderem `$N`", () => {
    for (const call of calls) {
      expect(call.sql).not.toMatch(/\$\d+/)
    }
  })

  it("każde zapytanie przechodzi przez formatter Knexa bez błędu bindingów", () => {
    for (const call of calls) {
      expect(() => formatWithKnex(call)).not.toThrow()
      expect(formatWithKnex(call).bindings).toHaveLength(call.bindings.length)
    }
  })

  it("skan luk jest READ-ONLY (żadnego INSERT/UPDATE/DELETE)", () => {
    const scan = calls.find((call) => call.sql.includes("CROSS JOIN (VALUES"))
    expect(scan).toBeDefined()
    expect(scan?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
    expect(scan?.sql).toMatch(/\bLIMIT\b/)
  })

  it("przejęcie `queued` niesie OBA guardy (status + staleness) i jedno UPDATE", () => {
    const abandon = calls.find(
      (call) =>
        call.sql.includes(`UPDATE ${VOUCHER_DELIVERY_DISPATCH_TABLE}`) &&
        call.sql.includes("SET status = 'failed'"),
    )
    expect(abandon).toBeDefined()
    expect(abandon?.sql).toContain("AND status = 'queued'")
    expect(abandon?.sql).toMatch(/queued_at < \?/)
  })
})

describe("R-2.3-H1 — reader locale rynku używa tego samego dialektu", () => {
  it("SELECT z `market_runtime_config` przechodzi przez formatter Knexa", async () => {
    const recorder = new RecordingSql(() => [{ locales: { default: "pl", supported: ["pl"] } }])
    const read = await createMarketLocalesReader(recorder).read("bonbeauty")

    expect(read.degraded).toBe(false)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].sql).not.toMatch(/\$\d+/)
    expect(() => formatWithKnex(recorder.calls[0])).not.toThrow()
  })
})

describe("toKnexPositionalSql — guardy kształtów, które Knex cicho przekłamuje", () => {
  it("zamienia `$N` na `?` w kolejności WYSTĄPIEŃ (powtórzony `$8` = trzy bindingi)", () => {
    const { text, bindings } = toKnexPositionalSql(
      "VALUES ($1, $2, $2, $2)",
      ["a", "b"],
    )
    expect(text).toBe("VALUES (?, ?, ?, ?)")
    expect(bindings).toEqual(["a", "b", "b", "b"])
  })

  it("odrzuca binding tablicowy (Knex rozwinąłby go w listę `?, ?`)", () => {
    expect(() => toKnexPositionalSql("WHERE status = ANY($1)", [["failed"]])).toThrow(
      SqlDialectError,
    )
  })

  it("odrzuca mieszanie dialektów (`?` w wejściowym SQL-u)", () => {
    expect(() => toKnexPositionalSql("WHERE a = ? AND b = $1", ["x"])).toThrow(
      SqlDialectError,
    )
  })

  it("odrzuca placeholder bez wartości (literówka `$7` przy 6 wartościach)", () => {
    expect(() => toKnexPositionalSql("VALUES ($1, $7)", ["a"])).toThrow(SqlDialectError)
  })
})
