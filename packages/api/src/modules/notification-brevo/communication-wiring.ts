/**
 * communication-wiring.ts — PRODUKCYJNY wiring `flagResolver` i
 * `flowKpiTelemetry` w module Notification (Story 2.3, AC6a; domknięcie
 * deferralu R-2.2-H1).
 *
 * ── Stan przed tą story (bez zaokrągleń) ────────────────────────────────────
 * Gniazda `flagResolver` / `flowKpiTelemetry` były wstrzykiwalne i podpięte do
 * konstruktora `DefaultMessagingGateway`, ale PRODUKCYJNIE NIEUSTAWIONE:
 * kill-switch per rynek/flow nie działał, a KPI `sent` nie były emitowane.
 * Audytor 2.2 zaakceptował to, bo rejestr szablonów był w całości
 * `not_configured` (zero realnych wysyłek). Story 2.3 dowozi pierwszą realną
 * wysyłkę, więc ryzyko materializuje się TERAZ — wiring powstaje tutaj.
 *
 * ── Źródła konfiguracji (kolejność: env → auto-detekcja repo) ───────────────
 *   flagi domyślne  `gp-config/<instance>/communication-defaults.yaml`
 *                   (env `GP_COMMUNICATION_DEFAULTS_PATH`, `GP_INSTANCE_ID`)
 *   override rynku  `gp-ops/markets/<market>/communication-flows.yaml`
 *                   (env `GP_COMMUNICATION_MARKET_FLOWS_DIR`)
 *   approvale KPI   `gp-ops/markets/_ratification/communication-flow-approvals.yaml`
 *                   (env `GP_COMMUNICATION_FLOW_APPROVALS_PATH`)
 *
 * Backend bywa deployowany BEZ super-repo, dlatego auto-detekcja idzie w górę
 * od `process.cwd()` i szuka markerów. Gdy konfiguracji nie ma, wiring
 * degraduje się do stanu sprzed 2.3 (gniazda `undefined`), ale ZAWSZE z
 * ostrzeżeniem: „kill-switch nieaktywny" musi być widoczne w logach, nie
 * domyślane. Operacyjny wymóg ustawienia ścieżek na deployu jest zapisany
 * w ADR-161.
 *
 * ── Fail-open dla flow spoza rejestru flag (decyzja, nie przypadek) ─────────
 * `StaticCommunicationFlowFlagResolver` rzuca `UnknownFlowError` dla flow bez
 * wpisu w defaults. Gateway przepuściłby ten wyjątek do wrappera providera i
 * KAŻDA wysyłka nieopisanego flow stałaby się twardym błędem — czyli pominięcie
 * wpisu w configu zamieniałoby się w awarię maili transakcyjnych. Odwrotność
 * (ciche wyłączenie) jest równie zła. Wybór: `GovernedFlowFlagResolver`
 * traktuje nieznany flow jako NIEBRAMKOWANY (przepuszcza) i loguje `warn`
 * — brak wpisu jest wtedy widoczny, a nie destrukcyjny. Wszystkie realne
 * `flow_id` z kodu są dopisane do `communication-defaults.yaml` w tej samej
 * zmianie, więc ścieżka ostrzeżenia nie jest normą.
 *
 * Ten moduł NIE tworzy i NIE modyfikuje wpisów approvali (5-8) — approval jest
 * decyzją operatora/PO. Flow bez approvala ma KPI wykluczone przez gate
 * (`gp.messaging.flow_kpi.gated`), co jest poprawnym zachowaniem, nie luką.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import * as yaml from "js-yaml"

import {
  createFlowKpiTelemetryHook,
  loadCommunicationDefaults,
  loadMarketFlows,
  StaticCommunicationFlowFlagResolver,
  type FlagResolverInput,
  type FlowApprovalEntry,
  type FlowApprovalLookup,
  type FlowFlagState,
  type FlowKpiTelemetryHook,
  type ICommunicationFlowFlagResolver,
  type MarketFlowsConfig,
} from "@gp/messaging"

export const DEFAULT_INSTANCE_ID = "gp-dev"
const MARKET_FLOWS_FILENAME = "communication-flows.yaml"
const APPROVALS_RELATIVE_PATH =
  "gp-ops/markets/_ratification/communication-flow-approvals.yaml"
const REPO_WALK_UP_LIMIT = 8

type WiringLogger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

export interface CommunicationWiring {
  flagResolver?: ICommunicationFlowFlagResolver
  flowKpiTelemetry?: FlowKpiTelemetryHook
  /** Diagnostyka dla logów/testów — co udało się podpiąć i skąd. */
  sources: {
    defaults_path: string | null
    market_flows_dir: string | null
    market_flows_loaded: string[]
    market_flows_skipped: string[]
    approvals_path: string | null
  }
}

/**
 * Resolver dziedziczący decyzje po statycznym, ale odporny na flow bez wpisu
 * w defaults (patrz nagłówek pliku: fail-open + `warn`, nie fail-closed).
 */
export class GovernedFlowFlagResolver implements ICommunicationFlowFlagResolver {
  private readonly warned = new Set<string>()

  constructor(
    private readonly inner: ICommunicationFlowFlagResolver,
    private readonly logger?: WiringLogger,
  ) {}

  resolve(input: FlagResolverInput): FlowFlagState {
    try {
      return this.inner.resolve(input)
    } catch (error) {
      const key = `${input.market_id}|${input.flow_id}`
      if (!this.warned.has(key)) {
        this.warned.add(key)
        this.logger?.warn?.(
          `[communication-wiring] flow '${input.flow_id}' nie ma wpisu w ` +
            "communication-defaults.yaml — wysyłka NIE jest bramkowana " +
            "kill-switchem (dopisz flow do rejestru flag)",
          {
            flow_id: input.flow_id,
            market_id: input.market_id,
            error_code: readErrorCode(error) ?? "FLOW_UNKNOWN",
          },
        )
      }

      return {
        // Fail-open: brak wpisu = brak bramki, nie ciche wyłączenie flow.
        enabled: true,
        consent_basis: "transactional_critical",
        source: "default",
        flow_id: input.flow_id,
        market_id: input.market_id,
      }
    }
  }
}

let cached: CommunicationWiring | null = null

/** Reset cache — wyłącznie dla testów. */
export function __resetCommunicationWiringForTests(): void {
  cached = null
}

/**
 * Buduje (raz na proces) wiring flag + KPI. Nigdy nie rzuca: awaria wiringu nie
 * może wywrócić rejestracji providera ani startu backendu.
 */
export function resolveCommunicationWiring(options: {
  env?: NodeJS.ProcessEnv
  logger?: WiringLogger
  /** Pomija cache (testy). */
  fresh?: boolean
} = {}): CommunicationWiring {
  if (cached && !options.fresh) return cached

  const env = options.env ?? process.env
  const logger = options.logger
  const wiring = buildWiring(env, logger)

  if (!options.fresh) cached = wiring
  return wiring
}

function buildWiring(
  env: NodeJS.ProcessEnv,
  logger?: WiringLogger,
): CommunicationWiring {
  const sources: CommunicationWiring["sources"] = {
    defaults_path: null,
    market_flows_dir: null,
    market_flows_loaded: [],
    market_flows_skipped: [],
    approvals_path: null,
  }

  const flagResolver = buildFlagResolver(env, sources, logger)
  const flowKpiTelemetry = buildKpiHook(env, sources, logger)

  if (!flagResolver) {
    logger?.warn?.(
      "[communication-wiring] kill-switch per rynek/flow NIEAKTYWNY — nie znaleziono " +
        "communication-defaults.yaml (ustaw GP_COMMUNICATION_DEFAULTS_PATH)",
      { defaults_path: sources.defaults_path },
    )
  }
  if (!flowKpiTelemetry) {
    logger?.warn?.(
      "[communication-wiring] telemetria KPI flow NIEAKTYWNA — nie znaleziono " +
        "rejestru approvali (ustaw GP_COMMUNICATION_FLOW_APPROVALS_PATH)",
      { approvals_path: sources.approvals_path },
    )
  }

  return { flagResolver, flowKpiTelemetry, sources }
}

function buildFlagResolver(
  env: NodeJS.ProcessEnv,
  sources: CommunicationWiring["sources"],
  logger?: WiringLogger,
): ICommunicationFlowFlagResolver | undefined {
  const defaultsPath = resolveDefaultsPath(env)
  sources.defaults_path = defaultsPath
  if (!defaultsPath) return undefined

  let defaults
  try {
    defaults = loadCommunicationDefaults(defaultsPath)
  } catch (error) {
    logger?.warn?.(
      "[communication-wiring] nie udało się wczytać communication-defaults.yaml",
      { defaults_path: defaultsPath, error_code: readErrorCode(error) },
    )
    return undefined
  }

  const marketOverrides = new Map<string, MarketFlowsConfig>()
  const marketFlowsDir = resolveMarketFlowsDir(env)
  sources.market_flows_dir = marketFlowsDir

  if (marketFlowsDir) {
    for (const marketId of listMarketDirs(marketFlowsDir)) {
      const path = join(marketFlowsDir, marketId, MARKET_FLOWS_FILENAME)
      if (!existsSync(path)) continue
      try {
        marketOverrides.set(marketId, loadMarketFlows(marketId, path))
        sources.market_flows_loaded.push(marketId)
      } catch (error) {
        // Jeden zepsuty plik rynku NIE może pozbawić kill-switcha pozostałych
        // rynków — pomijamy go głośno.
        sources.market_flows_skipped.push(marketId)
        logger?.warn?.(
          "[communication-wiring] pominięto override rynku (plik nie przechodzi walidacji)",
          {
            market_id: marketId,
            path,
            error_code: readErrorCode(error),
          },
        )
      }
    }
  }

  logger?.info?.("[communication-wiring] kill-switch flow AKTYWNY", {
    defaults_path: defaultsPath,
    markets_loaded: sources.market_flows_loaded,
    markets_skipped: sources.market_flows_skipped,
  })

  return new GovernedFlowFlagResolver(
    new StaticCommunicationFlowFlagResolver(defaults, marketOverrides),
    logger,
  )
}

function buildKpiHook(
  env: NodeJS.ProcessEnv,
  sources: CommunicationWiring["sources"],
  logger?: WiringLogger,
): FlowKpiTelemetryHook | undefined {
  const approvalsPath = resolveApprovalsPath(env)
  sources.approvals_path = approvalsPath
  if (!approvalsPath) return undefined

  const approvalLookup = loadFlowApprovalLookup(approvalsPath, logger)
  if (!approvalLookup) return undefined

  logger?.info?.("[communication-wiring] telemetria KPI flow AKTYWNA", {
    approvals_path: approvalsPath,
    // Klient PostHog powstaje leniwie z `POSTHOG_API_KEY`; jego brak oznacza
    // `not_emitted` (bez utraty klucza dedup), nie cichy sukces.
    posthog_configured: Boolean(env.POSTHOG_API_KEY),
  })

  return createFlowKpiTelemetryHook({ approvalLookup })
}

/**
 * Buduje lookup approvali z pliku ratyfikacji 5-8. Ten kod NIE tworzy
 * approvali — tylko je czyta.
 */
export function loadFlowApprovalLookup(
  approvalsPath: string,
  logger?: WiringLogger,
): FlowApprovalLookup | undefined {
  let parsed: unknown
  try {
    parsed = yaml.load(readFileSync(approvalsPath, "utf8"))
  } catch (error) {
    logger?.warn?.(
      "[communication-wiring] nie udało się wczytać rejestru approvali flow",
      { approvals_path: approvalsPath, error_code: readErrorCode(error) },
    )
    return undefined
  }

  if (!isRecord(parsed)) return undefined
  const approvals = parsed.approvals
  if (!isRecord(approvals)) return undefined

  return (market: string, flowId: string): FlowApprovalEntry | null => {
    const marketEntry = approvals[market]
    if (!isRecord(marketEntry)) return null
    const flowEntry = marketEntry[flowId]
    if (!isRecord(flowEntry)) return null
    return flowEntry as FlowApprovalEntry
  }
}

function resolveDefaultsPath(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.GP_COMMUNICATION_DEFAULTS_PATH?.trim()
  if (explicit) {
    return existsSync(explicit) ? absolute(explicit) : null
  }

  const instanceId = env.GP_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID
  return findUpwards(join("gp-config", instanceId, "communication-defaults.yaml"))
}

function resolveMarketFlowsDir(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.GP_COMMUNICATION_MARKET_FLOWS_DIR?.trim()
  if (explicit) {
    return existsSync(explicit) ? absolute(explicit) : null
  }
  return findUpwards(join("gp-ops", "markets"))
}

function resolveApprovalsPath(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.GP_COMMUNICATION_FLOW_APPROVALS_PATH?.trim()
  if (explicit) {
    return existsSync(explicit) ? absolute(explicit) : null
  }
  return findUpwards(APPROVALS_RELATIVE_PATH)
}

/**
 * Szuka artefaktu, idąc w górę od `process.cwd()`. Backend startuje z
 * `GP/backend`, więc super-repo jest 2 poziomy wyżej; limit chroni przed
 * wędrowaniem do `/` na deployu bez super-repo.
 */
function findUpwards(relativePath: string): string | null {
  let dir = process.cwd()
  for (let depth = 0; depth < REPO_WALK_UP_LIMIT; depth += 1) {
    const candidate = join(dir, relativePath)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function listMarketDirs(marketsDir: string): string[] {
  try {
    return readdirSync(marketsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const code = (error as Record<string, unknown>).error_code
    if (typeof code === "string" && code.trim()) return code.trim()
  }
  return error instanceof Error ? error.constructor.name : undefined
}
