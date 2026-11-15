/**
 * Story v1.16.0 7.8: GET /admin/operator/market-config?market_id=
 *
 * Read-only projection of the gp-config runtime artifact (Story 7.7) for the
 * operator screen in admin-panel. Every response is JSON with a `state` field
 * whose class survives end-to-end (403 forbidden, 404 invalid_context,
 * 500 projection_error, 200 ok/empty/stale) — a failure never renders as
 * an empty configuration.
 *
 * Writes are fail-closed: this route never mutates the projection (the only
 * write path is `gp-ops config load --apply`). A write without an explicit
 * scope is `403 scope_required`; a scoped write is still `405` and a write
 * aimed at a read-only control market (testmarketb) is `403 read_only_market`.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { resolveAdminMarketContext } from "../../../../lib/admin-market-context"
import {
  isReadOnlyControlMarket,
  readMarketConfigProjection,
  type MarketConfigProjectionResult,
} from "../../../../lib/market-config-projection-reader"

export const WRITE_SCOPE_HEADER = "x-gp-config-write-scope"

function queryMarketId(req: MedusaRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.market_id
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return null
}

function projectionToResponse(result: MarketConfigProjectionResult): { status: number; body: Record<string, unknown> } {
  switch (result.kind) {
    case "ok":
      return {
        status: 200,
        body: {
          state: "ok",
          market_id: result.market_id,
          instance_id: result.instance_id,
          read_only: result.read_only,
          empty: false,
          stale: false,
          config: result.config,
        },
      }
    case "empty":
      return {
        status: 200,
        body: {
          state: "empty",
          market_id: result.market_id,
          instance_id: result.instance_id,
          read_only: result.read_only,
          empty: true,
          stale: false,
          config: {},
        },
      }
    case "stale":
      return {
        status: 200,
        body: {
          state: "stale",
          market_id: result.market_id,
          instance_id: result.instance_id,
          read_only: result.read_only,
          empty: false,
          stale: true,
          stale_reason: result.reason,
          config: result.config,
        },
      }
    case "invalid_context":
      return {
        status: result.code === "market_not_found" ? 404 : 400,
        body: { state: "invalid_context", code: "invalid_context", reason: result.code, market_id: result.market_id },
      }
    case "projection_error":
      return {
        status: 500,
        body: { state: "projection_error", code: "projection_error", reason: result.code, market_id: result.market_id },
      }
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const requested = queryMarketId(req)
  const ctx = await resolveAdminMarketContext(req, { intrinsicMarketId: requested })
  if (!ctx.ok) {
    res.status(ctx.status).json({
      state: "forbidden",
      code: ctx.code,
      message: ctx.message,
      market_id: requested,
    })
    return
  }
  if (requested && ctx.market_id && ctx.market_id !== requested) {
    res.status(400).json({
      state: "invalid_context",
      code: "invalid_context",
      reason: "market_id_conflict",
      market_id: requested,
    })
    return
  }
  const { status, body } = projectionToResponse(await readMarketConfigProjection(ctx.market_id))
  res.status(status).json(body)
}

function readWriteScope(req: MedusaRequest): string | null {
  const raw = req.headers[WRITE_SCOPE_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function rejectWrite(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const marketId = queryMarketId(req)
  if (!readWriteScope(req)) {
    res.status(403).json({ state: "forbidden", code: "scope_required", market_id: marketId })
    return
  }
  if (marketId && isReadOnlyControlMarket(marketId)) {
    res.status(403).json({ state: "forbidden", code: "read_only_market", market_id: marketId })
    return
  }
  res.setHeader("Allow", "GET")
  res.status(405).json({ state: "forbidden", code: "write_not_supported", market_id: marketId })
}

export const POST = rejectWrite
export const PUT = rejectWrite
export const PATCH = rejectWrite
export const DELETE = rejectWrite
