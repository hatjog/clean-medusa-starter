import { afterEach, describe, expect, it } from "@jest/globals"

import { marketContextStorage } from "../../lib/market-context"
import voucherPiiRetentionSweep from "../voucher-pii-retention-sweep"

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
    const results = await voucherPiiRetentionSweep(containerForRetentionSweep(observedScopes, calls) as never)
    expect(results).toEqual([expect.objectContaining({ market_id: "market-a", carriers: {} })])
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
    const results = await voucherPiiRetentionSweep(container as never)
    expect(results).toEqual([])
    expect(errors.join("\n")).toMatch(/GP_RECIPIENT_RETENTION_NO_PG_CONNECTION/)
  })
})
