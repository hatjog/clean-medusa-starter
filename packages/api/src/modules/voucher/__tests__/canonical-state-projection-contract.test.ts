import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@jest/globals"

const CONTRACT_PATH = resolve(
  process.cwd(),
  "../../_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/3-6/canonical-state-projection-contract.md"
)
const VOCABULARY_PATH = resolve(
  process.cwd(),
  "../../specs/contracts/redemption/voucher-state-vocabulary.v3.yaml"
)

type MappingRow = {
  legacy: string
  canonical: string
}

function readContract(): string {
  return readFileSync(CONTRACT_PATH, "utf8")
}

function readVocabularyStates(): MappingRow[] {
  const yaml = readFileSync(VOCABULARY_PATH, "utf8")
  const rows: MappingRow[] = []
  const lines = yaml.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index].match(/^\s{6}- id:\s*([a-z_]+)\s*$/)?.[1]
    if (!id) continue
    const nextState = lines.slice(index + 1, index + 8).find((line) => line.includes("maps_to_entitlement_states:"))
    const canonical = nextState?.match(/\[([^\]]+)/)?.[1]?.split(",")[0]?.trim()
    if (canonical) rows.push({ legacy: id, canonical })
  }
  return rows
}

function sectionBetween(document: string, start: string, end: string): string {
  const startIndex = document.indexOf(start)
  const endIndex = document.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) return ""
  return document.slice(startIndex, endIndex)
}

function markdownTableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\s*\|[-| :]+\|\s*$/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
}

function assertContractShape(document: string): void {
  const normalized = document.toLocaleLowerCase("pl-PL")
  const mapping = sectionBetween(document, "## Mapowanie legacy", "## Kandydat warstwy")
  const candidate = sectionBetween(document, "## Kandydat warstwy", "## Idempotencja")
  const producers = sectionBetween(document, "## Producenci i konsumenci", "## Kompatybilność")
  const trigger = sectionBetween(document, "## Kandydaci triggera", "## Dwie osie evidence")
  const axes = document.slice(document.indexOf("## Dwie osie evidence"))
  const mappingRows = markdownTableRows(mapping)

  for (const heading of [
    "## Zakres i non-goals",
    "## Mapowanie legacy",
    "## Kandydat warstwy kanonicznej i projekcja",
    "## Idempotencja, replay i rozbieżność",
    "## Producenci i konsumenci",
    "## Kompatybilność",
    "## Kandydaci triggera",
    "## Dwie osie evidence",
  ]) expect(document).toContain(heading)

  expect(document).toMatch(/Status dokumentu:\s*\*\*?draft/i)
  expect(document).toMatch(/ADR-219[^\n]*proposed/i)
  expect(document).toMatch(/nie ratyfikuje|nie wybiera|nie jest ratyfikowan/i)
  expect(candidate).toMatch(/kandydat[^\n]*entitlement_instance\.state/i)
  expect(candidate).toMatch(/projekcj[\s\S]*voucher_status/i)
  expect(document).toMatch(/event_key[\s\S]*owed_business_unit_key|owed_business_unit_key[\s\S]*event_key/i)
  expect(document).toMatch(/unknown[^\n]*(FAIL|recovery)|FAIL[^\n]*recovery/i)
  expect(trigger).toContain("pozostaje wyłącznie kandydatem triggera")
  expect(document).not.toMatch(/wybrany trigger|selected trigger|trigger wybrany/i)

  expect(mappingRows.some((row) => row[0] === "uprawnienie" && row[1].includes("entitlement_instance.state"))).toBe(true)
  expect(mappingRows.some((row) => row[0] === "kod vouchera" && row[1].includes("voucher_status"))).toBe(true)
  for (const state of readVocabularyStates()) {
    expect(mappingRows.some((row) => row[0] === "kod vouchera" && row[1].includes(state.legacy) && row[1].includes(state.canonical))).toBe(true)
  }

  for (const [producer, consumer] of [
    ["voucher-live-issue", "live-issue-from-payment-intent.ts"],
    ["stripe-payment-audit", "stripe-payment-audit.ts"],
    ["entitlement-transition-wiring", "envelope stanu po commit"],
    ["voucher-purchase-delivery", "ścieżka realizacji"],
  ]) {
    expect(producers).toContain(producer)
    expect(producers).toContain(consumer)
  }
  expect(axes).toContain("Dowód triggera")
  expect(axes).toContain("Dowód skutku aktywacji")
  expect(axes).toMatch(/osobne identyfikatory.*znaczniki czasu.*werdykty/i)
  expect(normalized).toContain("gp.communication.delivery_state_changed.v1")
  expect(normalized).toContain("gp.webhooks.delivery_completed.v1")
}

describe("Story 3.6 AC2 — strukturalny draft kanonicznej projekcji", () => {
  it("wiąże pełny słownik SSOT z mapowaniem i rozdziela producentów, osie oraz trigger", () => {
    assertContractShape(readContract())
  })

  it.each([
    ["brak mapowania legacy", (document: string) => document.replace("| kod vouchera |", "| usunięty wiersz |")],
    ["zmiana wartości refunded", (document: string) => document.replace("`refunded` → `REFUNDED`", "`refunded` → `ISSUED`")],
    ["zmiana konsumenta", (document: string) => document.replace("voucher-live-issue` → `live-issue-from-payment-intent.ts", "voucher-live-issue` → `wrong-consumer.ts")],
    ["zlanie osi triggera i skutku", (document: string) => document.replace("Dowód skutku aktywacji", "Dowód aktywacji")],
    ["przedwczesny wybór triggera", (document: string) => document.replace("pozostaje wyłącznie kandydatem triggera", "jest wybranym triggerem")],
  ])("odrzuca mutację: %s", (_name, mutate) => {
    expect(() => assertContractShape(mutate(readContract()))).toThrow()
  })
})
