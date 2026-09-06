/**
 * recovery-authorization-idempotency.unit.spec.ts — v1.16.0 Story 4.1 AC2
 * (AD-48, AD-49, ADR-221 §4).
 *
 * Kontrakt akcji recovery mierzony na REALNYCH ogniwach tożsamości:
 *  - `withOperatorAuth` (middlewares/with-operator-auth.ts) ustawia `req.operatorAuth`
 *    z sesji; body z „actor_id" jest IGNOROWANE — kernel dostaje wyłącznie `operatorAuth`;
 *  - `resolveAdminMarketContext` (lib/admin-market-context.ts) rozstrzyga dostęp do rynku
 *    po stronie serwera (super-admin / grant / brak) na wstrzykniętym knex;
 *  - kernel `applyRecoveryIntent` egzekwuje: idempotency_key wynikający z intencji,
 *    powtórka = 0 skutków + rekord `replayed` z identycznym `after`, konflikt wersji =
 *    odmowa bez skutku, przejście w stan terminalny bez evidence = odmowa,
 *    zabronione przejście = odmowa; każdy rekord audytu ma `before`/`after`.
 *  - każdy wyprodukowany rekord audytu przechodzi `recovery-action-audit.v1.schema.json`.
 *
 * Test-the-test (mutanty odnotowane w story): wywołanie kernela z kluczem NIE
 * wynikającym z intencji rzuca; intencja bez expected_version nie da się zbudować.
 */
import fs from "node:fs"
import path from "node:path"
import type { Knex } from "knex"

import { withOperatorAuth, type OperatorAuthContext } from "../../middlewares/with-operator-auth"
import {
  __setKnexForAdminMarketTests,
  resolveAdminMarketContext,
  type AdminMarketContextResult,
} from "../../lib/admin-market-context"
import { __resetCapabilityCache, SUPER_ADMIN_CAPABILITY } from "../../lib/capability-check"
import {
  applyRecoveryIntent,
  authorizeRecoveryMarket,
  buildRecoveryIdempotencyKey,
  deriveSessionActor,
  RecoveryUnauthenticatedError,
  type IdempotencyLedger,
  type ApplyRecoveryIntentInput,
  type RecoveryActionAuditRecord,
  type RecoveryIntent,
  type RecoveryRecordView,
  type ResolutionEvidence,
} from "../../lib/recovery/recovery-action-contract"
import { LiteValidator, type JsonSchema } from "./json-schema-lite"

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")
const CONTRACT_DIR = path.join(REPO_ROOT, "specs/contracts/recovery/schemas")
const POPULATION_SCHEMA = "recovery-population.v1.schema.json"
const AUDIT_SCHEMA = "recovery-action-audit.v1.schema.json"

function readSchema(name: string): JsonSchema {
  const file = path.join(CONTRACT_DIR, name)
  if (!fs.existsSync(file)) throw new Error(`Brak schemy ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonSchema
}
const auditValidator = new LiteValidator({
  [POPULATION_SCHEMA]: readSchema(POPULATION_SCHEMA),
  [AUDIT_SCHEMA]: readSchema(AUDIT_SCHEMA),
})
const expectAuditValid = (audit: RecoveryActionAuditRecord) =>
  expect(auditValidator.validate(AUDIT_SCHEMA, audit)).toEqual([])

// ── fakes tożsamości (te same kształty, co w istniejących testach ogniw) ────────

function createReq(authContext: Record<string, unknown> | undefined, body: Record<string, unknown> = {}) {
  return {
    auth_context: authContext,
    body,
    headers: {} as Record<string, string>,
    scope: { resolve: jest.fn().mockReturnValue(undefined) },
  } as any // eslint-disable-line @typescript-eslint/no-explicit-any
}
function createRes() {
  return {
    body: null as unknown,
    statusCode: 0,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

/** Sesja → operatorAuth przez REALNY withOperatorAuth; body celowo niesie obcego aktora. */
async function operatorAuthFromSession(authContext: Record<string, unknown> | undefined) {
  let captured: OperatorAuthContext | undefined
  const wrapped = withOperatorAuth(async (req) => {
    captured = (req as unknown as { operatorAuth?: OperatorAuthContext }).operatorAuth
  })
  const req = createReq(authContext, { actor_id: "usr_FROM_BODY_ATTACKER", actor_type: "user" })
  const res = createRes()
  await wrapped(req, res as any, jest.fn()) // eslint-disable-line @typescript-eslint/no-explicit-any
  return { operatorAuth: captured, res }
}

function makeKnex(opts: { superAdmins?: Set<string>; marketGrants?: Record<string, Set<string>> }): Knex {
  function capabilityGrantsTable() {
    const state = { actor: "", caps: [] as string[] }
    const chain = {
      select: jest.fn(() => chain),
      where: jest.fn((col: string, val: string) => {
        if (col === "actor_id") state.actor = val
        return chain
      }),
      whereIn: jest.fn((col: string, vals: string[]) => {
        if (col === "capability") state.caps = vals
        return chain
      }),
      whereNull: jest.fn(() => chain),
      limit: jest.fn(async () =>
        opts.superAdmins?.has(state.actor) && state.caps.includes(SUPER_ADMIN_CAPABILITY)
          ? [{ capability: SUPER_ADMIN_CAPABILITY }]
          : []
      ),
    }
    return chain
  }
  function marketGrantsTable() {
    const state = { actor: "", market: "" }
    const chain = {
      select: jest.fn(() => chain),
      where: jest.fn((col: string, val: string) => {
        if (col === "admin_user_id") state.actor = val
        if (col === "market_id") state.market = val
        return chain
      }),
      whereNull: jest.fn(() => chain),
      limit: jest.fn(async () =>
        opts.marketGrants?.[state.actor]?.has(state.market) ? [{ admin_user_id: state.actor }] : []
      ),
    }
    return chain
  }
  const knex = jest.fn((table: string) =>
    table === "admin_market_grants" ? marketGrantsTable() : capabilityGrantsTable()
  )
  return knex as unknown as Knex
}

async function marketContextFor(actorId: string, marketHeader: string): Promise<AdminMarketContextResult> {
  const req = createReq({ actor_id: actorId, actor_type: "user" })
  req.headers["x-gp-market-id"] = marketHeader
  return resolveAdminMarketContext(req)
}

// ── stan wyjściowy ─────────────────────────────────────────────────────────────

const OPERATOR = "usr_01J8ZD0P4R7T2K9M6V3X1B5N8Q"
const OUTSIDER = "usr_OUTSIDER_NO_GRANTS"
const SESSION_INSTANCE = "gp-prod-eu1"

/** Surowe wejścia, które w runtime tworzą wyłącznie middleware i resolver serwera. */
function serverContext(
  actorId = OPERATOR,
  marketId = "bonbeauty",
  isSuperAdmin = false,
  sessionInstanceId = SESSION_INSTANCE
): Pick<ApplyRecoveryIntentInput, "operatorAuth" | "marketContext" | "sessionInstanceId"> {
  return {
    operatorAuth: { actor_id: actorId, actor_type: "user" },
    marketContext: {
      ok: true,
      market_id: marketId,
      actor_id: actorId,
      actor_type: "user",
      is_super_admin: isSuperAdmin,
      source: "intrinsic",
    },
    sessionInstanceId,
  }
}

function baseRecord(): RecoveryRecordView {
  return {
    population_type: "compensation_failure",
    population_id: "mpcf_3f9a1c2e7b4d5a60_webhook_delivery_release",
    instance_id: SESSION_INSTANCE,
    market_id: "bonbeauty",
    state: "open",
    owner: { owner_type: "operator_role", owner_id: "ops-recovery" },
    version: 1,
    retry_count: 0,
    resolution_evidence: null,
  }
}

const evidenceFor = (actorId: string): ResolutionEvidence => ({
  kind: "funds_recovered",
  reference: "pi_3U2vWGLq7ZbYtR8m0aBcDeFg:canceled",
  recorded_at: "2026-09-06T12:00:00Z",
  recorded_by: { actor_type: "user", actor_id: actorId, auth_identity_id: null, session_source: "medusa_admin_session" },
})

function intentFor(record: RecoveryRecordView, action: RecoveryIntent["action"], extra: Partial<RecoveryIntent> = {}): RecoveryIntent {
  const expected_version = extra.expected_version ?? record.version
  return {
    action,
    population_type: record.population_type,
    population_id: record.population_id,
    expected_version,
    idempotency_key: buildRecoveryIdempotencyKey({
      population_type: record.population_type,
      population_id: record.population_id,
      action,
      expected_version,
    }),
    ...extra,
  }
}

class MemoryLedger implements IdempotencyLedger {
  readonly applied = new Map<string, RecoveryActionAuditRecord>()
  findApplied(key: string) {
    return this.applied.get(key)
  }
  record(audit: RecoveryActionAuditRecord) {
    if (audit.outcome === "applied") this.applied.set(audit.idempotency_key, audit)
  }
}

let auditSeq = 0
const nextAuditId = () => `rcv_audit_${String(++auditSeq).padStart(4, "0")}`

beforeEach(() => {
  __setKnexForAdminMarketTests(undefined)
  __resetCapabilityCache()
})

// ── AC2: aktor z sesji, nie z body ──────────────────────────────────────────────

describe("aktor pochodzi z sesji (withOperatorAuth), body jest ignorowane", () => {
  it("operatorAuth = aktor sesji, mimo że body niesie innego actor_id", async () => {
    const { operatorAuth } = await operatorAuthFromSession({ actor_id: OPERATOR, actor_type: "user" })
    expect(operatorAuth?.actor_id).toBe(OPERATOR)
    const actor = deriveSessionActor(operatorAuth)
    expect(actor).toEqual({ actor_type: "user", actor_id: OPERATOR, auth_identity_id: null, session_source: "medusa_admin_session" })
  })

  it("brak sesji → 401 z ogniwa i brak aktora; kernel rzuca zamiast oceniać intencję", async () => {
    const { operatorAuth, res } = await operatorAuthFromSession(undefined)
    expect(res.statusCode).toBe(401)
    expect(operatorAuth).toBeUndefined()
    const record = baseRecord()
    expect(() =>
      applyRecoveryIntent({
        record,
        intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
        operatorAuth,
        marketContext: { ok: false, status: 401, code: "UNAUTHORIZED", message: "missing session" },
        sessionInstanceId: SESSION_INSTANCE,
        ledger: new MemoryLedger(),
        now: "2026-09-06T12:00:00Z",
        auditId: nextAuditId(),
      })
    ).toThrow(RecoveryUnauthenticatedError)
    expect(record.version).toBe(1)
  })

  it("sesja sprzedawcy (actor_type=seller) → 403 z ogniwa, brak aktora operatorskiego", async () => {
    const { operatorAuth, res } = await operatorAuthFromSession({ actor_id: "seller_1", actor_type: "seller" })
    expect(res.statusCode).toBe(403)
    expect(deriveSessionActor(operatorAuth)).toBeNull()
  })

  it("stare wejście z osobnym actor/grant nie jest wejściem kernela i nie daje skutku", () => {
    const record = baseRecord()
    const legacyForgedInput = {
      record,
      intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
      actor: { actor_type: "user", actor_id: "usr_FROM_BODY_ATTACKER", auth_identity_id: null, session_source: "medusa_admin_session" },
      authorization: { market_access: "super_admin", decision: "granted" },
      ledger: new MemoryLedger(),
      now: "2026-09-06T12:00:00Z",
      auditId: nextAuditId(),
    }
    expect(() => applyRecoveryIntent(legacyForgedInput as unknown as ApplyRecoveryIntentInput)).toThrow(RecoveryUnauthenticatedError)
    expect(record.version).toBe(1)
  })
})

// ── AC2: autoryzacja rynku/instancji po stronie serwera ────────────────────────

describe("autoryzacja rynku i instancji wiersza (resolveAdminMarketContext)", () => {
  it("operator z grantem na rynek wiersza → granted/market_grant", async () => {
    __setKnexForAdminMarketTests(makeKnex({ marketGrants: { [OPERATOR]: new Set(["bonbeauty"]) } }))
    const ctx = await marketContextFor(OPERATOR, "bonbeauty")
    expect(ctx.ok).toBe(true)
    expect(authorizeRecoveryMarket({ actor: deriveSessionActor({ actor_id: OPERATOR, actor_type: "user" })!, marketContext: ctx, sessionInstanceId: SESSION_INSTANCE, record: baseRecord() })).toEqual({
      market_access: "market_grant",
      decision: "granted",
    })
  })

  it("operator BEZ grantu na obcy rynek → 403 z ogniwa → odmowa bez skutku, audyt after==before", async () => {
    __setKnexForAdminMarketTests(makeKnex({ marketGrants: { [OUTSIDER]: new Set(["bongarden"]) } }))
    const ctx = await marketContextFor(OUTSIDER, "bonbeauty")
    expect(ctx.ok).toBe(false)
    if (!ctx.ok) expect(ctx.status).toBe(403)
    const record = baseRecord()
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
      operatorAuth: { actor_id: OUTSIDER, actor_type: "user" },
      marketContext: ctx,
      sessionInstanceId: SESSION_INSTANCE,
      ledger: new MemoryLedger(),
      now: "2026-09-06T12:00:00Z",
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_market_forbidden")
    expect(result.domain_effects).toBe(0)
    expect(result.record).toBe(record)
    expect(result.audit.after).toEqual(result.audit.before)
    expect(result.audit.authorization).toEqual({ market_access: "none", verified_by: "server_admin_market_context", decision: "denied" })
    expectAuditValid(result.audit)
  })

  it("grant na rynek, ale wiersz z INNEJ instancji niż sesja → odmowa", async () => {
    __setKnexForAdminMarketTests(makeKnex({ marketGrants: { [OPERATOR]: new Set(["bonbeauty"]) } }))
    const ctx = await marketContextFor(OPERATOR, "bonbeauty")
    const record = { ...baseRecord(), instance_id: "gp-prod-us1" }
    expect(authorizeRecoveryMarket({ actor: deriveSessionActor({ actor_id: OPERATOR, actor_type: "user" })!, marketContext: ctx, sessionInstanceId: SESSION_INSTANCE, record })).toEqual({
      market_access: "none",
      decision: "denied",
    })
  })

  it("grant na rynek A, wiersz z rynku B (nagłówek zweryfikowany, ale wiersz obcy) → odmowa", async () => {
    __setKnexForAdminMarketTests(makeKnex({ marketGrants: { [OPERATOR]: new Set(["bongarden"]) } }))
    const ctx = await marketContextFor(OPERATOR, "bongarden")
    expect(ctx.ok).toBe(true)
    expect(authorizeRecoveryMarket({ actor: deriveSessionActor({ actor_id: OPERATOR, actor_type: "user" })!, marketContext: ctx, sessionInstanceId: SESSION_INSTANCE, record: baseRecord() }).decision).toBe("denied")
  })

  it("super-admin → granted/super_admin na dowolnym rynku tej instancji", async () => {
    __setKnexForAdminMarketTests(makeKnex({ superAdmins: new Set([OPERATOR]) }))
    const ctx = await marketContextFor(OPERATOR, "bonbeauty")
    expect(authorizeRecoveryMarket({ actor: deriveSessionActor({ actor_id: OPERATOR, actor_type: "user" })!, marketContext: ctx, sessionInstanceId: SESSION_INSTANCE, record: baseRecord() })).toEqual({
      market_access: "super_admin",
      decision: "granted",
    })
  })

  it("wynik resolvera innego aktora nie może dać grantu bieżącej sesji", () => {
    const record = baseRecord()
    const trustedForOperator = serverContext(OPERATOR)
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
      ...trustedForOperator,
      operatorAuth: { actor_id: OUTSIDER, actor_type: "user" },
      ledger: new MemoryLedger(),
      now: "2026-09-06T12:00:00Z",
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_market_forbidden")
    expect(result.domain_effects).toBe(0)
    expect(result.audit.actor.actor_id).toBe(OUTSIDER)
  })
})

// ── AC2: idempotencja i wersja ─────────────────────────────────────────────────

describe("idempotencja intencji i optymistyczna kontrola wersji", () => {
  const now = "2026-09-06T12:00:00Z"

  it("ta sama intencja dwa razy = DOKŁADNIE jeden skutek domenowy, drugi rekord `replayed` z identycznym after", () => {
    const ledger = new MemoryLedger()
    const record = baseRecord()
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress" })

    const first = applyRecoveryIntent({ record, intent, ...serverContext(), ledger, now, auditId: nextAuditId() })
    ledger.record(first.audit)
    expect(first.outcome).toBe("applied")
    expect(first.domain_effects).toBe(1)
    expect(first.record.state).toBe("recovery_in_progress")
    expect(first.record.version).toBe(2)
    expect(first.audit.before).toEqual({ state: "open", version: 1, owner: { owner_type: "operator_role", owner_id: "ops-recovery" } })
    expect(first.audit.after).toEqual({ state: "recovery_in_progress", version: 2, owner: { owner_type: "operator_role", owner_id: "ops-recovery" } })
    expectAuditValid(first.audit)

    // powtórka trafia już na NOWY stan wiersza (version 2) z tym samym kluczem
    const second = applyRecoveryIntent({ record: first.record, intent, ...serverContext(), ledger, now, auditId: nextAuditId() })
    expect(second.outcome).toBe("replayed")
    expect(second.domain_effects).toBe(0)
    expect(second.record).toBe(first.record)
    expect(second.audit.after).toEqual(first.audit.after)
    expect(second.audit.before).toEqual(first.audit.after)
    expect(second.audit.idempotency_key).toBe(first.audit.idempotency_key)
    expectAuditValid(second.audit)

    const effects = [first, second].reduce((n, r) => n + r.domain_effects, 0)
    expect(effects).toBe(1)
  })

  it("niezgodna wersja → refused_version_conflict, zero skutku, after==before", () => {
    const record = { ...baseRecord(), version: 3 }
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress", expected_version: 2 })
    const result = applyRecoveryIntent({ record, intent, ...serverContext(), ledger: new MemoryLedger(), now, auditId: nextAuditId() })
    expect(result.outcome).toBe("refused_version_conflict")
    expect(result.domain_effects).toBe(0)
    expect(result.record).toBe(record)
    expect(result.audit.after).toEqual(result.audit.before)
    expect(result.audit.expected_version).toBe(2)
    expectAuditValid(result.audit)
  })

  it("dwie różne intencje na tej samej wersji: druga przegrywa konfliktem, nie nadpisuje", () => {
    const ledger = new MemoryLedger()
    const record = baseRecord()
    const a = applyRecoveryIntent({ record, intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }), ...serverContext(), ledger, now, auditId: nextAuditId() })
    ledger.record(a.audit)
    const b = applyRecoveryIntent({
      record: a.record,
      intent: intentFor(record, "resolve", { target_state: "closed_unrecoverable", resolution_evidence: evidenceFor(OPERATOR) }),
      ...serverContext(),
      ledger,
      now,
      auditId: nextAuditId(),
    })
    expect(b.outcome).toBe("refused_version_conflict")
    expect(b.record.state).toBe("recovery_in_progress")
  })

  it("przejście w stan terminalny bez evidence → refused_missing_evidence (zmiana stanu nie jest dowodem)", () => {
    const record = baseRecord()
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered" }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_missing_evidence")
    expect(result.domain_effects).toBe(0)
    expect(result.record.state).toBe("open")
    expectAuditValid(result.audit)
  })

  it("przejście w stan terminalny Z evidence → applied, evidence w wierszu i w audycie", () => {
    const record = baseRecord()
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered", resolution_evidence: evidenceFor(OPERATOR) }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("applied")
    expect(result.record.state).toBe("resolved_recovered")
    expect(result.record.resolution_evidence?.kind).toBe("funds_recovered")
    expect(result.audit.resolution_evidence?.kind).toBe("funds_recovered")
    expectAuditValid(result.audit)
  })

  it("evidence wskazujące innego aktora niż sesja jest odmową bez skutku", () => {
    const record = baseRecord()
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered", resolution_evidence: evidenceFor(OUTSIDER) }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expectAuditValid(result.audit)
  })

  it("zabronione przejście (terminalny → cokolwiek) → refused_invalid_transition", () => {
    const record: RecoveryRecordView = { ...baseRecord(), state: "resolved_recovered", version: 3, resolution_evidence: evidenceFor(OPERATOR) }
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "retry", { target_state: "open" }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expectAuditValid(result.audit)
  })

  it("stan legacy nie jest osiągalny akcją (tylko backfill)", () => {
    const record = baseRecord()
    const legacy: ResolutionEvidence = { ...evidenceFor(OPERATOR), kind: "legacy_manual_resolution" }
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "resolve", { target_state: "closed_legacy_unevidenced", resolution_evidence: legacy }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
  })

  it("retry zwiększa retry_count wiersza o 1 i wersję o 1", () => {
    const record: RecoveryRecordView = { ...baseRecord(), population_type: "dlq_entry", population_id: "dlq_01", state: "dlq_pending_retry", retry_count: 3 }
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "retry", { target_state: "dlq_pending_ops_review" }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("applied")
    expect(result.record.retry_count).toBe(4)
    expect(result.record.version).toBe(2)
  })

  it("take_ownership zmienia właściciela w wierszu i w after audytu", () => {
    const record = baseRecord()
    const result = applyRecoveryIntent({
      record,
      intent: intentFor(record, "take_ownership", { new_owner: { owner_type: "operator_user", owner_id: OPERATOR } }),
      ...serverContext(),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("applied")
    expect(result.record.owner).toEqual({ owner_type: "operator_user", owner_id: OPERATOR })
    expect(result.audit.after.owner).toEqual({ owner_type: "operator_user", owner_id: OPERATOR })
    expectAuditValid(result.audit)
  })
})

// ── test-the-test: rozluźnienie kontraktu musi pękać ────────────────────────────

describe("test-the-test: klucz idempotencji musi wynikać z intencji", () => {
  it("klucz podany przez klienta (nie z intencji) → błąd, nie skutek", () => {
    const record = baseRecord()
    const intent = { ...intentFor(record, "escalate", { target_state: "recovery_in_progress" }), idempotency_key: "client-chosen-key" }
    expect(() =>
      applyRecoveryIntent({ record, intent, ...serverContext(), ledger: new MemoryLedger(), now: "2026-09-06T12:00:00Z", auditId: nextAuditId() })
    ).toThrow(/idempotency_key/)
  })

  it("expected_version < 1 albo niecałkowite → klucz nie powstaje", () => {
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: "dlq_01", action: "retry", expected_version: 0 })).toThrow(/expected_version/)
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: "dlq_01", action: "retry", expected_version: 1.5 })).toThrow(/expected_version/)
  })

  it("population_id z dwukropkiem → klucz niejednoznaczny → błąd", () => {
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: "a:b", action: "retry", expected_version: 1 })).toThrow(/dwukropek/)
  })

  it("intencja wskazująca inny wiersz niż rekord → błąd", () => {
    const record = baseRecord()
    const other = { ...baseRecord(), population_id: "mpcf_OTHER" }
    const intent = intentFor(other, "escalate", { target_state: "recovery_in_progress" })
    expect(() =>
      applyRecoveryIntent({ record, intent, ...serverContext(), ledger: new MemoryLedger(), now: "2026-09-06T12:00:00Z", auditId: nextAuditId() })
    ).toThrow()
  })
})
