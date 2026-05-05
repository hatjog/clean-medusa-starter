import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  appendOperatorT30Kickoff,
  getLastOperatorT30Kickoff,
} from "../../../src/lib/operator-kickoff-store"

type AnyFn = (...args: unknown[]) => unknown

function makeKnexMock(insertReturning: unknown[] = [], firstResult: unknown = null) {
  const firstMock = jest.fn().mockResolvedValue(firstResult)
  const orderByMock = jest.fn(() => ({ first: firstMock }))
  const selectMock = jest.fn(() => ({ orderBy: orderByMock }))
  const returningMock = jest.fn().mockResolvedValue(insertReturning)
  const insertMock = jest.fn(() => ({ returning: returningMock }))

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
    firstMock,
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

describe("operator-kickoff-store", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("appendOperatorT30Kickoff persists and returns the full row", async () => {
    const persistedRow = {
      id: "kickoff-1",
      started_at: "2026-05-05T10:00:00Z",
      t0_target: "2026-06-04T10:00:00Z",
      triggered_by: "admin_1",
      vendor_count: 3,
      admin_note: "go",
      override: false,
      created_at: "2026-05-05T10:00:01Z",
    }
    const { knex, returningMock } = makeKnexMock([persistedRow])

    const result = await appendOperatorT30Kickoff(makeScope(knex), {
      started_at: persistedRow.started_at,
      t0_target: persistedRow.t0_target,
      triggered_by: persistedRow.triggered_by,
      vendor_count: persistedRow.vendor_count,
      admin_note: persistedRow.admin_note,
      override: persistedRow.override,
    })

    expect(result).toEqual(persistedRow)
    expect(returningMock).toHaveBeenCalledWith("*")
  })

  it("getLastOperatorT30Kickoff returns the latest durable kickoff row", async () => {
    const row = {
      id: "kickoff-last",
      started_at: "2026-05-05T12:00:00Z",
      t0_target: "2026-06-04T12:00:00Z",
      triggered_by: "admin_2",
      vendor_count: 5,
      admin_note: null,
      override: true,
      created_at: "2026-05-05T12:00:01Z",
    }
    const { knex, orderByMock, firstMock } = makeKnexMock([], row)

    const result = await getLastOperatorT30Kickoff(makeScope(knex))

    expect(result).toEqual(row)
    expect(orderByMock).toHaveBeenCalledWith("started_at", "desc")
    expect(firstMock).toHaveBeenCalledTimes(1)
  })
})