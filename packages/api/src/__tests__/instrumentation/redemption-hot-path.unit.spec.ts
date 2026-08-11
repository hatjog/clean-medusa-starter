/**
 * v1.15.0 Story 6.2 (AC1, AC3) — nosnik pomiaru sciezki goracej realizacji.
 *
 * Dwie rzeczy, ktore ten plik ma udowodnic wykonaniem:
 *  1. licznik prob i licznik sukcesow sa OSOBNYMI seriami (AC1),
 *  2. przy probie ponizej progu werdykt jest `not_computable`, a nie `pass`
 *     ani liczba udajaca percentyl (AC3) — z KONTROLA W OBIE STRONY.
 */
import { describe, expect, it } from "@jest/globals"

import {
  NFR11_MIN_POPULATION,
  REDEMPTION_ATTEMPT_EVENT,
  REDEMPTION_DURATION_EVENT,
  REDEMPTION_SUCCESS_EVENT,
  computeNfr11Verdict,
  emitRedemptionHotPathMetrics,
  withRedemptionPiiGuard,
} from "../../lib/instrumentation/redemption-hot-path"

const LABELS = {
  request_id: "req_6_2",
  market_id: "bonbeauty",
  env: "dev",
  instance_id: "gp-dev",
  actor_id: "0123456789abcdef",
}

const makeSink = () => {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = []
  return {
    events,
    capture: (event: string, properties: Record<string, unknown>) =>
      events.push({ event, properties }),
  }
}

describe("AC1 — dwa liczniki i czas jako OSOBNE serie", () => {
  it("udana realizacja emituje probe, sukces i czas", () => {
    const sink = makeSink()
    const result = emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: { duration_ms: 1234, succeeded: true, http_status: 200 },
    })

    expect(result).toBe("emitted")
    expect(sink.events.map((e) => e.event)).toEqual([
      REDEMPTION_ATTEMPT_EVENT,
      REDEMPTION_SUCCESS_EVENT,
      REDEMPTION_DURATION_EVENT,
    ])
  })

  it("odmowa emituje probe i czas, ale NIE sukces", () => {
    const sink = makeSink()
    emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: {
        duration_ms: 77,
        succeeded: false,
        http_status: 409,
        refusal_code: "already_redeemed",
      },
    })

    const names = sink.events.map((e) => e.event)
    expect(names).toContain(REDEMPTION_ATTEMPT_EVENT)
    expect(names).toContain(REDEMPTION_DURATION_EVENT)
    expect(names).not.toContain(REDEMPTION_SUCCESS_EVENT)
  })

  it("kazda seria niesie komplet etykiet AD-25", () => {
    const sink = makeSink()
    emitRedemptionHotPathMetrics({
      sink,
      labels: LABELS,
      outcome: { duration_ms: 10, succeeded: true, http_status: 200 },
    })

    for (const emitted of sink.events) {
      expect(emitted.properties.env).toBe("dev")
      expect(emitted.properties.instance_id).toBe("gp-dev")
      expect(emitted.properties.market_id).toBe("bonbeauty")
      expect(emitted.properties.request_id).toBe("req_6_2")
    }
  })

  it("brak nosnika jest NAZWANY, nie cichym sukcesem i nie wyjatkiem", () => {
    expect(
      emitRedemptionHotPathMetrics({
        sink: null,
        labels: LABELS,
        outcome: { duration_ms: 1, succeeded: true, http_status: 200 },
      }),
    ).toBe("carrier_unavailable")
  })

  it("bramka PII siedzi na NOSNIKU i rzuca, nie strippuje", () => {
    const sink = makeSink()
    const guarded = withRedemptionPiiGuard(sink, "test")
    expect(() => guarded?.capture("x", { email: "a@b.c" })).toThrow(/PII/)
    expect(sink.events).toHaveLength(0)
  })
})

describe("AC3 — prog bez populacji jest NIEMIERZALNY", () => {
  it("KONTROLA: N = 1 daje not_computable, nie pass i nie liczbe", () => {
    const v = computeNfr11Verdict([{ duration_ms: 1000, succeeded: true }])

    expect(v.window_status).toBe("open")
    expect(v.success_rate_verdict).toBe("not_computable")
    expect(v.duration_p95_verdict).toBe("not_computable")
    expect(v.success_rate).toBeNull()
    expect(v.duration_p95_ms).toBeNull()
    expect(v.missing_to_threshold).toBe(NFR11_MIN_POPULATION - 1)
  })

  it("KONTROLA PRZECIWNA: populacja progowa daje liczbe i werdykt", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, () => ({
      duration_ms: 1000,
      succeeded: true,
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.window_status).toBe("closed")
    expect(v.success_rate).toBe(1)
    expect(v.success_rate_verdict).toBe("pass")
    expect(v.duration_p95_ms).toBe(1000)
    expect(v.duration_p95_verdict).toBe("pass")
  })

  it("domknieta proba PONIZEJ progu skutecznosci daje fail, nie not_computable", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, (_, i) => ({
      duration_ms: 500,
      succeeded: i > 1, // 2/30 nieudane => 93,3% < 98%
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.window_status).toBe("closed")
    expect(v.success_rate_verdict).toBe("fail")
  })

  it("percentyl przekraczajacy prog czasu daje fail", () => {
    const samples = Array.from({ length: NFR11_MIN_POPULATION }, (_, i) => ({
      duration_ms: i >= NFR11_MIN_POPULATION - 2 ? 30_000 : 100,
      succeeded: true,
    }))
    const v = computeNfr11Verdict(samples)

    expect(v.duration_p95_ms).toBe(30_000)
    expect(v.duration_p95_verdict).toBe("fail")
  })
})
