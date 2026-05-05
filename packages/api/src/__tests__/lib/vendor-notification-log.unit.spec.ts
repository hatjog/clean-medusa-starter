/**
 * Story v160-cleanup-7-vendor-lifecycle-prod-wiring follow-up — durable
 * audit log persistence (closes AC4 from Stories 7.1/7.2/7.3).
 *
 * Unit coverage with mocked Knex query builder. Integration tests against
 * a real Postgres instance live in the gp-dev integration suite (gated by
 * DATABASE_URL).
 */

import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  appendNotificationLog,
  appendNotificationLogBestEffort,
  listNotificationLog,
} from "../../../src/lib/vendor-notification-log"

type AnyFn = (...args: unknown[]) => unknown

function makeKnexMock(insertReturning: unknown[] | Error, listResult: unknown[] = []) {
  const orderByMock = jest.fn().mockReturnThis()
  const whereMock = jest.fn().mockReturnThis()
  const limitMock = jest.fn().mockReturnThis()
  const offsetMock = jest.fn().mockReturnThis()
  const selectMock = jest.fn(() => ({
    orderBy: orderByMock,
    where: whereMock,
    limit: limitMock,
    offset: offsetMock,
    then: (resolve: AnyFn) => resolve(listResult),
    catch: () => undefined,
  }))

  const returningMock = jest.fn(() => {
    if (insertReturning instanceof Error) {
      return Promise.reject(insertReturning)
    }
    return Promise.resolve(insertReturning)
  })
  const insertMock = jest.fn(() => ({
    returning: returningMock,
  }))

  const tableFn: AnyFn = jest.fn(() => ({
    insert: insertMock,
    select: selectMock,
  }))

  return {
    knex: tableFn,
    insertMock,
    returningMock,
    selectMock,
    orderByMock,
    whereMock,
  }
}

function makeScope(knex: AnyFn) {
  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return knex
      return undefined
    },
  }
}

describe("vendor-notification-log (cleanup-7-followup AC4)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("appendNotificationLog persists row + returns full entry", async () => {
    const persistedRow = {
      id: "uuid-server-assigned",
      vendor_id: "v_1",
      vendor_handle: "kremidotyk",
      notification_type: "decision_capture",
      sent_at: "2026-05-05T12:00:00Z",
      locale: "pl",
      recipient_email: "vendor@example.com",
      status: "sent",
      error_message: null,
      triggered_by: "admin_1",
    }
    const { knex, insertMock, returningMock } = makeKnexMock([persistedRow])

    const result = await appendNotificationLog(makeScope(knex), {
      vendor_id: "v_1",
      vendor_handle: "kremidotyk",
      notification_type: "decision_capture",
      locale: "pl",
      recipient_email: "vendor@example.com",
      status: "sent",
      triggered_by: "admin_1",
    })

    expect(result.id).toBe("uuid-server-assigned")
    expect(result.notification_type).toBe("decision_capture")
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(returningMock).toHaveBeenCalledWith("*")
  })

  it("appendNotificationLog throws when DB write fails (no silent swallow)", async () => {
    const dbErr = new Error("relation does not exist")
    const { knex } = makeKnexMock(dbErr)

    await expect(
      appendNotificationLog(makeScope(knex), {
        vendor_id: "v_1",
        notification_type: "t30_migration",
        locale: "pl",
        recipient_email: "vendor@example.com",
        status: "sent",
        triggered_by: "admin_1",
      }),
    ).rejects.toThrow(/relation does not exist/)
  })

  it("appendNotificationLogBestEffort returns persisted=true on success", async () => {
    const persistedRow = {
      id: "uuid-1",
      vendor_id: "v_1",
      vendor_handle: null,
      notification_type: "nudge_t14",
      sent_at: "2026-05-05T12:00:00Z",
      locale: "en",
      recipient_email: "v@example.com",
      status: "sent",
      error_message: null,
      triggered_by: "admin_1",
    }
    const { knex } = makeKnexMock([persistedRow])

    const result = await appendNotificationLogBestEffort(makeScope(knex), {
      vendor_id: "v_1",
      notification_type: "nudge_t14",
      locale: "en",
      recipient_email: "v@example.com",
      status: "sent",
      triggered_by: "admin_1",
    })

    expect(result.persisted).toBe(true)
    expect(result.entry.id).toBe("uuid-1")
    expect(result.error).toBeUndefined()
  })

  it("appendNotificationLogBestEffort returns persisted=false + synthetic entry on DB failure", async () => {
    const dbErr = new Error("connection refused")
    const { knex } = makeKnexMock(dbErr)

    const result = await appendNotificationLogBestEffort(makeScope(knex), {
      id: "caller-supplied-id",
      vendor_id: "v_1",
      notification_type: "t30_migration",
      locale: "pl",
      recipient_email: "v@example.com",
      status: "sent",
      triggered_by: "admin_1",
    })

    expect(result.persisted).toBe(false)
    expect(result.entry.id).toBe("caller-supplied-id")
    expect(result.error).toBe("connection refused")
  })

  it("listNotificationLog applies vendor_id + status filters + orders desc", async () => {
    const rows = [
      {
        id: "1",
        vendor_id: "v_1",
        vendor_handle: null,
        notification_type: "decision_capture",
        sent_at: "2026-05-05T12:00:00Z",
        locale: "pl",
        recipient_email: "v@example.com",
        status: "sent",
        error_message: null,
        triggered_by: "admin_1",
      },
    ]
    const { knex, selectMock, orderByMock, whereMock } = makeKnexMock([], rows)

    const result = await listNotificationLog(makeScope(knex), {
      vendor_id: "v_1",
      status: "sent",
      limit: 10,
    })

    expect(result).toEqual(rows)
    expect(selectMock).toHaveBeenCalledWith("*")
    expect(orderByMock).toHaveBeenCalledWith("sent_at", "desc")
    expect(whereMock).toHaveBeenCalledWith({ vendor_id: "v_1" })
    expect(whereMock).toHaveBeenCalledWith({ status: "sent" })
  })
})
