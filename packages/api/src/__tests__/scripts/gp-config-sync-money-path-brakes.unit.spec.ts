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

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  MONEY_PATH_BRAKE_SAFE_STATE,
  MONEY_PATH_BRAKE_SWITCHES,
  MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
  MoneyPathBrakesDriftError,
  assertMoneyPathBrakesRoundTrip,
  checkMoneyPathBrakesBeforeApply,
  compareMoneyPathBrakesRoundTrip,
  loadCanonicalMarketSource,
  normalizeMoneyPathBrakes,
} from "../../scripts/gp-config-sync-market-runtime"
import gpConfigSyncMarketRuntime from "../../scripts/gp-config-sync-market-runtime"

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

// ── Story 6.8 (AC2): round-trip KANONICZNE źródło ↔ runtime ────────────────
//
// R-4/R-10 (review 6.8): kontrakt jest testowany na FIXTURE'ACH, nie na żywej
// polityce repo. Żywy stan (`engaged` na dziś) jest POMIAREM — legalne,
// świadome zwolnienie bramką ludzką (`gp-ops brake set`) nie może zrobić tego
// testu czerwonym, dopóki źródło i projekcja są zgodne.
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const ALL_ENGAGED = normalizeMoneyPathBrakes(undefined)
const BASE_PROJECTION = path.join(
  REPO_ROOT,
  "GP",
  "config",
  "gp-dev",
  "markets",
  "bonbeauty",
  "market.yaml",
)

function loadYaml(file: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.JSON_SCHEMA }) as Record<
    string,
    unknown
  >
}

type Fixture = {
  configRoot: string
  marketsSourceRoot: string
  sourcePath: string
  cleanup: () => void
}

/** Drzewo: <tmp>/gp-ops/markets/<m>/config/<i>/markets/<m>/market.yaml + <tmp>/config/<i>/markets/<m>/market.yaml */
function makeFixture(input: {
  source: Record<string, string> | undefined
  projection: Record<string, string> | undefined
  sidecarSourceSha?: "match" | "stale" | "none"
}): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-6-8-brakes-"))
  const base = loadYaml(BASE_PROJECTION)
  const write = (file: string, brakes: Record<string, string> | undefined) => {
    const doc = { ...base, market_id: "bonbeauty" } as Record<string, unknown>
    delete doc.money_path_brakes
    if (brakes) doc.money_path_brakes = brakes
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, yaml.dump(doc))
  }
  const marketsSourceRoot = path.join(tmp, "gp-ops", "markets")
  const sourcePath = path.join(
    marketsSourceRoot,
    "bonbeauty",
    "config",
    "gp-dev",
    "markets",
    "bonbeauty",
    "market.yaml",
  )
  const configRoot = path.join(tmp, "config")
  const projectionDir = path.join(configRoot, "gp-dev", "markets", "bonbeauty")
  write(sourcePath, input.source)
  write(path.join(projectionDir, "market.yaml"), input.projection)
  const mode = input.sidecarSourceSha ?? "match"
  if (mode !== "none") {
    const sha =
      mode === "match"
        ? createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
        : "0".repeat(64)
    fs.writeFileSync(
      path.join(projectionDir, ".gp-projection-provenance.json"),
      JSON.stringify({ schema_version: 1, source_files: { "market.yaml": sha } }),
    )
  }
  return {
    configRoot,
    marketsSourceRoot,
    sourcePath,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

/**
 * Atrapa `market_runtime_config` z pełnym wierszem. `dropWrites=true` to
 * mutant „martwy zapis": INSERT nie zmienia stanu — kontrola po apply MUSI to
 * odróżnić od działającego mechanizmu (R-3).
 */
function fakeRuntimeDb(initial: Record<string, unknown> | null, options: { dropWrites?: boolean } = {}) {
  let row: Record<string, unknown> | null = initial
  const raw = jest.fn(async (sql: string, bindings: unknown[]) => {
    if (/^\s*INSERT INTO market_runtime_config/.test(sql)) {
      if (!options.dropWrites) {
        row = {
          locales: JSON.parse(String(bindings[1])),
          support_email: bindings[2],
          market_url: bindings[3],
          money_path_brakes: JSON.parse(String(bindings[4])),
        }
      }
      return { rows: [] }
    }
    return { rows: row ? [row] : [] }
  })
  return { raw, current: () => row }
}

async function runSync(fixture: Fixture, db: { raw: jest.Mock }, apply: boolean) {
  const env = { ...process.env }
  process.env.GP_CONFIG_ROOT = fixture.configRoot
  process.env.GP_MARKETS_SOURCE_ROOT = fixture.marketsSourceRoot
  delete process.env.GP_DRY_RUN
  if (apply) process.env.GP_SYNC_APPLY = "true"
  else delete process.env.GP_SYNC_APPLY
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined)
  try {
    return await gpConfigSyncMarketRuntime({
      container: { resolve: () => db },
      args: ["gp-dev", "bonbeauty"],
    } as never)
  } finally {
    log.mockRestore()
    process.env = env
  }
}

describe("Story 6.8 — kontrakt round-tripu na fixture'ach (kanoniczne źródło)", () => {
  const fixtures: Fixture[] = []
  const fixture = (input: Parameters<typeof makeFixture>[0]) => {
    const f = makeFixture(input)
    fixtures.push(f)
    return f
  }
  afterAll(() => fixtures.forEach((f) => f.cleanup()))

  it("R-1: nieaktualna projekcja `released` przy źródle `engaged` jest odmową PRZED zapisem", async () => {
    const f = fixture({
      source: ALL_ENGAGED,
      projection: { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" },
    })
    const db = fakeRuntimeDb(null)
    await expect(runSync(f, db, true)).rejects.toMatchObject({
      name: "MoneyPathBrakesDriftError",
      error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
      fatal: true,
      phase: "source-projection",
    })
    // nic nie trafiło do bazy
    expect(db.raw.mock.calls.some(([sql]) => /INSERT INTO/.test(String(sql)))).toBe(false)
    expect(db.current()).toBeNull()
  })

  it("R-4: zgodne źródło i projekcja `released` (legalne zwolnienie) przechodzą", async () => {
    const released = { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" }
    const f = fixture({ source: released, projection: released })
    const db = fakeRuntimeDb(null)
    const summary = await runSync(f, db, true)
    expect(summary.ok).toBe(true)
    expect((db.current() as { money_path_brakes: unknown }).money_path_brakes).toEqual(released)
  })

  it("R-1: raport niesie proweniencję kanonicznego źródła (ścieżka + sha256)", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const summary = await runSync(f, fakeRuntimeDb(null), true)
    const provenance = summary.money_path_brakes_round_trip.provenance
    expect(provenance.source_path).toBe(f.sourcePath)
    expect(provenance.source_sha256).toBe(
      createHash("sha256").update(fs.readFileSync(f.sourcePath)).digest("hex"),
    )
    expect(provenance.projection_built_from_source).toBe(true)
  })

  it("R-1: sidecar z innym sha źródła jest raportowany jako projekcja nie z tego źródła", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED, sidecarSourceSha: "stale" })
    const summary = await runSync(f, fakeRuntimeDb(null), false)
    expect(summary.money_path_brakes_round_trip.provenance.projection_built_from_source).toBe(false)
  })

  it("R-1: brak kanonicznego źródła jest rozjazdem fatalnym, nie zgodnością", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    fs.rmSync(f.sourcePath)
    await expect(runSync(f, fakeRuntimeDb(null), true)).rejects.toMatchObject({
      error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
      phase: "source-missing",
    })
  })

  it("R-3: zastany rozjazd bazy (released przy źródle engaged) — dry-run ok=false i nazwany pre_apply_drift", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const db = fakeRuntimeDb({
      locales: {},
      support_email: "x",
      market_url: "x",
      money_path_brakes: { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" },
    })
    const summary = await runSync(f, db, false)
    expect(summary.ok).toBe(false)
    expect(summary.money_path_brakes_round_trip.pre_apply_drift.join(" ")).toMatch(
      /fr_9_delivery_idempotency: source 'engaged' != runtime 'released'/,
    )
  })

  it("R-3: apply naprawia zastany rozjazd w stronę źródła i to jest widoczne w raporcie", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const db = fakeRuntimeDb({
      locales: {},
      support_email: "x",
      market_url: "x",
      money_path_brakes: { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" },
    })
    const summary = await runSync(f, db, true)
    expect(summary.ok).toBe(true)
    expect(summary.money_path_brakes_round_trip.pre_apply_drift).not.toHaveLength(0)
    expect((db.current() as { money_path_brakes: unknown }).money_path_brakes).toEqual(ALL_ENGAGED)
  })

  it("R-3: martwy zapis (mutant) przy zastanym rozjeździe wywraca etap kodem po apply", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const db = fakeRuntimeDb(
      {
        locales: {},
        support_email: "x",
        market_url: "x",
        money_path_brakes: { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" },
      },
      { dropWrites: true },
    )
    await expect(runSync(f, db, true)).rejects.toMatchObject({
      error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
      phase: "post-apply",
    })
  })

  it("rozjazd source↔runtime jest odmową (fail-closed), nie zwolnieniem", () => {
    const runtime = { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" }
    const result = compareMoneyPathBrakesRoundTrip(
      "bonbeauty",
      { fr_9_delivery_idempotency: "engaged" },
      runtime,
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches.join(" ")).toMatch(/fr_9_delivery_idempotency/)
    expect(() =>
      assertMoneyPathBrakesRoundTrip("bonbeauty", { fr_9_delivery_idempotency: "engaged" }, runtime),
    ).toThrow(MoneyPathBrakesDriftError)
  })

  it("brak wiersza runtime jest rozjazdem, nie zgodnością przez wartość domyślną", () => {
    const result = compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, null)
    expect(result.ok).toBe(false)
    expect(result.runtime).toBeNull()
  })

  it("brak wpisu w runtime dla jednego przełącznika jest rozjazdem", () => {
    const partial: Record<string, string> = { ...ALL_ENGAGED }
    delete partial.fr_9_delivery_idempotency
    const result = compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, partial)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([
      "fr_9_delivery_idempotency: runtime brak wpisu (source 'engaged')",
    ])
  })

  it("przełącznik spoza ADR-177 w runtime jest rozjazdem", () => {
    const result = compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, {
      ...ALL_ENGAGED,
      fr_99_x: "released",
    })
    expect(result.ok).toBe(false)
  })

  // R-9: test MOŻE być czerwony — mutant, który toleruje dodatkowe pola
  // (budżet/cutoff) w runtime albo w źródle, przechodzi round-trip jako zgodny.
  it("R-9: budżet/cutoff dopisany do bloku hamulców jest rozjazdem (runtime) i błędem (źródło)", () => {
    const withBudget = compareMoneyPathBrakesRoundTrip(
      "bonbeauty",
      undefined,
      JSON.stringify({ ...ALL_ENGAGED, sender_budget: "released", cutoff: "released" }),
    )
    expect(withBudget.ok).toBe(false)
    expect(withBudget.mismatches).toEqual([
      "runtime: przelacznik spoza ADR-177 'sender_budget'",
      "runtime: przelacznik spoza ADR-177 'cutoff'",
    ])
    expect(() =>
      compareMoneyPathBrakesRoundTrip("bonbeauty", { sender_budget: "released" }, ALL_ENGAGED),
    ).toThrow(/ADR-177/)
    // kontrola dodatnia: brak wpisu w źródle == pięć hamulców engaged == zgodne
    expect(compareMoneyPathBrakesRoundTrip("bonbeauty", undefined, ALL_ENGAGED).ok).toBe(true)
  })

  it("checkMoneyPathBrakesBeforeApply: literówka w projekcji jest błędem, nie zgodnością", () => {
    expect(() =>
      checkMoneyPathBrakesBeforeApply({
        marketId: "bonbeauty",
        canonicalBlock: ALL_ENGAGED,
        projectionBlock: { fr_9_delivery_idempotency: "relesed" },
        existingRuntimeBlock: null,
      }),
    ).toThrow(/money_path_brakes\.fr_9_delivery_idempotency/)
  })
})

// ── Pomiar żywego stanu repo (NIE kontrakt) ────────────────────────────────
// Wymaga tylko zgodności kanonicznego źródła z projekcją, z dowolnym stanem.
// Stan zastany (dziś: wszystkie `engaged`) jest raportowany w artefakcie
// `quality-measurement/6-8-round-trip-hamulca.json` (generator
// `_bmad-output/releases/v1.16.0/implementation-artifacts/quality-measurement/gen_6_8_round_trip_hamulca.py`), a nie egzekwowany asercją.
type MarketSource = { instance: string; market: string }

function discoverMarketSources(): MarketSource[] {
  const marketsRoot = path.join(REPO_ROOT, "gp-ops", "markets")
  const found: MarketSource[] = []
  for (const market of fs.readdirSync(marketsRoot).sort()) {
    const configRoot = path.join(marketsRoot, market, "config")
    if (!fs.existsSync(configRoot)) continue
    for (const instance of fs.readdirSync(configRoot).sort()) {
      if (fs.existsSync(path.join(configRoot, instance, "markets", market, "market.yaml"))) {
        found.push({ instance, market })
      }
    }
  }
  return found
}

describe("Story 6.8 — pomiar: kanoniczne źródło == projekcja na żywym repo", () => {
  it.each(discoverMarketSources().map((s) => [`${s.instance}/${s.market}`, s] as const))(
    "%s: źródło gp-ops/markets odtwarza się w projekcji GP/config",
    async (_label, s) => {
      const canonical = await loadCanonicalMarketSource({
        configRoot: path.join(REPO_ROOT, "GP", "config"),
        marketsSourceRoot: path.join(REPO_ROOT, "gp-ops", "markets"),
        instanceId: s.instance,
        marketId: s.market,
      })
      const projection = loadYaml(canonical.provenance.projection_path)
      const check = checkMoneyPathBrakesBeforeApply({
        marketId: s.market,
        canonicalBlock: canonical.doc.money_path_brakes,
        projectionBlock: projection.money_path_brakes,
        existingRuntimeBlock: normalizeMoneyPathBrakes(projection.money_path_brakes),
      })
      expect(check.source_projection.ok).toBe(true)
      expect(check.pre_apply.ok).toBe(true)
    },
  )
})
