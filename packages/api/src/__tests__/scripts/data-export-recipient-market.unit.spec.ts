/**
 * v1.16.0 Story 11.6 fix R-5 (DW-15-362 p.1) — eksport DSAR obdarowanej czyta
 * WYŁĄCZNIE w jawnie zadeklarowanym rynku (`market=`).
 *
 * Mutanty, które te testy czerwienią:
 *   - usunięcie guarda `if (!market)` ⇒ eksport startuje transakcję bez rynku;
 *   - usunięcie filtra `r.market_id === market` ⇒ wiersz obcego rynku trafia
 *     do eksportu (albo do łańcucha audytu).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import dataExportRecipient from "../../scripts/data-export-recipient"
import { RecipientPiiMarketAccessDeniedError } from "../../modules/voucher-pii/recipient-pii-market-guard"

const FOREIGN_EMAIL = "foreign-recipient@example.invalid"

function chain(rows: unknown[]): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "whereIn", "where", "whereNotNull", "distinct", "orderBy", "whereRaw"]) {
    b[m] = () => b
  }
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej)
  return b
}

function makeContainer(opts: { sessionMarket: string; piiRows: unknown[] }) {
  const tables: string[] = []
  const trx = Object.assign(
    (table: string) => {
      tables.push(table)
      return chain(table === "voucher_recipient_pii" ? opts.piiRows : [])
    },
    { raw: jest.fn(async () => ({ rows: [{ market_id: opts.sessionMarket }] })) }
  )
  const pg = { transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(trx)) }
  return {
    tables,
    pg,
    container: {
      resolve: (k: string) => {
        if (k === ContainerRegistrationKeys.PG_CONNECTION) return pg
        throw new Error(`unresolved ${k}`)
      },
    },
  }
}

describe("data-export-recipient — rynek wymagany (11.6 fix R-5, DW-15-362 p.1)", () => {
  let stdout: string[]
  let warn: ReturnType<typeof jest.spyOn>
  let write: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    stdout = []
    write = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    })
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    write.mockRestore()
    warn.mockRestore()
  })

  it.each([
    [["subject=recipient", "voucher=VCH-1"]],
    [["subject=recipient", `email=${FOREIGN_EMAIL}`]],
  ])("bez market= (%j) ⇒ RecipientPiiMarketAccessDeniedError('missing_market_context'), zero dostępu do danych", async (args) => {
    const { container, pg } = makeContainer({ sessionMarket: "mkt_a", piiRows: [] })
    const err = await dataExportRecipient({ container, args } as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecipientPiiMarketAccessDeniedError)
    expect((err as RecipientPiiMarketAccessDeniedError).reason).toBe("missing_market_context")
    expect(pg.transaction).not.toHaveBeenCalled()
    expect(stdout).toEqual([])
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toMatch(/GP_RECIPIENT_PII_MARKET_ACCESS_DENIED/)
    expect(logged).not.toContain(FOREIGN_EMAIL)
  })

  it("ścieżka voucher= z market=mkt_a: wiersz rynku mkt_b jest odfiltrowany (found=false, bez PII obcego rynku)", async () => {
    const { container, pg } = makeContainer({
      sessionMarket: "mkt_a",
      piiRows: [
        {
          id: "pii_b",
          market_id: "mkt_b",
          entitlement_id: "ent_b",
          order_id: "ord_b",
          recipient_email: FOREIGN_EMAIL,
          recipient_phone: null,
          locale: "pl",
          is_gift: true,
          created_at: new Date(0),
          tombstoned_at: null,
        },
      ],
    })
    await dataExportRecipient({ container, args: ["subject=recipient", "voucher=VCH-1", "market=mkt_a"] } as never)
    expect(pg.transaction).toHaveBeenCalledTimes(1)
    const out = JSON.parse(stdout.join(""))
    expect(out.found).toBe(false)
    expect(out.query).toMatchObject({ voucher: "VCH-1", market: "mkt_a" })
    expect(stdout.join("")).not.toContain(FOREIGN_EMAIL)
  })
})
