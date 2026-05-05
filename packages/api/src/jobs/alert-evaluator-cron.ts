/**
 * Story v160-8-5: Alert evaluator cron — every 60s evaluates thresholds,
 * persists firing history, invokes auto-rollback on P1 firings, and records
 * a durable heartbeat per tick so operators can distinguish "no alerts firing"
 * from "scheduler never ran".
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import { evaluateAlerts } from "../lib/alert-evaluator"
import {
  getRollbackHistory24h,
  triggerRollback,
} from "../lib/automated-rollback"
import type { Knex } from "knex"

const _firingHistory: Array<{
  alert_id: string
  severity: string
  action: string
  evaluated_value: string | number | null
  firing_since: string
  computed_at: string
}> = []

const ALERT_HISTORY_TABLE = "operator_alert_firing_history"
const TICK_HISTORY_TABLE = "operator_alert_evaluator_tick_history"

export const SCHEDULE_NAME = "alert-evaluator-cron" as const
export const SCHEDULE_CRON = "* * * * *" as const

type ScopeResolver = {
  resolve: (key: string) => unknown
}

type JobLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, err?: unknown) => void
}

type AlertHistoryRow = {
  id?: string
  alert_id: string
  severity: string
  action: string
  evaluated_value: string | number | null
  firing_since: string
  computed_at: string
}

type TickStatus = "pass" | "fail"
type TickTriggeredBy = "manual" | "scheduler"

type TickHistoryRow = {
  id?: string
  schedule_name: string
  triggered_by: TickTriggeredBy
  tick_started_at: string
  tick_finished_at: string
  firing_count: number
  auto_rollbacks: number
  status: TickStatus
  error_message: string | null
}

const _tickHistory: TickHistoryRow[] = []

function resolveOptional<T>(
  container: MedusaContainer | undefined,
  key: string,
): T | null {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null
  } catch {
    return null
  }
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (message) => console.log(`[${SCHEDULE_NAME}] ${message}`),
    warn: (message) => console.warn(`[${SCHEDULE_NAME}] ${message}`),
    error: (message, err) => console.error(`[${SCHEDULE_NAME}] ${message}`, err),
  }

  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved && typeof resolved.info === "function") {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? fallback.error).bind(resolved),
      }
    }
  } catch {
    return fallback
  }

  return fallback
}

async function persistTickHistory(
  row: TickHistoryRow,
  db?: Knex | null,
): Promise<void> {
  _tickHistory.push(row)
  if (_tickHistory.length > 1000) {
    _tickHistory.splice(0, _tickHistory.length - 1000)
  }

  if (db) {
    await db<TickHistoryRow>(TICK_HISTORY_TABLE).insert(row)
  }
}

export async function runAlertEvaluatorTick(options: {
  db?: Knex | null
  scope?: ScopeResolver | null
  triggered_by?: TickTriggeredBy
  logger?: JobLogger | null
} = {}): Promise<{
  firing_count: number
  auto_rollbacks: number
  tick_started_at: string
  tick_finished_at: string
  status: TickStatus
  triggered_by: TickTriggeredBy
}> {
  return runAlertEvaluatorTickWithOptions(options)
}

export async function runAlertEvaluatorTickWithOptions(options: {
  db?: Knex | null
  scope?: ScopeResolver | null
  triggered_by?: TickTriggeredBy
  logger?: JobLogger | null
} = {}): Promise<{
  firing_count: number
  auto_rollbacks: number
  tick_started_at: string
  tick_finished_at: string
  status: TickStatus
  triggered_by: TickTriggeredBy
}> {
  const tick_started_at = new Date().toISOString()
  const triggered_by = options.triggered_by ?? "manual"

  try {
    const result = await evaluateAlerts({
      db: options.db ?? null,
      scope: options.scope ?? null,
    })
    let auto_rollbacks = 0

    const historyRows: AlertHistoryRow[] = []
    for (const alert of result.firing) {
      const row = {
        alert_id: alert.id,
        severity: alert.severity,
        action: alert.action,
        evaluated_value: alert.evaluated_value,
        firing_since: alert.firing_since,
        computed_at: result.computed_at,
      }
      _firingHistory.push(row)
      historyRows.push(row)
      if (alert.action === "auto_rollback") {
        const rb = await triggerRollback(
          alert.id,
          `Auto-rollback by ${alert.id}`,
          options.db ?? null,
        )
        if (rb.rolled_back) auto_rollbacks++
      }
    }

    if (options.db && historyRows.length > 0) {
      await options.db<AlertHistoryRow>(ALERT_HISTORY_TABLE).insert(historyRows)
    }
    if (_firingHistory.length > 1000) {
      _firingHistory.splice(0, _firingHistory.length - 1000)
    }

    const tick_finished_at = new Date().toISOString()
    await persistTickHistory(
      {
        schedule_name: SCHEDULE_NAME,
        triggered_by,
        tick_started_at,
        tick_finished_at,
        firing_count: result.firing.length,
        auto_rollbacks,
        status: "pass",
        error_message: null,
      },
      options.db ?? null,
    )
    options.logger?.info(
      `tick done: firing=${result.firing.length} auto_rollbacks=${auto_rollbacks} trigger=${triggered_by}`,
    )

    return {
      firing_count: result.firing.length,
      auto_rollbacks,
      tick_started_at,
      tick_finished_at,
      status: "pass",
      triggered_by,
    }
  } catch (err) {
    const tick_finished_at = new Date().toISOString()
    await persistTickHistory(
      {
        schedule_name: SCHEDULE_NAME,
        triggered_by,
        tick_started_at,
        tick_finished_at,
        firing_count: 0,
        auto_rollbacks: 0,
        status: "fail",
        error_message: err instanceof Error ? err.message : String(err),
      },
      options.db ?? null,
    )
    options.logger?.error(`tick failed: trigger=${triggered_by}`, err)
    throw err
  }
}

export async function getFiringHistory24h(
  db?: Knex | null,
): Promise<typeof _firingHistory> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  if (db) {
    const rows = await db<AlertHistoryRow>(ALERT_HISTORY_TABLE)
      .select("*")
      .where("firing_since", ">=", new Date(cutoff).toISOString())
      .orderBy("firing_since", "desc")
      .limit(200)

    return rows
  }
  return _firingHistory.filter((e) => Date.parse(e.firing_since) >= cutoff)
}

export async function getTickHistory24h(
  db?: Knex | null,
): Promise<TickHistoryRow[]> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  if (db) {
    const rows = await db<TickHistoryRow>(TICK_HISTORY_TABLE)
      .select("*")
      .where("tick_started_at", ">=", new Date(cutoff).toISOString())
      .orderBy("tick_started_at", "desc")
      .limit(200)

    return rows
  }

  return _tickHistory
    .filter((entry) => Date.parse(entry.tick_started_at) >= cutoff)
    .sort((left, right) => right.tick_started_at.localeCompare(left.tick_started_at))
}

export async function getLastTick(
  db?: Knex | null,
): Promise<TickHistoryRow | null> {
  if (db) {
    const row = await db<TickHistoryRow>(TICK_HISTORY_TABLE)
      .select("*")
      .orderBy("tick_started_at", "desc")
      .first()

    return row ?? null
  }

  return (
    [..._tickHistory].sort((left, right) =>
      right.tick_started_at.localeCompare(left.tick_started_at),
    )[0] ?? null
  )
}

export { getRollbackHistory24h }

export default async function alertEvaluatorCron(
  container: MedusaContainer,
): Promise<void> {
  const logger = resolveLogger(container)
  const db = resolveOptional<Knex>(container, "__pg_connection__")
  if (!db) {
    logger.warn("no DB connection resolved — heartbeat will be in-memory only")
  }

  await runAlertEvaluatorTick({
    db,
    scope: container as ScopeResolver,
    triggered_by: "scheduler",
    logger,
  })
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
