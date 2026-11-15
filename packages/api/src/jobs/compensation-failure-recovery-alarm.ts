/**
 * compensation-failure-recovery-alarm — v1.16.0 Story 4.3 (FR-11, AD-32, AD-48, NFR-2, NFR-4).
 *
 * Runtime alarm recovery NIEZALEŻNY od push developera, profilu pre-push,
 * GROW i Brevo (Amendment D4 do AD-31): scheduled job Medusy (`config.schedule`)
 * czyta populację `compensation_failure` po terminie (`deadline < now()` w bazie)
 * i dla każdego wiersza emituje alarm z typem populacji, bezpiecznym
 * identyfikatorem, `instance_id`, ownerem i deadline — do logu/ring buffera
 * ORAZ trwałym kanałem z fallbackiem (`lib/alert-channel.ts`, D-33).
 *
 * ── Fail-loud (NFR-4) ──────────────────────────────────────────────────────
 *  - brak adaptera wymaganej populacji ⇒ `RecoveryPopulationAdapterMissingError`
 *    PRZY STARCIE przebiegu (rzucany — scheduler nie udaje sukcesu);
 *  - porażka odczytu rynku ⇒ ERROR + wynik rynku `evaluated: false` (izolacja
 *    per rynek: pozostałe rynki są oceniane);
 *  - brak wszystkich kanałów ⇒ ERROR `ALERT_CHANNEL_*` z `deliverAlert`;
 *  - porażka samego przebiegu (`RUN_FAILED`) idzie TYM SAMYM kanałem trwałym
 *    (`deliver`), nie tylko do logu/ring buffera;
 *  - wynik dostarczenia każdego alarmu jest logowany (`delivered_via`,
 *    `attempts`; WARN, gdy sukces przyszedł po porażce próby).
 *
 * Populacja obejmuje kwarantannę backfillu 4.2 (`quarantined_pending_review`,
 * ADR-238 §7) z rozróżnialnym `source` w ładunku alarmu.
 *
 * ── Stan mierzalny (AC4) ───────────────────────────────────────────────────
 * Wynik przebiegu rozróżnia pustą populację (`evaluated: true, overdue_count: 0`)
 * od porażki loadera (`evaluated: false`). Każdy przebieg loguje linię INFO
 * `run evaluated=… overdue_count=…`.
 *
 * Bez mutacji stanu wierszy (mutacja naprawcza = Epik 11) i bez migracji (D-35 p.16).
 */
import type { MedusaContainer } from "@medusajs/framework/types"

import { deliverAlert, type AlertDeliveryResult, type DeliverAlertDeps } from "../lib/alert-channel"
import { emitStructuredAlert, type StructuredAlertPayload } from "../lib/alert-emit"
import { marketContextStorage } from "../lib/market-context"
import { queryUnderMarketContext } from "../lib/payment/stripe-payment-intent-transport"
import type { TraceQueryClient } from "../lib/recovery/deferred-issuance-trace"
import {
  assertRecoveryPopulationAdapters,
  COMPENSATION_ALARM_REQUIRED_POPULATIONS,
  DEFAULT_RECOVERY_POPULATION_ADAPTERS,
  type RecoveryAlarm,
  type RecoveryPopulationAdapterRegistry,
} from "../lib/recovery/recovery-population-adapters"
import {
  runInSystemMarketContext,
  SystemMarketContextError,
  type SystemExecutionOrigin,
  type SystemMarketScope,
} from "../lib/system-market-context"

export const SCHEDULE_NAME = "compensation-failure-recovery-alarm" as const
/** Co 15 minut — opóźnienie alarmu ≪ SLA 24 h (D-35 p.9). */
export const SCHEDULE_CRON = "*/15 * * * *" as const
export const MARKETS_ENV_VAR = "COMPENSATION_FAILURE_RECOVERY_ALARM_MARKETS" as const
export const ALERT_CODE_RUN_FAILED = "RECOVERY_COMPENSATION_ALARM_RUN_FAILED" as const

export const ALARM_ORIGIN: SystemExecutionOrigin = { surface: "job", name: SCHEDULE_NAME }

type JobLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, err?: unknown) => void
}

export type MarketAlarmResult =
  | { market_id: string; evaluated: true; overdue_count: number }
  | { market_id: string; evaluated: false; reason: "read_failed"; error: string }

export type CompensationAlarmRunResult = {
  population_type: "compensation_failure"
  /** true tylko, gdy KAŻDY zadeklarowany rynek został oceniony. */
  evaluated: boolean
  overdue_count: number
  markets: string[]
  per_market: MarketAlarmResult[]
  alarms: Array<{ alarm: RecoveryAlarm; delivery: AlertDeliveryResult }>
  /** Alarmy porażki samego przebiegu (`RUN_FAILED`) z wynikiem dostarczenia kanałem. */
  run_failed_alarms: Array<{ reason: string; market_id: string | null; delivery: AlertDeliveryResult }>
  failure?: { reason: string; error: string }
}

function describeAttempts(delivery: AlertDeliveryResult): string {
  return JSON.stringify(delivery.attempts)
}

export type CompensationAlarmDeps = {
  env?: NodeJS.ProcessEnv
  registry?: RecoveryPopulationAdapterRegistry
  emit?: (payload: StructuredAlertPayload) => void
  deliver?: (alert: StructuredAlertPayload, deps?: DeliverAlertDeps) => Promise<AlertDeliveryResult>
  deliverDeps?: DeliverAlertDeps
  clientForMarket?: (
    container: MedusaContainer,
    context: { market_id: string; instance_id: string }
  ) => TraceQueryClient
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, err) => console.error(`[${SCHEDULE_NAME}] ${m}`, err),
  }
  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved?.info) {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch (err) {
    fallback.warn(`logger unresolved, using console: ${String(err)}`)
  }
  return fallback
}

export function readDeclaredMarkets(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env[MARKETS_ENV_VAR]
  if (raw === undefined) return undefined
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

function defaultClientForMarket(
  container: MedusaContainer,
  context: { market_id: string; instance_id: string }
): TraceQueryClient {
  return {
    query: async <T = Record<string, unknown>>(sql: string, values?: ReadonlyArray<unknown>) => {
      const result = await queryUnderMarketContext<T>(
        container as unknown as { resolve: (key: string) => unknown },
        context,
        sql,
        values ?? []
      )
      return { rows: result.rows, rowCount: result.rows.length }
    },
  }
}

export async function runCompensationFailureRecoveryAlarm(
  container: MedusaContainer,
  deps: CompensationAlarmDeps = {}
): Promise<CompensationAlarmRunResult> {
  const registry = deps.registry ?? DEFAULT_RECOVERY_POPULATION_ADAPTERS
  // AC1: brak adaptera zatrzymuje start — PRZED jakimkolwiek odczytem.
  assertRecoveryPopulationAdapters(registry, COMPENSATION_ALARM_REQUIRED_POPULATIONS)
  const adapter = registry.get("compensation_failure")!

  const logger = resolveLogger(container)
  const emit = deps.emit ?? emitStructuredAlert
  const deliver = deps.deliver ?? deliverAlert
  const clientForMarket = deps.clientForMarket ?? defaultClientForMarket
  const env = deps.env ?? process.env
  const declared = readDeclaredMarkets(env)

  const result: CompensationAlarmRunResult = {
    population_type: "compensation_failure",
    evaluated: false,
    overdue_count: 0,
    markets: declared ?? [],
    per_market: [],
    alarms: [],
    run_failed_alarms: [],
  }
  const deliverDeps = deps.deliverDeps ?? { env, emit }

  /**
   * AC3: porażka samego alarmu nie degraduje się do logu — RUN_FAILED idzie
   * tym samym kanałem trwałym co alarm populacji.
   */
  async function raiseRunFailed(payload: StructuredAlertPayload, reason: string, marketId: string | null) {
    emit(payload)
    const delivery = await deliver(payload, deliverDeps)
    result.run_failed_alarms.push({ reason, market_id: marketId, delivery })
    logger.error(
      `run_failed_alarm reason=${reason} market=${marketId ?? "-"} delivery=${delivery.status} ` +
        `delivered_via=${delivery.status === "delivered" ? delivery.delivered_via : "-"} attempts=${describeAttempts(delivery)}`
    )
  }

  const scope = {
    markets: declared as unknown as readonly string[],
    origin: ALARM_ORIGIN,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) => logger.warn(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (message: string, meta?: Record<string, unknown>) => logger.error(`${message} ${JSON.stringify(meta ?? {})}`),
    },
  } satisfies SystemMarketScope

  try {
    await runInSystemMarketContext(scope, async (marketId) => {
      try {
        const instanceId = marketContextStorage.getStore()?.instance_id
        if (!instanceId) throw new Error(`brak instance_id w kontekscie rynku ${marketId}`)
        const rows = await adapter.loader(clientForMarket(container, { market_id: marketId, instance_id: instanceId }))
        for (const row of rows) {
          const alarm = adapter.toAlarm(row)
          const payload: StructuredAlertPayload = {
            severity: "ERROR",
            code: adapter.alarmCode,
            message:
              `Kompensacja ${alarm.failure_id} po terminie ${alarm.deadline} ` +
              `(stan ${alarm.state}) — wlasciciel ${alarm.owner_type}/${alarm.owner_id}`,
            context: { ...alarm },
          }
          emit(payload)
          const delivery = await deliver(payload, deliverDeps)
          result.alarms.push({ alarm, delivery })
          const line =
            `alarm failure_id=${alarm.failure_id} source=${alarm.source} market=${alarm.market_id} ` +
            `delivery=${delivery.status} delivered_via=${delivery.status === "delivered" ? delivery.delivered_via : "-"} ` +
            `attempts=${describeAttempts(delivery)}`
          if (delivery.status !== "delivered") logger.error(line)
          else if (delivery.attempts.some((a) => !a.ok)) logger.warn(line)
          else logger.info(line)
        }
        result.per_market.push({ market_id: marketId, evaluated: true, overdue_count: rows.length })
        result.overdue_count += rows.length
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`market=${marketId} read FAILED; populacja nieoceniona`, err)
        result.per_market.push({ market_id: marketId, evaluated: false, reason: "read_failed", error: message })
        await raiseRunFailed(
          {
            severity: "ERROR",
            code: ALERT_CODE_RUN_FAILED,
            message: `Alarm kompensacji: rynek ${marketId} nieoceniony (read_failed)`,
            context: { reason: "read_failed", error: message, market_id: marketId },
          },
          "read_failed",
          marketId
        )
      }
    })
  } catch (err) {
    const reason = err instanceof SystemMarketContextError ? `market_context_denied:${err.reason}` : "run_failed"
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`run FAILED (${reason})`, err)
    result.failure = { reason, error: message }
    await raiseRunFailed(
      {
        severity: "ERROR",
        code: ALERT_CODE_RUN_FAILED,
        message: `Alarm kompensacji nie wykonal sie (${reason}) — populacja nieoceniona`,
        context: { reason, error: message, markets: declared ?? null, markets_env_var: MARKETS_ENV_VAR },
      },
      reason,
      null
    )
    return result
  }

  result.evaluated = result.per_market.length > 0 && result.per_market.every((m) => m.evaluated)
  logger.info(
    `run evaluated=${result.evaluated} overdue_count=${result.overdue_count} ` +
      `markets=${result.markets.join(",")} delivered=${result.alarms.filter((a) => a.delivery.status === "delivered").length} ` +
      `delivered_after_failure=${result.alarms.filter((a) => a.delivery.status === "delivered" && a.delivery.attempts.some((t) => !t.ok)).length} ` +
      `failed=${result.alarms.filter((a) => a.delivery.status === "failed").length}`
  )
  return result
}

export default async function compensationFailureRecoveryAlarm(
  container: MedusaContainer
): Promise<CompensationAlarmRunResult> {
  return runCompensationFailureRecoveryAlarm(container)
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
