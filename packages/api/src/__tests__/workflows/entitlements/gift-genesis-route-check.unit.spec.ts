/**
 * v1.16.0 Story 3.8 AC2 — kontrola genezy prezentu zależnej od trasy
 * (ADR-219 §4 człon 2, decyzja PO D-1: raportująca, nazwana).
 */
import { describe, it, expect } from "@jest/globals"
import { readFileSync } from "fs"
import { join } from "path"
import {
  checkGiftGenesis,
  GIFT_GENESIS_KNOWN_DIVERGENCE,
  type GenesisObservation,
} from "../../../workflows/entitlements/gift-genesis-route-check"

const CAPTURED = "src/workflows/entitlements/issue-entitlement.ts"
const PATH_Y = "src/workflows/entitlements/live-issue-from-payment-intent.ts"

const obs = (o: Partial<GenesisObservation>): GenesisObservation => ({
  route: "captured-path",
  producer: CAPTURED,
  purchase_mode: "gift",
  genesis_state: "ACTIVE",
  ...o,
})

/** Stan genezy odczytany ze źródła: pierwszy `EntitlementInstanceState.X` po literale SQL `INSERT INTO entitlement_instance`. */
function genesisStateFromSource(rel: string): string | null {
  const text = readFileSync(join(__dirname, "../../../..", rel), "utf8")
  // Literał SQL (backtick), nie wzmianka w komentarzu.
  const at = /`\s*INSERT INTO entitlement_instance(?!`)/.exec(text)
  if (!at) return null
  const i = at.index
  const m = /EntitlementInstanceState\.([A-Z_]+)/.exec(text.slice(i, i + 2500))
  return m ? m[1] : null
}

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
    const r = checkGiftGenesis([obs({})])
    expect(r.ok).toBe(true)
    const row = r.rows.find((x) => x.verdict === "KNOWN-DIVERGENCE")
    expect(row).toBeDefined()
    expect(row!.line).toContain("route=captured-path")
    expect(row!.line).toContain("DW-15-210")
    expect(row!.line).toContain("DW-15-271")
  })

  it("allowlista zawiera DOKŁADNIE jedną trasę: captured-path", () => {
    expect(GIFT_GENESIS_KNOWN_DIVERGENCE).toHaveLength(1)
    expect(GIFT_GENESIS_KNOWN_DIVERGENCE[0].route).toBe("captured-path")
    expect(GIFT_GENESIS_KNOWN_DIVERGENCE[0].producer).toBe(CAPTURED)
  })

  it("mutant: gift + ACTIVE na INNEJ trasie (przy zachowanej allowliście) ⇒ FAIL", () => {
    const r = checkGiftGenesis([
      obs({}),
      obs({ route: "path-y-live-issue", producer: PATH_Y }),
    ])
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

  it("mutant: druga trasa dopisana do allowlisty ⇒ FAIL (liczność ≠ 1)", () => {
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
    ])
    expect(r.ok).toBe(true)
  })

  it("realne źródło: captured-path tworzy ACTIVE, Path Y tworzy ISSUED ⇒ jeden wiersz KNOWN-DIVERGENCE", () => {
    const captured = genesisStateFromSource(CAPTURED)
    const pathY = genesisStateFromSource(PATH_Y)
    expect(captured).toBe("ACTIVE")
    expect(pathY).toBe("ISSUED")
    const r = checkGiftGenesis([
      obs({ genesis_state: captured! }),
      obs({ route: "path-y-live-issue", producer: PATH_Y, genesis_state: pathY! }),
    ])
    expect(r.ok).toBe(true)
    expect(r.rows.filter((x) => x.verdict === "KNOWN-DIVERGENCE").map((x) => x.route)).toEqual([
      "captured-path",
    ])
    // Wyjście kontroli — widoczne w logu przebiegu (evidence).
    // eslint-disable-next-line no-console
    console.log(r.rows.map((x) => x.line).join("\n"))
  })
})
