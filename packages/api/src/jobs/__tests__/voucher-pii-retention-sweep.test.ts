import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"

import { marketContextStorage } from "../../lib/market-context"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import voucherPiiRetentionSweep, {
  RETENTION_DAYS_MIN,
  RETRY_HORIZON_DAYS,
  validateRetentionDays,
} from "../voucher-pii-retention-sweep"
import { SWEEP_GAP_LOOKBACK_MS } from "../voucher-delivery-reconciliation-sweep"
import { resolveRetentionMarkets } from "../../modules/voucher-pii/recipient-retention-markets"

const originalInstanceId = process.env.GP_INSTANCE_ID

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = originalInstanceId
})

function containerForRetentionSweep(observedScopes: Array<unknown>, calls: string[]) {
  return {
    resolve: (key: string) => {
      if (key === "gp_market_loader") return { listActive: async () => ["market-a"] }
      if (key === "voucher_pii_retention_runner") {
        // v1.16.0 Story 11.6: job nie zależy już od klucza `voucher_pii`
        // (nierejestrowanego w runtime) — seam wykonawcy per rynek.
        return async ({ market_id, cutoff }: { market_id: string; cutoff: Date }) => {
          calls.push(market_id)
          observedScopes.push(marketContextStorage.getStore())
          return { market_id, cutoff: cutoff.toISOString(), carriers: {} }
        }
      }
      if (key === "logger") return { info: () => undefined, warn: () => undefined, error: () => undefined }
      throw new Error(`unresolved ${key}`)
    },
  }
}

describe("Story 11.1 — job retention ustanawia systemowy scope", () => {
  it("wykonuje rzeczywisty sweep per market we wspólnym nośniku ALS", async () => {
    process.env.GP_INSTANCE_ID = "instance-job"
    const observedScopes: Array<unknown> = []
    const calls: string[] = []
    await voucherPiiRetentionSweep(containerForRetentionSweep(observedScopes, calls) as never)

    expect(calls).toEqual(["market-a"])
    expect(observedScopes).toEqual([
      expect.objectContaining({
        market_id: "market-a",
        instance_id: "instance-job",
        system: { surface: "job", name: "voucher-pii-retention-sweep" },
      }),
    ])
  })

  it("odmawia przed sweepem, gdy job nie ma jawnej instancji", async () => {
    delete process.env.GP_INSTANCE_ID
    const observedScopes: Array<unknown> = []
    const calls: string[] = []

    await expect(
      voucherPiiRetentionSweep(containerForRetentionSweep(observedScopes, calls) as never)
    ).rejects.toThrow(/instance_id/)
    expect(calls).toEqual([])
    expect(observedScopes).toEqual([])
  })
})

describe("Story 11.6 — wynik per nośnik i brak martwego wiring", () => {
  it("zwraca wynik wykonawcy per rynek (liczniki per nośnik), bez klucza voucher_pii", async () => {
    process.env.GP_INSTANCE_ID = "instance-job"
    const observedScopes: Array<unknown> = []
    const calls: string[] = []
    const run = await voucherPiiRetentionSweep(containerForRetentionSweep(observedScopes, calls) as never)
    expect(run.results).toEqual([expect.objectContaining({ market_id: "market-a", carriers: {} })])
  })

  it("brak PG_CONNECTION i wykonawcy = głośny error, zero pracy (nie cichy no-op)", async () => {
    process.env.GP_INSTANCE_ID = "instance-job"
    const errors: string[] = []
    const container = {
      resolve: (key: string) => {
        if (key === "gp_market_loader") return { listActive: async () => ["market-a"] }
        if (key === "logger") return { info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) }
        throw new Error(`unresolved ${key}`)
      },
    }
    const run = await voucherPiiRetentionSweep(container as never)
    expect(run.results).toEqual([])
    expect(errors.join("\n")).toMatch(/GP_RECIPIENT_RETENTION_NO_PG_CONNECTION/)
  })
})

describe("Story 11.6 fix R-4 — walidacja terminu retencji wobec horyzontu retry", () => {
  const savedDays = process.env.VOUCHER_PII_RETENTION_DAYS
  afterEach(() => {
    if (savedDays === undefined) delete process.env.VOUCHER_PII_RETENTION_DAYS
    else process.env.VOUCHER_PII_RETENTION_DAYS = savedDays
  })

  it("horyzont retry pochodzi z SWEEP_GAP_LOOKBACK_MS (jedno źródło), minimum > horyzont", () => {
    expect(RETRY_HORIZON_DAYS).toBe(SWEEP_GAP_LOOKBACK_MS / (24 * 60 * 60 * 1000))
    expect(RETENTION_DAYS_MIN).toBeGreaterThan(RETRY_HORIZON_DAYS)
  })

  it.each([
    ["abc", "not_integer"],
    ["NaN", "not_integer"],
    ["12.5", "not_integer"],
    ["-30", "not_integer"],
    ["0", "below_retry_horizon"],
    ["3", "below_retry_horizon"],
    ["7", "below_retry_horizon"],
  ])("VOUCHER_PII_RETENTION_DAYS=%s ⇒ nazwana odmowa (%s), wykonawca NIE jest wołany", async (raw, reason) => {
    expect(validateRetentionDays(raw)).toMatchObject({ ok: false, reason, error_code: "GP_RECIPIENT_RETENTION_TERM_INVALID" })
    process.env.GP_INSTANCE_ID = "instance-job"
    process.env.VOUCHER_PII_RETENTION_DAYS = raw
    const calls: string[] = []
    const errors: string[] = []
    const base = containerForRetentionSweep([], calls)
    const container = {
      resolve: (key: string) =>
        key === "logger"
          ? { info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) }
          : base.resolve(key),
    }
    const run = await voucherPiiRetentionSweep(container as never)
    expect(calls).toEqual([])
    expect(run.results).toEqual([])
    expect(run.alarms.term_invalid).toBe(1)
    expect(errors.join("\n")).toMatch(/GP_RECIPIENT_RETENTION_TERM_INVALID/)
  })

  it.each([[undefined], ["365"]])("VOUCHER_PII_RETENTION_DAYS=%s ⇒ przebieg z cutoff 365 d", async (raw) => {
    process.env.GP_INSTANCE_ID = "instance-job"
    if (raw === undefined) delete process.env.VOUCHER_PII_RETENTION_DAYS
    else process.env.VOUCHER_PII_RETENTION_DAYS = raw
    const calls: string[] = []
    const run = await voucherPiiRetentionSweep(containerForRetentionSweep([], calls) as never)
    expect(calls).toEqual(["market-a"])
    expect(run.term_refusal).toBeNull()
    const cutoffMs = Date.parse(run.results[0].cutoff)
    expect(Math.round((Date.now() - cutoffMs) / (24 * 60 * 60 * 1000))).toBe(365)
  })
})

describe("Story 11.6 fix R-1 — źródło rynków z projekcji gp-config instancji", () => {
  let base: string
  const logger = { error: jest.fn() }
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "s116-markets-"))
    logger.error.mockClear()
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  function project(markets: string[], extra: string[] = []): void {
    const dir = path.join(base, "inst1", "markets")
    mkdirSync(dir, { recursive: true })
    for (const m of markets) {
      mkdirSync(path.join(dir, m))
      writeFileSync(path.join(dir, m, "market.yaml"), "x: 1\n")
    }
    for (const m of extra) mkdirSync(path.join(dir, m))
  }

  it("bez env zawężenia: rynki = katalogi z market.yaml (katalog bez market.yaml pominięty)", async () => {
    project(["bonbeauty", "bonevent"], ["_ratification"])
    const r = await resolveRetentionMarkets({ env: { GP_CONFIG_ROOT: base, GP_INSTANCE_ID: "inst1" }, logger })
    expect(r).toMatchObject({ markets: ["bonbeauty", "bonevent"], source: "gp_config_projection", no_markets: null })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("env = jawne zawężenie (przecięcie); rynek spoza konfiguracji zgłoszony i nieprzetwarzany", async () => {
    project(["bonbeauty", "bonevent"])
    const r = await resolveRetentionMarkets({
      env: { GP_CONFIG_ROOT: base, GP_INSTANCE_ID: "inst1", VOUCHER_PII_RETENTION_MARKETS: "bonevent,ghost" },
      logger,
    })
    expect(r.markets).toEqual(["bonevent"])
    expect(r.narrowing_rejected).toEqual(["ghost"])
    expect(String(logger.error.mock.calls[0][0])).toMatch(/GP_RECIPIENT_RETENTION_MARKET_NOT_CONFIGURED/)
  })

  it.each([
    ["projection_empty", () => project([]), "inst1"],
    ["projection_unreadable", () => undefined, "inst1"],
    ["instance_unresolved", () => undefined, ""],
  ])("puste źródło (%s) ⇒ nazwany alarm GP_RECIPIENT_RETENTION_NO_MARKETS na poziomie error", async (reason, setup, inst) => {
    setup()
    const r = await resolveRetentionMarkets({ env: { GP_CONFIG_ROOT: base, GP_INSTANCE_ID: inst }, logger })
    expect(r.markets).toEqual([])
    expect(r.no_markets).toEqual({ error_code: "GP_RECIPIENT_RETENTION_NO_MARKETS", reason })
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/GP_RECIPIENT_RETENTION_NO_MARKETS/)
  })
})
