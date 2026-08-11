/**
 * v1.15.0 Story 6.2 (AC2) — koperta instrumentacji niesie kontekst AD-25,
 * a jego brak jest ODMOWA, nie domyslka.
 *
 * Przed ta story `buildEnvelope` zwracal piec pol i `env` ani `instance_id` wsrod nich
 * NIE BYLO (zmierzone 2026-08-11, `track.ts:186-204`). Metryka z `gp-dev` i metryka
 * z `gp-test` byly w odbiorze nieodroznialne, mimo ze AD-25 mowi wprost, ze artefakt
 * jednego srodowiska nie jest dowodem dla innego.
 */
import { describe, expect, it } from "@jest/globals"

import {
  MeasurementContextError,
  buildEnvelope,
  resolveMeasurementContext,
} from "../../lib/instrumentation/track"

const BASE = {
  request_id: "req_6_2",
  market_id: "bonbeauty",
  raw_actor_id: "usr_01ABCDEF",
  event_type: "voucher.redeem",
  outcome: "pass" as const,
}

describe("Story 6.2 AC2 — kontekst pomiaru w kopercie", () => {
  it("koperta niesie env i instance_id z jawnego kontekstu", () => {
    const envelope = buildEnvelope({
      ...BASE,
      measurement_env: { GP_ENV: "dev", GP_INSTANCE_ID: "gp-dev" } as NodeJS.ProcessEnv,
    })

    expect(envelope.env).toBe("dev")
    expect(envelope.instance_id).toBe("gp-dev")
    expect(envelope.market_id).toBe("bonbeauty")
    expect(envelope.actor_id).not.toBe(BASE.raw_actor_id)
  })

  it("KONTROLA NEGATYWNA: brak instance_id jest odmowa, nie domyslka", () => {
    expect(() =>
      buildEnvelope({ ...BASE, measurement_env: { GP_ENV: "dev" } as NodeJS.ProcessEnv }),
    ).toThrow(MeasurementContextError)
  })

  it("KONTROLA NEGATYWNA: brak env jest odmowa, nie domyslka", () => {
    expect(() =>
      buildEnvelope({
        ...BASE,
        measurement_env: { GP_INSTANCE_ID: "gp-dev" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(MeasurementContextError)
  })

  it("pusta wartosc nie przechodzi jako wartosc — to nadal brak kontekstu", () => {
    expect(() =>
      resolveMeasurementContext({ GP_ENV: "   ", GP_INSTANCE_ID: "gp-dev" } as NodeJS.ProcessEnv),
    ).toThrow(MeasurementContextError)
  })

  it("normalizacja jest TA SAMA co w Story 4.8 — drugi ksztalt bylby drugim zrodlem prawdy", () => {
    expect(
      resolveMeasurementContext({
        NODE_ENV: "development",
        GP_INSTANCE_ID: "gp-dev",
      } as NodeJS.ProcessEnv).env,
    ).toBe("dev")
    expect(
      resolveMeasurementContext({
        NODE_ENV: "production",
        GP_INSTANCE_ID: "gp-prod",
      } as NodeJS.ProcessEnv).env,
    ).toBe("prod")
  })

  it("blad niesie MASZYNOWY kod, a nie tylko tekst", () => {
    try {
      resolveMeasurementContext({} as NodeJS.ProcessEnv)
      throw new Error("mialo rzucic")
    } catch (error) {
      expect((error as MeasurementContextError).error_code).toBe(
        "INSTRUMENTATION_MEASUREMENT_CONTEXT_REQUIRED",
      )
    }
  })
})
