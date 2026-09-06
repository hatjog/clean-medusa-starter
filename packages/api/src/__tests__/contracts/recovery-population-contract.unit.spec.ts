/**
 * recovery-population-contract.unit.spec.ts — v1.16.0 Story 4.1 AC1 (AD-32, ADR-218, ADR-221).
 *
 * Test kontraktu wiersza wymagającego człowieka PO STRONIE KONSUMENTA (backend):
 *
 *  (a) przykłady z `specs/contracts/recovery/examples/recovery-populations.v1.example.json`
 *      przechodzą schemę `recovery-population.v1.schema.json` interpretowaną w TS;
 *  (b) MUTANTY muszą dać FAIL: wiersz bez instance_id, z instance_id=`unknown`,
 *      terminalny bez evidence, nieterminalny z evidence, zamknięty samą zmianą
 *      stanu (closure_path=not_closed przy stanie terminalnym), stan legacy z runtime,
 *      nieznana populacja, DLQ z klasą retryable przy tierze ops_review;
 *  (c) PARYTET dwóch nośników tabeli przejść: `RECOVERY_TRANSITIONS` w
 *      `lib/recovery/recovery-action-contract.ts` == `$defs.transitions` w schemie,
 *      wartość po wartości (stała-lustro z bramką porównania);
 *  (d) słowniki stanów trzech populacji są rozłączne także po stronie TS.
 *
 * Schema jest czytana z super-repo (`REPO_ROOT/specs/contracts/...`). Brak pliku to
 * FAIL, nie skip — test uruchamiany jest z checkoutu GP, w którym specs/ istnieje;
 * skip zamieniłby brak kontraktu w zieleń.
 */
import fs from "node:fs"
import path from "node:path"

import { RECOVERY_POPULATION_TYPES, RECOVERY_TRANSITIONS } from "../../lib/recovery/recovery-action-contract"
import { LiteValidator, type JsonSchema } from "./json-schema-lite"

// packages/api/src/__tests__/contracts -> GP/backend -> GP -> <repo root>
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const CONTRACT_DIR = path.join(REPO_ROOT, "specs/contracts/recovery")
const POPULATION_SCHEMA = "recovery-population.v1.schema.json"
const AUDIT_SCHEMA = "recovery-action-audit.v1.schema.json"

function readJson<T = unknown>(rel: string): T {
  const file = path.join(CONTRACT_DIR, rel)
  if (!fs.existsSync(file)) {
    throw new Error(`Brak kontraktu ${file} — test kontraktu bez kontraktu nie ma prawa być zielony`)
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T
}

type Row = Record<string, unknown> & {
  population_type: string
  state: string
  payload: Record<string, unknown>
  resolution_evidence: unknown
  provenance: { kind: string; source: string }
}

const schema = readJson<JsonSchema>(`schemas/${POPULATION_SCHEMA}`)
const auditSchema = readJson<JsonSchema>(`schemas/${AUDIT_SCHEMA}`)
const examples = readJson<Row[]>("examples/recovery-populations.v1.example.json")
const validator = new LiteValidator({ [POPULATION_SCHEMA]: schema, [AUDIT_SCHEMA]: auditSchema })

// Zamrożony oracle v1: nie odczytujemy polityki z żywej schemy. Mutacja schemy
// oraz examples w tym samym commicie nadal musi uszkodzić ten test.
const FROZEN_V1_STATES = {
  compensation_failure: ["open", "recovery_in_progress", "resolved_recovered", "closed_unrecoverable", "closed_legacy_unevidenced"],
  deferred_issuance_trace: ["awaiting_order", "escalated", "issued_after_link", "closed_order_never_created"],
  dlq_entry: ["dlq_pending_retry", "dlq_pending_ops_review", "replayed", "discarded_with_evidence"],
} as const

const FROZEN_V1_TRANSITIONS = {
  compensation_failure: {
    open: ["recovery_in_progress", "resolved_recovered", "closed_unrecoverable"],
    recovery_in_progress: ["open", "resolved_recovered", "closed_unrecoverable"],
    resolved_recovered: [],
    closed_unrecoverable: [],
    closed_legacy_unevidenced: [],
  },
  deferred_issuance_trace: {
    awaiting_order: ["escalated", "issued_after_link", "closed_order_never_created"],
    escalated: ["issued_after_link", "closed_order_never_created"],
    issued_after_link: [],
    closed_order_never_created: [],
  },
  dlq_entry: {
    dlq_pending_retry: ["replayed", "dlq_pending_ops_review", "discarded_with_evidence"],
    dlq_pending_ops_review: ["replayed", "discarded_with_evidence"],
    replayed: [],
    discarded_with_evidence: [],
  },
} as const

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const findRow = (pred: (r: Row) => boolean): Row => {
  const row = examples.find(pred)
  if (!row) throw new Error("brak wiersza przykładowego spełniającego predykat")
  return clone(row)
}
const errorsOf = (row: unknown) => validator.validate(POPULATION_SCHEMA, row)

describe("recovery-population.v1 — przykłady kontraktu przechodzą po stronie konsumenta", () => {
  it("każdy wiersz przykładu jest zgodny ze schemą", () => {
    expect(examples.length).toBeGreaterThan(0)
    for (const row of examples) {
      expect({ id: row.population_id, errors: errorsOf(row) }).toEqual({ id: row.population_id, errors: [] })
    }
  })

  it("przykłady pokrywają trzy populacje, każda z wierszem nieterminalnym i terminalnym", () => {
    const transitions = (schema.$defs as Record<string, JsonSchema>).transitions as Record<string, { terminal: string[] }>
    for (const pop of RECOVERY_POPULATION_TYPES) {
      const rows = examples.filter((r) => r.population_type === pop)
      const terminal = new Set(transitions[pop].terminal)
      expect(rows.some((r) => terminal.has(r.state))).toBe(true)
      expect(rows.some((r) => !terminal.has(r.state))).toBe(true)
    }
  })
})

describe("recovery-population.v1 — mutanty muszą dać FAIL", () => {
  it("wiersz bez instance_id", () => {
    const row = findRow((r) => r.state === "open")
    delete (row as Record<string, unknown>).instance_id
    expect(errorsOf(row).join("\n")).toMatch(/instance_id/)
  })

  it("wiersz z instance_id=unknown (wartość zastępcza udająca scope)", () => {
    const row = findRow((r) => r.state === "open")
    row.instance_id = "unknown"
    expect(errorsOf(row).join("\n")).toMatch(/instance_id/)
  })

  it.each(["UNKNOWN", "Default", " UNASSIGNED "])("scope placeholder `%s` niezależnie od wielkości liter lub spacji", (value) => {
    const row = findRow((r) => r.state === "open")
    row.instance_id = value
    expect(errorsOf(row).join("\n")).toMatch(/instance_id/)
  })

  it("wiersz z market_id pustym", () => {
    const row = findRow((r) => r.state === "open")
    row.market_id = ""
    expect(errorsOf(row).join("\n")).toMatch(/market_id/)
  })

  it("stan terminalny bez resolution_evidence", () => {
    const row = findRow((r) => r.state === "resolved_recovered")
    row.resolution_evidence = null
    expect(errorsOf(row).join("\n")).toMatch(/resolution_evidence/)
  })

  it("stan nieterminalny z resolution_evidence (evidence null nie jest bezwarunkowe, ale i nie dowolne)", () => {
    const donor = findRow((r) => r.state === "resolved_recovered")
    const row = findRow((r) => r.state === "open")
    row.resolution_evidence = donor.resolution_evidence
    expect(errorsOf(row).join("\n")).toMatch(/resolution_evidence/)
  })

  it.each(["deferred_issuance_trace", "dlq_entry"] as const)("%s nie przyjmuje legacy_manual_resolution", (population) => {
    const row = findRow((r) => r.population_type === population && r.resolution_evidence !== null)
    ;(row.resolution_evidence as { kind: string }).kind = "legacy_manual_resolution"
    expect(errorsOf(row).join("\n")).toMatch(/resolution_evidence/)
  })

  it("zamknięcie samą zmianą stanu: terminalny + closure_path=not_closed", () => {
    const row = findRow((r) => r.state === "replayed")
    row.closure_path = "not_closed"
    expect(errorsOf(row).join("\n")).toMatch(/closure_path/)
  })

  it("stan legacy (closed_legacy_unevidenced) z proweniencją runtime", () => {
    const row = findRow((r) => r.state === "closed_legacy_unevidenced")
    row.provenance = { kind: "runtime_observed", source: "money-path-compensation-registry" }
    expect(errorsOf(row).join("\n")).toMatch(/provenance/)
  })

  it("proweniencja `assumed` nie istnieje w słowniku", () => {
    const row = findRow((r) => r.state === "open")
    row.provenance = { kind: "assumed", source: "guess" }
    expect(errorsOf(row).join("\n")).toMatch(/provenance\.kind/)
  })

  it("nieznana populacja", () => {
    const row = findRow((r) => r.state === "open")
    row.population_type = "other"
    expect(errorsOf(row).length).toBeGreaterThan(0)
  })

  it("stan z obcej populacji w gałęzi dlq_entry", () => {
    const row = findRow((r) => r.state === "dlq_pending_retry")
    row.state = "open"
    expect(errorsOf(row).length).toBeGreaterThan(0)
  })

  it("DLQ: klasa retryable przy tierze dlq_pending_ops_review (klasyfikacja nierozłączna)", () => {
    const row = findRow((r) => r.state === "dlq_pending_ops_review")
    row.payload.classification = "retryable"
    expect(errorsOf(row).join("\n")).toMatch(/classification|tier|is_retryable/)
  })

  it("ślad płatności: sufiks markera jako tożsamość zdarzenia", () => {
    const row = findRow((r) => r.population_type === "deferred_issuance_trace")
    row.payload.stripe_event_id = `${String(row.payload.stripe_event_id)}#deferred-issuance`
    expect(errorsOf(row).join("\n")).toMatch(/stripe_event_id/)
  })

  it("owner `unassigned` nie istnieje (właściciel należy do wiersza)", () => {
    const row = findRow((r) => r.state === "open")
    row.owner = { owner_type: "unassigned", owner_id: "" }
    expect(errorsOf(row).join("\n")).toMatch(/owner/)
  })

  it.each(["default", "UNASSIGNED", " unknown "])("owner placeholder `%s` jest odrzucany", (value) => {
    const row = findRow((r) => r.state === "open")
    ;(row.owner as { owner_id: string }).owner_id = value
    expect(errorsOf(row).join("\n")).toMatch(/owner_id/)
  })

  it("brak wersji rekordu (kontrola współbieżności martwa)", () => {
    const row = findRow((r) => r.state === "open")
    delete (row as Record<string, unknown>).version
    expect(errorsOf(row).join("\n")).toMatch(/version/)
  })

  it("pole spoza kontraktu jest odrzucane (additionalProperties: false)", () => {
    const row = findRow((r) => r.state === "open")
    ;(row as Record<string, unknown>).legacy_flag = true
    expect(errorsOf(row).join("\n")).toMatch(/legacy_flag/)
  })
})

describe("parytet dwóch nośników tabeli przejść (kernel TS vs $defs.transitions)", () => {
  const transitions = (schema.$defs as Record<string, JsonSchema>).transitions as Record<
    string,
    { terminal: string[]; allowed: Record<string, string[]> }
  >

  it("zbiór populacji jest identyczny", () => {
    const fromSchema = Object.keys(transitions).filter((k) => k !== "description").sort()
    expect(fromSchema).toEqual([...RECOVERY_POPULATION_TYPES].sort())
  })

  it("żywa schema i kernel odpowiadają zamrożonemu kontraktowi v1, nie sobie nawzajem", () => {
    for (const pop of RECOVERY_POPULATION_TYPES) {
      const expected = [...FROZEN_V1_STATES[pop]].sort()
      expect(Object.keys(RECOVERY_TRANSITIONS[pop].allowed).sort()).toEqual(expected)
      const branch = (schema.oneOf as JsonSchema[]).find(
        (b) => ((b.properties as Record<string, JsonSchema>).population_type as { const: string }).const === pop
      )
      const live = ((branch!.properties as Record<string, JsonSchema>).state as { enum: string[] }).enum
      expect([...live].sort()).toEqual(expected)
    }
  })

  it("każda krawędź przejścia odpowiada zamrożonej polityce v1, nie tylko żywemu drugiemu nośnikowi", () => {
    for (const pop of RECOVERY_POPULATION_TYPES) {
      expect(RECOVERY_TRANSITIONS[pop].allowed).toEqual(FROZEN_V1_TRANSITIONS[pop])
      expect(transitions[pop].allowed).toEqual(FROZEN_V1_TRANSITIONS[pop])
    }
  })

  it.each([...RECOVERY_POPULATION_TYPES])("%s: terminal i allowed są identyczne wartość po wartości", (pop) => {
    const kernel = RECOVERY_TRANSITIONS[pop]
    expect([...kernel.terminal].sort()).toEqual([...transitions[pop].terminal].sort())
    const normalize = (m: Record<string, readonly string[]>) =>
      Object.fromEntries(
        Object.entries(m)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, [...v].sort()])
      )
    expect(normalize(kernel.allowed)).toEqual(normalize(transitions[pop].allowed))
  })

  it.each([...RECOVERY_POPULATION_TYPES])("%s: słownik stanów gałęzi oneOf == klucze allowed", (pop) => {
    const branch = (schema.oneOf as JsonSchema[]).find(
      (b) => ((b.properties as Record<string, JsonSchema>).population_type as { const: string }).const === pop
    )
    expect(branch).toBeDefined()
    const enumStates = ((branch!.properties as Record<string, JsonSchema>).state as { enum: string[] }).enum
    expect([...enumStates].sort()).toEqual(Object.keys(RECOVERY_TRANSITIONS[pop].allowed).sort())
  })

  it("słowniki stanów trzech populacji są parami rozłączne", () => {
    const pops = [...RECOVERY_POPULATION_TYPES]
    for (let i = 0; i < pops.length; i++) {
      for (let j = i + 1; j < pops.length; j++) {
        const a = new Set(Object.keys(RECOVERY_TRANSITIONS[pops[i]].allowed))
        const shared = Object.keys(RECOVERY_TRANSITIONS[pops[j]].allowed).filter((s) => a.has(s))
        expect({ pair: [pops[i], pops[j]], shared }).toEqual({ pair: [pops[i], pops[j]], shared: [] })
      }
    }
  })

  it("stany terminalne nie mają przejść wyjściowych", () => {
    for (const pop of RECOVERY_POPULATION_TYPES) {
      for (const t of RECOVERY_TRANSITIONS[pop].terminal) {
        expect({ pop, t, out: RECOVERY_TRANSITIONS[pop].allowed[t] }).toEqual({ pop, t, out: [] })
      }
    }
  })
})

describe("test-the-test: interpreter nie przepuszcza słowa kluczowego, którego nie zna", () => {
  it("nieznane słowo walidujące w schemie rzuca zamiast dawać cichy PASS", () => {
    const mutated = clone(schema)
    ;(mutated.properties as Record<string, JsonSchema>).instance_id = { type: "string", maxLength: 3 }
    const v = new LiteValidator({ [POPULATION_SCHEMA]: mutated, [AUDIT_SCHEMA]: auditSchema })
    expect(() => v.validate(POPULATION_SCHEMA, examples[0])).toThrow(/maxLength/)
  })
})
