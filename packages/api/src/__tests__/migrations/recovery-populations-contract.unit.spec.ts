/**
 * recovery-populations-contract.unit.spec.ts — v1.16.0 Story 4.1 AC3 (AD-44; ADR-221 §5).
 *
 * Plan migracji trzech nośników jako dane (`lib/recovery/recovery-migration-plan.ts`):
 *  - trzy nośniki = trzy RÓŻNE tabele, po jednej na populację (rozłączność);
 *  - każdy krok `up` ma odwrotny krok `down` i odwrotnie (symetria planu);
 *  - `NOT NULL` dla nowych danych obejmuje scope, stan, właściciela, termin, wersję;
 *  - jedyne wartości domyślne to liczniki (retry_count, version) z zapisaną racją —
 *    żadna kolumna scope'u/stanu/właściciela nie ma default;
 *  - backfill nie zna wartości zastępczej: wiersz bez odwzorowania rynku → kwarantanna;
 *    fałszywy backfill (`instance_id: "default"`) jest odrzucony;
 *  - backfill DLQ jest jawnie pusty;
 *  - baza planu zgadza się z REALNĄ migracją 20260818090000 (RecordingMigration):
 *    tabela, `market_id NOT NULL`, słownik CHECK-a (`open`, `resolved_manually`);
 *  - nazwy trzech tabel są wymienione w ADR-221 (linkowalność planu z decyzją).
 */
import fs from "node:fs"
import path from "node:path"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import { RECOVERY_POPULATION_TYPES } from "../../lib/recovery/recovery-action-contract"
import { LiteValidator, type JsonSchema } from "../contracts/json-schema-lite"
import {
  classifyHistoricalCompensationRow,
  COMPENSATION_FAILURE_TABLE,
  COMPENSATION_BACKFILL_PROVENANCE_SOURCE,
  DEFERRED_ISSUANCE_TRACE_TABLE,
  DLQ_ENTRY_TABLE,
  INSTANCE_ID_BACKFILL_SOURCE,
  isTrustworthyOwner,
  isTrustworthyScopeValue,
  LEGACY_COMPENSATION_STATES,
  RECOVERY_MIGRATION_PLAN,
  materializeCompensationBackfill,
  type CarrierPlan,
  type VerifiedHistoricalCompensationMetadata,
} from "../../lib/recovery/recovery-migration-plan"

class RecordingMigration extends Migration20260818090000MoneyPathCompensationFailureTable {
  readonly recorded: string[] = []
  addSql(sql: string): void {
    this.recorded.push(sql)
  }
}

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const ADR_PATH = path.join(REPO_ROOT, "specs/adr/2026-09-06-adr-221-kontrakt-trzech-populacji-recovery-i-migracji.md")
const POPULATION_SCHEMA = "recovery-population.v1.schema.json"
const populationSchema = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "specs/contracts/recovery/schemas", POPULATION_SCHEMA), "utf8")
) as JsonSchema
const populationValidator = new LiteValidator({ [POPULATION_SCHEMA]: populationSchema })

const planFor = (pop: CarrierPlan["population_type"]): CarrierPlan => {
  const plan = RECOVERY_MIGRATION_PLAN.find((p) => p.population_type === pop)
  if (!plan) throw new Error(`brak planu dla ${pop}`)
  return plan
}

describe("trzy nośniki, trzy populacje — rozłączność", () => {
  it("plan ma dokładnie jeden nośnik na populację i trzy różne tabele", () => {
    expect(RECOVERY_MIGRATION_PLAN.map((p) => p.population_type).sort()).toEqual([...RECOVERY_POPULATION_TYPES].sort())
    const tables = RECOVERY_MIGRATION_PLAN.map((p) => p.table)
    expect(new Set(tables).size).toBe(3)
    expect(tables.sort()).toEqual([COMPENSATION_FAILURE_TABLE, DEFERRED_ISSUANCE_TRACE_TABLE, DLQ_ENTRY_TABLE].sort())
  })

  it("tabele kwarantanny są per nośnik i różne od siebie", () => {
    const quarantines = RECOVERY_MIGRATION_PLAN.flatMap((p) => (p.backfill.kind === "from_verified_source" ? [p.backfill.quarantine_table] : []))
    expect(quarantines.length).toBe(2)
    expect(new Set(quarantines).size).toBe(2)
    for (const q of quarantines) {
      expect(RECOVERY_MIGRATION_PLAN.some((p) => q.startsWith(p.table))).toBe(true)
    }
  })

  it("żaden krok up jednego nośnika nie dotyka tabeli innego nośnika", () => {
    for (const plan of RECOVERY_MIGRATION_PLAN) {
      const others = RECOVERY_MIGRATION_PLAN.filter((p) => p !== plan).map((p) => p.table)
      for (const step of plan.up) {
        for (const other of others) {
          // wyjątek nazwany: źródło backfillu (webhook_event_processed) nie jest nośnikiem populacji
          expect({ step: step.id, mentions: other, hit: new RegExp(`\\b${other}\\b`).test(step.sql_shape) }).toEqual({ step: step.id, mentions: other, hit: false })
        }
      }
    }
  })
})

describe("symetria up/down", () => {
  it.each(RECOVERY_MIGRATION_PLAN.map((p) => [p.population_type, p] as const))("%s: każdy up ma down i każdy down odwraca istniejący up", (_pop, plan) => {
    const upIds = plan.up.map((s) => s.id)
    const reversed = plan.down.map((s) => s.reverses)
    expect([...reversed].sort()).toEqual([...upIds].sort())
    expect(new Set(plan.down.map((s) => s.id)).size).toBe(plan.down.length)
    // down w odwrotnej kolejności do up
    expect(reversed).toEqual([...upIds].reverse())
  })
})

describe("NOT NULL dla nowych danych i brak default poza licznikami", () => {
  it.each(RECOVERY_MIGRATION_PLAN.map((p) => [p.population_type, p] as const))("%s: scope, stan, właściciel, termin, wersja są NOT NULL", (_pop, plan) => {
    for (const col of ["instance_id", "market_id", "state", "owner_type", "owner_id", "deadline", "version", "closure_path", "provenance_kind", "provenance_source"]) {
      expect({ col, present: plan.not_null_for_new_data.includes(col) }).toEqual({ col, present: true })
    }
  })

  it.each(RECOVERY_MIGRATION_PLAN.map((p) => [p.population_type, p] as const))("%s: default wyłącznie na licznikach i z racją", (_pop, plan) => {
    expect(plan.semantic_defaults.map((d) => d.column).sort()).toEqual(["retry_count", "version"])
    for (const d of plan.semantic_defaults) {
      expect(d.reason.length).toBeGreaterThan(10)
    }
    // w kształcie SQL każde DEFAULT stoi przy liczniku albo przy znaczniku czasu kwarantanny
    for (const step of plan.up) {
      const defaults = step.sql_shape.match(/(\w+)\s+[A-Z]+(?:\([^)]*\))?\s+NOT NULL DEFAULT/g) ?? []
      for (const d of defaults) {
        expect(d).toMatch(/^(retry_count|version|quarantined_at)\b/)
      }
    }
  })

  it("SET NOT NULL na istniejącej tabeli ma warunek wstępny zero NULL-i po atomowym przeniesieniu do kwarantanny", () => {
    const step = planFor("compensation_failure").up.find((s) => s.id === "cf-set-not-null")!
    const backfill = planFor("compensation_failure").up.find((s) => s.id === "cf-backfill")!
    expect(backfill.sql_shape).toMatch(/INSERT INTO money_path_compensation_failure_backfill_quarantine/)
    expect(backfill.sql_shape).toMatch(/DELETE FROM money_path_compensation_failure/)
    expect(backfill.sql_shape).toMatch(/BEGIN;.*COMMIT;/)
    expect(step.sql_shape).toMatch(/PRECONDITION: count\(\*\) WHERE instance_id IS NULL OR owner_id IS NULL OR deadline IS NULL/)
  })

  it("literalny SQL kwalifikuje pełne certyfikowane metadata i nie tylko niepuste kolumny", () => {
    const backfill = planFor("compensation_failure").up.find((s) => s.id === "cf-backfill")!
    const remap = planFor("compensation_failure").up.find((s) => s.id === "cf-remap-legacy-resolved")!
    for (const sql of [backfill.sql_shape, remap.sql_shape]) {
      expect(sql).toContain("owner_type IN ('operator_role','operator_user')")
      expect(sql).toContain("lower(btrim(")
      expect(sql).toContain("NOT IN ('unknown','default','null','none','n/a','tbd','todo','unassigned')")
      expect(sql).toContain("deadline::text ~")
      expect(sql).toContain("jsonb_typeof(")
      expect(sql).toContain("legacy_resolver->>'actor_type'='user'")
      expect(sql).toContain("legacy_resolver->>'actor_id'=c.resolved_by")
      expect(sql).toContain("legacy_resolver->>'session_source'='medusa_admin_session'")
    }
    expect(backfill.sql_shape).toContain("missing certified scope, owner, deadline, or legacy resolver evidence")
  })
})

describe("backfill bez wartości zastępczej", () => {
  const instanceByMarket = new Map([["bonbeauty", "gp-prod-eu1"], ["bongarden", "gp-prod-eu1"]])
  const certified = new Map<string, VerifiedHistoricalCompensationMetadata>([
    [
      "f1",
      {
        owner: { owner_type: "operator_role", owner_id: "compensation-ops" },
        deadline: "2026-08-20T12:00:00Z",
        legacy_resolver: null,
      },
    ],
    [
      "f2",
      {
        owner: { owner_type: "operator_user", owner_id: "usr_1" },
        deadline: "2026-08-19T12:00:00Z",
        legacy_resolver: { actor_type: "user", actor_id: "usr_1", auth_identity_id: null, session_source: "medusa_admin_session" },
      },
    ],
  ])

  it("wiersz `open` z kompletem certyfikowanych faktów → migrate/open, bez syntetycznego ownera ani deadline", () => {
    const decision = classifyHistoricalCompensationRow(
      { failure_id: "f1", market_id: "bonbeauty", resolution_state: "open", resolved_by: null, resolved_at: null },
      instanceByMarket,
      certified
    )
    expect(decision).toEqual({
      decision: "migrate",
      instance_id: "gp-prod-eu1",
      state: "open",
      owner: { owner_type: "operator_role", owner_id: "compensation-ops" },
      deadline: "2026-08-20T12:00:00Z",
      provenance: { kind: "backfilled_verified", source: INSTANCE_ID_BACKFILL_SOURCE },
      resolution_evidence: null,
    })
  })

  it("wiersz `resolved_manually` z certyfikowanym aktorem → pełne evidence legacy zgodne ze schemą", () => {
    const decision = classifyHistoricalCompensationRow(
      { failure_id: "f2", market_id: "bongarden", resolution_state: "resolved_manually", resolved_by: "usr_1", resolved_at: "2026-08-19T12:04:55Z" },
      instanceByMarket,
      certified
    )
    expect(decision).toMatchObject({
      decision: "migrate",
      state: "closed_legacy_unevidenced",
      resolution_evidence: {
        kind: "legacy_manual_resolution",
        recorded_at: "2026-08-19T12:04:55Z",
        recorded_by: { actor_type: "user", actor_id: "usr_1", auth_identity_id: null, session_source: "medusa_admin_session" },
      },
    })
  })

  it("zmaterializowany legacy row przechodzi recovery-population.v1 z pełnym evidence", () => {
    const source = materializeCompensationBackfill(
      [{ failure_id: "f2", market_id: "bongarden", resolution_state: "resolved_manually", resolved_by: "usr_1", resolved_at: "2026-08-19T12:04:55Z" }],
      instanceByMarket,
      certified
    ).source_rows_after[0]
    const contractRow = {
      contract_version: "1.0.0",
      population_type: "compensation_failure",
      population_id: source.failure_id,
      instance_id: source.instance_id,
      market_id: source.market_id,
      state: "closed_legacy_unevidenced",
      owner: source.owner,
      deadline: source.deadline,
      retry_count: 0,
      resolution_evidence: source.resolution_evidence,
      version: 1,
      occurred_at: "2026-08-19T12:00:00Z",
      closure_path: "operator_action",
      provenance: { kind: "backfilled_verified", source: INSTANCE_ID_BACKFILL_SOURCE },
      payload: {
        compensation_kind: "webhook_delivery_release",
        delivery_path: "stripe_webhook",
        stripe_event_id: "evt_legacy_1",
        attempt_count: 1,
        order_id: "order_legacy_1",
      },
    }
    expect(populationValidator.validate(POPULATION_SCHEMA, contractRow)).toEqual([])
  })

  it("wiersz `resolved_manually` BEZ resolved_by → kwarantanna (nie ma nawet dowodu legacy)", () => {
    const decision = classifyHistoricalCompensationRow(
      { failure_id: "f3", market_id: "bongarden", resolution_state: "resolved_manually", resolved_by: null, resolved_at: null },
      instanceByMarket,
      certified
    )
    expect(decision.decision).toBe("quarantine")
  })

  it("rynek bez zweryfikowanego mapowania → kwarantanna, NIE wymyślony instance_id", () => {
    const decision = classifyHistoricalCompensationRow(
      { failure_id: "f4", market_id: "market-from-2025", resolution_state: "open", resolved_by: null, resolved_at: null },
      instanceByMarket,
      certified
    )
    expect(decision).toEqual({ decision: "quarantine", reason: expect.stringContaining("f4") })
    expect(JSON.stringify(decision)).not.toMatch(/ops-recovery|24 hours|gp-prod-eu1/)
  })

  it("brak certyfikowanego ownera/deadline → kwarantanna, NIE `ops-recovery` ani created_at + 24h", () => {
    const decision = classifyHistoricalCompensationRow(
      { failure_id: "missing-owner-deadline", market_id: "bonbeauty", resolution_state: "open", resolved_by: null, resolved_at: null },
      instanceByMarket,
      certified
    )
    expect(decision).toEqual({ decision: "quarantine", reason: expect.stringContaining("missing-owner-deadline") })
    expect(JSON.stringify(decision)).not.toMatch(/ops-recovery|24 hours|gp-prod-eu1/)
  })

  it("fałszywy backfill: placeholder scope lub owner z dowolną wielkością liter jest odrzucony", () => {
    const poisoned = new Map<string, VerifiedHistoricalCompensationMetadata>([["f5", { owner: { owner_type: "operator_role", owner_id: "UNASSIGNED" }, deadline: "2026-08-20T12:00:00Z", legacy_resolver: null }]])
    const poisonedInstanceByMarket = new Map([["bonbeauty", "Default"]])
    const decision = classifyHistoricalCompensationRow(
      { failure_id: "f5", market_id: "bonbeauty", resolution_state: "open", resolved_by: null, resolved_at: null },
      poisonedInstanceByMarket,
      poisoned
    )
    expect(decision.decision).toBe("quarantine")
    for (const v of ["unknown", "UNKNOWN", "default", "Default", "null", "none", "n/a", "TBD", " todo ", "UNASSIGNED", ""]) {
      expect({ v, ok: isTrustworthyScopeValue(v) }).toEqual({ v, ok: false })
    }
    expect(isTrustworthyOwner({ owner_type: "operator_role", owner_id: " Default " })).toBe(false)
    expect(isTrustworthyScopeValue("gp-prod-eu1")).toBe(true)
  })

  it("wiersz bez metadanych jest atomowo przeniesiony do kwarantanny przed SET NOT NULL", () => {
    const result = materializeCompensationBackfill(
      [
        { failure_id: "f1", market_id: "bonbeauty", resolution_state: "open", resolved_by: null, resolved_at: null },
        { failure_id: "missing-owner-deadline", market_id: "bonbeauty", resolution_state: "open", resolved_by: null, resolved_at: null },
      ],
      instanceByMarket,
      certified
    )
    expect(result.migrated).toHaveLength(1)
    expect(result.quarantine).toHaveLength(1)
    expect(result.source_rows_after.map((row) => row.failure_id)).toEqual(["f1"])
    expect(result.source_rows_after[0]).toMatchObject({
      instance_id: "gp-prod-eu1",
      owner: { owner_type: "operator_role", owner_id: "compensation-ops" },
      deadline: "2026-08-20T12:00:00Z",
      resolution_evidence: null,
    })
    expect(JSON.stringify(result.migrated)).not.toMatch(/ops-recovery|created_at \+ interval '24 hours'/)
  })

  it("reguła backfillu nie ma pola default_value; brak odwzorowania = quarantine", () => {
    for (const plan of RECOVERY_MIGRATION_PLAN) {
      expect("default_value" in plan.backfill).toBe(false)
      if (plan.backfill.kind === "from_verified_source") {
        expect(plan.backfill.on_unresolved_provenance).toBe("quarantine")
        expect(plan.backfill.scope_source).toBe(INSTANCE_ID_BACKFILL_SOURCE)
      }
    }
  })

  it("backfill DLQ jest jawnie pusty (brak nośnika trwałego dziś)", () => {
    const plan = planFor("dlq_entry")
    expect(plan.backfill.kind).toBe("none")
    expect(plan.kind).toBe("create_new")
  })

  it("mapowanie stanów historycznych kompensacji pokrywa DOKŁADNIE słownik legacy", () => {
    const plan = planFor("compensation_failure")
    expect(plan.backfill.kind).toBe("from_verified_source")
    if (plan.backfill.kind === "from_verified_source") {
      expect(Object.keys(plan.backfill.state_mapping).sort()).toEqual([...LEGACY_COMPENSATION_STATES].sort())
      expect(plan.backfill.state_mapping.resolved_manually).toBe("closed_legacy_unevidenced")
    }
  })
})

describe("baza planu = realna migracja 20260818090000", () => {
  const migration = new RecordingMigration(
    {} as ConstructorParameters<typeof Migration20260818090000MoneyPathCompensationFailureTable>[0],
    {} as ConstructorParameters<typeof Migration20260818090000MoneyPathCompensationFailureTable>[1]
  )
  const sql = (() => {
    migration.up()
    return migration.recorded.join("\n").replace(/\s+/g, " ")
  })()

  it("istniejąca tabela nazywa się tak, jak nośnik ALTER w planie", () => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${COMPENSATION_FAILURE_TABLE} (`)
    expect(planFor("compensation_failure").kind).toBe("alter_existing")
  })

  it("market_id jest NOT NULL już dziś (plan nie musi go backfillować), instance_id nie istnieje (plan go dodaje)", () => {
    expect(sql).toMatch(/market_id TEXT NOT NULL/)
    expect(sql).not.toMatch(/instance_id/)
    const add = planFor("compensation_failure").up.find((s) => s.id === "cf-add-columns")!
    expect(add.sql_shape).toMatch(/ADD COLUMN instance_id TEXT/)
  })

  it("słownik CHECK-a resolution_state w realnej migracji == LEGACY_COMPENSATION_STATES (baza mapowania)", () => {
    const m = sql.match(/CHECK \(resolution_state IN \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const states = m![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort()
    expect(states).toEqual([...LEGACY_COMPENSATION_STATES].sort())
  })

  it("down planu przywraca dokładnie ten słownik", () => {
    const restore = planFor("compensation_failure").down.find((s) => s.id === "cf-restore-state-check")!
    for (const s of LEGACY_COMPENSATION_STATES) {
      expect(restore.sql_shape).toContain(`'${s}'`)
    }
    expect(restore.sql_shape).not.toContain("closed_legacy_unevidenced")
  })
})

describe("linkowalność planu z ADR-221", () => {
  it("ADR-221 istnieje i wymienia trzy tabele nośników oraz źródło backfillu", () => {
    expect(fs.existsSync(ADR_PATH)).toBe(true)
    const text = fs.readFileSync(ADR_PATH, "utf8")
    for (const table of [COMPENSATION_FAILURE_TABLE, DEFERRED_ISSUANCE_TRACE_TABLE, DLQ_ENTRY_TABLE]) {
      expect({ table, present: text.includes(table) }).toEqual({ table, present: true })
    }
    expect(text).toContain(INSTANCE_ID_BACKFILL_SOURCE)
    expect(text).toContain(COMPENSATION_BACKFILL_PROVENANCE_SOURCE)
    expect(text).not.toMatch(/\*\*Status:\*\*\s*Rejected/)
  })
})
