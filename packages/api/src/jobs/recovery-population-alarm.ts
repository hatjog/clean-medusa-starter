/**
 * recovery-population-alarm — v1.16.0 Story 11.3 AC-2 (FR-11, FR-12, FR-14, AD-48, NFR-4; D-33).
 *
 * Runtime alarm dwóch populacji dostępnych przez wejście odczytu 4.7, które
 * scheduler 4.3 jeszcze nie obejmował: `deferred_issuance_trace` i `dlq_entry`
 * (populacja `compensation_failure` zostaje na `compensation-failure-recovery-alarm`).
 * Każda populacja ma OSOBNY adapter (loader, deadline, eskalacja, deduplikacja —
 * `lib/recovery/recovery-population-adapters.ts`).
 *
 *  - Walidacja rejestru PRZY STARCIE: ładowanie modułu przez scheduler rzuca
 *    `RecoveryPopulationAdapterMissingError`, gdy brak adaptera (DW-15-342 p.1).
 *  - Agregacja per przebieg: JEDEN alarm zbiorczy na populację i rynek z listą
 *    identyfikatorów (DW-15-342 p.3, DW-15-333 p.3 — zamiast WARN co wiersz).
 *  - Porażka odczytu populacji ⇒ RUN_FAILED tym samym kanałem trwałym
 *    (`deliverAlert`), z `context.error` po sanitizacji; pozostałe populacje
 *    i rynki są oceniane dalej.
 *  - Kanał nie zależy od Brevo; niedostępność dowolnego dostawcy e-mail nie
 *    ukrywa alarmu. Wynik pre-push nie zastępuje tego monitorowania.
 */
import type { MedusaContainer } from "@medusajs/framework/types"

import {
  deliverAlert,
  sanitizeAttemptError,
  type AlertDeliveryResult,
  type DeliverAlertDeps,
} from "../lib/alert-channel"
import { emitStructuredAlert, type StructuredAlertPayload } from "../lib/alert-emit"
import { marketContextStorage } from "../lib/market-context"
import { queryUnderMarketContext } from "../lib/payment/stripe-payment-intent-transport"
import type { TraceQueryClient } from "../lib/recovery/deferred-issuance-trace"
import type { RecoveryPopulationType } from "../lib/recovery/recovery-action-contract"
import {
  aggregateRecoveryAlarm,
  DEFAULT_RECOVERY_ALARM_ADAPTERS,
  RECOVERY_ALARM_REQUIRED_POPULATIONS,
  validateRecoveryAlarmRegistryAtStartup,
  type AggregatedRecoveryAlarm,
  type RecoveryPopulationAdapterRegistry,
} from "../lib/recovery/recovery-population-adapters"
import {
  runInSystemMarketContext,
  SystemMarketContextError,
  type SystemExecutionOrigin,
  type SystemMarketScope,
} from "../lib/system-market-context"

export const SCHEDULE_NAME = "recovery-population-alarm" as const
export const SCHEDULE_CRON = "*/15 * * * *" as const
export const MARKETS_ENV_VAR = "RECOVERY_POPULATION_ALARM_MARKETS" as const
export const ALERT_CODE_RUN_FAILED = "RECOVERY_POPULATION_ALARM_RUN_FAILED" as const
export const ALARM_ORIGIN: SystemExecutionOrigin = { surface: "job", name: SCHEDULE_NAME }

// Start: brak adaptera zatrzymuje rejestrację joba (fail-loud przy ładowaniu modułu).
validateRecoveryAlarmRegistryAtStartup(DEFAULT_RECOVERY_ALARM_ADAPTERS)

export type PopulationAlarmOutcome =
  | { population_type: RecoveryPopulationType; market_id: string; evaluated: true; overdue_count: number; alarm: AggregatedRecoveryAlarm | null; delivery: AlertDeliveryResult | null }
  | { population_type: RecoveryPopulationType; market_id: string; evaluated: false; error: string; delivery: AlertDeliveryResult }

export type RecoveryPopulationAlarmRunResult = {
  evaluated: boolean
  markets: string[]
  outcomes: PopulationAlarmOutcome[]
  failure?: { reason: string; error: string; delivery: AlertDeliveryResult }
}

export type RecoveryPopulationAlarmDeps = {
  env?: NodeJS.ProcessEnv
  registry?: RecoveryPopulationAdapterRegistry
  emit?: (payload: StructuredAlertPayload) => void
  deliver?: (alert: StructuredAlertPayload, deps?: DeliverAlertDeps) => Promise<AlertDeliveryResult>
  deliverDeps?: DeliverAlertDeps
  clientForMarket?: (container: MedusaContainer, context: { market_id: string; instance_id: string }) => TraceQueryClient
}

export function readDeclaredMarkets(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env[MARKETS_ENV_VAR]
  if (raw === undefined) return undefined
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

function defaultClientForMarket(container: MedusaContainer, context: { market_id: string; instance_id: string }): TraceQueryClient {
  return {
    query: async <T = Record<string, unknown>>(sql: string, values?: ReadonlyArray<unknown>) => {
      const result = await queryUnderMarketContext<T>(container as unknown as { resolve: (key: string) => unknown }, context, sql, values ?? [])
      return { rows: result.rows, rowCount: result.rows.length }
    },
  }
}

function errorText(err: unknown): string {
  return sanitizeAttemptError(err instanceof Error ? err.message : String(err))
}

export async function runRecoveryPopulationAlarm(
  container: MedusaContainer,
  deps: RecoveryPopulationAlarmDeps = {}
): Promise<RecoveryPopulationAlarmRunResult> {
  const registry = deps.registry ?? DEFAULT_RECOVERY_ALARM_ADAPTERS
  validateRecoveryAlarmRegistryAtStartup(registry)
  const emit = deps.emit ?? emitStructuredAlert
  const deliver = deps.deliver ?? deliverAlert
  const env = deps.env ?? process.env
  const deliverDeps = deps.deliverDeps ?? { env, emit }
  const clientForMarket = deps.clientForMarket ?? defaultClientForMarket
  const declared = readDeclaredMarkets(env)
  const result: RecoveryPopulationAlarmRunResult = { evaluated: false, markets: declared ?? [], outcomes: [] }

  const send = async (payload: StructuredAlertPayload): Promise<AlertDeliveryResult> => {
    emit(payload)
    return deliver(payload, deliverDeps)
  }

  const scope = {
    markets: declared as unknown as readonly string[],
    origin: ALARM_ORIGIN,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) => console.warn(`[${SCHEDULE_NAME}] ${message} ${JSON.stringify(meta ?? {})}`),
      error: (message: string, meta?: Record<string, unknown>) => console.error(`[${SCHEDULE_NAME}] ${message} ${JSON.stringify(meta ?? {})}`),
    },
  } satisfies SystemMarketScope

  try {
    await runInSystemMarketContext(scope, async (marketId) => {
      const instanceId = marketContextStorage.getStore()?.instance_id ?? ""
      for (const population of RECOVERY_ALARM_REQUIRED_POPULATIONS) {
        const adapter = registry.get(population)!
        try {
          if (!instanceId) throw new Error(`brak instance_id w kontekscie rynku ${marketId}`)
          const rows = await adapter.loader(clientForMarket(container, { market_id: marketId, instance_id: instanceId }))
          const alarm = aggregateRecoveryAlarm(adapter, rows, { market_id: marketId, instance_id: instanceId })
          const delivery = alarm
            ? await send({
                severity: alarm.severity,
                code: alarm.alarm_code,
                message: `Populacja ${population}: ${alarm.overdue_count} wierszy po terminie na rynku ${marketId} (najwczesniejszy ${alarm.earliest_deadline})`,
                context: { ...alarm },
              })
            : null
          result.outcomes.push({ population_type: population, market_id: marketId, evaluated: true, overdue_count: alarm?.overdue_count ?? 0, alarm, delivery })
        } catch (err) {
          const error = errorText(err)
          const delivery = await send({
            severity: "ERROR",
            code: ALERT_CODE_RUN_FAILED,
            message: `Alarm populacji ${population}: rynek ${marketId} nieoceniony (read_failed)`,
            context: { reason: "read_failed", population_type: population, market_id: marketId, error },
          })
          result.outcomes.push({ population_type: population, market_id: marketId, evaluated: false, error, delivery })
        }
      }
    })
  } catch (err) {
    const reason = err instanceof SystemMarketContextError ? `market_context_denied:${err.reason}` : "run_failed"
    const error = errorText(err)
    const delivery = await send({
      severity: "ERROR",
      code: ALERT_CODE_RUN_FAILED,
      message: `Alarm populacji recovery nie wykonal sie (${reason})`,
      context: { reason, error, markets_env_var: MARKETS_ENV_VAR },
    })
    result.failure = { reason, error, delivery }
    return result
  }
  result.evaluated = result.outcomes.length > 0 && result.outcomes.every((o) => o.evaluated)
  return result
}

export default async function recoveryPopulationAlarm(container: MedusaContainer): Promise<RecoveryPopulationAlarmRunResult> {
  return runRecoveryPopulationAlarm(container)
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
