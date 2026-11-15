/**
 * v1.16.0 Story 11.3 AC-1/AC-4 (unit) — POST /admin/recovery/:population/:id/propose|approve:
 * aktor WYŁĄCZNIE z sesji (`withOperatorAuth`), pole aktora w body odrzucone,
 * 401 z wrappera bez wywołania handlera (DW-15-341 p.2, także GET 4.7),
 * odmowa rynku przed transakcją.
 */
import { afterEach, describe, expect, it } from "@jest/globals"

import { POST as PROPOSE } from "../[population]/[id]/propose/route"
import { POST as APPROVE } from "../[population]/[id]/approve/route"
import { GET } from "../route"
import { __setKnexForAdminMarketTests } from "../../../../lib/admin-market-context"
import {
  ACTOR_BODY_FIELDS,
  handleRecoveryStep,
  parseRecoveryStepBody,
  RECOVERY_ACTION_CODES,
  type RecoveryTransaction,
} from "../../../../lib/recovery/recovery-action-http"
import { withOperatorAuth } from "../../../../middlewares/with-operator-auth"

type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res }
function res(): Res {
  const r: Res = {
    statusCode: 200,
    body: undefined,
    status(c) {
      r.statusCode = c
      return r
    },
    json(b) {
      r.body = b
      return r
    },
  }
  return r
}

function knexWithGrants(grants: Array<[string, string]>) {
  const builder = (table: string) => {
    const where: Record<string, unknown> = {}
    const q = {
      select: () => q,
      where: (k: string, v: unknown) => {
        where[k] = v
        return q
      },
      whereNull: () => q,
      andWhere: () => q,
      first: async () => undefined,
      limit: async () =>
        table === "admin_market_grants" && grants.some(([a, m]) => a === where.admin_user_id && m === where.market_id)
          ? [{ admin_user_id: where.admin_user_id }]
          : [],
      then: (ok: (v: unknown[]) => unknown) => ok([]),
    }
    return q
  }
  return builder as unknown as Parameters<typeof __setKnexForAdminMarketTests>[0]
}

const silent = { resolve: () => ({ warn: () => undefined, error: () => undefined, info: () => undefined }) }

function req(opts: { auth?: boolean; body?: unknown; market?: string; actor?: string } = {}) {
  return {
    auth_context: opts.auth === false ? undefined : { actor_id: opts.actor ?? "user_a", actor_type: "user" },
    params: { population: "compensation_failure", id: "mpcf_1" },
    query: { market_id: opts.market ?? "mkt_a" },
    headers: {},
    body: opts.body ?? { action: "retry", target_state: "recovery_in_progress", expected_version: 1 },
    scope: silent,
  } as never
}

const forbiddenTransaction: RecoveryTransaction = async () => {
  throw new Error("transakcja nie może wystartować")
}

afterEach(() => __setKnexForAdminMarketTests(undefined))

describe("Story 11.3 — 401 z wrappera withOperatorAuth (handler niewywołany)", () => {
  for (const [name, route] of [
    ["propose", PROPOSE],
    ["approve", APPROVE],
    ["GET 4.7", GET],
  ] as const) {
    it(`${name}: brak sesji ⇒ 401 z kodem wrappera, bez kodu handlera`, async () => {
      const r = res()
      await route(req({ auth: false }), r as never, (() => undefined) as never)
      expect(r.statusCode).toBe(401)
      expect(r.body).toEqual({ message: "Unauthorized — valid admin session required" })
    })
  }

  it("handler wywołany bez operatorAuth (ominięty wrapper) też odmawia 401", async () => {
    const r = res()
    await handleRecoveryStep("propose", req() as never, r as never, { transaction: forbiddenTransaction })
    expect(r.statusCode).toBe(401)
    expect(r.body.code).toBe(RECOVERY_ACTION_CODES.unauthenticated)
  })
})

describe("Story 11.3 — aktor z sesji, nie z body", () => {
  for (const field of ACTOR_BODY_FIELDS) {
    it(`pole "${field}" w body ⇒ 400 ${RECOVERY_ACTION_CODES.actorInBody}`, () => {
      const parsed = parseRecoveryStepBody("propose", "compensation_failure", "mpcf_1", {
        action: "retry",
        target_state: "recovery_in_progress",
        expected_version: 1,
        [field]: "user_spoof",
      })
      expect(parsed).toEqual(expect.objectContaining({ ok: false, code: RECOVERY_ACTION_CODES.actorInBody }))
    })
  }

  it("recorded_by w evidence ⇒ 400 (poświadczenie wypełnia serwer)", () => {
    const parsed = parseRecoveryStepBody("propose", "compensation_failure", "mpcf_1", {
      action: "resolve",
      target_state: "closed_unrecoverable",
      expected_version: 1,
      evidence: { kind: "written_off_with_approval", reference: "INC-1", recorded_by: { actor_id: "x" } },
    })
    expect(parsed).toEqual(expect.objectContaining({ ok: false, code: RECOVERY_ACTION_CODES.actorInBody }))
  })

  it("approve z evidence w body ⇒ 400 (evidence należy do propozycji)", () => {
    const parsed = parseRecoveryStepBody("approve", "compensation_failure", "mpcf_1", {
      action: "resolve",
      target_state: "closed_unrecoverable",
      expected_version: 1,
      evidence: { kind: "written_off_with_approval", reference: "INC-1" },
    })
    expect(parsed.ok).toBe(false)
  })

  it("akcja spoza pary retry/resolve ⇒ 400", () => {
    const parsed = parseRecoveryStepBody("propose", "compensation_failure", "mpcf_1", {
      action: "take_ownership",
      target_state: "open",
      expected_version: 1,
    })
    expect(parsed.ok).toBe(false)
  })

  it("propose zapisuje aktora z req.operatorAuth (sesja), nie z body", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_session", "mkt_a"]]))
    const inserted: unknown[][] = []
    const transaction: RecoveryTransaction = async (_req, _scope, fn) =>
      fn({
        query: async (sql: string, values?: ReadonlyArray<unknown>) => {
          if (/^\s*SELECT failure_id AS population_id/.test(sql)) {
            return {
              rows: [
                {
                  population_id: "mpcf_1",
                  instance_id: "gp_test",
                  market_id: "mkt_a",
                  state: "open",
                  owner_type: "operator_role",
                  owner_id: "ops-recovery",
                  version: 1,
                  retry_count: 0,
                  resolution_evidence: null,
                  payment_intent_id: "pi_1",
                },
              ] as never[],
            }
          }
          if (/INSERT INTO recovery_action_step/.test(sql)) inserted.push([...(values ?? [])])
          return { rows: [] }
        },
      })
    const r = res()
    const route = withOperatorAuth((rq, rs) =>
      handleRecoveryStep("propose", rq, rs, { transaction, instanceId: () => "gp_test", newAuditId: () => "aud_1", now: () => "2026-11-15T00:00:00.000Z" })
    )
    await route(req({ actor: "user_session" }), r as never, (() => undefined) as never)
    expect(r.statusCode).toBe(201)
    expect(r.body.outcome).toBe("proposed")
    expect(inserted).toHaveLength(1)
    expect(inserted[0][11]).toBe("user_session")
    expect(JSON.parse(String(inserted[0][12]))).toEqual(
      expect.objectContaining({ actor_id: "user_session", session_source: "medusa_admin_session" })
    )
  })

  it("rynek spoza uprawnień ⇒ 403 przed transakcją", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_a", "mkt_a"]]))
    const r = res()
    const route = withOperatorAuth((rq, rs) => handleRecoveryStep("approve", rq, rs, { transaction: forbiddenTransaction, instanceId: () => "gp_test" }))
    await route(req({ market: "mkt_b" }), r as never, (() => undefined) as never)
    expect(r.statusCode).toBe(403)
    expect(r.body.code).toBe(RECOVERY_ACTION_CODES.marketForbidden)
  })
})
