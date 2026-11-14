/**
 * gp-config-sync-market-runtime — normalizacja bloku `money_path_brakes`
 * (v1.15.0 Story 2.1, AC4).
 *
 * Etap sync jest miejscem, w którym konfiguracja rynku przestaje być tekstem,
 * a zaczyna być zachowaniem. Dlatego tutaj rozstrzyga się, co jest brakiem
 * deklaracji (legalnym, z wartością bezpieczną), a co jest BŁĘDEM
 * konfiguracji (literówka w stanie hamulca) — cicha podmiana literówki na
 * `engaged` ukryłaby nieudaną próbę zwolnienia hamulca przed operatorem,
 * który byłby przekonany, że mu się udało.
 */

import fs from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  MONEY_PATH_BRAKE_SAFE_STATE,
  MONEY_PATH_BRAKE_SWITCHES,
  MoneyPathBrakesDriftError,
  applyMarketRuntimeSync,
  assertMoneyPathBrakesRoundTrip,
  buildMarketRuntimeRecord,
  compareMoneyPathBrakesRoundTrip,
  normalizeMoneyPathBrakes,
  readRuntimeMoneyPathBrakes,
} from "../../scripts/gp-config-sync-market-runtime"

describe("normalizeMoneyPathBrakes", () => {
  it("brak bloku => wszystkie pięć hamulców zaciągniętych", () => {
    expect(normalizeMoneyPathBrakes(undefined)).toEqual({
      fr_6_7_multi_seller_purchase_return: "engaged",
      fr_9_delivery_idempotency: "engaged",
      fr_10_panel_redemption: "engaged",
      fr_12_redemption_ledger: "engaged",
      fr_14_market_isolation: "engaged",
    })
  })

  it("blok częściowy => brakujące przełączniki dostają wartość bezpieczną", () => {
    const result = normalizeMoneyPathBrakes({ fr_10_panel_redemption: "released" })
    expect(result.fr_10_panel_redemption).toBe("released")
    for (const brake of MONEY_PATH_BRAKE_SWITCHES) {
      if (brake === "fr_10_panel_redemption") continue
      expect(result[brake]).toBe(MONEY_PATH_BRAKE_SAFE_STATE)
    }
  })

  it("literówka w stanie zatrzymuje sync PRZED zapisem", () => {
    expect(() =>
      normalizeMoneyPathBrakes({ fr_9_delivery_idempotency: "relesed" }),
    ).toThrow(/money_path_brakes\.fr_9_delivery_idempotency/)
  })

  it("przełącznik spoza piątki jest błędem, nie polem ignorowanym", () => {
    expect(() => normalizeMoneyPathBrakes({ fr_99_wlasna_flaga: "released" })).toThrow(
      /ADR-177/,
    )
  })

  it("pusty blok jest błędem — „nic” nie jest deklaracją", () => {
    expect(() => normalizeMoneyPathBrakes({})).toThrow(/pusty/)
  })
})

// ── Story 6.8 (AC2): round-trip source↔runtime dla WSZYSTKICH rynków ────────
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")

type MarketSource = { instance: string; market: string; sourcePath: string; runtimePath: string }

function discoverMarketSources(): MarketSource[] {
  const marketsRoot = path.join(REPO_ROOT, "gp-ops", "markets")
  const found: MarketSource[] = []
  for (const market of fs.readdirSync(marketsRoot).sort()) {
    const configRoot = path.join(marketsRoot, market, "config")
    if (!fs.existsSync(configRoot)) continue
    for (const instance of fs.readdirSync(configRoot).sort()) {
      const sourcePath = path.join(configRoot, instance, "markets", market, "market.yaml")
      if (!fs.existsSync(sourcePath)) continue
      found.push({
        instance,
        market,
        sourcePath,
        runtimePath: path.join(REPO_ROOT, "GP", "config", instance, "markets", market, "market.yaml"),
      })
    }
  }
  return found
}

function loadYaml(file: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.JSON_SCHEMA }) as Record<
    string,
    unknown
  >
}

/** Atrapa `market_runtime_config` — przechowuje DOKŁADNIE to, co zapisał apply. */
function fakeRuntimeDb() {
  const rows = new Map<string, unknown>()
  return {
    rows,
    db: {
      raw: jest.fn(async (sql: string, bindings: unknown[]) => {
        if (/^\s*INSERT INTO market_runtime_config/.test(sql)) {
          rows.set(String(bindings[0]), String(bindings[4]))
          return { rows: [] }
        }
        const id = String(bindings[0])
        return { rows: rows.has(id) ? [{ money_path_brakes: rows.get(id) }] : [] }
      }),
    },
  }
}

describe("Story 6.8 — round-trip money_path_brakes source↔runtime", () => {
  const sources = discoverMarketSources()

  it("odkrywa wszystkie skonfigurowane rynki (w tym testmarketb tylko do odczytu)", () => {
    const markets = new Set(sources.map((s) => s.market))
    expect([...markets].sort()).toEqual(
      expect.arrayContaining(["bonbeauty", "bonevent", "bongarden", "mercur", "testmarketb"]),
    )
    expect(sources.length).toBeGreaterThanOrEqual(10)
  })

  it.each(discoverMarketSources().map((s) => [`${s.instance}/${s.market}`, s] as const))(
    "%s: source == projekcja runtime == wiersz po apply (dokładne wartości)",
    async (_label, source) => {
      const sourceYaml = loadYaml(source.sourcePath)
      const runtimeYaml = loadYaml(source.runtimePath)

      // warstwa 1: source -> projekcja GP/config (byte-verbatim assemble)
      assertMoneyPathBrakesRoundTrip(
        source.market,
        sourceYaml.money_path_brakes,
        normalizeMoneyPathBrakes(runtimeYaml.money_path_brakes),
      )

      // warstwa 2: projekcja -> market_runtime_config -> odczyt
      const { db } = fakeRuntimeDb()
      const record = buildMarketRuntimeRecord(source.market, runtimeYaml)
      await applyMarketRuntimeSync(db as never, record)
      const stored = await readRuntimeMoneyPathBrakes(db as never, source.market)
      const roundTrip = assertMoneyPathBrakesRoundTrip(
        source.market,
        sourceYaml.money_path_brakes,
        stored,
      )
      expect(roundTrip.runtime).toEqual(roundTrip.source)
      // stan zastany: wszystkie hamulce engaged (story nie zmienia stanu)
      expect(roundTrip.source.fr_9_delivery_idempotency).toBe("engaged")
    },
  )

  it("rozjazd source↔runtime jest odmową (fail-closed), nie zwolnieniem", () => {
    const result = compareMoneyPathBrakesRoundTrip(
      "bonbeauty",
      { fr_9_delivery_idempotency: "engaged" },
      { ...normalizeMoneyPathBrakes(undefined), fr_9_delivery_idempotency: "released" },
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches.join(" ")).toMatch(/fr_9_delivery_idempotency/)
    expect(() =>
      assertMoneyPathBrakesRoundTrip(
        "bonbeauty",
        { fr_9_delivery_idempotency: "engaged" },
        { ...normalizeMoneyPathBrakes(undefined), fr_9_delivery_idempotency: "released" },
      ),
    ).toThrow(MoneyPathBrakesDriftError)
  })

  it("brak wiersza runtime jest rozjazdem, nie zgodnością przez wartość domyślną", () => {
    const result = compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, null)
    expect(result.ok).toBe(false)
    expect(result.runtime).toBeNull()
  })

  it("brak wpisu w runtime dla jednego przełącznika jest rozjazdem", () => {
    const partial: Record<string, string> = { ...normalizeMoneyPathBrakes(undefined) }
    delete partial.fr_9_delivery_idempotency
    const result = compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, partial)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([
      "fr_9_delivery_idempotency: runtime brak wpisu (source 'engaged')",
    ])
  })

  it("przełącznik spoza ADR-177 w runtime jest rozjazdem", () => {
    const result = compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, {
      ...normalizeMoneyPathBrakes(undefined),
      fr_99_x: "released",
    })
    expect(result.ok).toBe(false)
  })

  it("brak wpisu w źródle => engaged, bez budżetu/pól domyślnych", () => {
    const result = compareMoneyPathBrakesRoundTrip(
      "bonbeauty",
      undefined,
      JSON.stringify(normalizeMoneyPathBrakes(undefined)),
    )
    expect(result.ok).toBe(true)
    expect(result.source.fr_9_delivery_idempotency).toBe("engaged")
    expect(Object.keys(result.source).sort()).toEqual([...MONEY_PATH_BRAKE_SWITCHES].sort())
    expect(result.source).not.toHaveProperty("sender_budget")
    expect(result.source).not.toHaveProperty("cutoff")
  })
})
