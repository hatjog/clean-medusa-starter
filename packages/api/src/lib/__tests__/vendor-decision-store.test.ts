import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { describe, expect, it } from "@jest/globals"

import { listSellers } from "../vendor-decision-store"

function buildDb(rows: Array<Record<string, unknown>>) {
  const query = {
    select: () => query,
    whereNull: () => query,
    where: (column: string, value: unknown) => {
      filteredRows = filteredRows.filter((row) => row[column] === value)
      return query
    },
    then: (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
      Promise.resolve(resolve(filteredRows)),
  }

  let filteredRows = [...rows]

  return () => query
}

describe("vendor-decision-store", () => {
  it("falls back to PG_CONNECTION when seller service is absent from the request scope", async () => {
    const rows = [
      {
        id: "seller_1",
        handle: "city-beauty",
        email: "seller@example.com",
        name: "City Beauty",
        status: "open",
        metadata: { gp: { preferred_locale: "pl" } },
      },
    ]

    const scope = {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) {
          return buildDb(rows)
        }

        throw new Error(`missing:${key}`)
      },
    }

    await expect(listSellers(scope)).resolves.toEqual(rows)
    await expect(listSellers(scope, { id: "seller_1" })).resolves.toEqual(rows)
    await expect(listSellers(scope, { id: "missing" })).resolves.toEqual([])
  })
})