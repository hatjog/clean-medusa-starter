/**
 * v1.16.0 Story 4.5 AC2 — job eskalacji wieku: scheduled (cron), niezależny
 * od `order.placed`, SQL bez czasu aplikacji, porażka ma skutek (NFR-4).
 */
import { afterEach, describe, expect, it } from "@jest/globals"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { StructuredAlertPayload } from "../../lib/alert-emit"
import {
  LIST_DEFERRED_ISSUANCE_TRACES_OVER_AGE_THRESHOLD_SQL,
  type TraceQueryClient,
} from "../../lib/recovery/deferred-issuance-trace"
import { DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS } from "../../lib/recovery/recovery-config"
import { marketContextStorage } from "../../lib/market-context"
import deferredIssuanceTraceAgeEscalation, {
  ALERT_CODE_RUN_FAILED,
  ALERT_CODE_THRESHOLD_EXCEEDED,
  config,
  MARKETS_ENV_VAR,
  runDeferredIssuanceTraceAgeEscalation,
} from "../deferred-issuance-trace-age-escalation"

// Kod bez komentarzy: nagłówek pliku NAZYWA `order.placed`, kod nie może go użyć.
const SOURCE = readFileSync(join(__dirname, "..", "deferred-issuance-trace-age-escalation.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
const originalInstance = process.env.GP_INSTANCE_ID

afterEach(() => {
  if (originalInstance === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = originalInstance
})

function container(errors: string[] = []) {
  return {
    resolve: (key: string) => {
      if (key === "logger")
        return { info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) }
      throw new Error(`unresolved ${key}`)
    },
  }
}

function client(rows: unknown[] | Error, calls: ReadonlyArray<unknown>[] = []): TraceQueryClient {
  return {
    query: async <T,>(_sql: string, values: ReadonlyArray<unknown> = []) => {
      calls.push(values)
      if (rows instanceof Error) throw rows
      return { rows: rows as T[], rowCount: rows.length }
    },
  }
}

describe("Story 4.5 AC2 — job deferred-issuance-trace-age-escalation", () => {
  it("ma config.schedule (cron) i nie subskrybuje order.placed", () => {
    expect(config).toEqual({ name: "deferred-issuance-trace-age-escalation", schedule: expect.stringMatching(/^\S+ \S+ \S+ \S+ \S+$/) })
    expect(config).not.toHaveProperty("event")
    expect(SOURCE).not.toMatch(/order\.placed|subscribers\/|SubscriberConfig/)
    expect(typeof deferredIssuanceTraceAgeEscalation).toBe("function")
  })

  it("SQL liczy wiek w bazie z jednej migawki; jedyny binding to próg (brak Date)", async () => {
    expect(LIST_DEFERRED_ISSUANCE_TRACES_OVER_AGE_THRESHOLD_SQL).toMatch(/statement_timestamp\(\) - psp_occurred_at > make_interval\(secs => \$1/)
    expect(LIST_DEFERRED_ISSUANCE_TRACES_OVER_AGE_THRESHOLD_SQL).not.toMatch(/\$2/)
    expect(SOURCE).not.toMatch(/new Date\(|Date\.now\(/)
    const calls: ReadonlyArray<unknown>[] = []
    await runDeferredIssuanceTraceAgeEscalation(container() as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" },
      emit: () => undefined,
      clientForMarket: () => client([], calls),
    })
    expect(calls).toEqual([[DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS]])
    for (const values of calls) for (const v of values) expect(v).not.toBeInstanceOf(Date)
  })

  it("eskaluje każdy ślad ponad progiem alarmem WARN pod kontekstem rynku", async () => {
    process.env.GP_INSTANCE_ID = "gp_test"
    const alerts: StructuredAlertPayload[] = []
    const contexts: unknown[] = []
    const result = await runDeferredIssuanceTraceAgeEscalation(container() as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a" },
      emit: (p) => alerts.push(p),
      clientForMarket: (_c, ctx) => {
        contexts.push({ ctx, store: marketContextStorage.getStore()?.market_id })
        return client([{ trace_id: "evt_1#deferred-issuance", market_id: "mkt_a", instance_id: "gp_test", owner_id: "ops-recovery", age_seconds: "90000", age_source: "database_now_minus_occurred_at" }])
      },
    })
    expect(contexts).toEqual([{ ctx: { market_id: "mkt_a", instance_id: "gp_test" }, store: "mkt_a" }])
    expect(alerts).toEqual([expect.objectContaining({ severity: "WARN", code: ALERT_CODE_THRESHOLD_EXCEEDED, context: expect.objectContaining({ trace_id: "evt_1#deferred-issuance", age_seconds: 90000 }) })])
    expect(result).toEqual(expect.objectContaining({ status: "ok", escalated: [{ market_id: "mkt_a", trace_id: "evt_1#deferred-issuance", age_seconds: 90000 }] }))
  })

  it("NFR-4 negatywny: porażka zapytania = alarm ERROR + log + status failed (nie pusty catch)", async () => {
    const alerts: StructuredAlertPayload[] = []
    const errors: string[] = []
    const result = await runDeferredIssuanceTraceAgeEscalation(container(errors) as never, {
      env: { [MARKETS_ENV_VAR]: "mkt_a", GP_INSTANCE_ID: "gp_test" },
      emit: (p) => alerts.push(p),
      clientForMarket: () => client(new Error("connection refused")),
    })
    expect(result).toEqual({ status: "failed", reason: "read_failed", error: "connection refused", markets: ["mkt_a"] })
    expect(alerts).toEqual([expect.objectContaining({ severity: "ERROR", code: ALERT_CODE_RUN_FAILED })])
    expect(errors.some((m) => /FAILED/.test(m))).toBe(true)
  })

  it("NFR-4 negatywny: brak deklaracji rynków = odmowa z alarmem, zero odczytu", async () => {
    const alerts: StructuredAlertPayload[] = []
    const calls: ReadonlyArray<unknown>[] = []
    const result = await runDeferredIssuanceTraceAgeEscalation(container() as never, {
      env: { GP_INSTANCE_ID: "gp_test" },
      emit: (p) => alerts.push(p),
      clientForMarket: () => client([], calls),
    })
    expect(result).toEqual(expect.objectContaining({ status: "failed", reason: "market_context_denied:markets_not_declared" }))
    expect(alerts.map((a) => a.code)).toEqual([ALERT_CODE_RUN_FAILED])
    expect(calls).toEqual([])
  })
})
