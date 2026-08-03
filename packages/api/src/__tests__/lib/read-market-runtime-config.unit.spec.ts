/**
 * read-market-runtime-config.unit.spec.ts — Story 5.7 (AC1/AC2).
 *
 * Odczyt runtime config jest JEDNĄ implementacją: `read()` (blok `locales`)
 * jest projekcją tego samego zapytania co `readRuntimeConfig()`. Test broni
 * właśnie tego — dwa kanały SQL rozjechałyby się przy pierwszej zmianie tabeli.
 */

import {
  createMarketLocalesReader,
  type MarketLocalesSql,
} from "../../lib/read-market-locales"

type Recorded = { sql: string; bindings: readonly unknown[] }

function fakeSql(
  impl: (sql: string, bindings: readonly unknown[]) => unknown,
): MarketLocalesSql & { recorded: Recorded[] } {
  const recorded: Recorded[] = []
  return {
    recorded,
    async raw(sql: string, bindings: readonly unknown[] = []) {
      recorded.push({ sql, bindings })
      return impl(sql, bindings)
    },
  }
}

const ROW = {
  locales: { default: "pl", supported: ["pl", "en"] },
  support_email: "kontakt@bonbeauty.pl",
  market_url: "https://dev.bonbeauty.pl",
}

describe("readRuntimeConfig — AC2", () => {
  it("czyta locales, support_email i market_url JEDNYM zapytaniem", async () => {
    const sql = fakeSql(() => ({ rows: [ROW] }))
    const reader = createMarketLocalesReader(sql)

    const read = await reader.readRuntimeConfig!("bonbeauty")

    expect(read.degraded).toBe(false)
    expect(read.row).toEqual(ROW)
    expect(sql.recorded).toHaveLength(1)
    const query = sql.recorded[0].sql.replace(/\s+/g, " ")
    expect(query).toContain("support_email")
    expect(query).toContain("market_url")
    expect(query).toContain("market_runtime_config")
  })

  it("brak wiersza rynku → `row: null` BEZ degradacji (to nie awaria odczytu)", async () => {
    const reader = createMarketLocalesReader(fakeSql(() => ({ rows: [] })))
    const read = await reader.readRuntimeConfig!("bonbeauty")

    expect(read).toEqual({ row: null, degraded: false })
  })

  it("błąd odczytu (np. brak tabeli) → `degraded: true`, nigdy wartość domyślna", async () => {
    const warnings: string[] = []
    const reader = createMarketLocalesReader(
      fakeSql(() => {
        throw new Error('relation "market_runtime_config" does not exist')
      }),
      { warn: (message) => warnings.push(message) },
    )

    const read = await reader.readRuntimeConfig!("bonbeauty")

    expect(read).toEqual({ row: null, degraded: true })
    expect(warnings).toHaveLength(1)
    // Żadnego shimu env dla kontaktu/URL — te pola nie mają fallbacku (AC2).
    expect(read.row).toBeNull()
  })

  it("puste stringi są traktowane jak brak wartości", async () => {
    const reader = createMarketLocalesReader(
      fakeSql(() => ({
        rows: [{ locales: ROW.locales, support_email: "   ", market_url: "" }],
      })),
    )

    const read = await reader.readRuntimeConfig!("bonbeauty")

    expect(read.row?.support_email).toBeNull()
    expect(read.row?.market_url).toBeNull()
  })
})

describe("read() — projekcja tego samego odczytu (bez drugiego kanału SQL)", () => {
  it("zwraca konfigurację rynku, gdy blok locales istnieje", async () => {
    const reader = createMarketLocalesReader(fakeSql(() => ({ rows: [ROW] })))
    const read = await reader.read("bonbeauty")

    expect(read.degraded).toBe(false)
    expect(read.config.default).toBe("pl")
  })

  it("brak bloku locales → shim env z flagą `degraded` (zachowanie 2.3)", async () => {
    const reader = createMarketLocalesReader(
      fakeSql(() => ({ rows: [{ ...ROW, locales: null }] })),
    )

    expect((await reader.read("bonbeauty")).degraded).toBe(true)
  })

  it("`locales` w formie tekstowej (jsonb jako string) jest parsowane", async () => {
    const reader = createMarketLocalesReader(
      fakeSql(() => ({
        rows: [{ ...ROW, locales: JSON.stringify(ROW.locales) }],
      })),
    )

    const read = await reader.read("bonbeauty")
    expect(read.degraded).toBe(false)
    expect(read.config.supported).toEqual(["pl", "en"])
  })
})
