import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@jest/globals"

const CONTRACT_PATH = resolve(
  process.cwd(),
  "../../_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/3-6/canonical-state-projection-contract.md"
)

function readContract(): string {
  return readFileSync(CONTRACT_PATH, "utf8")
}

function sectionBetween(document: string, start: string, end: string): string {
  const startIndex = document.indexOf(start)
  const endIndex = document.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) return ""
  return document.slice(startIndex, endIndex)
}

function assertContractShape(document: string): void {
  const normalized = document.toLocaleLowerCase("pl-PL")
  const requiredHeadings = [
    "## Zakres i non-goals",
    "## Mapowanie legacy",
    "## Kandydat warstwy kanonicznej i projekcja",
    "## Idempotencja, replay i rozbieżność",
    "## Producenci i konsumenci",
    "## Kompatybilność",
    "## Kandydaci triggera",
    "## Dwie osie evidence",
  ]
  const requiredTerms = [
    "ADR-219",
    "proposed",
    "entitlement_instance.state",
    "voucher_status",
    "event_key",
    "owed_business_unit_key",
    "voucher-live-issue",
    "stripe-payment-audit",
    "entitlement-transition-wiring",
    "voucher-purchase-delivery",
    "ścieżka realizacji",
    "gp.stripe.payment_intent_succeeded.v1",
    "gp.entitlements.entitlement_state_changed.v1",
    "gp.communication.delivery_state_changed.v1",
    "gp.webhooks.delivery_completed.v1",
    "delivered",
    "candidate",
    "triggera",
    "dowód triggera",
    "skutku aktywacji",
    "provider accepted",
  ]

  for (const heading of requiredHeadings) expect(document).toContain(heading)
  for (const term of requiredTerms) expect(normalized).toContain(term.toLocaleLowerCase("pl-PL"))

  expect(document).toMatch(/Status dokumentu:\s*\*\*?draft/i)
  expect(document).toMatch(/ADR-219[^\n]*proposed/i)
  expect(document).toMatch(/nie ratyfikuje|nie wybiera|nie jest ratyfikowan/i)
  expect(document).toMatch(/kandydat[^\n]*entitlement_instance\.state/i)
  expect(document).toMatch(/projekcj[^\n]*voucher_status/i)
  expect(document).toMatch(/event_key[\s\S]*owed_business_unit_key|owed_business_unit_key[\s\S]*event_key/i)
  expect(document).toContain("pozostaje wyłącznie kandydatem triggera")
  expect(document).not.toMatch(/wybrany trigger|selected trigger|trigger wybrany/i)

  const mapping = sectionBetween(document, "## Mapowanie legacy", "## Kandydat warstwy")
  const candidate = sectionBetween(document, "## Kandydat warstwy", "## Idempotencja")
  const trigger = sectionBetween(document, "## Kandydaci triggera", "## Dwie osie evidence")
  const axes = document.slice(document.indexOf("## Dwie osie evidence"))
  expect(mapping).toContain("entitlement_instance.state")
  expect(mapping).toContain("voucher_status")
  expect(candidate).toContain("candidate")
  expect(candidate).toContain("entitlement_instance.state")
  expect(candidate).toContain("voucher_status")
  expect(trigger).toContain("pozostaje wyłącznie kandydatem triggera")
  expect(axes).toContain("Dowód triggera")
  expect(axes).toContain("Dowód skutku aktywacji")
}

describe("Story 3.6 AC2 — draft kanonicznej projekcji", () => {
  it("zawiera pełny kształt kontraktu bez ratyfikacji ADR-219", () => {
    assertContractShape(readContract())
  })

  it("odrzuca mutant bez mapowania legacy", () => {
    const mutant = readContract().replaceAll("entitlement_instance.state", "removed_legacy_state")
    expect(() => assertContractShape(mutant)).toThrow()
  })

  it("odrzuca mutant zlania osi triggera i skutku", () => {
    const mutant = readContract()
      .replaceAll("Dowód triggera", "Dowód aktywacji")
      .replaceAll("skutku aktywacji", "aktywacji")
    expect(() => assertContractShape(mutant)).toThrow()
  })

  it("odrzuca mutant przedwcześnie wybierający trigger", () => {
    const mutant = readContract().replace("pozostaje wyłącznie kandydatem triggera", "jest wybranym triggerem")
    expect(() => assertContractShape(mutant)).toThrow()
  })
})
