/**
 * gp-config-sync-market-runtime.unit.spec.ts — Story 5.7 (AC2).
 *
 * Bez żywego Postgresa: `Knex.raw` jest atrapą zapamiętującą zapytania.
 * Broniony jest kontrakt kanału gp-config → runtime, nie sterownik.
 */

import type { Knex } from "knex"

import {
  applyMarketRuntimeSync,
  buildMarketRuntimeRecord,
  MarketRuntimeConfigInvalidError,
  normalizeLocalesBlock,
  normalizeMarketUrl,
  normalizeSupportEmail,
  parseMarketRuntimeSyncArgs,
  planMarketRuntimeSync,
} from "../gp-config-sync-market-runtime"

const MARKET_YAML = {
  market_id: "bonbeauty",
  locales: {
    default: "pl",
    supported: ["pl", "en", "ua", "de"],
    fallback_chain: ["pl", "en", "ua", "de"],
  },
  owners: { primary: "market-bonbeauty-team", email: "kontakt@bonbeauty.pl" },
  domains: { primary: "dev.bonbeauty.pl", aliases: ["www.dev.bonbeauty.pl"] },
}

/** Atrapa Knexa: SELECT zwraca zadany wiersz, INSERT jest zapamiętywany. */
function fakeDb(existing: Record<string, unknown> | null) {
  const queries: Array<{ sql: string; bindings: unknown[] }> = []
  let row = existing

  const db = {
    async raw(sql: string, bindings: unknown[] = []) {
      queries.push({ sql, bindings })
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: row ? [row] : [] }
      }
      // Kolejność bindingów MUSI odpowiadać INSERT-owi z
      // `applyMarketRuntimeSync`. Po dodaniu `money_path_brakes` (v1.15.0
      // Story 2.1) atrapa gubiła tę kolumnę i drugi sync raportował `update`
      // zamiast `unchanged` — atrapa opisywała nieaktualny kontrakt.
      const [, locales, support_email, market_url, money_path_brakes] =
        bindings as string[]
      row = { locales, support_email, market_url, money_path_brakes }
      return { rows: [] }
    },
  } as unknown as Knex

  return { db, queries, current: () => row }
}

describe("AC2 — tryby --dry-run / --apply", () => {
  const ENV_KEYS = ["GP_DRY_RUN", "GP_SYNC_APPLY", "GP_CONFIG_ROOT"] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it("domyślnie jest DRY-RUN — zapis wymaga jawnego `--apply`", () => {
    expect(parseMarketRuntimeSyncArgs(["gp-dev", "bonbeauty"]).dryRun).toBe(true)
    expect(
      parseMarketRuntimeSyncArgs(["gp-dev", "bonbeauty", "--apply"]).dryRun,
    ).toBe(false)
  })

  it("GP_DRY_RUN orchestratora jest TWARDYM override'em nad `--apply`", () => {
    process.env.GP_DRY_RUN = "true"
    expect(
      parseMarketRuntimeSyncArgs(["gp-dev", "bonbeauty", "--apply"]).dryRun,
    ).toBe(true)
  })
})

describe("AC2.3 — mapowanie i normalizacja market.yaml", () => {
  it("mapuje market_id / locales / owners.email / domains.primary", () => {
    expect(buildMarketRuntimeRecord("bonbeauty", MARKET_YAML)).toEqual({
      market_id: "bonbeauty",
      locales: MARKET_YAML.locales,
      // v1.15.0 Story 2.1: rekord runtime niesie też nośnik hamulca. Brak
      // wpisu w market.yaml = pięć razy wartość bezpieczna (ADR-177).
      money_path_brakes: {
        fr_6_7_multi_seller_purchase_return: "engaged",
        fr_9_delivery_idempotency: "engaged",
        fr_10_panel_redemption: "engaged",
        fr_12_redemption_ledger: "engaged",
        fr_14_market_isolation: "engaged",
      },
      support_email: "kontakt@bonbeauty.pl",
      market_url: "https://dev.bonbeauty.pl",
    })
  })

  it("normalizuje domenę bez schematu do ABSOLUTNEGO URL i ucina końcowy slash", () => {
    expect(normalizeMarketUrl("dev.bonbeauty.pl")).toBe("https://dev.bonbeauty.pl")
    expect(normalizeMarketUrl("https://dev.bonbeauty.pl/")).toBe(
      "https://dev.bonbeauty.pl",
    )
    expect(normalizeMarketUrl("http://dev.bonbeauty.pl")).toBe(
      "http://dev.bonbeauty.pl",
    )
  })

  it("odmawia zapisu rynku pod cudzym market_id", () => {
    expect(() =>
      buildMarketRuntimeRecord("bongarden", MARKET_YAML),
    ).toThrow(MarketRuntimeConfigInvalidError)
  })
})

describe("AC2.4 — walidacja PRZED zapisem", () => {
  it.each([
    ["", "pusta domena"],
    ["   ", "same białe znaki"],
    ["ftp://dev.bonbeauty.pl", "zły protokół"],
    ["localhost", "host bez kropki"],
  ])("odrzuca domains.primary = %p (%s)", (value) => {
    expect(() => normalizeMarketUrl(value)).toThrow(MarketRuntimeConfigInvalidError)
  })

  it.each(["", "  ", "kontakt", "kontakt@", "@bonbeauty.pl"])(
    "odrzuca owners.email = %p",
    (value) => {
      expect(() => normalizeSupportEmail(value)).toThrow(
        MarketRuntimeConfigInvalidError,
      )
    },
  )

  it.each([
    [null],
    [{}],
    [{ default: "pl" }],
    [{ default: "pl", supported: [] }],
    [{ default: "pl", supported: ["en"] }],
    [{ default: "", supported: ["pl"] }],
  ])("odrzuca niepoprawny blok locales: %p", (block) => {
    expect(() => normalizeLocalesBlock(block)).toThrow(
      MarketRuntimeConfigInvalidError,
    )
  })

  it("błąd niesie NAZWĘ pola i stabilny kod, bez sekretów", () => {
    try {
      normalizeSupportEmail("")
      throw new Error("oczekiwano MarketRuntimeConfigInvalidError")
    } catch (error) {
      const typed = error as MarketRuntimeConfigInvalidError
      expect(typed.error_code).toBe("GP_CONFIG_MARKET_RUNTIME_INVALID")
      expect(typed.message).toContain("owners.email")
    }
  })
})

describe("AC2.2 / AC2.7 — idempotentny upsert po market_id", () => {
  const record = buildMarketRuntimeRecord("bonbeauty", MARKET_YAML)

  it("brak wiersza → plan `insert`", async () => {
    const { db } = fakeDb(null)
    expect((await planMarketRuntimeSync(db, record)).action).toBe("insert")
  })

  it("wiersz o innych wartościach → plan `update`", async () => {
    const { db } = fakeDb({
      locales: record.locales,
      support_email: "stary@bonbeauty.pl",
      market_url: record.market_url,
      money_path_brakes: record.money_path_brakes,
    })
    expect((await planMarketRuntimeSync(db, record)).action).toBe("update")
  })

  it("DRUGI sync tych samych danych nie zmienia rekordu (`unchanged`)", async () => {
    const harness = fakeDb(null)

    expect((await planMarketRuntimeSync(harness.db, record)).action).toBe("insert")
    await applyMarketRuntimeSync(harness.db, record)

    // Drugi przebieg na stanie po pierwszym: zero zmian.
    expect((await planMarketRuntimeSync(harness.db, record)).action).toBe(
      "unchanged",
    )
  })

  it("porównanie `locales` jest niewrażliwe na kolejność kluczy i na formę jsonb/tekst", async () => {
    const { db } = fakeDb({
      locales: JSON.stringify({
        fallback_chain: ["pl", "en", "ua", "de"],
        supported: ["pl", "en", "ua", "de"],
        default: "pl",
      }),
      support_email: record.support_email,
      market_url: record.market_url,
      money_path_brakes: record.money_path_brakes,
    })

    expect((await planMarketRuntimeSync(db, record)).action).toBe("unchanged")
  })

  it("upsert używa ON CONFLICT (market_id), nie DELETE + INSERT", async () => {
    const { db, queries } = fakeDb(null)
    await applyMarketRuntimeSync(db, record)

    const sql = queries[queries.length - 1].sql.replace(/\s+/g, " ")
    expect(sql).toMatch(/ON CONFLICT \(market_id\) DO UPDATE/i)
    expect(sql).not.toMatch(/\bDELETE\b/i)
  })
})
