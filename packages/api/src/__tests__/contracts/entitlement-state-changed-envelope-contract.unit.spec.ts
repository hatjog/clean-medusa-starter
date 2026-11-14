/**
 * entitlement-state-changed-envelope-contract.unit.spec.ts — v1.16.0 Story 11.2 AC1
 * (ADR-240, DW-15-183).
 *
 * Przykłady `gp.entitlements.entitlement_state_changed.v1` (bieżący i koperta
 * zastana) przechodzą schemę envelope.v1 + schemę payloadu, a ich semantyka
 * tożsamości jest zgodna z regułą konsumenta:
 *   - przykład bieżący: `scope.instance_id` = instancja runtime ≠ entitlement id,
 *   - przykład zastany: `scope.instance_id` = `payload.entitlement_id`
 *     (kompatybilność historyczna, `legacy_entitlement_scoped`).
 * Brak pliku kontraktu to FAIL, nie skip.
 */
import fs from "node:fs"
import path from "node:path"

import {
  classifyEnvelopeInstance,
  LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT,
} from "../../lib/runtime-instance-identity"
import { LiteValidator, type JsonSchema } from "./json-schema-lite"

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const EVENTS = path.join(REPO_ROOT, "specs/contracts/events")

function readJson<T = unknown>(rel: string): T {
  const file = path.join(EVENTS, rel)
  if (!fs.existsSync(file)) {
    throw new Error(`Brak kontraktu ${file} — test kontraktu bez kontraktu nie ma prawa być zielony`)
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T
}

type Envelope = {
  occurred_at: string
  event_type: string
  scope: { instance_id: string; market_id: string }
  payload: { entitlement_id: string }
}

const ENVELOPE = "envelope.v1.schema.json"
const PAYLOAD = "gp.entitlements.entitlement_state_changed.v1.schema.json"
const validator = new LiteValidator({
  [ENVELOPE]: readJson<JsonSchema>(`schemas/${ENVELOPE}`),
  [PAYLOAD]: readJson<JsonSchema>(`schemas/payloads/${PAYLOAD}`),
})
const current = readJson<Envelope>(
  "examples/gp.entitlements.entitlement_state_changed.v1.example.json"
)
const legacy = readJson<Envelope>(
  "examples/gp.entitlements.entitlement_state_changed.v1.legacy-entitlement-scoped.example.json"
)

describe("Story 11.2 — kontrakt koperty entitlement_state_changed (ADR-240)", () => {
  it.each([
    ["bieżący", current],
    ["zastany", legacy],
  ])("przykład %s przechodzi envelope.v1 i schemę payloadu", (_name, example) => {
    expect(validator.validate(ENVELOPE, example)).toEqual([])
    expect(validator.validate(PAYLOAD, example.payload)).toEqual([])
    expect(example.event_type).toBe("gp.entitlements.entitlement_state_changed.v1")
  })

  it("przykład bieżący: instance_id to instancja runtime, entitlement id we własnym polu", () => {
    expect(current.scope.instance_id).not.toBe(current.payload.entitlement_id)
    expect(
      classifyEnvelopeInstance({
        envelope_instance_id: current.scope.instance_id,
        entitlement_id: current.payload.entitlement_id,
        runtime_instance_id: current.scope.instance_id,
      })
    ).toBe("match")
  })

  it("przykład zastany jest rozpoznany wg zasady kompatybilności historycznej", () => {
    expect(legacy.scope.instance_id).toBe(legacy.payload.entitlement_id)
    expect(
      classifyEnvelopeInstance({
        envelope_instance_id: legacy.scope.instance_id,
        entitlement_id: legacy.payload.entitlement_id,
        runtime_instance_id: current.scope.instance_id,
        occurred_at: legacy.occurred_at,
      })
    ).toBe("legacy_entitlement_scoped")
  })

  it("okno kompatybilności ma nazwany koniec zapisany w kontrakcie (review R-3/R-4)", () => {
    const schema = readJson<{
      properties: { scope: { properties: { instance_id: { description?: string } } } }
    }>(`schemas/${ENVELOPE}`)
    const description = schema.properties.scope.properties.instance_id.description ?? ""
    expect(description).toContain(LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT)
    // Ta sama koperta zastana, ale z occurred_at w punkcie odcięcia = odmowa.
    expect(
      classifyEnvelopeInstance({
        envelope_instance_id: legacy.scope.instance_id,
        entitlement_id: legacy.payload.entitlement_id,
        runtime_instance_id: current.scope.instance_id,
        occurred_at: LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT,
      })
    ).toBe("mismatch")
  })

  it("schema opisuje lifecycle i kompatybilność historyczną scope.instance_id", () => {
    const schema = readJson<{
      properties: { scope: { properties: { instance_id: { description?: string } } } }
    }>(`schemas/${ENVELOPE}`)
    const description = schema.properties.scope.properties.instance_id.description ?? ""
    expect(description).toContain("GP_INSTANCE_ID")
    expect(description).toContain("ADR-240")
    expect(description).toMatch(/Lifecycle/)
    expect(description).toMatch(/Kompatybilność historyczna/)
  })

  it("kontrola ujemna: koperta bez scope.instance_id nie przechodzi envelope.v1", () => {
    const broken = { ...current, scope: { market_id: current.scope.market_id } }
    expect(validator.validate(ENVELOPE, broken)).not.toEqual([])
  })
})
