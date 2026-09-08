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
  canonical: string[]
}

function readContract(): string {
  return readFileSync(CONTRACT_PATH, "utf8")
}

function readVocabularyStates(yaml = readFileSync(VOCABULARY_PATH, "utf8")): MappingRow[] {
  const rows: MappingRow[] = []
  const lines = yaml.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index].match(/^\s*- id:\s*([a-z_]+)\s*$/)?.[1]
    if (!id) continue
    const followingLines = lines.slice(index + 1)
    const nextEntryIndex = followingLines.findIndex((line) => /^\s*- id:\s*/.test(line))
    const stateBlock =
      nextEntryIndex === -1 ? followingLines : followingLines.slice(0, nextEntryIndex)
    const nextState = stateBlock.find((line) => line.includes("maps_to_entitlement_states:"))
    const canonical = nextState?.match(/\[([^\]]+)\]/)?.[1]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    if (canonical?.length) rows.push({ legacy: id, canonical })
  }
  expect(rows).not.toHaveLength(0)
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
    for (const canonical of state.canonical) {
      expect(
        mappingRows.some(
          (row) => row[0] === "kod vouchera" && row[1].includes(`\`${state.legacy}\` → \`${canonical}\``)
        )
      ).toBe(true)
    }
  }

  const producerRows = markdownTableRows(producers)
  for (const [producer, consumer] of [
    ["natywny Stripe hook Medusy", "stripe-payment-audit.ts"],
    ["GP Path Y", "voucher-live-issue"],
    ["entitlement-transition-wiring", "odbiorcy audytu/projekcji"],
    ["voucher-purchase-delivery", "ścieżka realizacji"],
  ]) {
    expect(
      producerRows.some((row) => row[1]?.includes(producer) && row[2]?.includes(consumer))
    ).toBe(true)
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
    ["zmiana drugiej wartości idle", (document: string) => document.replace("`idle` → `ACTIVE`", "`idle` → `VOIDED`")],
    [
      "zmiana konsumenta",
      (document: string) =>
        document.replace(
          "GP Path Y `/webhooks/stripe/payment-intent` | `voucher-live-issue` → `live-issue-from-payment-intent.ts`",
          "GP Path Y `/webhooks/stripe/payment-intent` | `wrong-consumer` → `live-issue-from-payment-intent.ts`"
        ),
    ],
    [
      "zamiana pełnych par producent–konsument",
      (document: string) =>
        document
          .replace(
            "| `payment.captured` | natywny Stripe hook Medusy `/hooks/payment/stripe` | `stripe-payment-audit` → `workflows/payment/stripe-payment-audit.ts` → `issue-entitlement.ts` | persisted `ACTIVE` |",
            "| `payment.captured` | natywny Stripe hook Medusy `/hooks/payment/stripe` | `voucher-live-issue` → `live-issue-from-payment-intent.ts` | persisted `ACTIVE` |"
          )
          .replace(
            "| `gp.stripe.payment_intent_succeeded.v1` | GP Path Y `/webhooks/stripe/payment-intent` | `voucher-live-issue` → `live-issue-from-payment-intent.ts` | persisted `ISSUED` |",
            "| `gp.stripe.payment_intent_succeeded.v1` | GP Path Y `/webhooks/stripe/payment-intent` | `stripe-payment-audit` → `workflows/payment/stripe-payment-audit.ts` → `issue-entitlement.ts` | persisted `ISSUED` |"
          ),
    ],
    ["zlanie osi triggera i skutku", (document: string) => document.replace("Dowód skutku aktywacji", "Dowód aktywacji")],
    ["przedwczesny wybór triggera", (document: string) => document.replace("pozostaje wyłącznie kandydatem triggera", "jest wybranym triggerem")],
  ])("odrzuca mutację: %s", (_name, mutate) => {
    expect(() => assertContractShape(mutate(readContract()))).toThrow()
  })

  it("nie pobiera mapowania z następnego bloku słownika", () => {
    expect(
      readVocabularyStates(`
  - id: idle
  - id: refunded
    maps_to_entitlement_states: [REFUNDED]
`)
    ).toEqual([{ legacy: "refunded", canonical: ["REFUNDED"] }])
  })
})
