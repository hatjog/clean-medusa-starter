/**
 * Story 8.4 fix (checkpoint PO, MEDIUM) — ponowienie eventu
 * `gp.stripe.payment_intent_succeeded.v1` przez event bus.
 *
 * Przed poprawką kontrakt `gift-line-issue-outcome.v1` opierał odzysk linii
 * nieudanej na „retry/DLQ Medusy", a emisja w route nie ustawiała `attempts`.
 * `@medusajs/event-bus-redis` buduje zadanie z domyślnym `attempts: 1`, więc
 * rzut `LiveIssuePartialFailureError` kończył się ostrzeżeniem „Retrying is not
 * configured" — mechanizm, na którym stał kontrakt, w produkcji nie odpalał.
 *
 * Najbliższy mierzalny odpowiednik realnego ponowienia: PRAWDZIWY
 * `RedisEventBusService` (jego `buildEvents` i `worker_`), z `bullmq`
 * zastąpionym kolejką w pamięci. Pętla `drive` odtwarza kontrakt BullMQ:
 * zadanie, którego procesor rzucił, jest uruchamiane ponownie z
 * `attemptsMade + 1` (0 przy pierwszym przebiegu), dopóki liczba prób nie
 * osiągnie `opts.attempts`. Sam Redis/BullMQ
 * nie jest tu mierzony (NEEDS-LIVE-RUN w evidence 8.4).
 */
const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = []

jest.mock("bullmq", () => ({
  __esModule: true,
  Queue: class {
    async addBulk(jobs: typeof added) {
      added.push(...jobs)
    }
    async close() {}
  },
  Worker: class {
    async run() {}
    async close() {}
  },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RedisEventBusService = require("@medusajs/event-bus-redis/dist/services/event-bus-redis")
  .default as new (...args: unknown[]) => {
  subscribe: (name: string, fn: (e: unknown) => Promise<unknown>, ctx?: unknown) => unknown
  emit: (data: unknown, options?: Record<string, unknown>) => Promise<void>
  worker_: (job: unknown) => Promise<unknown>
}

import { PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS } from "../route"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../../../../subscribers/voucher-live-issue"

function makeBus() {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  const bus = new RedisEventBusService(
    { logger, eventBusRedisConnection: { disconnect() {}, expire: async () => 1 } },
    {},
    { scope: "internal", resources: "shared", worker_mode: "shared" }
  )
  return { bus, logger }
}

/** Odtwarza ponawianie BullMQ: kolejne próby, dopóki procesor rzuca i są próby. */
async function drive(
  bus: { worker_: (job: unknown) => Promise<unknown> },
  job: { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }
): Promise<number> {
  const attempts = Number(job.opts.attempts ?? 1)
  const live = {
    ...job,
    attemptsMade: 0,
    async updateData(d: Record<string, unknown>) {
      live.data = d
    },
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // BullMQ v5: `attemptsMade` w trakcie przebiegu = liczba prób ZAKOŃCZONYCH
    // (0 przy pierwszej); rośnie po porażce, a zadanie pada ostatecznie, gdy
    // osiągnie `opts.attempts`.
    live.attemptsMade = attempt - 1
    try {
      await bus.worker_(live)
      return attempt
    } catch {
      if (attempt === attempts) return attempt
    }
  }
  return attempts
}

describe("Story 8.4 fix — emisja payment_intent_succeeded z ponowieniem busa", () => {
  beforeEach(() => {
    added.length = 0
  })

  it("stała opcji emisji: attempts > 1 i backoff wykładniczy", () => {
    expect(PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS.attempts).toBeGreaterThan(1)
    expect(PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 30_000,
    })
  })

  it("z opcjami route'u subskrybent, który padł, jest ponawiany przez bus (drugi przebieg domyka)", async () => {
    const { bus } = makeBus()
    let calls = 0
    const okCalls: number[] = []
    bus.subscribe(
      PAYMENT_INTENT_SUCCEEDED_EVENT,
      async () => {
        calls += 1
        if (calls === 1) throw new Error("LiveIssuePartialFailureError: li_2:issue_write_failed")
      },
      { subscriberId: "voucher-live-issue" }
    )
    bus.subscribe(PAYMENT_INTENT_SUCCEEDED_EVENT, async () => void okCalls.push(1), {
      subscriberId: "inny-subskrybent",
    })

    await bus.emit({
      name: PAYMENT_INTENT_SUCCEEDED_EVENT,
      data: { payload: { payment_intent_id: "pi_1" } },
      options: { ...PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS },
    })
    expect(added).toHaveLength(1)
    expect(added[0].opts).toMatchObject({ attempts: 5, backoff: { type: "exponential", delay: 30_000 } })

    const used = await drive(bus, added[0] as never)
    expect(used).toBe(2)
    expect(calls).toBe(2)
    // Ponowienie dotyczy wyłącznie subskrybenta, który padł.
    expect(okCalls).toHaveLength(1)
  })

  it("kontrola odwrotna: bez opcji (domyślne attempts:1) bus NIE ponawia i ostrzega", async () => {
    const { bus, logger } = makeBus()
    let calls = 0
    bus.subscribe(
      PAYMENT_INTENT_SUCCEEDED_EVENT,
      async () => {
        calls += 1
        throw new Error("LiveIssuePartialFailureError")
      },
      { subscriberId: "voucher-live-issue" }
    )
    await bus.emit({ name: PAYMENT_INTENT_SUCCEEDED_EVENT, data: {} })
    expect(added[0].opts.attempts).toBe(1)
    await drive(bus, added[0] as never)
    expect(calls).toBe(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Retrying is not configured"))
  })

  it("po wyczerpaniu prób subskrybent wołany dokładnie `attempts` razy (dalej: populacja odzysku z kontraktu)", async () => {
    const { bus } = makeBus()
    let calls = 0
    bus.subscribe(
      PAYMENT_INTENT_SUCCEEDED_EVENT,
      async () => {
        calls += 1
        throw new Error("LiveIssuePartialFailureError")
      },
      { subscriberId: "voucher-live-issue" }
    )
    await bus.emit({
      name: PAYMENT_INTENT_SUCCEEDED_EVENT,
      data: {},
      options: { ...PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS },
    })
    await drive(bus, added[0] as never)
    expect(calls).toBe(PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS.attempts)
  })
})
