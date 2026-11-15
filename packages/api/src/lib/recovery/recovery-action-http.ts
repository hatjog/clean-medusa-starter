/**
 * recovery-action-http.ts — v1.16.0 Story 11.3: granica HTTP kroków `propose` / `approve`
 * (POST /admin/recovery/:population/:id/propose|approve).
 *
 * Kolejność (fail-closed, nazwane kody):
 *   1. `withOperatorAuth` (trasa) — 401 bez sesji; aktor WYŁĄCZNIE z `req.operatorAuth`.
 *   2. Body z polem aktora (`actor`, `actor_id`, `recorded_by`, …) = 400
 *      `recovery_actor_in_body_rejected` — body nie jest źródłem aktora.
 *   3. `market_id` (query albo `x-gp-market-id`) wymagany, bez domyślnego;
 *      uprawnienie aktora do rynku (`resolveAdminMarketContext`) przed zapytaniem.
 *   4. Transakcja na rozłącznym połączeniu pod kontekstem rynku (RLS
 *      `market_isolation`, rola `medusa_store`); GUC zweryfikowane przed SQL.
 */
import { randomUUID } from "crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { resolveAdminMarketContext } from "../admin-market-context"
import { marketContextStorage, resolveRuntimeInstanceId } from "../market-context"
import { acquireFreshPgConnection, RlsScopedReadError, RLS_CONTEXT_NOT_APPLIED } from "../payment/stripe-payment-intent-transport"
import { GP_INSTANCE_SESSION_VAR, GP_MARKET_SESSION_VAR } from "../rls-pool-hook"
import type { OperatorAuthContext } from "../../middlewares/with-operator-auth"
import { RECOVERY_POPULATION_TYPES, type RecoveryPopulationType } from "./recovery-action-contract"
import {
  approveRecoveryAction,
  EXPOSED_RECOVERY_ACTIONS,
  httpStatusForStepOutcome,
  proposeRecoveryAction,
  type ExposedRecoveryAction,
  type RecoveryActionClient,
  type RecoveryStep,
  type RecoveryStepRequest,
  type RecoveryStepResult,
} from "./recovery-action-runtime"
import { publicDomainAdapterResult } from "./recovery-domain-adapters"

export const RECOVERY_ACTION_CODES = {
  marketRequired: "recovery_market_required",
  marketAmbiguous: "recovery_market_ambiguous",
  marketForbidden: "recovery_market_forbidden",
  unauthenticated: "recovery_unauthenticated",
  instanceUnconfigured: "recovery_instance_unconfigured",
  actorInBody: "recovery_actor_in_body_rejected",
  invalidRequest: "recovery_action_invalid_request",
  actionFailed: "recovery_action_failed",
} as const

/** Pola, które podszywałyby się pod aktora/poświadczenie — odrzucane, nie ignorowane. */
export const ACTOR_BODY_FIELDS = ["actor", "actor_id", "actor_type", "recorded_by", "operator", "auth_identity_id", "approved_by", "proposed_by"] as const

export type RecoveryTransaction = <T>(
  req: MedusaRequest,
  scope: { instance_id: string; market_id: string },
  fn: (client: RecoveryActionClient) => Promise<T>
) => Promise<T>

export type RecoveryActionHttpDeps = {
  instanceId?: () => string | null
  transaction?: RecoveryTransaction
  now?: () => string
  newAuditId?: () => string
}

/** Transakcja pod kontekstem RLS rynku: BEGIN … COMMIT na połączeniu z GUC tego rynku. */
export const defaultRecoveryTransaction: RecoveryTransaction = (req, scope, fn) =>
  marketContextStorage.run({ market_id: scope.market_id, instance_id: scope.instance_id }, async () => {
    const connection = await acquireFreshPgConnection(req.scope as unknown as { resolve: (key: string) => unknown })
    if (!connection) throw new RlsScopedReadError("pg_connection_unavailable", "brak rozłącznego połączenia PG dla akcji recovery")
    const client = connection.client as unknown as RecoveryActionClient
    try {
      const guc = await client.query<{ market_id: string | null; instance_id: string | null }>(
        `SELECT current_setting('${GP_MARKET_SESSION_VAR}', true) AS market_id, current_setting('${GP_INSTANCE_SESSION_VAR}', true) AS instance_id`,
        []
      )
      if (guc.rows[0]?.market_id !== scope.market_id || guc.rows[0]?.instance_id !== scope.instance_id) {
        throw new RlsScopedReadError(RLS_CONTEXT_NOT_APPLIED, "połączenie nie niesie kontekstu RLS żądanego rynku/instancji")
      }
      await client.query("BEGIN", [])
      try {
        const result = await fn(client)
        await client.query("COMMIT", [])
        return result
      } catch (err) {
        await client.query("ROLLBACK", []).catch((rollbackErr: unknown) => {
          // Pierwotny błąd idzie dalej; porażka ROLLBACK jest dopisana do niego (NFR-4: nie ginie).
          ;(err as { rollback_error?: string }).rollback_error = String((rollbackErr as Error)?.message ?? rollbackErr)
        })
        throw err
      }
    } finally {
      connection.release()
    }
  })

type Logger = { error?: (m: string) => void; warn?: (m: string) => void }

function logger(req: MedusaRequest): Logger {
  try {
    return (req.scope?.resolve("logger") as Logger | undefined) ?? console
  } catch {
    return console
  }
}

function param(req: MedusaRequest, name: string): string {
  const v = (req.params as Record<string, unknown> | undefined)?.[name]
  return typeof v === "string" ? v : ""
}

function requestedMarket(req: MedusaRequest): { market: string | null; ambiguous: boolean } {
  const raw = (req.query as Record<string, unknown> | undefined)?.market_id
  const q = Array.isArray(raw) ? raw[0] : raw
  const fromQuery = typeof q === "string" && q.trim() ? q.trim() : null
  const h = req.headers?.["x-gp-market-id"]
  const fromHeader = typeof h === "string" && h.trim() ? h.trim() : null
  if (fromQuery && fromHeader && fromQuery !== fromHeader) return { market: null, ambiguous: true }
  return { market: fromQuery ?? fromHeader, ambiguous: false }
}

export type ParsedStepBody = { ok: true; request: RecoveryStepRequest } | { ok: false; code: string; message: string }

export function parseRecoveryStepBody(step: RecoveryStep, population: string, id: string, body: unknown): ParsedStepBody {
  const invalid = (message: string): ParsedStepBody => ({ ok: false, code: RECOVERY_ACTION_CODES.invalidRequest, message })
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("body musi być obiektem")
  const b = body as Record<string, unknown>
  const evidenceRaw = b.evidence as Record<string, unknown> | undefined | null
  const actorField = ACTOR_BODY_FIELDS.find(
    (f) => Object.prototype.hasOwnProperty.call(b, f) || (evidenceRaw && typeof evidenceRaw === "object" && Object.prototype.hasOwnProperty.call(evidenceRaw, f))
  )
  if (actorField) {
    return { ok: false, code: RECOVERY_ACTION_CODES.actorInBody, message: `pole "${actorField}" w body — aktor pochodzi wyłącznie z sesji` }
  }
  if (!(RECOVERY_POPULATION_TYPES as readonly string[]).includes(population)) return invalid(`nieznana populacja "${population}"`)
  if (!(EXPOSED_RECOVERY_ACTIONS as readonly string[]).includes(String(b.action))) return invalid("action musi być retry albo resolve")
  if (typeof b.target_state !== "string" || !b.target_state) return invalid("target_state wymagany")
  if (!Number.isInteger(b.expected_version) || (b.expected_version as number) < 1) return invalid("expected_version musi być całkowite >= 1")
  if (!id) return invalid("brak identyfikatora wiersza")
  let evidence: RecoveryStepRequest["evidence"] = null
  if (evidenceRaw !== undefined && evidenceRaw !== null) {
    if (step === "approve") return invalid("approve nie przyjmuje evidence — skutek wykonuje propozycja")
    if (typeof evidenceRaw !== "object" || typeof evidenceRaw.kind !== "string" || typeof evidenceRaw.reference !== "string") {
      return invalid("evidence wymaga kind i reference")
    }
    evidence = { kind: evidenceRaw.kind as never, reference: evidenceRaw.reference }
  }
  return {
    ok: true,
    request: {
      population_type: population as RecoveryPopulationType,
      population_id: id,
      action: b.action as ExposedRecoveryAction,
      target_state: b.target_state,
      expected_version: b.expected_version as number,
      evidence,
    },
  }
}

export async function handleRecoveryStep(
  step: RecoveryStep,
  req: MedusaRequest & { operatorAuth?: OperatorAuthContext },
  res: MedusaResponse,
  deps: RecoveryActionHttpDeps = {}
): Promise<void> {
  const log = logger(req)
  if (!req.operatorAuth) {
    res.status(401).json({ code: RECOVERY_ACTION_CODES.unauthenticated, message: "brak sesji operatora" })
    return
  }
  const parsed = parseRecoveryStepBody(step, param(req, "population"), param(req, "id"), req.body)
  if (!parsed.ok) {
    res.status(400).json({ code: parsed.code, message: parsed.message })
    return
  }
  const { market, ambiguous } = requestedMarket(req)
  if (ambiguous) {
    res.status(400).json({ code: RECOVERY_ACTION_CODES.marketAmbiguous, message: "market_id w query i nagłówku różnią się" })
    return
  }
  if (!market) {
    res.status(400).json({ code: RECOVERY_ACTION_CODES.marketRequired, message: "market_id jest wymagany; brak rynku domyślnego" })
    return
  }
  const ctx = await resolveAdminMarketContext(req, { intrinsicMarketId: market })
  if (!ctx.ok || ctx.market_id !== market) {
    if (!ctx.ok && ctx.status === 401) {
      res.status(401).json({ code: RECOVERY_ACTION_CODES.unauthenticated, message: ctx.message })
      return
    }
    log.warn?.(`[admin-recovery-action] code=${RECOVERY_ACTION_CODES.marketForbidden} market_id=${market}`)
    res.status(403).json({ code: RECOVERY_ACTION_CODES.marketForbidden, market_id: market })
    return
  }
  const instanceId = (deps.instanceId ?? (() => resolveRuntimeInstanceId()))()
  if (!instanceId) {
    res.status(503).json({ code: RECOVERY_ACTION_CODES.instanceUnconfigured, message: "GP_INSTANCE_ID nieustawione" })
    return
  }
  const scope = { instance_id: instanceId, market_id: market }
  const stepDeps = { now: deps.now ?? (() => new Date().toISOString()), newAuditId: deps.newAuditId ?? (() => `rcv_${randomUUID()}`) }
  const session = { operatorAuth: req.operatorAuth, marketContext: ctx, instanceId }
  try {
    const result: RecoveryStepResult = await (deps.transaction ?? defaultRecoveryTransaction)(req, scope, (client) =>
      step === "propose"
        ? proposeRecoveryAction(client, session, parsed.request, stepDeps)
        : approveRecoveryAction(client, session, parsed.request, stepDeps)
    )
    // R-13: szczegół adaptera (`detail`) nie wychodzi do klienta — zostaje w audycie kroku.
    const body = result.domain_adapter ? { ...result, domain_adapter: publicDomainAdapterResult(result.domain_adapter) } : result
    res.status(httpStatusForStepOutcome(result.outcome)).json(body)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    log.error?.(
      `[admin-recovery-action] code=${RECOVERY_ACTION_CODES.actionFailed} step=${step} market_id=${market} cause=${String(code ?? "unknown")}: ${(err as Error).message}`
    )
    res.status(503).json({ code: RECOVERY_ACTION_CODES.actionFailed, cause: typeof code === "string" ? code : "unknown" })
  }
}
