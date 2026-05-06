import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  deriveCsrfProbeToken,
  resolveCsrfProbeAllowedOrigin,
} from "../../../lib/security-gate-csrf-probe"
import { marketContextStorage } from "../../../lib/market-context"

let acceptedProbeRuns = 0
let lastAcceptedAt: string | null = null

type HeaderCarrier = {
  headers?: Record<string, string | string[] | undefined>
  get?: (name: string) => string | string[] | undefined
}

function setProbeHeaders(res: MedusaResponse): void {
  res.setHeader?.("Cache-Control", "no-store")
  res.setHeader?.("Vary", "Origin")
}

function getHeader(req: MedusaRequest, name: string): string | null {
  const request = req as MedusaRequest & HeaderCarrier
  const viaGetter = request.get?.(name)
  const viaMap = request.headers?.[name] ?? request.headers?.[name.toLowerCase()]
  const value = viaGetter ?? viaMap

  if (Array.isArray(value)) {
    return value[0] ?? null
  }

  return typeof value === "string" ? value : null
}

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  setProbeHeaders(res)
  const marketContext = marketContextStorage.getStore()

  res.json({
    market_id: marketContext?.market_id ?? null,
    configured: Boolean(
      resolveCsrfProbeAllowedOrigin(process.env) &&
        deriveCsrfProbeToken(process.env),
    ),
    accepted_probe_runs: acceptedProbeRuns,
    last_accepted_at: lastAcceptedAt,
  })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  setProbeHeaders(res)
  const marketContext = marketContextStorage.getStore()

  const expectedOrigin = resolveCsrfProbeAllowedOrigin(process.env)
  const expectedToken = deriveCsrfProbeToken(process.env)

  if (!expectedOrigin || !expectedToken) {
    res.status(503).json({
      error: "probe_not_configured",
      message:
        "Set GP_SEC_GATE_CSRF_ALLOWED_ORIGIN|STOREFRONT_URL and GP_SEC_GATE_CSRF_PROBE_TOKEN|JWT_SECRET|COOKIE_SECRET.",
    })
    return
  }

  const origin = getHeader(req, "origin")
  if (origin !== expectedOrigin) {
    res.status(403).json({ error: "origin_mismatch" })
    return
  }

  const csrfToken = getHeader(req, "x-csrf-token")
  if (csrfToken !== expectedToken) {
    res.status(403).json({ error: "csrf_token_invalid" })
    return
  }

  acceptedProbeRuns += 1
  lastAcceptedAt = new Date().toISOString()

  res.status(200).json({
    ok: true,
    market_id: marketContext?.market_id ?? null,
    accepted_probe_runs: acceptedProbeRuns,
    last_accepted_at: lastAcceptedAt,
  })
}
