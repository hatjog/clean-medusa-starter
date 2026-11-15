/**
 * v1.16.0 Story 4.7 AC1/AC2 (unit) — GET /admin/recovery: łańcuch `withOperatorAuth`
 * (401/403), odmowa bez rynku, odmowa rynku spoza uprawnień PRZED zapytaniem,
 * redakcja `reason` DLQ (DW-15-321 p.2).
 */
import { afterEach, describe, expect, it } from "@jest/globals"

import { GET, handleRecoveryRead, RECOVERY_READ_CODES } from "../route"
import { __setKnexForAdminMarketTests } from "../../../../lib/admin-market-context"
import { classifyEventFailure } from "../../../../lib/events/event-failure-classification"

type Res = { statusCode: number; body: unknown; status: (c: number) => Res; json: (b: unknown) => Res }
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

/** Knex-mock: grant `admin_market_grants` tylko dla (actor, market) z listy; brak super-admina. */
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
        table === "admin_market_grants" &&
        grants.some(([a, m]) => a === where.admin_user_id && m === where.market_id)
          ? [{ admin_user_id: where.admin_user_id }]
          : [],
      then: (ok: (v: unknown[]) => unknown) => ok([]),
    }
    return q
  }
  return builder as unknown as Parameters<typeof __setKnexForAdminMarketTests>[0]
}

function req(opts: { actor_type?: string; market?: string; header?: string; auth?: boolean } = {}) {
  return {
    auth_context: opts.auth === false ? undefined : { actor_id: "user_a", actor_type: opts.actor_type ?? "user" },
    query: opts.market ? { market_id: opts.market } : {},
    headers: opts.header ? { "x-gp-market-id": opts.header } : {},
    scope: { resolve: () => ({ warn: () => undefined, error: () => undefined, info: () => undefined }) },
  } as never
}

afterEach(() => __setKnexForAdminMarketTests(undefined))

describe("Story 4.7 — GET /admin/recovery (withOperatorAuth)", () => {
  it("401 bez sesji", async () => {
    const r = res()
    await GET(req({ auth: false }), r as never, (() => undefined) as never)
    expect(r.statusCode).toBe(401)
  })

  it("403 dla sellera (ten sam łańcuch withOperatorAuth co 4.1)", async () => {
    const r = res()
    await GET(req({ actor_type: "seller", market: "mkt_a" }), r as never, (() => undefined) as never)
    expect(r.statusCode).toBe(403)
  })
})

describe("Story 4.7 — kontrola rynku przed zapytaniem", () => {
  const neverQuery = () => {
    throw new Error("zapytanie nie może wystartować przed autoryzacją rynku")
  }

  it("brak market_id ⇒ 400 recovery_market_required (bez rynku domyślnego), bez zapytania", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_a", "mkt_a"]]))
    const r = res()
    await handleRecoveryRead(req(), r as never, { queryFor: neverQuery, instanceId: () => "gp_test" })
    expect(r.statusCode).toBe(400)
    expect((r.body as { code: string }).code).toBe(RECOVERY_READ_CODES.marketRequired)
  })

  it("rynek spoza uprawnień ⇒ 403 recovery_market_forbidden, nie 200 []", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_a", "mkt_a"]]))
    const r = res()
    await handleRecoveryRead(req({ market: "mkt_b" }), r as never, { queryFor: neverQuery, instanceId: () => "gp_test" })
    expect(r.statusCode).toBe(403)
    expect((r.body as { code: string }).code).toBe(RECOVERY_READ_CODES.marketForbidden)
  })

  it("rozbieżny rynek query vs nagłówek ⇒ 400 recovery_market_ambiguous", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_a", "mkt_a"]]))
    const r = res()
    await handleRecoveryRead(req({ market: "mkt_a", header: "mkt_b" }), r as never, { queryFor: neverQuery })
    expect(r.statusCode).toBe(400)
    expect((r.body as { code: string }).code).toBe(RECOVERY_READ_CODES.marketAmbiguous)
  })

  it("brak GP_INSTANCE_ID ⇒ 503 recovery_instance_unconfigured", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_a", "mkt_a"]]))
    const r = res()
    await handleRecoveryRead(req({ market: "mkt_a" }), r as never, { queryFor: neverQuery, instanceId: () => null })
    expect(r.statusCode).toBe(503)
    expect((r.body as { code: string }).code).toBe(RECOVERY_READ_CODES.instanceUnconfigured)
  })

  it("uprawniony rynek ⇒ 200 z trzema populacjami; wiersz spoza scope'u ⇒ 503 (odmowa, nie filtr)", async () => {
    __setKnexForAdminMarketTests(knexWithGrants([["user_a", "mkt_a"]]))
    const ok = res()
    await handleRecoveryRead(req({ market: "mkt_a" }), ok as never, {
      instanceId: () => "gp_test",
      queryFor: () => async () => ({ rows: [] }),
    })
    expect(ok.statusCode).toBe(200)
    // Story 4.8 AC1 (AD-31): 200 niesie aktora odczytu.
    expect((ok.body as { actor_id?: string }).actor_id).toBe("user_a")
    expect(Object.keys((ok.body as { populations: object }).populations).sort()).toEqual([
      "compensation_failure",
      "deferred_issuance_trace",
      "dlq_entry",
    ])

    const leak = res()
    await handleRecoveryRead(req({ market: "mkt_a" }), leak as never, {
      instanceId: () => "gp_test",
      queryFor: () => async <T>(sql: string) =>
        ({
          rows: sql.includes("deferred_issuance_trace")
            ? ([
                {
                  population_id: "evt_x#deferred-issuance",
                  instance_id: "gp_test",
                  market_id: "mkt_b",
                  state: "awaiting_order",
                  owner_type: "operator_role",
                  owner_id: "ops-recovery",
                  deadline: "2026-11-15T00:00:00Z",
                  retry_count: 0,
                  resolution_evidence: null,
                  version: 1,
                  occurred_at: "2026-11-14T00:00:00Z",
                  closure_path: "not_closed",
                  provenance_kind: "runtime_observed",
                  provenance_source: "x",
                  payment_intent_id: "pi",
                  stripe_event_id: "evt_x",
                  deferral_reason: "webhook_before_order",
                  psp_occurred_at: "2026-11-14T00:00:00Z",
                  age_source: "database_now_minus_occurred_at",
                },
              ] as unknown as T[])
            : [],
        }),
    })
    expect(leak.statusCode).toBe(503)
    expect((leak.body as { cause: string }).cause).toBe("recovery_scope_violation")
  })
})

describe("Story 4.7 — DW-15-321 p.2: redakcja reason DLQ", () => {
  it("komunikat PG klasy 22 cytujący wartość wejścia NIE trafia do reason", () => {
    const secret = "jan.kowalski@example.com"
    const err = Object.assign(new Error(`invalid input syntax for type uuid: "${secret}"`), { code: "22P02" })
    const c = classifyEventFailure(err)
    expect(c.event_class).toBe("permanent_data_defect")
    expect(c.reason).toBe("permanent_data_defect:sqlstate_22P02:Error")
    expect(c.reason).not.toContain(secret)
  })

  it("nieznany błąd: tylko klasa i typ", () => {
    const c = classifyEventFailure(new Error("PESEL 90010112345 w komunikacie"))
    expect(c.reason).toBe("unknown_fail_closed:Error")
  })
})
