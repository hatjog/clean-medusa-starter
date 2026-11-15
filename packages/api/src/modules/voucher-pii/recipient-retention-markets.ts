/**
 * v1.16.0 Story 11.6 (fix R-1, AC2.a; AD-21) — źródło listy rynków dla jobów
 * retencji danych obdarowanego.
 *
 * Przed naprawą oba joby brały rynki WYŁĄCZNIE z `VOUCHER_PII_RETENTION_MARKETS`,
 * której nie podaje żadne środowisko, więc w realnym runtime kończyły się warnem
 * i zerową pracą. Źródłem jest teraz runtime'owa projekcja konfiguracji rynków
 * instancji — ta sama, którą backend czyta w `lib/market-config-projection-reader.ts`
 * (Story 7.7/7.8): `<GP_CONFIG_ROOT>/<GP_INSTANCE_ID>/markets/<market>/market.yaml`.
 * Rynek = katalog z plikiem `market.yaml` i identyfikatorem w kształcie hooka RLS.
 *
 * Świadomie NIE wyliczamy rynków przez `DISTINCT market_id` na tabelach pod RLS
 * (rola runtime nie widzi innych rynków) ani przez `market_runtime_config` na
 * `PG_CONNECTION` (po instalacji hooka RLS odczyt bez kontekstu rynku jest odmową).
 *
 * `VOUCHER_PII_RETENTION_MARKETS` zostaje wyłącznie JAWNYM ZAWĘŻENIEM: przecięcie
 * z rosterem; rynek z env spoza konfiguracji instancji nie jest przetwarzany i jest
 * zgłaszany. Pusta lista po rozwiązaniu źródła = nazwany alarm
 * `GP_RECIPIENT_RETENTION_NO_MARKETS` (poziom error, licznik w wyniku joba).
 */
import { promises as fs } from "node:fs"
import path from "node:path"

import { resolveRuntimeInstanceId } from "../../lib/market-context"
import { resolveProjectionConfigRoot } from "../../lib/market-config-projection-reader"

export const RETENTION_MARKETS_NARROWING_ENV = "VOUCHER_PII_RETENTION_MARKETS" as const
export const RETENTION_NO_MARKETS_ERROR_CODE = "GP_RECIPIENT_RETENTION_NO_MARKETS" as const
export const RETENTION_MARKET_NOT_CONFIGURED_ERROR_CODE =
  "GP_RECIPIENT_RETENTION_MARKET_NOT_CONFIGURED" as const

const SAFE_MARKET_ID_RE = /^[a-zA-Z0-9_-]+$/

export type RetentionMarketsSource = "injected_loader" | "gp_config_projection"

export type RetentionNoMarketsReason =
  | "instance_unresolved"
  | "projection_unreadable"
  | "projection_empty"
  | "narrowing_excludes_all"

export type RetentionMarketsResolution = {
  markets: string[]
  source: RetentionMarketsSource
  /** Katalog źródła (bez PII) — do logu i evidence. */
  source_ref: string | null
  /** Rynki z env zawężenia, których nie ma w konfiguracji instancji. */
  narrowing_rejected: string[]
  /** Ustawione, gdy lista jest pusta — nazwany alarm, nie cichy warn. */
  no_markets: { error_code: typeof RETENTION_NO_MARKETS_ERROR_CODE; reason: RetentionNoMarketsReason } | null
}

export type RetentionMarketsLogger = {
  error: (msg: string, err?: unknown) => void
}

function parseNarrowing(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env[RETENTION_MARKETS_NARROWING_ENV]
  if (raw === undefined || raw.trim() === "") return null
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Rynki z projekcji konfiguracji instancji (katalogi z `market.yaml`). */
export async function listConfiguredProjectionMarkets(args: {
  configRoot: string
  instanceId: string
}): Promise<string[]> {
  const marketsDir = path.join(args.configRoot, args.instanceId, "markets")
  const entries = await fs.readdir(marketsDir, { withFileTypes: true })
  const markets: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_MARKET_ID_RE.test(entry.name)) continue
    try {
      const stat = await fs.stat(path.join(marketsDir, entry.name, "market.yaml"))
      if (stat.isFile()) markets.push(entry.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
    }
  }
  return markets.sort()
}

export async function resolveRetentionMarkets(args: {
  env?: NodeJS.ProcessEnv
  logger: RetentionMarketsLogger
  injectedLoader?: { listActive: () => Promise<string[]> } | null
}): Promise<RetentionMarketsResolution> {
  const env = args.env ?? process.env
  const narrowing = parseNarrowing(env)

  let roster: string[]
  let source: RetentionMarketsSource
  let sourceRef: string | null = null

  if (args.injectedLoader?.listActive) {
    source = "injected_loader"
    roster = await args.injectedLoader.listActive()
  } else {
    source = "gp_config_projection"
    const instanceId = resolveRuntimeInstanceId(env.GP_INSTANCE_ID)
    const configRoot = resolveProjectionConfigRoot(env)
    if (!instanceId) {
      return empty(source, null, [], "instance_unresolved", args.logger)
    }
    sourceRef = path.join(configRoot, instanceId, "markets")
    try {
      roster = await listConfiguredProjectionMarkets({ configRoot, instanceId })
    } catch (err) {
      args.logger.error(
        `${RETENTION_NO_MARKETS_ERROR_CODE}: gp-config projection unreadable dir=${sourceRef} ` +
          `code=${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name}`,
        err
      )
      return empty(source, sourceRef, [], "projection_unreadable", args.logger)
    }
    if (roster.length === 0) {
      return empty(source, sourceRef, [], "projection_empty", args.logger)
    }
  }

  let markets = roster
  const rejected: string[] = []
  if (narrowing) {
    const allowed = new Set(roster)
    markets = narrowing.filter((m) => allowed.has(m))
    for (const m of narrowing) if (!allowed.has(m)) rejected.push(m)
    if (rejected.length > 0) {
      args.logger.error(
        `${RETENTION_MARKET_NOT_CONFIGURED_ERROR_CODE}: ${RETENTION_MARKETS_NARROWING_ENV} names ` +
          `markets outside instance config (not processed): ${rejected.join(",")}`
      )
    }
  }
  if (markets.length === 0) {
    return empty(source, sourceRef, rejected, narrowing ? "narrowing_excludes_all" : "projection_empty", args.logger)
  }
  return { markets, source, source_ref: sourceRef, narrowing_rejected: rejected, no_markets: null }
}

function empty(
  source: RetentionMarketsSource,
  sourceRef: string | null,
  rejected: string[],
  reason: RetentionNoMarketsReason,
  logger: RetentionMarketsLogger
): RetentionMarketsResolution {
  logger.error(
    `${RETENTION_NO_MARKETS_ERROR_CODE}: no markets resolved (reason=${reason} source=${source}` +
      `${sourceRef ? ` dir=${sourceRef}` : ""}) — retention NOT executed`
  )
  return {
    markets: [],
    source,
    source_ref: sourceRef,
    narrowing_rejected: rejected,
    no_markets: { error_code: RETENTION_NO_MARKETS_ERROR_CODE, reason },
  }
}
