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
import {
  applyFatalStageVerdict,
  executeMarketRuntimeStage,
  runStage,
} from "../../scripts/gp-config-sync-orchestrator"

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

/** `process.exitCode` ustawiony przez entrypoint w ostatnim `runSync` (przywracany po każdym wywołaniu). */
let lastStageExitCode: number | string | undefined

async function runSync(fixture: Fixture, db: { raw: jest.Mock }, apply: boolean) {
  const env = { ...process.env }
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  lastStageExitCode = undefined
  process.env.GP_CONFIG_ROOT = fixture.configRoot
  process.env.GP_MARKETS_SOURCE_ROOT = fixture.marketsSourceRoot
  delete process.env.GP_DRY_RUN
  if (apply) process.env.GP_SYNC_APPLY = "true"
  else delete process.env.GP_SYNC_APPLY
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined)
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    return await gpConfigSyncMarketRuntime({
      container: { resolve: () => db },
      args: ["gp-dev", "bonbeauty"],
    } as never)
  } finally {
    log.mockRestore()
    warn.mockRestore()
    process.env = env
    lastStageExitCode = process.exitCode
    process.exitCode = previousExitCode
  }
}

const DRIFTED_ROW = {
  locales: {},
  support_email: "x",
  market_url: "x",
  money_path_brakes: { ...ALL_ENGAGED, fr_9_delivery_idempotency: "released" },
}

/**
 * Etap tak, jak woła go orchestrator: `runStage` (etap OPCJONALNY) +
 * wrapper `executeMarketRuntimeStage` + werdykt runu. Mutant wrappera
 * ignorującego `summary.ok` albo werdyktu ignorującego `failed` jest czerwony.
 */
async function runStageAsOrchestrator(fixture: Fixture, db: { raw: jest.Mock }, apply: boolean) {
  const warnings: string[] = []
  const stage = await runStage({
    name: "sync-market-runtime",
    required: false,
    execute: () =>
      executeMarketRuntimeStage({
        dryRun: !apply,
        warnings,
        run: () => runSync(fixture, db, apply),
      }),
  })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  const summary = { ok: true }
  applyFatalStageVerdict(summary, [stage])
  const runExitCode = process.exitCode
  process.exitCode = previousExitCode
  return { stage, warnings, summary, runExitCode }
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
    // apply: dry-run na pustej bazie jest od R-18 fatalny (brak wiersza nie jest zgodnością)
    const summary = await runSync(f, fakeRuntimeDb(null), true)
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

  it("R-3/R-18: zastany rozjazd bazy (released przy źródle engaged) — dry-run kończy etap błędem fatalnym pre-apply i exitCode=1", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const db = fakeRuntimeDb(DRIFTED_ROW)
    await expect(runSync(f, db, false)).rejects.toMatchObject({
      name: "MoneyPathBrakesDriftError",
      error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
      fatal: true,
      phase: "pre-apply",
      message: expect.stringMatching(
        /fr_9_delivery_idempotency: source 'engaged' != runtime 'released'/,
      ),
    })
    expect(lastStageExitCode).toBe(1)
    expect(db.raw.mock.calls.some(([sql]) => /INSERT INTO/.test(String(sql)))).toBe(false)
  })

  it("R-15/R-19: zastany rozjazd w dry-run przez runStage => failed + nazwany kod, run ok=false / exit 1", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const { stage, summary, runExitCode } = await runStageAsOrchestrator(
      f,
      fakeRuntimeDb(DRIFTED_ROW),
      false,
    )
    expect(stage.status).toBe("failed")
    expect(stage.error_code).toBe(MONEY_PATH_BRAKES_DRIFT_ERROR_CODE)
    expect(stage.message).toMatch(/\[pre-apply\]/)
    expect(summary.ok).toBe(false)
    expect(runExitCode).toBe(1)
  })

  it("R-18: pusta baza bez wiersza rynku w dry-run => failed (brak wpisu nie zwalnia hamulca)", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const { stage, summary, runExitCode } = await runStageAsOrchestrator(f, fakeRuntimeDb(null), false)
    expect(stage.status).toBe("failed")
    expect(stage.error_code).toBe(MONEY_PATH_BRAKES_DRIFT_ERROR_CODE)
    expect(stage.message).toMatch(/runtime: brak bloku money_path_brakes/)
    expect(summary.ok).toBe(false)
    expect(runExitCode).toBe(1)
  })

  it("R-18: zgodna baza w dry-run => ok (kontrola: hamulec nie wywraca zgodnego runu)", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const { stage, summary, runExitCode } = await runStageAsOrchestrator(
      f,
      fakeRuntimeDb({ ...DRIFTED_ROW, money_path_brakes: ALL_ENGAGED }),
      false,
    )
    expect(stage.status).toBe("ok")
    expect(summary.ok).toBe(true)
    expect(runExitCode).toBeUndefined()
  })

  it("R-17/R-18: apply z zastanym rozjazdem naprawia w stronę źródła i NAZYWA rozjazd w warnings runu", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const db = fakeRuntimeDb(DRIFTED_ROW)
    const { stage, warnings, summary } = await runStageAsOrchestrator(f, db, true)
    expect(stage.status).toBe("ok")
    expect(summary.ok).toBe(true)
    expect(warnings.join("\n")).toMatch(
      /sync-market-runtime: GP_CONFIG_MONEY_PATH_BRAKES_DRIFT \[pre-apply\].*fr_9_delivery_idempotency: source 'engaged' != runtime 'released'/,
    )
    expect((db.current() as { money_path_brakes: unknown }).money_path_brakes).toEqual(ALL_ENGAGED)
  })

  it("R-16: literówka w KANONICZNYM źródle (relesed) => fatal source-invalid przez runStage, baza nietknięta", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    fs.writeFileSync(
      f.sourcePath,
      fs
        .readFileSync(f.sourcePath, "utf8")
        .replace(/fr_9_delivery_idempotency: engaged/, "fr_9_delivery_idempotency: relesed"),
    )
    expect(fs.readFileSync(f.sourcePath, "utf8")).toMatch(/relesed/)
    const db = fakeRuntimeDb(DRIFTED_ROW)
    await expect(runSync(f, db, true)).rejects.toMatchObject({
      error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
      fatal: true,
      phase: "source-invalid",
    })
    const { stage, summary, runExitCode } = await runStageAsOrchestrator(f, db, true)
    expect(stage.status).toBe("failed")
    expect(stage.message).toMatch(/\[source-invalid\].*relesed/)
    expect(summary.ok).toBe(false)
    expect(runExitCode).toBe(1)
    expect(db.raw.mock.calls.some(([sql]) => /INSERT INTO/.test(String(sql)))).toBe(false)
    expect((db.current() as { money_path_brakes: unknown }).money_path_brakes).toEqual(
      DRIFTED_ROW.money_path_brakes,
    )
  })

  it("R-16: ta sama literówka w źródle I projekcji (assemble kopiuje) też jest fatalna, nie warningiem locales", async () => {
    const typo = { ...ALL_ENGAGED, fr_9_delivery_idempotency: "relesed" }
    const f = fixture({ source: typo, projection: typo })
    const { stage, runExitCode } = await runStageAsOrchestrator(f, fakeRuntimeDb(null), true)
    expect(stage.status).toBe("failed")
    expect(stage.error_code).toBe(MONEY_PATH_BRAKES_DRIFT_ERROR_CODE)
    expect(stage.message).toMatch(/\[source-invalid\]/)
    expect(runExitCode).toBe(1)
  })

  it("R-16: nieparsowalny YAML kanonicznego źródła => fatal source-invalid", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    fs.writeFileSync(f.sourcePath, "- tylko\n- lista\n")
    await expect(runSync(f, fakeRuntimeDb(null), true)).rejects.toMatchObject({
      error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
      phase: "source-invalid",
    })
  })

  // R-25: składniowo zły YAML (YAMLException), nie tylko poprawny YAML o złym
  // kształcie. Mutant: zwykły `yaml.load` bez obsługi w projekcji albo
  // projekcja czytana przed źródłem => etap `warning` / inna faza => czerwień.
  const BROKEN_YAML = "money_path_brakes: {fr_9: [engaged\n  : : :\n"

  async function expectFatalYamlStage(f: Fixture, phase: string, dryRunToo = true) {
    for (const apply of dryRunToo ? [false, true] : [true]) {
      const db = fakeRuntimeDb(DRIFTED_ROW)
      await expect(runSync(f, db, apply)).rejects.toMatchObject({
        error_code: MONEY_PATH_BRAKES_DRIFT_ERROR_CODE,
        fatal: true,
        phase,
      })
      const { stage, summary, runExitCode, warnings } = await runStageAsOrchestrator(f, db, apply)
      expect(stage.status).toBe("failed")
      expect(stage.error_code).toBe(MONEY_PATH_BRAKES_DRIFT_ERROR_CODE)
      expect(stage.message).toContain(`[${phase}]`)
      expect(summary.ok).toBe(false)
      expect(runExitCode).toBe(1)
      expect(warnings).toHaveLength(0)
      expect(db.raw.mock.calls.some(([sql]) => /INSERT INTO/.test(String(sql)))).toBe(false)
    }
  }

  it("R-25 (a): zły YAML tylko w PROJEKCJI => fatal projection-invalid (dry-run i apply), run ok=false / exit 1", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const projectionPath = path.join(f.configRoot, "gp-dev", "markets", "bonbeauty", "market.yaml")
    fs.writeFileSync(projectionPath, BROKEN_YAML)
    expect(() => yaml.load(BROKEN_YAML)).toThrow()
    await expectFatalYamlStage(f, "projection-invalid")
  })

  it("R-25 (b): zły YAML w ŹRÓDLE i PROJEKCJI => fatal source-invalid (źródło czytane pierwsze)", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const projectionPath = path.join(f.configRoot, "gp-dev", "markets", "bonbeauty", "market.yaml")
    fs.writeFileSync(projectionPath, BROKEN_YAML)
    fs.writeFileSync(f.sourcePath, BROKEN_YAML)
    await expectFatalYamlStage(f, "source-invalid")
  })

  it("R-25 (c): zły YAML tylko w ŹRÓDLE (regresja R-16) => fatal source-invalid", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    fs.writeFileSync(f.sourcePath, BROKEN_YAML)
    await expectFatalYamlStage(f, "source-invalid")
  })

  it("R-3: apply naprawia zastany rozjazd w stronę źródła i to jest widoczne w raporcie", async () => {
    const f = fixture({ source: ALL_ENGAGED, projection: ALL_ENGAGED })
    const db = fakeRuntimeDb(DRIFTED_ROW)
    const summary = await runSync(f, db, true)
    expect(summary.ok).toBe(true)
    expect(summary.money_path_brakes_round_trip.pre_apply_drift).not.toHaveLength(0)
    expect(summary.warnings.join(" ")).toMatch(/GP_CONFIG_MONEY_PATH_BRAKES_DRIFT \[pre-apply\]/)
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

  it("R-16: checkMoneyPathBrakesBeforeApply — literówka w kanonicznym źródle jest fatalna (source-invalid)", () => {
    let caught: unknown
    try {
      checkMoneyPathBrakesBeforeApply({
        marketId: "bonbeauty",
        canonicalBlock: { fr_9_delivery_idempotency: "relesed" },
        projectionBlock: ALL_ENGAGED,
        existingRuntimeBlock: ALL_ENGAGED,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MoneyPathBrakesDriftError)
    expect(caught).toMatchObject({ fatal: true, phase: "source-invalid" })
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
