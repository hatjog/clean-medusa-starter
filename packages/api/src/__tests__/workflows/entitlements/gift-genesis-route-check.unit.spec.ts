/**
 * v1.16.0 Story 3.8 AC2 — kontrola genezy prezentu zależnej od trasy
 * (ADR-219 §4 człon 2, decyzja PO D-1: raportująca, nazwana).
 */
import { describe, it, expect } from "@jest/globals"
import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"
import {
  checkGiftGenesis,
  type KnownDivergenceEntry,
  GIFT_GENESIS_KNOWN_DIVERGENCE,
  KNOWN_DIVERGENCE_CLOSED_SET,
  type GenesisObservation,
} from "../../../workflows/entitlements/gift-genesis-route-check"

const CAPTURED = "src/workflows/entitlements/issue-entitlement.ts"
const PATH_Y = "src/workflows/entitlements/live-issue-from-payment-intent.ts"
const REISSUE = "src/modules/voucher/workflows/reissue-lost-code.ts"
const RETENTION = "src/modules/voucher/workflows/issue-retention.ts"
const NEW_SUCCESSOR = "src/modules/voucher/workflows/new-successor.ts"

// Allowlista zawężona do captured-path: przypadki z jedną obserwacją nie mają
// wtedy wierszy STALE od wpisów następców (D-11), które mają osobne testy.
const CAPTURED_ONLY = GIFT_GENESIS_KNOWN_DIVERGENCE.filter((e) => e.route === "captured-path")

const obs = (o: Partial<GenesisObservation>): GenesisObservation => ({
  route: "captured-path",
  producer: CAPTURED,
  purchase_mode: "gift",
  genesis_state: "ACTIVE",
  ...o,
})

/**
 * Review-fix R-9 (checkpoint 2026-11-14, D-6): jedno źródło przypadków reguł
 * oceny dla TS i Pythona, plus JEDEN ekstraktor stanu (bramka Pythona) — test
 * realnego źródła porównuje werdykty `checkGiftGenesis` z `--json` bramki,
 * zamiast trzymać drugi ekstraktor (okno 2500 znaków) w TS.
 */
type Case = {
  name: string
  observations: GenesisObservation[]
  allowlist: KnownDivergenceEntry[]
  expected: [string, string][]
}
const CASES: Case[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/gift-genesis-cases.json"), "utf8")
).cases

const REPO_ROOT = resolve(__dirname, "../../../../../../../..")
const VALIDATOR = join(REPO_ROOT, "_grow/tools/validate_voucher_genesis_activation_contract.py")

describe("Story 3.8 AC2 — gift + ACTIVE czerwieni z nazwą trasy", () => {
  it("fikstura: gift + ACTIVE na trasie spoza allowlisty ⇒ FAIL z nazwą trasy", () => {
    const r = checkGiftGenesis(
      [obs({ route: "path-y-live-issue", producer: PATH_Y })],
      []
    )
    expect(r.ok).toBe(false)
    const fail = r.rows.find((x) => x.verdict === "FAIL" && x.route === "path-y-live-issue")
    expect(fail?.line).toContain("route=path-y-live-issue")
  })

  it("captured-path gift + ACTIVE ⇒ wiersz KNOWN-DIVERGENCE z trasą, DW-15-210 i DW-15-271 (nie wyciszenie)", () => {
    const r = checkGiftGenesis([obs({})], CAPTURED_ONLY)
    expect(r.ok).toBe(true)
    const row = r.rows.find((x) => x.verdict === "KNOWN-DIVERGENCE")
    expect(row).toBeDefined()
    expect(row!.line).toContain("route=captured-path")
    expect(row!.line).toContain("DW-15-210")
    expect(row!.line).toContain("DW-15-271")
  })

  it("D-11: allowlista == zamknięty zbiór DOKŁADNIE trzech tras po nazwie i pliku", () => {
    expect(GIFT_GENESIS_KNOWN_DIVERGENCE.map((e) => [e.route, e.producer, [...e.refs]])).toEqual([
      ["captured-path", CAPTURED, ["DW-15-210", "DW-15-271"]],
      ["lost-code-reissue", REISSUE, ["DW-15-281"]],
      ["retention-issue", RETENTION, ["DW-15-281"]],
    ])
    expect(Object.keys(KNOWN_DIVERGENCE_CLOSED_SET).sort()).toEqual([
      "captured-path",
      "lost-code-reissue",
      "retention-issue",
    ])
  })

  it("D-11: następcy gift + ACTIVE ⇒ KNOWN-DIVERGENCE z DW-15-281, rc ok", () => {
    const r = checkGiftGenesis([
      obs({}),
      obs({ route: "lost-code-reissue", producer: REISSUE }),
      obs({ route: "retention-issue", producer: RETENTION }),
    ])
    expect(r.ok).toBe(true)
    const kd = r.rows.filter((x) => x.verdict === "KNOWN-DIVERGENCE")
    expect(kd.map((x) => x.route)).toEqual(["captured-path", "lost-code-reissue", "retention-issue"])
    expect(kd[1].line).toContain("refs=DW-15-281")
  })

  it("D-11: NOWA trasa następcy gift + ACTIVE ⇒ FAIL (D-1)", () => {
    const r = checkGiftGenesis([
      obs({}),
      obs({ route: "lost-code-reissue", producer: REISSUE }),
      obs({ route: "retention-issue", producer: RETENTION }),
      obs({ route: "new-successor", producer: NEW_SUCCESSOR }),
    ])
    expect(r.ok).toBe(false)
    expect(r.rows.filter((x) => x.verdict === "FAIL").map((x) => x.route)).toEqual(["new-successor"])
  })

  it("D-11 mutant: wpis-wzorzec w allowliście nie dopuszcza nowej trasy ⇒ FAIL", () => {
    const r = checkGiftGenesis(
      [obs({}), obs({ route: "new-successor", producer: NEW_SUCCESSOR })],
      [...GIFT_GENESIS_KNOWN_DIVERGENCE, { route: "*", producer: "*", refs: ["DW-15-210", "DW-15-271", "DW-15-281"] }]
    )
    expect(r.ok).toBe(false)
    expect(r.rows.some((x) => x.verdict === "KNOWN-DIVERGENCE" && x.route === "new-successor")).toBe(false)
    expect(r.rows.some((x) => x.line.includes("spoza zamkniętego zbioru"))).toBe(true)
  })

  it("D-11: rozbieżność następcy ustąpiła ⇒ sygnał „zamknij DW-15-281”", () => {
    const r = checkGiftGenesis([
      obs({}),
      obs({ route: "lost-code-reissue", producer: REISSUE, genesis_state: "ISSUED" }),
      obs({ route: "retention-issue", producer: RETENTION }),
    ])
    expect(r.ok).toBe(false)
    const stale = r.rows.find((x) => x.line.includes("STALE"))
    expect(stale?.route).toBe("lost-code-reissue")
    expect(stale?.line).toContain("rozbieżność ustąpiła — zamknij DW-15-281")
  })

  it("mutant: gift + ACTIVE na INNEJ trasie (przy zachowanej allowliście) ⇒ FAIL", () => {
    const r = checkGiftGenesis([
      obs({}),
      obs({ route: "path-y-live-issue", producer: PATH_Y }),
    ], CAPTURED_ONLY)
    expect(r.ok).toBe(false)
    expect(r.rows.filter((x) => x.verdict === "FAIL").map((x) => x.route)).toEqual([
      "path-y-live-issue",
    ])
  })

  it("mutant: ta sama nazwa trasy, inny producent ⇒ FAIL (allowlista wiąże trasę z plikiem)", () => {
    const r = checkGiftGenesis([obs({ producer: "src/subscribers/other.ts" })])
    expect(r.ok).toBe(false)
  })

  it("mutant: brak wiersza KNOWN-DIVERGENCE (pusta allowlista) ⇒ FAIL", () => {
    const r = checkGiftGenesis([obs({})], [])
    expect(r.ok).toBe(false)
    expect(r.rows.some((x) => x.verdict === "KNOWN-DIVERGENCE")).toBe(false)
    expect(r.rows.some((x) => x.verdict === "FAIL" && x.route === "captured-path")).toBe(true)
  })

  it("mutant: trasa spoza zamkniętego zbioru dopisana do allowlisty ⇒ FAIL", () => {
    const r = checkGiftGenesis(
      [obs({}), obs({ route: "path-y-live-issue", producer: PATH_Y })],
      [
        ...GIFT_GENESIS_KNOWN_DIVERGENCE,
        { route: "path-y-live-issue", producer: PATH_Y, refs: ["DW-15-210", "DW-15-271"] },
      ]
    )
    expect(r.ok).toBe(false)
  })

  it("mutant: wpis allowlisty bez DW-15-271 ⇒ FAIL", () => {
    const r = checkGiftGenesis([obs({})], [
      { route: "captured-path", producer: CAPTURED, refs: ["DW-15-210"] },
    ])
    expect(r.ok).toBe(false)
  })

  it("STALE: allowlista bez obserwacji gift+ACTIVE (naprawa weszła) ⇒ FAIL", () => {
    const r = checkGiftGenesis([obs({ genesis_state: "ISSUED" })])
    expect(r.ok).toBe(false)
    expect(r.rows.some((x) => x.line.includes("STALE"))).toBe(true)
  })

  it("kontrola przeciwna: self + ACTIVE NIE czerwieni (mierzymy domenę, nie trasę)", () => {
    const r = checkGiftGenesis([
      obs({}),
      obs({ route: "path-y-live-issue", producer: PATH_Y, purchase_mode: "self" }),
    ], CAPTURED_ONLY)
    expect(r.ok).toBe(true)
  })

  it.each(CASES.map((c) => [c.name, c] as const))(
    "parytet reguł TS ↔ Python (wspólna fikstura): %s",
    (_name, c) => {
      const r = checkGiftGenesis(c.observations, c.allowlist)
      expect(r.rows.map((x) => [x.verdict, x.route])).toEqual(c.expected)
    }
  )

  // Poza super-repo (samodzielny checkout submodułu) bramki Pythona nie ma —
  // wtedy test jest jawnie pominięty z nazwą, nie zielony.
  const realIt = existsSync(VALIDATOR) ? it : it.skip
  realIt("realne źródło: werdykty TS == werdykty bramki Pythona; KNOWN-DIVERGENCE dokładnie 3 trasy (D-11)", () => {
    let out: string
    try {
      out = execFileSync("python3", [VALIDATOR, "--root", REPO_ROOT, "--json"], { encoding: "utf8" })
    } catch (e) {
      // exit 1 = FAIL w pomiarze — JSON i tak jest na stdout.
      out = (e as { stdout?: string }).stdout ?? ""
    }
    const py = JSON.parse(out) as {
      observations: GenesisObservation[]
      allowlist: KnownDivergenceEntry[]
      closed_set: unknown
      rows: { verdict: string; route: string }[]
    }
    expect(py.observations.length).toBeGreaterThanOrEqual(2)
    expect(py.allowlist).toEqual(
      GIFT_GENESIS_KNOWN_DIVERGENCE.map((e) => ({ ...e, refs: [...e.refs] }))
    )
    const ts = checkGiftGenesis(py.observations)
    expect(ts.rows.map((x) => [x.verdict, x.route])).toEqual(
      py.rows.map((x) => [x.verdict, x.route])
    )
    expect(py.closed_set).toEqual(
      JSON.parse(JSON.stringify(KNOWN_DIVERGENCE_CLOSED_SET))
    )
    expect(ts.ok).toBe(true)
    expect(
      ts.rows.filter((x) => x.verdict === "KNOWN-DIVERGENCE").map((x) => x.route).sort()
    ).toEqual(["captured-path", "lost-code-reissue", "retention-issue"])
    const pathY = py.observations.find((o) => o.route === "path-y-live-issue")
    expect(pathY?.genesis_state).toBe("ISSUED")
    // Wyjście kontroli — widoczne w logu przebiegu (evidence).
    // eslint-disable-next-line no-console
    console.log(ts.rows.map((x) => x.line).join("\n"))
  })
})
