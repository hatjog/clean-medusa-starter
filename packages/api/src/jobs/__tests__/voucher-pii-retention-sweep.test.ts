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
      if (key === "voucher_pii") {
        return {
          purgeExpiredPii: async ({ market_id }: { market_id: string }) => {
            calls.push(market_id)
            observedScopes.push(marketContextStorage.getStore())
            return { rows_deleted: 0, orphans_deleted: 0 }
          },
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
