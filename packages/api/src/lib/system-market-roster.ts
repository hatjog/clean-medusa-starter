/**
 * v1.16.0 Story 8.7 (DW-15-374) — wykonanie asynchroniczne (job/subscriber)
 * PER RYNEK z rosteru instancji, pod tym samym nośnikiem co `/store/*`
 * (`runInSystemMarketContext` → ALS → hook RLS ustawia rolę i GUC przy acquire).
 *
 * Roster: wstrzyknięty `gp_market_loader` albo projekcja gp-config instancji
 * (`resolveRetentionMarkets`). Pusty roster to NAZWANA odmowa, nie cichy no-op.
 */
import { resolveRetentionMarkets } from "../modules/voucher-pii/recipient-retention-markets"
import { runInSystemMarketContext, type SystemExecutionOrigin } from "./system-market-context"

export class SystemMarketRosterError extends Error {
  readonly error_code = "GP_SYSTEM_MARKET_ROSTER_EMPTY"
  constructor(readonly origin: SystemExecutionOrigin, readonly reason: string) {
    super(`${origin.surface}:${origin.name}: brak rynków w rosterze instancji (${reason}) — przebieg odmówiony`)
    this.name = "SystemMarketRosterError"
  }
}

type ContainerLike = { resolve: (key: string) => unknown }
type RosterLogger = { error: (msg: string, meta?: unknown) => void }

function resolveLoader(container: ContainerLike): { listActive: () => Promise<string[]> } | null {
  try {
    return (container.resolve("gp_market_loader") as { listActive: () => Promise<string[]> }) ?? null
  } catch {
    return null
  }
}

export async function resolveSystemMarketRoster(
  container: ContainerLike,
  origin: SystemExecutionOrigin,
  logger: RosterLogger
): Promise<string[]> {
  const resolution = await resolveRetentionMarkets({
    logger: { error: (m, e) => logger.error(m, e) },
    injectedLoader: resolveLoader(container),
    // Zawężenie env retencji PII nie dotyczy innych powierzchni.
    env: { ...process.env, VOUCHER_PII_RETENTION_MARKETS: "" },
  })
  if (resolution.markets.length === 0) {
    throw new SystemMarketRosterError(origin, resolution.no_markets?.reason ?? "empty")
  }
  return resolution.markets
}

export async function runPerRosterMarket<T>(
  container: ContainerLike,
  origin: SystemExecutionOrigin,
  logger: RosterLogger & { warn?: (m: string, meta?: Record<string, unknown>) => void },
  work: (marketId: string) => Promise<T>
): Promise<T[]> {
  const markets = await resolveSystemMarketRoster(container, origin, logger)
  return runInSystemMarketContext(
    { markets, instanceId: process.env.GP_INSTANCE_ID, origin, logger: { error: (m, meta) => logger.error(m, meta) } },
    work
  )
}
