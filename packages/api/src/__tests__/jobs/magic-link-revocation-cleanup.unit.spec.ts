import magicLinkRevocationCleanup, {
  SCHEDULE_CRON,
  SCHEDULE_NAME,
  config,
} from "../../jobs/magic-link-revocation-cleanup"
import {
  PostgresMagicLinkStore,
  shouldDeleteMagicLinkRevocation,
} from "../../lib/auth/magic-link-revocation"

describe("magic-link-revocation-cleanup", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("retains rows exactly at 30d and deletes rows older than 30d", () => {
    const now = new Date("2026-05-18T08:00:00.000Z")
    const exactly30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const olderThan30d = new Date(exactly30d.getTime() - 1)

    expect(shouldDeleteMagicLinkRevocation(exactly30d, now)).toBe(false)
    expect(shouldDeleteMagicLinkRevocation(olderThan30d, now)).toBe(true)
  })

  it("runs the Postgres cleanup store from the scheduled job", async () => {
    const cleanupRevocationsSpy = jest
      .spyOn(PostgresMagicLinkStore.prototype, "cleanupExpiredRevocations")
      .mockResolvedValue(2)
    const cleanupIssuedSpy = jest
      .spyOn(PostgresMagicLinkStore.prototype, "cleanupExpiredIssued")
      .mockResolvedValue(4)
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const container = {
      resolve: jest.fn((key: string) => {
        if (key === "logger") return logger
        return {}
      }),
    }

    await magicLinkRevocationCleanup(container as never)

    expect(cleanupRevocationsSpy).toHaveBeenCalledTimes(1)
    expect(cleanupIssuedSpy).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      "deleted_revocations=2 deleted_issued=4"
    )
  })

  it("exports the cron registration", () => {
    expect(SCHEDULE_NAME).toBe("magic-link-revocation-cleanup")
    expect(SCHEDULE_CRON).toBe("15 3 * * *")
    expect(config).toEqual({
      name: "magic-link-revocation-cleanup",
      schedule: "15 3 * * *",
    })
  })
})
