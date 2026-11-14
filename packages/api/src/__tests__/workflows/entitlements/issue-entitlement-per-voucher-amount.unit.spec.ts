/**
 * v1.16.0 Story 3.5 AC2 (FR-13, ADR-166 pkt 6/8).
 *
 * Koperta PaymentIntenta niesie PEŁNĄ kwotę PI (`payload.amount_minor`).
 * Do tej story `issueEntitlementsForAllLineItems` podstawiał ją pod kwotę
 * każdej linii bez `amount_minor` w profilu — N linii dawało N voucherów na
 * całe PI. Kwota vouchera = kwota JEGO linii (`order_line_item.unit_price`,
 * NUMERIC jako string z node-pg); brak kwoty linii ⇒ odmowa przed zapisem.
 */
import {
  issueEntitlementsForAllLineItems,
  MissingVoucherLineAmountError,
  type PgClient,
} from "../../../workflows/entitlements/issue-entitlement"

type Line = {
  line_item_id: string
  unit_price: string | null
  amount_minor?: number
}

const PI_AMOUNT_MINOR = 99900 // cała kwota PI (obejmuje też inne zamówienia, ADR-166 pkt 8)

function makeClient(lines: Line[]) {
  const inserts: { snapshot: Record<string, unknown>; line_item_id: string }[] = []
  const vouchers: { code: string; value_minor: unknown }[] = []
  const client: PgClient = {
    query: (async (text: string, values?: ReadonlyArray<unknown>) => {
      if (text.includes("oli.unit_price AS line_unit_price")) {
        return {
          rows: lines.map((l) => ({
            line_item_id: l.line_item_id,
            line_unit_price: l.unit_price,
            metadata: {
              entitlement_profile_id: "prof_voucher",
              entitlement_type: "VOUCHER_AMOUNT",
              entitlement_policy: { validity_months: 12 },
              ...(l.amount_minor !== undefined ? { amount_minor: l.amount_minor } : {}),
            },
            line_title: `Usługa ${l.line_item_id}`,
            seller_id: "sel_1",
            seller_name: "Salon",
            seller_handle: "salon",
          })),
        }
      }
      if (text.includes("SELECT id, claim_token FROM entitlement_instance")) {
        return { rows: [] }
      }
      if (text.includes("INSERT INTO entitlement_instance")) {
        inserts.push({
          line_item_id: values?.[4] as string,
          snapshot: JSON.parse(values?.[6] as string),
        })
        return { rows: [], rowCount: 1 }
      }
      if (text.includes("INSERT INTO voucher")) {
        vouchers.push({ code: values?.[0] as string, value_minor: values?.[6] })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`nieoczekiwane zapytanie: ${text.slice(0, 80)}`)
    }) as PgClient["query"],
  }
  return { client, inserts, vouchers }
}

const payload = {
  event_id: "evt_pi_1",
  order_id: "order_1",
  payment_intent_id: "pi_1",
  market_id: "bonbeauty",
  amount_minor: PI_AMOUNT_MINOR,
  currency: "PLN",
  entitlement_profile: null,
}

describe("issueEntitlementsForAllLineItems — kwota per voucher (Story 3.5 AC2)", () => {
  it("koperta z N=3 liniami: amount_minor każdego vouchera == kwota jego linii, != kwota PI", async () => {
    const lines: Line[] = [
      { line_item_id: "oli_a", unit_price: "10000.00" },
      { line_item_id: "oli_b", unit_price: "15000" },
      { line_item_id: "oli_c", unit_price: null, amount_minor: 20000 },
    ]
    const { client, inserts, vouchers } = makeClient(lines)

    const result = await issueEntitlementsForAllLineItems(client, payload, new Date("2026-11-14T10:00:00Z"))

    expect(result.results).toHaveLength(3)
    const byLine = Object.fromEntries(
      inserts.map((i) => [i.line_item_id, i.snapshot.amount_minor])
    )
    expect(byLine).toEqual({ oli_a: 10000, oli_b: 15000, oli_c: 20000 })
    for (const i of inserts) {
      expect(i.snapshot.amount_minor).not.toBe(PI_AMOUNT_MINOR)
      expect(typeof i.snapshot.amount_minor).toBe("number")
    }
    expect(vouchers.map((v) => v.value_minor)).toEqual([10000, 15000, 20000])
    expect(vouchers.every((v) => v.value_minor !== PI_AMOUNT_MINOR)).toBe(true)
  })

  it("linia bez kwoty (brak profilu i ceny) ⇒ fail-closed, bez wystawienia na kwotę PI", async () => {
    const { client, inserts, vouchers } = makeClient([
      { line_item_id: "oli_a", unit_price: "10000.00" },
      { line_item_id: "oli_x", unit_price: null },
    ])

    await expect(
      issueEntitlementsForAllLineItems(client, payload, new Date())
    ).rejects.toBeInstanceOf(MissingVoucherLineAmountError)
    expect(inserts.some((i) => i.line_item_id === "oli_x")).toBe(false)
    expect(
      [...inserts.map((i) => i.snapshot.amount_minor), ...vouchers.map((v) => v.value_minor)]
    ).not.toContain(PI_AMOUNT_MINOR)
  })

  it("cena linii z ułamkiem grosza ⇒ odmowa, nie zaokrąglenie przez float", async () => {
    const { client } = makeClient([{ line_item_id: "oli_a", unit_price: "100.50" }])
    await expect(
      issueEntitlementsForAllLineItems(client, payload, new Date())
    ).rejects.toBeInstanceOf(MissingVoucherLineAmountError)
  })

  it("direct-payload bez amount_minor profilu ⇒ odmowa (bez fallbacku na kwotę PI)", async () => {
    const { client, inserts } = makeClient([])
    await expect(
      issueEntitlementsForAllLineItems(
        client,
        {
          ...payload,
          entitlement_profile: {
            profile_id: "prof_credit",
            entitlement_type: "CREDIT_PACK",
            policy: {},
            line_item_id: "oli_a",
          },
        },
        new Date()
      )
    ).rejects.toBeInstanceOf(MissingVoucherLineAmountError)
    expect(inserts).toHaveLength(0)
  })
})
