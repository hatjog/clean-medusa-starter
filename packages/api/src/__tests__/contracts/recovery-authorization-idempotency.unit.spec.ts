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
  establishRecoveryServerSession,
  RecoveryRecordNotFoundError,
  RecoveryUnauthenticatedError,
  type IdempotencyLedger,
  type ApplyRecoveryIntentInput,
  type RecoveryActionAuditRecord,
  type RecoveryIntent,
  type RecoveryRecordStore,
  type RecoveryRecordView,
  type RecoveryServerSession,
  type ResolutionEvidenceVerifier,
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
let standardRecoverySession: RecoveryServerSession

function serverContext(
  record: RecoveryRecordView,
  recoverySession = standardRecoverySession,
  recordStore: RecoveryRecordStore = new MemoryRecoveryRecordStore(record)
): Pick<ApplyRecoveryIntentInput, "recoverySession" | "recordStore" | "evidenceVerifier"> {
  return {
    recoverySession,
    recordStore,
    evidenceVerifier: new RecordedEvidenceVerifier([evidenceFor(OPERATOR)]),
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

class MemoryRecoveryRecordStore implements RecoveryRecordStore {
  constructor(private record: RecoveryRecordView) {}

  readForRecovery(input: { population_type: RecoveryRecordView["population_type"]; population_id: string; instance_id: string }): RecoveryRecordView | null {
    return input.population_type === this.record.population_type && input.population_id === this.record.population_id && input.instance_id === this.record.instance_id
      ? this.record
      : null
  }

  async compareAndSetForRecovery(input: {
    population_type: RecoveryRecordView["population_type"]
    population_id: string
    instance_id: string
    market_id: string
    expected_version: number
    next: RecoveryRecordView
  }) {
    if (
      input.population_type !== this.record.population_type ||
      input.population_id !== this.record.population_id ||
      input.instance_id !== this.record.instance_id ||
      input.market_id !== this.record.market_id
    ) {
      throw new Error("MemoryRecoveryRecordStore: compare-and-set wskazuje inny wiersz")
    }
    if (this.record.version !== input.expected_version) {
      return { applied: false as const, record: this.record }
    }
    this.record = input.next
    return { applied: true as const, record: this.record }
  }
}

class RecordedEvidenceVerifier implements ResolutionEvidenceVerifier {
  private readonly references = new Set<string>()

  constructor(evidence: readonly ResolutionEvidence[]) {
    for (const item of evidence) this.references.add(item.reference)
  }

  verifies(input: Parameters<ResolutionEvidenceVerifier["verifies"]>[0]): boolean {
    return (
      this.references.has(input.evidence.reference) &&
      input.evidence.recorded_by.actor_id === input.actor.actor_id &&
      input.evidence.recorded_at === "2026-09-06T12:00:00Z"
    )
  }
}

class MemoryLedger implements IdempotencyLedger {
  readonly applied = new Map<string, RecoveryActionAuditRecord>()
  private readonly inFlight = new Map<string, Promise<RecoveryActionAuditRecord>>()

  async executeOnce(
    scope: Pick<RecoveryRecordView, "instance_id" | "market_id">,
    key: string,
    operation: () => Promise<Awaited<ReturnType<typeof applyRecoveryIntent>>>
  ): ReturnType<IdempotencyLedger["executeOnce"]> {
    const scopedKey = `${scope.instance_id}\u0000${scope.market_id}\u0000${key}`
    const prior = this.applied.get(scopedKey)
    if (prior) return { created: false, applied: prior }
    const pending = this.inFlight.get(scopedKey)
    if (pending) return { created: false, applied: await pending }
    let settle!: (audit: RecoveryActionAuditRecord) => void
    const claimed = new Promise<RecoveryActionAuditRecord>((resolve) => { settle = resolve })
    this.inFlight.set(scopedKey, claimed)
    const result = await operation()
    if (result.outcome === "applied") this.applied.set(scopedKey, result.audit)
    settle(result.audit)
    this.inFlight.delete(scopedKey)
    return { created: true, result }
  }
}

let auditSeq = 0
const nextAuditId = () => `rcv_audit_${String(++auditSeq).padStart(4, "0")}`

beforeEach(async () => {
  __setKnexForAdminMarketTests(undefined)
  __resetCapabilityCache()
  const { operatorAuth } = await operatorAuthFromSession({ actor_id: OPERATOR, actor_type: "user" })
  __setKnexForAdminMarketTests(makeKnex({ marketGrants: { [OPERATOR]: new Set(["bonbeauty"]) } }))
  const marketContext = await marketContextFor(OPERATOR, "bonbeauty")
  standardRecoverySession = establishRecoveryServerSession({
    operatorAuth,
    marketContext,
    sessionInstanceId: SESSION_INSTANCE,
  })
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
    await expect(
      applyRecoveryIntent({
        intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
        ...serverContext(record),
        recoverySession: undefined as unknown as RecoveryServerSession,
        ledger: new MemoryLedger(),
        now: "2026-09-06T12:00:00Z",
        auditId: nextAuditId(),
      })
    ).rejects.toThrow(RecoveryUnauthenticatedError)
    expect(record.version).toBe(1)
  })

  it("sesja sprzedawcy (actor_type=seller) → 403 z ogniwa, brak aktora operatorskiego", async () => {
    const { operatorAuth, res } = await operatorAuthFromSession({ actor_id: "seller_1", actor_type: "seller" })
    expect(res.statusCode).toBe(403)
    expect(deriveSessionActor(operatorAuth)).toBeNull()
  })

  it("resolver rynku odrzuca actor_id bez actor_type=user", async () => {
    const result = await resolveAdminMarketContext(createReq({ actor_id: OPERATOR }))
    expect(result).toMatchObject({ ok: false, status: 401, code: "UNAUTHORIZED" })
  })

  it("stare wejście z osobnym actor/grant nie jest wejściem kernela i nie daje skutku", async () => {
    const record = baseRecord()
    const legacyForgedInput = {
      intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
      actor: { actor_type: "user", actor_id: "usr_FROM_BODY_ATTACKER", auth_identity_id: null, session_source: "medusa_admin_session" },
      authorization: { market_access: "super_admin", decision: "granted" },
      recoverySession: {} as RecoveryServerSession,
      ledger: new MemoryLedger(),
      now: "2026-09-06T12:00:00Z",
      auditId: nextAuditId(),
    }
    await expect(applyRecoveryIntent(legacyForgedInput as unknown as ApplyRecoveryIntentInput)).rejects.toThrow(RecoveryUnauthenticatedError)
    expect(record.version).toBe(1)
  })

  it("ręcznie złożone wejścia issuer factory nie mintują capability", async () => {
    expect(() => establishRecoveryServerSession({
      operatorAuth: { actor_id: "usr_ATTACKER", actor_type: "user" },
      marketContext: { ok: true, market_id: "bonbeauty", actor_id: "usr_ATTACKER", actor_type: "user", is_super_admin: true, source: "intrinsic" },
      sessionInstanceId: SESSION_INSTANCE,
    })).toThrow(RecoveryUnauthenticatedError)
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
    const { operatorAuth } = await operatorAuthFromSession({ actor_id: OUTSIDER, actor_type: "user" })
    const recoverySession = establishRecoveryServerSession({
      operatorAuth,
      marketContext: ctx,
      sessionInstanceId: SESSION_INSTANCE,
    })
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
      ...serverContext(record, recoverySession),
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

  it("ręcznie złożony wynik resolvera innego aktora nie mintuje capability", async () => {
    const record = baseRecord()
    const { operatorAuth } = await operatorAuthFromSession({ actor_id: OUTSIDER, actor_type: "user" })
    expect(() => establishRecoveryServerSession({
        operatorAuth,
        marketContext: {
          ok: true,
          market_id: "bonbeauty",
          actor_id: OPERATOR,
          actor_type: "user",
          is_super_admin: false,
          source: "intrinsic",
        },
        sessionInstanceId: SESSION_INSTANCE,
      })).toThrow(RecoveryUnauthenticatedError)
  })

  it("wynik resolvera innego aktora nie może dać grantu bieżącej sesji", () => {
    const decision = authorizeRecoveryMarket({
      actor: deriveSessionActor({ actor_id: OUTSIDER, actor_type: "user" })!,
      marketContext: {
        ok: true,
        market_id: "bonbeauty",
        actor_id: OPERATOR,
        actor_type: "user",
        is_super_admin: true,
        source: "intrinsic",
      },
      sessionInstanceId: SESSION_INSTANCE,
      record: baseRecord(),
    })
    expect(decision).toEqual({ market_access: "none", decision: "denied" })
  })
})

// ── AC2: idempotencja i wersja ─────────────────────────────────────────────────

describe("idempotencja intencji i optymistyczna kontrola wersji", () => {
  const now = "2026-09-06T12:00:00Z"

  it("ta sama intencja dwa razy = DOKŁADNIE jeden skutek domenowy, drugi rekord `replayed` z identycznym after", async () => {
    const ledger = new MemoryLedger()
    const record = baseRecord()
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress" })

    const first = await applyRecoveryIntent({ intent, ...serverContext(record), ledger, now, auditId: nextAuditId() })
    expect(first.outcome).toBe("applied")
    expect(first.domain_effects).toBe(1)
    expect(first.record.state).toBe("recovery_in_progress")
    expect(first.record.version).toBe(2)
    expect(first.audit.before).toEqual({ state: "open", version: 1, owner: { owner_type: "operator_role", owner_id: "ops-recovery" } })
    expect(first.audit.after).toEqual({ state: "recovery_in_progress", version: 2, owner: { owner_type: "operator_role", owner_id: "ops-recovery" } })
    expectAuditValid(first.audit)

    // powtórka trafia już na NOWY stan wiersza (version 2) z tym samym kluczem
    const second = await applyRecoveryIntent({ intent, ...serverContext(first.record), ledger, now, auditId: nextAuditId() })
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

  it("niezgodna wersja → refused_version_conflict, zero skutku, after==before", async () => {
    const record = { ...baseRecord(), version: 3 }
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress", expected_version: 2 })
    const result = await applyRecoveryIntent({ intent, ...serverContext(record), ledger: new MemoryLedger(), now, auditId: nextAuditId() })
    expect(result.outcome).toBe("refused_version_conflict")
    expect(result.domain_effects).toBe(0)
    expect(result.record).toBe(record)
    expect(result.audit.after).toEqual(result.audit.before)
    expect(result.audit.expected_version).toBe(2)
    expectAuditValid(result.audit)
  })

  it("dwie różne intencje na tej samej wersji: druga przegrywa konfliktem, nie nadpisuje", async () => {
    const ledger = new MemoryLedger()
    const record = baseRecord()
    const a = await applyRecoveryIntent({ intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }), ...serverContext(record), ledger, now, auditId: nextAuditId() })
    const b = await applyRecoveryIntent({
      intent: intentFor(record, "resolve", { target_state: "closed_unrecoverable", resolution_evidence: evidenceFor(OPERATOR) }),
      ...serverContext(a.record),
      ledger,
      now,
      auditId: nextAuditId(),
    })
    expect(b.outcome).toBe("refused_version_conflict")
    expect(b.record.state).toBe("recovery_in_progress")
  })

  it("RÓWNOLEGŁE różne klucze na tej samej wersji wykonują dokładnie jeden compare-and-set", async () => {
    const ledger = new MemoryLedger()
    const record = baseRecord()
    const store = new MemoryRecoveryRecordStore(record)
    const [first, second] = await Promise.all([
      applyRecoveryIntent({
        intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
        ...serverContext(record, standardRecoverySession, store),
        ledger,
        now,
        auditId: nextAuditId(),
      }),
      applyRecoveryIntent({
        intent: intentFor(record, "take_ownership", { new_owner: { owner_type: "operator_user", owner_id: OPERATOR } }),
        ...serverContext(record, standardRecoverySession, store),
        ledger,
        now,
        auditId: nextAuditId(),
      }),
    ])

    expect([first.outcome, second.outcome].sort()).toEqual(["applied", "refused_version_conflict"])
    expect(first.domain_effects + second.domain_effects).toBe(1)
    expect(store.readForRecovery({
      population_type: record.population_type,
      population_id: record.population_id,
      instance_id: record.instance_id,
    })?.version).toBe(2)
    expectAuditValid(first.audit)
    expectAuditValid(second.audit)
  })

  it("przejście w stan terminalny bez evidence → refused_missing_evidence (zmiana stanu nie jest dowodem)", async () => {
    const record = baseRecord()
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered" }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_missing_evidence")
    expect(result.domain_effects).toBe(0)
    expect(result.record.state).toBe("open")
    expectAuditValid(result.audit)
  })

  it("przejście w stan terminalny Z evidence → applied, evidence w wierszu i w audycie", async () => {
    const record = baseRecord()
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered", resolution_evidence: evidenceFor(OPERATOR) }),
      ...serverContext(record),
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

  it("evidence wskazujące innego aktora niż sesja jest odmową bez skutku", async () => {
    const record = baseRecord()
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered", resolution_evidence: evidenceFor(OUTSIDER) }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expectAuditValid(result.audit)
  })

  it("niepoświadczony reference evidence nie może zamknąć rekordu terminalnego", async () => {
    const record = baseRecord()
    const forgedEvidence = { ...evidenceFor(OPERATOR), reference: "pi_forged:pretend-recovered" }
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "resolve", { target_state: "resolved_recovered", resolution_evidence: forgedEvidence }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expectAuditValid(result.audit)
  })

  it("rekord dociera wyłącznie z store pod RLS; wstrzyknięty body record jest ignorowany", async () => {
    const record = baseRecord()
    const forgedRecord = { ...record, instance_id: "gp-prod-us1", market_id: "attacker-market" }
    const input = {
      intent: intentFor(record, "escalate", { target_state: "recovery_in_progress" }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
      record: forgedRecord,
    } as unknown as ApplyRecoveryIntentInput
    const result = await applyRecoveryIntent(input)
    expect(result.outcome).toBe("applied")
    expect(result.record.instance_id).toBe(SESSION_INSTANCE)
    expect(result.record.market_id).toBe("bonbeauty")
    expectAuditValid(result.audit)
  })

  it("zabronione przejście (terminalny → cokolwiek) → refused_invalid_transition", async () => {
    const record: RecoveryRecordView = { ...baseRecord(), state: "resolved_recovered", version: 3, resolution_evidence: evidenceFor(OPERATOR) }
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "retry", { target_state: "open" }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expectAuditValid(result.audit)
  })

  it("stan legacy nie jest osiągalny akcją (tylko backfill)", async () => {
    const record = baseRecord()
    const legacy: ResolutionEvidence = { ...evidenceFor(OPERATOR), kind: "legacy_manual_resolution" }
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "resolve", { target_state: "closed_legacy_unevidenced", resolution_evidence: legacy }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
  })

  it("retry zwiększa retry_count wiersza o 1 i wersję o 1", async () => {
    const record: RecoveryRecordView = { ...baseRecord(), population_type: "dlq_entry", population_id: "dlq_01", state: "dlq_pending_retry", retry_count: 3 }
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "retry", { target_state: "dlq_pending_ops_review" }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("applied")
    expect(result.record.retry_count).toBe(4)
    expect(result.record.version).toBe(2)
  })

  it("take_ownership zmienia właściciela w wierszu i w after audytu", async () => {
    const record = baseRecord()
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "take_ownership", { new_owner: { owner_type: "operator_user", owner_id: OPERATOR } }),
      ...serverContext(record),
      ledger: new MemoryLedger(),
      now,
      auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("applied")
    expect(result.record.owner).toEqual({ owner_type: "operator_user", owner_id: OPERATOR })
    expect(result.audit.after.owner).toEqual({ owner_type: "operator_user", owner_id: OPERATOR })
    expectAuditValid(result.audit)
  })

  it.each([" ", "default", "UNKNOWN", "bad owner"])("take_ownership odrzuca owner_id=%p", async (ownerId) => {
    const record = baseRecord()
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "take_ownership", { new_owner: { owner_type: "operator_user", owner_id: ownerId } }),
      ...serverContext(record), ledger: new MemoryLedger(), now, auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
  })

  it("take_ownership nie zmienia ownera rekordu terminalnego", async () => {
    const record = { ...baseRecord(), state: "resolved_recovered", resolution_evidence: evidenceFor(OPERATOR) }
    const result = await applyRecoveryIntent({
      intent: intentFor(record, "take_ownership", { new_owner: { owner_type: "operator_user", owner_id: OPERATOR } }),
      ...serverContext(record), ledger: new MemoryLedger(), now, auditId: nextAuditId(),
    })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.record.owner).toEqual(record.owner)
  })

  it("runtime odrzuca action spoza zamkniętego słownika", async () => {
    const record = baseRecord()
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress" })
    ;(intent as unknown as { action: string }).action = "force_close"
    const result = await applyRecoveryIntent({ intent, ...serverContext(record), ledger: new MemoryLedger(), now, auditId: nextAuditId() })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expect(result.audit.action).toBe("escalate")
    expectAuditValid(result.audit)
  })

  it("nieznana action z wadliwym kluczem zapisuje schematyczny audit odmowy, nie surowe body", async () => {
    const record = baseRecord()
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress", idempotency_key: "garbage" })
    ;(intent as unknown as { action: string }).action = "force_close"
    const result = await applyRecoveryIntent({ intent, ...serverContext(record), ledger: new MemoryLedger(), now, auditId: nextAuditId() })
    expect(result.outcome).toBe("refused_invalid_transition")
    expect(result.domain_effects).toBe(0)
    expect(result.audit.action).toBe("retry")
    expect(result.audit.idempotency_key).toBe(buildRecoveryIdempotencyKey({
      population_type: record.population_type,
      population_id: record.population_id,
      action: "retry",
      expected_version: record.version,
    }))
    expectAuditValid(result.audit)
  })

  it("ledger atomowo claimuje scoped key i nie uruchamia skutku drugi raz", async () => {
    const ledger = new MemoryLedger()
    let calls = 0
    const record = baseRecord()
    const intent = intentFor(record, "escalate", { target_state: "recovery_in_progress" })
    const operation = async () => {
      calls += 1
      return await applyRecoveryIntent({ intent, ...serverContext(record), ledger: new MemoryLedger(), now, auditId: nextAuditId() })
    }
    const scope = { instance_id: SESSION_INSTANCE, market_id: "other-market" }
    const [first, second] = await Promise.all([
      ledger.executeOnce(scope, intent.idempotency_key, operation),
      ledger.executeOnce(scope, intent.idempotency_key, operation),
    ])
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(calls).toBe(1)
    expect(ledger.applied.size).toBe(1)
  })
})

// ── test-the-test: rozluźnienie kontraktu musi pękać ────────────────────────────

describe("test-the-test: klucz idempotencji musi wynikać z intencji", () => {
  it("klucz podany przez klienta (nie z intencji) → błąd, nie skutek", async () => {
    const record = baseRecord()
    const intent = { ...intentFor(record, "escalate", { target_state: "recovery_in_progress" }), idempotency_key: "client-chosen-key" }
    await expect(
      applyRecoveryIntent({ intent, ...serverContext(record), ledger: new MemoryLedger(), now: "2026-09-06T12:00:00Z", auditId: nextAuditId() })
    ).rejects.toThrow(/idempotency_key/)
  })

  it("expected_version < 1 albo niecałkowite → klucz nie powstaje", async () => {
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: "dlq_01", action: "retry", expected_version: 0 })).toThrow(/expected_version/)
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: "dlq_01", action: "retry", expected_version: 1.5 })).toThrow(/expected_version/)
  })

  it("population_id z dwukropkiem → klucz niejednoznaczny → błąd", async () => {
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: "a:b", action: "retry", expected_version: 1 })).toThrow(/konkretnym identyfikatorem/)
  })

  it.each(["unknown", "default", "UNASSIGNED"])("population_id=%s nie może być wartością zastępczą", (populationId) => {
    expect(() => buildRecoveryIdempotencyKey({ population_type: "dlq_entry", population_id: populationId, action: "retry", expected_version: 1 })).toThrow(/konkretnym identyfikatorem/)
  })

  it("intencja wskazująca inny wiersz niż rekord → błąd", async () => {
    const record = baseRecord()
    const other = { ...baseRecord(), population_id: "mpcf_OTHER" }
    const intent = intentFor(other, "escalate", { target_state: "recovery_in_progress" })
    await expect(
      applyRecoveryIntent({ intent, ...serverContext(record), ledger: new MemoryLedger(), now: "2026-09-06T12:00:00Z", auditId: nextAuditId() })
    ).rejects.toThrow(RecoveryRecordNotFoundError)
  })
})

// ── Story 11.3 AC-4 (rozszerzenie): klucze kroków D-37, wiązanie evidence, reguły w backendzie ──
import {
  EVIDENCE_KINDS_BY_TARGET,
  httpStatusForStepOutcome,
  RECOVERY_ACTION_TARGETS,
  stepKey,
  verifyEvidenceBinding,
} from "../../lib/recovery/recovery-action-runtime"
import { RECOVERY_TRANSITIONS } from "../../lib/recovery/recovery-action-contract"

describe("Story 11.3 — kontrakt kroków propose → approve (D-37)", () => {
  const intentKey = buildRecoveryIdempotencyKey({
    population_type: "compensation_failure",
    population_id: "mpcf_1",
    action: "retry",
    expected_version: 1,
  })

  it("propose i approve mają OSOBNE klucze idempotencji wyprowadzone z tej samej intencji", () => {
    expect(stepKey("propose", intentKey)).toBe(`propose:${intentKey}`)
    expect(stepKey("approve", intentKey)).toBe(`approve:${intentKey}`)
    expect(stepKey("propose", intentKey)).not.toBe(stepKey("approve", intentKey))
  })

  it("każdy cel retry/resolve jest dozwolonym przejściem tabeli 4.1, a każdy cel terminalny ma rodzaj evidence", () => {
    for (const [population, pairs] of Object.entries(RECOVERY_ACTION_TARGETS)) {
      for (const targets of Object.values(pairs)) {
        for (const target of targets) {
          const fromAny = Object.keys(RECOVERY_TRANSITIONS[population as keyof typeof RECOVERY_TRANSITIONS].allowed).some((from) =>
            RECOVERY_TRANSITIONS[population as keyof typeof RECOVERY_TRANSITIONS].allowed[from].includes(target)
          )
          expect(fromAny).toBe(true)
          if (RECOVERY_TRANSITIONS[population as keyof typeof RECOVERY_TRANSITIONS].terminal.includes(target)) {
            expect(EVIDENCE_KINDS_BY_TARGET[target]?.length).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it("evidence związane z faktem wiersza: obca płatność / obce zdarzenie ⇒ odmowa", () => {
    const actor = { actor_type: "user" as const, actor_id: "u", auth_identity_id: null, session_source: "medusa_admin_session" as const }
    const ev = (kind: "refund_confirmed" | "replayed_successfully" | "written_off_with_approval", reference: string) => ({
      kind,
      reference,
      recorded_at: "2026-11-15T00:00:00Z",
      recorded_by: actor,
    })
    expect(verifyEvidenceBinding(ev("refund_confirmed", "pi_1"), "compensation_failure", "resolved_recovered", { payment_intent_id: "pi_1" })).toBe(true)
    expect(verifyEvidenceBinding(ev("refund_confirmed", "pi_2"), "compensation_failure", "resolved_recovered", { payment_intent_id: "pi_1" })).toBe(false)
    expect(verifyEvidenceBinding(ev("written_off_with_approval", "INC-1"), "compensation_failure", "resolved_recovered", { payment_intent_id: "pi_1" })).toBe(false)
    expect(verifyEvidenceBinding(ev("replayed_successfully", "evt_1"), "dlq_entry", "replayed", { event_id: "evt_1" })).toBe(true)
    expect(verifyEvidenceBinding(ev("replayed_successfully", "evt_1"), "dlq_entry", "replayed", { event_id: null })).toBe(false)
  })

  it("konflikt jest jawny (409), odmowa rynku 403, powtórka 200", () => {
    expect(httpStatusForStepOutcome("refused_version_conflict")).toBe(409)
    expect(httpStatusForStepOutcome("refused_market_forbidden")).toBe(403)
    expect(httpStatusForStepOutcome("replayed")).toBe(200)
    expect(httpStatusForStepOutcome("proposed")).toBe(201)
  })

  it("AC-4: żadna reguła domenowa recovery nie mieszka w CLI (gp-ops/cli/src)", () => {
    const cliRoot = path.resolve(__dirname, "../../../../../../../gp-ops/cli/src")
    const hits: string[] = []
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|js)$/.test(entry.name) && /RECOVERY_TRANSITIONS|resolved_recovered|closed_order_never_created|discarded_with_evidence|EVIDENCE_KINDS_BY_TARGET/.test(fs.readFileSync(p, "utf8"))) hits.push(p)
      }
    }
    walk(cliRoot)
    expect(fs.existsSync(cliRoot)).toBe(true)
    expect(hits).toEqual([])
  })
})
