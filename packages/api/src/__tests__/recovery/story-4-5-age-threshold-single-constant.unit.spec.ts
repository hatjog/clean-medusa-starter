/**
 * v1.16.0 Story 4.5 AC1 — jedna nazwana stała progu wieku, czytana przez
 * stronę eskalacji (job) i stronę odczytu populacji (zapytanie/bindingi).
 * Wartość porównywana z IMPORTU `recovery-config.ts`, nie z literału.
 */
import { describe, expect, it } from "@jest/globals"

import {
  assertDeferredIssuanceTraceAgeThreshold,
  DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD,
  DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS,
  DEFERRED_ISSUANCE_TRACE_SLA,
} from "../../lib/recovery/recovery-config"
import {
  LIST_DEFERRED_ISSUANCE_TRACES_OVER_AGE_THRESHOLD_SQL,
  listDeferredIssuanceTracesOverAgeThreshold,
  readDeferredIssuanceTraceAgeThresholdSeconds,
  type TraceQueryClient,
} from "../../lib/recovery/deferred-issuance-trace"
import { runDeferredIssuanceTraceAgeEscalation } from "../../jobs/deferred-issuance-trace-age-escalation"

function capturingClient(calls: Array<{ sql: string; values: ReadonlyArray<unknown> }>): TraceQueryClient {
  return {
    query: async <T,>(sql: string, values: ReadonlyArray<unknown> = []) => {
      calls.push({ sql, values })
      return { rows: [] as T[], rowCount: 0 }
    },
  }
}

const quietContainer = {
  resolve: (key: string) => {
    if (key === "logger") return { info: () => undefined, warn: () => undefined, error: () => undefined }
    throw new Error(`unresolved ${key}`)
  },
}

async function jobBinding(thresholdConfig?: typeof DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD) {
  const calls: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
  const result = await runDeferredIssuanceTraceAgeEscalation(quietContainer as never, {
    env: { DEFERRED_ISSUANCE_TRACE_AGE_ESCALATION_MARKETS: "mkt_4_5_a", GP_INSTANCE_ID: "gp_test" },
    emit: () => undefined,
    thresholdConfig,
    clientForMarket: () => capturingClient(calls),
  })
  return { calls, result }
}

describe("Story 4.5 AC1 — jedna nazwana stała progu wieku", () => {
  it("próg czyta wartość z jednej decyzji (D-35 p.9): ta sama wartość co SLA, osobna nazwa", () => {
    expect(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS).toBe(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD.seconds)
    expect(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD.seconds).toBe(DEFERRED_ISSUANCE_TRACE_SLA.seconds)
    expect(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD.source).toBe(DEFERRED_ISSUANCE_TRACE_SLA.source)
    expect(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD.owner_id).toBe("ops-recovery")
    expect(Object.isFrozen(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD)).toBe(true)
  })

  it("strona odczytu populacji binduje próg z TEJ stałej (jedyny binding)", async () => {
    const calls: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const out = await listDeferredIssuanceTracesOverAgeThreshold(capturingClient(calls))
    expect(out.threshold_seconds).toBe(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS)
    expect(calls).toEqual([
      { sql: LIST_DEFERRED_ISSUANCE_TRACES_OVER_AGE_THRESHOLD_SQL, values: [DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS] },
    ])
    expect(readDeferredIssuanceTraceAgeThresholdSeconds()).toBe(DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS)
  })

  it("strona eskalacji (job) dostaje tę samą wartość z tej samej stałej", async () => {
    const { calls, result } = await jobBinding()
    expect(result).toEqual(expect.objectContaining({ status: "ok", threshold_seconds: DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS }))
    expect(calls.map((c) => c.values)).toEqual([[DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD_SECONDS]])
  })

  it("mutacja konfiguracji (wstrzyknięcie) przesuwa obie strony jednocześnie", async () => {
    const mutated = Object.freeze({ ...DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD, seconds: DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD.seconds + 7 })
    const readCalls: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const read = await listDeferredIssuanceTracesOverAgeThreshold(capturingClient(readCalls), mutated)
    const { calls, result } = await jobBinding(mutated)
    expect(read.threshold_seconds).toBe(mutated.seconds)
    expect(readCalls[0].values).toEqual([mutated.seconds])
    expect(calls[0].values).toEqual([mutated.seconds])
    expect(result).toEqual(expect.objectContaining({ threshold_seconds: mutated.seconds }))
  })

  it("niepoprawny próg = fail-loud (nigdy cichy próg zerowy)", async () => {
    for (const bad of [null, {}, { ...DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD, seconds: 0 }, { ...DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD, seconds: 1.5 }, { ...DEFERRED_ISSUANCE_TRACE_AGE_THRESHOLD, source: " " }]) {
      expect(() => assertDeferredIssuanceTraceAgeThreshold(bad as never)).toThrow(/AGE_THRESHOLD/)
    }
    await expect(
      listDeferredIssuanceTracesOverAgeThreshold(capturingClient([]), { seconds: -1 } as never)
    ).rejects.toThrow(/AGE_THRESHOLD/)
  })
})
