/**
 * Admin health dashboard endpoint (Story 8.7).
 *
 * GET /v1/admin/health — returns service health, entitlement stats, last sync.
 *
 * Probes: Postgres (TCP 5432), Redis (TCP 6379), MinIO (HTTP 9000), Mercur (HTTP 9002/health).
 * Protected by withOperatorAuth — admin session required.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import net from "node:net"
import { withOperatorAuth } from "../../../../middlewares/with-operator-auth"
import GpCoreService from "../../../../modules/gp-core/service"

type ServiceProbe = {
  id: string
  name: string
  ok: boolean
  latency_ms: number | null
  error?: string
}

async function checkTcp(
  id: string,
  name: string,
  host: string,
  port: number,
  timeoutMs = 500
): Promise<ServiceProbe> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()

    const done = (ok: boolean, error?: string) => {
      try { socket.destroy() } catch { /* ignore */ }
      resolve({
        id,
        name,
        ok,
        latency_ms: ok ? Date.now() - started : null,
        ...(error ? { error } : {}),
      })
    }

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false, "timeout"))
    socket.once("error", (err) => done(false, err.message))
    socket.connect(port, host)
  })
}

async function checkHttp(
  id: string,
  name: string,
  url: string,
  timeoutMs = 800
): Promise<ServiceProbe> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      cache: "no-store",
    })
    return { id, name, ok: true, latency_ms: Date.now() - started }
  } catch (error) {
    return {
      id,
      name,
      ok: false,
      latency_ms: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function getGpCoreService(req: MedusaRequest): GpCoreService {
  return req.scope.resolve("gpCoreService") as GpCoreService
}

export const GET = withOperatorAuth(async (req, res) => {
  const gpCore = getGpCoreService(req)

  // Run all probes in parallel
  const [postgres, redis, minio, mercur] = await Promise.all([
    checkTcp("postgres", "Postgres", "127.0.0.1", 5432),
    checkTcp("redis", "Redis", "127.0.0.1", 6379),
    checkHttp("minio", "MinIO", "http://localhost:9000"),
    checkHttp("mercur", "Mercur backend", "http://localhost:9002/health"),
  ])

  // Entitlement stats from gp_core
  let entitlement_stats: Record<string, number> = {}
  let last_sync_at: string | null = null

  try {
    const dbHealth = await gpCore.healthCheck()
    if (dbHealth.core) {
      // These use the internal pool — safe to call
      const pool = (gpCore as any).getCorePool()

      const statsResult = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM entitlements GROUP BY status`
      )
      for (const row of statsResult.rows) {
        entitlement_stats[row.status] = row.count
      }

      const syncResult = await pool.query(
        `SELECT MAX(updated_at) AS last_sync FROM entitlements`
      )
      if (syncResult.rows[0]?.last_sync) {
        last_sync_at = new Date(syncResult.rows[0].last_sync).toISOString()
      }
    }
  } catch {
    // Stats unavailable — return empty
  }

  res.json({
    updated_at: new Date().toISOString(),
    services: [postgres, redis, minio, mercur],
    entitlement_stats,
    last_sync_at,
  })
})
