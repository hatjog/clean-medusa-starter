/**
 * deferred-issuance-trace-age-escalation — v1.16.0 Story 4.5 (FR-12, AD-32, NFR-4).
 *
 * WYZWALACZ ODZYSKU niezależny od `order.placed`: scheduled job, który co
 * przebieg czyta populację śladów `deferred_issuance_trace` w stanie
 * `awaiting_order` starszych niż próg wieku i eskaluje każdy z nich alarmem
 * strukturalnym (`emitStructuredAlert`, właściciel `ops-recovery`).
 *
 * ── Jedna stała, jedna migawka ─────────────────────────────────────────────
 * Próg pochodzi wyłącznie z `DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD`
 * (`lib/recovery/recovery-config.ts`, D-35 p.9). Wiek liczy BAZA w jednej
 * instrukcji (`LIST_DEFERRED_ISSUANCE_TRACES_OVER_AGE_THRESHOLD_SQL`,
 * `statement_timestamp()`); ten plik nie bierze `Date` do zapytania.
 *
 * ── Bez mutacji stanu — decyzja Story 4.3 (DW-15-333 p.3) ──────────────────
 * CHECK `deferred_issuance_trace_state_check` (4.4) ma już stan `escalated`,
 * więc przejście NIE wymaga migracji. Decyzja 4.3: job go NIE wykonuje i NIE
 * deduplikuje WARN. Powód: przejście stanu populacji recovery to mutacja
 * naprawcza, która należy do Epiku 11 (kernel `applyRecoveryIntent`, 11.3) —
 * job alarmowy pisałby stan z pominięciem audytu i wersji kontraktu 4.1;
 * deduplikacja w pamięci procesu ginie przy restarcie, a trwała wymaga zapisu.
 * Konsekwencja nazwana: ślad ponad progiem jest eskalowany przy KAŻDYM
 * przebiegu, dopóki nie zostanie domknięty (alarm powtarzalny, nie jednorazowy).
 *
 * ── Izolacja porażki per rynek (Story 4.3, DW-15-333 p.1) ─────────────────
 * Wyjątek odczytu na rynku A nie przerywa oceny rynku B: każdy rynek ma
 * wynik w `per_market` (`evaluated: true|false`). Status przebiegu to `ok`
 * tylko, gdy oceniono każdy zadeklarowany rynek.
 *
 * ── NFR-4: porażka ma skutek ───────────────────────────────────────────────
 * Job nie wywraca schedulera, ale każda porażka (brak deklaracji rynków,
 * błąd odczytu) emituje alarm `ERROR`, jest logowana i zwraca wynik
 * przebiegu `status: "failed"` z nazwą przyczyny — nigdy pusty `catch`.
 *
 * ── Kontekst rynku (AD-21, ADR-177) ────────────────────────────────────────
 * Lista rynków jest jawna (`DEFERRED_ISSUANCE_TRACE_AGE_ESCALATION_MARKETS`,
 * CSV); brak deklaracji = odmowa nośnika `runInSystemMarketContext`. Odczyt
 * idzie przez `queryUnderMarketContext`, który weryfikuje, że sesja PG niesie
 * GUC rynku i instancji (RLS `market_isolation`).
 */
import type { MedusaContainer } from "@medusajs/framework/types"

import { emitStructuredAlert, type StructuredAlertPayload } from "../lib/alert-emit"
import { marketContextStorage } from "../lib/market-context"
import { queryUnderMarketContext } from "../lib/payment/stripe-payment-intent-transport"
import {
  listDeferredIssuanceTracesOverAgeThreshold,
  type DeferredIssuanceTraceOverAgeRow,
  type TraceQueryClient,
} from "../lib/recovery/deferred-issuance-trace"
import {
  DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD,
  type DeferredIssuanceTraceAgeThresholdConfig,
} from "../lib/recovery/recovery-config"
import {
  runInSystemMarketContext,
  SystemMarketContextError,
  type SystemExecutionOrigin,
  type SystemMarketScope,
} from "../lib/system-market-context"

export const SCHEDULE_NAME = "deferred-issuance-trace-age-escalation" as const
/** Co 15 minut — opóźnienie eskalacji ≪ próg 24 h, a odczyt to jeden indeksowany SELECT. */
export const SCHEDULE_CRON = "*/15 * * * *" as const
export const MARKETS_ENV_VAR = "DEFERRED_ISSUANCE_TRACE_AGE_ESCALATION_MARKETS" as const

export const ALERT_CODE_THRESHOLD_EXCEEDED = "DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_EXCEEDED" as const
export const ALERT_CODE_RUN_FAILED = "DEFERRED_ISSUANCE_TRACE_AGE_ESCALATION_FAILED" as const

export const ESCALATION_ORIGIN: SystemExecutionOrigin = {
  surface: "job",
  name: SCHEDULE_NAME,
}

type JobLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, err?: unknown) => void
}

export type AgeEscalationMarketResult =
  | { market_id: string; evaluated: true; over_threshold: number }
  | { market_id: string; evaluated: false; reason: "read_failed"; error: string }

export type AgeEscalationRunResult =
  | {
      status: "ok"
      threshold_seconds: number
      markets: string[]
      escalated: Array<{ market_id: string; trace_id: string; age_seconds: number }>
      per_market: AgeEscalationMarketResult[]
    }
  | {
      status: "failed"
      reason: string
      error: string
      markets: string[]
      per_market: AgeEscalationMarketResult[]
    }

export type AgeEscalationDeps = {
  env?: NodeJS.ProcessEnv
  thresholdConfig?: Partial<DeferredIssuanceTraceAgeThresholdConfig>
  emit?: (payload: StructuredAlertPayload) => void
  /** Klient odczytu pod kontekstem rynku; domyślnie `queryUnderMarketContext`. */
  clientForMarket?: (
    container: MedusaContainer,
    context: { market_id: string; instance_id: string }
  ) => TraceQueryClient
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (message) => console.log(`[${SCHEDULE_NAME}] ${message}`),
    warn: (message) => console.warn(`[${SCHEDULE_NAME}] ${message}`),
    error: (message, err) => console.error(`[${SCHEDULE_NAME}] ${message}`, err),
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
    .map((market) => market.trim())
    .filter((market) => market.length > 0)
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

function toAgeSeconds(row: DeferredIssuanceTraceOverAgeRow): number {
  return typeof row.age_seconds === "number" ? row.age_seconds : Number(row.age_seconds)
}

export async function runDeferredIssuanceTraceAgeEscalation(
  container: MedusaContainer,
  deps: AgeEscalationDeps = {}
): Promise<AgeEscalationRunResult> {
  const logger = resolveLogger(container)
  const emit = deps.emit ?? emitStructuredAlert
  const clientForMarket = deps.clientForMarket ?? defaultClientForMarket
  const thresholdConfig = deps.thresholdConfig ?? DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD
  const declared = readDeclaredMarkets(deps.env ?? process.env)

  const scope = {
    // `undefined` jedzie do nośnika CELOWO — odmowę wystawia nośnik (AD-21).
    markets: declared as unknown as readonly string[],
    origin: ESCALATION_ORIGIN,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) =>
        logger.warn(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (message: string, meta?: Record<string, unknown>) =>
        logger.error(`${message} ${JSON.stringify(meta ?? {})}`),
    },
  } satisfies SystemMarketScope

  const escalated: Array<{ market_id: string; trace_id: string; age_seconds: number }> = []
  const perMarket: AgeEscalationMarketResult[] = []
  let thresholdSeconds = 0

  try {
    await runInSystemMarketContext(scope, async (marketId) => {
      try {
        const store = marketContextStorage.getStore()
        const instanceId = store?.instance_id
        if (!instanceId) {
          throw new Error(`brak instance_id w kontekscie rynku ${marketId}`)
        }
        const client = clientForMarket(container, { market_id: marketId, instance_id: instanceId })
        const population = await listDeferredIssuanceTracesOverAgeThreshold(client, thresholdConfig)
        thresholdSeconds = population.threshold_seconds
        for (const row of population.rows) {
          const ageSeconds = toAgeSeconds(row)
          emit({
            severity: "WARN",
            code: ALERT_CODE_THRESHOLD_EXCEEDED,
            message:
              `Slad platnosci bez zamowienia ${row.trace_id} przekroczyl prog wieku ` +
              `(${ageSeconds}s > ${population.threshold_seconds}s) — eskalacja do ${row.owner_id}`,
            context: {
              trace_id: row.trace_id,
              market_id: row.market_id,
              instance_id: row.instance_id,
              owner_id: row.owner_id,
              payment_intent_id: row.payment_intent_id,
              age_seconds: ageSeconds,
              threshold_seconds: population.threshold_seconds,
              age_source: row.age_source,
              measured_at: row.measured_at,
            },
          })
          escalated.push({ market_id: marketId, trace_id: row.trace_id, age_seconds: ageSeconds })
        }
        logger.info(`market=${marketId} over_threshold=${population.rows.length}`)
        perMarket.push({ market_id: marketId, evaluated: true, over_threshold: population.rows.length })
      } catch (err) {
        // Izolacja per rynek (DW-15-333 p.1): porażka ma skutek (ERROR + wynik
        // rynku), a pozostałe rynki są oceniane dalej.
        const message = err instanceof Error ? err.message : String(err)
        emit({
          severity: "ERROR",
          code: ALERT_CODE_RUN_FAILED,
          message: `Eskalacja wieku sladow: rynek ${marketId} nieoceniony (read_failed)`,
          context: { reason: "read_failed", error: message, market_id: marketId, markets_env_var: MARKETS_ENV_VAR },
        })
        logger.error(`market=${marketId} escalation FAILED (read_failed); populacja rynku nieoceniona`, err)
        perMarket.push({ market_id: marketId, evaluated: false, reason: "read_failed", error: message })
      }
    })
  } catch (err) {
    const reason =
      err instanceof SystemMarketContextError ? `market_context_denied:${err.reason}` : "read_failed"
    const message = err instanceof Error ? err.message : String(err)
    emit({
      severity: "ERROR",
      code: ALERT_CODE_RUN_FAILED,
      message: `Eskalacja wieku sladow nie wykonala sie (${reason}) — populacja nieoceniona`,
      context: { reason, error: message, markets: declared ?? null, markets_env_var: MARKETS_ENV_VAR },
    })
    logger.error(`escalation FAILED (${reason}); populacja ponad progiem nieoceniona`, err)
    return { status: "failed", reason, error: message, markets: declared ?? [], per_market: perMarket }
  }

  const failedMarket = perMarket.find((m) => !m.evaluated)
  if (failedMarket && !failedMarket.evaluated) {
    return {
      status: "failed",
      reason: "read_failed",
      error: failedMarket.error,
      markets: declared ?? [],
      per_market: perMarket,
    }
  }

  logger.info(
    `markets=${(declared ?? []).join(",")} threshold_seconds=${thresholdSeconds} escalated=${escalated.length}`
  )
  return { status: "ok", threshold_seconds: thresholdSeconds, markets: declared ?? [], escalated, per_market: perMarket }
}

export default async function deferredIssuanceTraceAgeEscalation(
  container: MedusaContainer
): Promise<void> {
  await runDeferredIssuanceTraceAgeEscalation(container)
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
