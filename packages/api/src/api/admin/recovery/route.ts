/**
 * v1.16.0 Story 4.7: GET /admin/recovery?market_id=<rynek> — jedno wejście odczytu
 * trzech populacji wymagających człowieka pod RLS (FR-11/FR-12/FR-14, AD-31, AD-22, NFR-3).
 *
 * Kolejność kontroli (fail-closed, każda odmowa z NAZWANYM kodem):
 *   1. `withOperatorAuth` — 401 bez sesji, 403 dla aktora innego niż admin (seller).
 *   2. `market_id` wymagany (query albo `x-gp-market-id`); brak = 400
 *      `recovery_market_required` — NIE ma rynku domyślnego. Rozbieżne źródła =
 *      400 `recovery_market_ambiguous`.
 *   3. Uprawnienie aktora do rynku (`resolveAdminMarketContext`) PRZED zapytaniem;
 *      brak = 403 `recovery_market_forbidden` — odmowa, nie pusty zbiór.
 *   4. Instancja runtime (`GP_INSTANCE_ID`); brak = 503 `recovery_instance_unconfigured`.
 *   5. Odczyt przez `queryUnderMarketContext` (rola `medusa_store`, RLS).
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { resolveAdminMarketContext } from "../../../lib/admin-market-context"
import { resolveRuntimeInstanceId } from "../../../lib/market-context"
import { queryUnderMarketContext } from "../../../lib/payment/stripe-payment-intent-transport"
import {
  readRecoveryPopulations,
  type RecoveryPopulationQuery,
} from "../../../lib/recovery/recovery-population-read"
import { withOperatorAuth } from "../../../middlewares/with-operator-auth"

export const RECOVERY_READ_CODES = {
  marketRequired: "recovery_market_required",
  marketAmbiguous: "recovery_market_ambiguous",
  marketForbidden: "recovery_market_forbidden",
  unauthenticated: "recovery_unauthenticated",
  instanceUnconfigured: "recovery_instance_unconfigured",
  readFailed: "recovery_read_failed",
} as const

type Logger = { error?: (m: string) => void; warn?: (m: string) => void }

export type RecoveryReadDeps = {
  instanceId?: () => string | null
  queryFor?: (
    req: MedusaRequest,
    scope: { instance_id: string; market_id: string }
  ) => RecoveryPopulationQuery
}

function defaultQueryFor(req: MedusaRequest, scope: { instance_id: string; market_id: string }): RecoveryPopulationQuery {
  return (sql, params) =>
    queryUnderMarketContext(req.scope as unknown as { resolve: (key: string) => unknown }, scope, sql, params)
}

function logger(req: MedusaRequest): Logger {
  try {
    return (req.scope?.resolve("logger") as Logger | undefined) ?? console
  } catch {
    return console
  }
}

function queryMarketId(req: MedusaRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.market_id
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export async function handleRecoveryRead(
  req: MedusaRequest,
  res: MedusaResponse,
  deps: RecoveryReadDeps = {}
): Promise<void> {
  const log = logger(req)
  const fromQuery = queryMarketId(req)
  const rawHeader = req.headers?.["x-gp-market-id"]
  const fromHeader = typeof rawHeader === "string" && rawHeader.trim() ? rawHeader.trim() : null
  if (fromQuery && fromHeader && fromQuery !== fromHeader) {
    res.status(400).json({ code: RECOVERY_READ_CODES.marketAmbiguous, message: "market_id w query i nagłówku różnią się" })
    return
  }
  const requested = fromQuery ?? fromHeader
  if (!requested) {
    res.status(400).json({ code: RECOVERY_READ_CODES.marketRequired, message: "market_id jest wymagany; brak rynku domyślnego" })
    return
  }

  const ctx = await resolveAdminMarketContext(req, { intrinsicMarketId: requested })
  if (!ctx.ok) {
    if (ctx.status === 401) {
      res.status(401).json({ code: RECOVERY_READ_CODES.unauthenticated, message: ctx.message })
      return
    }
    log.warn?.(`[admin-recovery] code=${RECOVERY_READ_CODES.marketForbidden} market_id=${requested}`)
    res.status(403).json({ code: RECOVERY_READ_CODES.marketForbidden, market_id: requested, message: ctx.message })
    return
  }
  if (ctx.market_id !== requested) {
    res.status(403).json({ code: RECOVERY_READ_CODES.marketForbidden, market_id: requested, message: "rozjazd rynku kontekstu" })
    return
  }

  const instanceId = (deps.instanceId ?? (() => resolveRuntimeInstanceId()))()
  if (!instanceId) {
    log.error?.(`[admin-recovery] code=${RECOVERY_READ_CODES.instanceUnconfigured}`)
    res.status(503).json({ code: RECOVERY_READ_CODES.instanceUnconfigured, message: "GP_INSTANCE_ID nieustawione" })
    return
  }

  const scope = { instance_id: instanceId, market_id: requested }
  try {
    const result = await readRecoveryPopulations((deps.queryFor ?? defaultQueryFor)(req, scope), scope)
    res.status(200).json(result)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    log.error?.(
      `[admin-recovery] code=${RECOVERY_READ_CODES.readFailed} market_id=${requested} cause=${String(code ?? "unknown")}: ${(err as Error).message}`
    )
    res.status(503).json({ code: RECOVERY_READ_CODES.readFailed, cause: typeof code === "string" ? code : "unknown" })
  }
}

export const GET = withOperatorAuth((req, res) => handleRecoveryRead(req, res))
