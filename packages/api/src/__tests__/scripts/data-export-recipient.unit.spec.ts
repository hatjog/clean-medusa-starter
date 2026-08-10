/**
 * Odzyskane narzędzie DSAR (RODO Art. 15) — kontrole, które pękają po cofnięciu naprawy.
 *
 * Wersja z porzuconej gałęzi v1.6.0 była niesprawna wobec dzisiejszego schematu w trzech
 * miejscach; każde z nich ma tu asercję, bo „naprawione" bez pomiaru jest tym samym, czym
 * był ten skrypt przez trzy miesiące — deklaracją bez nośnika.
 */

import {
  DSAR_RUNBOOK_PATH,
  findAuditRows,
  findRecipientPiiRows,
  logDsarAccess,
  parseArgs,
  redactOtherSubjects,
} from "../../scripts/data-export-recipient"

const appendAuditRow = jest.fn().mockResolvedValue({ audit_id: "aud_1" })
jest.mock("../../modules/voucher-pii/adapters/pg-audit", () => ({
  PgAuditAdapter: jest.fn().mockImplementation(() => ({ appendAuditRow })),
}))

/** Minimalny dubler Knexa: zapamiętuje wywołaną tabelę i klauzule. */
function makeDb() {
  const calls: Array<Record<string, unknown>> = []
  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: jest.fn(self),
    distinct: jest.fn(self),
    where: jest.fn((arg: unknown) => {
      calls.push({ where: arg })
      return chain
    }),
    whereIn: jest.fn((col: string, val: unknown) => {
      calls.push({ whereIn: col, val })
      return chain
    }),
    whereRaw: jest.fn((sql: string, bindings: unknown) => {
      calls.push({ whereRaw: sql, bindings })
      return chain
    }),
    whereNotNull: jest.fn(self),
    orderBy: jest.fn(() => Promise.resolve([])),
  })
  const db = jest.fn((table: string) => {
    calls.push({ table })
    return chain
  })
  return { db: db as never, calls, chain }
}

beforeEach(() => {
  appendAuditRow.mockClear()
})

describe("parseArgs", () => {
  it("czyta pary --klucz=wartosc i ignoruje smieci", () => {
    expect(parseArgs(["--subject=recipient", "--voucher=ABC-123", "--pusty"])).toEqual({
      subject: "recipient",
      voucher: "ABC-123",
    })
    expect(parseArgs(undefined)).toEqual({})
  })
})

describe("findRecipientPiiRows — schemat, nie wspomnienie o schemacie", () => {
  it("szuka kodu vouchera w voucher_event, bo entitlement_instance go nie niesie", async () => {
    const { db, calls } = makeDb()
    await findRecipientPiiRows(db, { voucher: "ABC-123" })
    const tables = calls.filter((c) => c.table).map((c) => c.table)
    expect(tables).toContain("voucher_recipient_pii")
    // Kontrola dodatnia: przed naprawa szlo tu `gp_core.entitlements`, relacja nieistniejaca.
    expect(tables).toContain("voucher_event")
    expect(tables).not.toContain("gp_core.entitlements")
  })

  it("wybiera tombstoned_at, nie deleted_at", async () => {
    const { db, chain } = makeDb()
    await findRecipientPiiRows(db, { email: "a@b.pl", market: "bonbeauty" })
    const columns = (chain.select as jest.Mock).mock.calls[0][0] as string[]
    expect(columns).toContain("tombstoned_at")
    expect(columns).not.toContain("deleted_at")
  })

  it("odmawia bez wystarczajacych argumentow — cichy pusty eksport bylby gorszy", async () => {
    const { db } = makeDb()
    await expect(findRecipientPiiRows(db, {})).rejects.toThrow(/--voucher.*--email/s)
    await expect(findRecipientPiiRows(db, { email: "a@b.pl" })).rejects.toThrow()
  })
})

describe("logDsarAccess — łańcuch liczony, nie zgadywany", () => {
  const rows = [
    { id: "pii_1", market_id: "bonbeauty", order_id: "order_1" },
    { id: "pii_2", market_id: "bonbeauty", order_id: "order_1" },
    { id: "pii_3", market_id: "bonevent", order_id: "order_2" },
  ] as never

  it("dopisuje wpis przez PgAuditAdapter — jeden na rynek", async () => {
    const { db } = makeDb()
    const ids = await logDsarAccess(db, rows, { operator: "robert", voucher: "ABC" })

    expect(appendAuditRow).toHaveBeenCalledTimes(2)
    expect(ids).toHaveLength(2)
    const markets = appendAuditRow.mock.calls.map((c) => c[0].market_id)
    expect(new Set(markets)).toEqual(new Set(["bonbeauty", "bonevent"]))
  })

  it("ładunek niesie DSAR_ACCESS, operatora i objęte identyfikatory", async () => {
    const { db } = makeDb()
    await logDsarAccess(db, rows, { operator: "robert", dsar_request_id: "dsar-7" })

    const payload = appendAuditRow.mock.calls[0][0].payload
    expect(payload.action).toBe("DSAR_ACCESS")
    expect(payload.operator).toBe("robert")
    expect(payload.dsar_request_id).toBe("dsar-7")
    expect(payload.recipient_pii_ids).toEqual(["pii_1", "pii_2"])
    // `order_id` jest kluczem powiazania sladu audytowego — bez niego krok 3 nic nie znajdzie.
    expect(payload.order_id).toBe("order_1")
  })

  it("NIE wstawia wiersza samodzielnie — surowy INSERT zlamalby łańcuch", async () => {
    const { db, calls } = makeDb()
    await logDsarAccess(db, rows, {})
    expect(calls.some((c) => c.table === "voucher_pii_consent_audit")).toBe(false)
  })
})

describe("findAuditRows", () => {
  it("wiaze slad po payload->>'order_id', bo kolumny recipient_pii_id juz nie ma", async () => {
    const { db, calls } = makeDb()
    await findAuditRows(db, ["order_1"], ["bonbeauty"])
    const raw = calls.find((c) => c.whereRaw)
    expect(String(raw?.whereRaw)).toContain("payload->>'order_id'")
  })

  it("pusta lista zamowien nie odpytuje bazy", async () => {
    const { db, calls } = makeDb()
    expect(await findAuditRows(db, [], ["bonbeauty"])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe("redactOtherSubjects", () => {
  it("zeruje dane kupujacego — to inny podmiot danych", () => {
    expect(
      redactOtherSubjects({ buyer_email: "k@b.pl", purchaser_email: "k@b.pl", recipient_locale: "pl" })
    ).toEqual({ buyer_email: null, purchaser_email: null, recipient_locale: "pl" })
  })

  it("nie wywraca sie na ksztaltach spoza obiektu", () => {
    expect(redactOtherSubjects(null)).toBeNull()
    expect(redactOtherSubjects([1, 2])).toEqual([1, 2])
  })
})

describe("kontrakt bramki", () => {
  it("wskazuje runbook, ktorego wymaga consent-privacy-dsar-integrity", () => {
    expect(DSAR_RUNBOOK_PATH).toBe("specs/legal/recipient-dsar-runbook.md")
  })
})
