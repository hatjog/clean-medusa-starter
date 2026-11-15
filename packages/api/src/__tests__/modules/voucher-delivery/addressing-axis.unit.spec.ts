/**
 * v1.16.0 Story 6.4 AC1 — oś (a) adresowania: adresat != płatnik, po WARTOŚCI.
 */
import { describe, expect, it } from "@jest/globals"

import {
  ADDRESSING_AXIS_TARGET_ROWS_SQL,
  ADDRESSING_AXIS_TEMPLATE_KEY,
  buildAddressingAxisProofQuery,
  checkAddressingAxis,
  runAddressingAxisProof,
  type QueryRunner,
} from "../../../modules/voucher-delivery/addressing-axis"
import { hashRecipientEmail } from "../../../modules/voucher-delivery/recipient-hash"

const PAYER = "platnik@example.test"
const RECIPIENT = "ola@example.test"

describe("Story 6.4 AC1 — oś (a): adresat powiadomienia różny od płatnika", () => {
  it("różne adresy ⇒ PASS (i jawnie NIE dowód dostarczenia)", () => {
    const v = checkAddressingAxis({
      notification_recipient_hash: hashRecipientEmail(RECIPIENT),
      payer_email: PAYER,
    })
    expect(v).toEqual({ verdict: "PASS", is_delivery_proof: false })
  })

  it("ten sam adres w innej wielkości liter/spacjach ⇒ FAIL", () => {
    const v = checkAddressingAxis({
      notification_recipient_hash: hashRecipientEmail("  PlatNIK@Example.TEST "),
      payer_email: PAYER,
    })
    expect(v.verdict).toBe("FAIL")
  })

  it("oba pola obecne, wartości równe ⇒ FAIL (mutant „obecność pola” oblewa)", () => {
    const v = checkAddressingAxis({
      notification_recipient_hash: hashRecipientEmail(PAYER),
      payer_email: PAYER,
    })
    expect(v).toEqual({
      verdict: "FAIL",
      reason_code: "ADDRESSING_AXIS_RECIPIENT_EQUALS_PAYER",
      is_delivery_proof: false,
    })
  })

  it.each([
    [{ notification_recipient_hash: hashRecipientEmail(RECIPIENT), payer_email: null }, "ADDRESSING_AXIS_PAYER_ADDRESS_MISSING"],
    [{ notification_recipient_hash: hashRecipientEmail(RECIPIENT), payer_email: "   " }, "ADDRESSING_AXIS_PAYER_ADDRESS_MISSING"],
    [{ notification_recipient_hash: null, payer_email: PAYER }, "ADDRESSING_AXIS_RECIPIENT_HASH_MISSING"],
    [{ notification_recipient_hash: RECIPIENT, payer_email: PAYER }, "ADDRESSING_AXIS_RECIPIENT_HASH_INVALID"],
  ])("brak/zły adres ⇒ odmowa diagnozowalna, nie PASS (%#)", (input, code) => {
    const v = checkAddressingAxis(input)
    expect(v.verdict).toBe("REFUSED")
    expect(v).toHaveProperty("reason_code", code)
  })

  it("zapytanie dowodowe filtruje po szablonie handoff i WARTOŚCI hasha płatnika", () => {
    const q = buildAddressingAxisProofQuery({ entitlement_id: "ent_1", payer_email: " PLATNIK@example.test" })
    expect(q.values).toEqual(["ent_1", ADDRESSING_AXIS_TEMPLATE_KEY, hashRecipientEmail(PAYER)])
    expect(q.text).toMatch(/recipient_hash = \$3/)
  })
})

describe("Story 6.4 AC2 (logika) — kontrola dodatnia, wiersz badanego, potem (0 rows)", () => {
  type Row = { dispatch_id: string; entitlement_id: string; recipient_hash: string }
  /** Atrapa ledgera: filtruje WIERSZE, a nie zwraca liczby — zapytanie badanego bez filtra hasha. */
  function fakeDb(table: Row[]): QueryRunner & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async query(text, values) {
        const ent = String(values[0])
        const isTarget = text === ADDRESSING_AXIS_TARGET_ROWS_SQL
        calls.push(`${isTarget ? "target" : "hash"}:${ent}`)
        return {
          rows: table.filter(
            (r) => r.entitlement_id === ent && (isTarget || r.recipient_hash === String(values[2])),
          ),
        }
      },
    }
  }
  const row = (ent: string, email: string): Row => ({
    dispatch_id: `d_${ent}`,
    entitlement_id: ent,
    recipient_hash: hashRecipientEmail(email),
  })
  const run = (db: QueryRunner, entitlement_id = "ent") =>
    runAddressingAxisProof(db, { entitlement_id, control_entitlement_id: "ent_ctrl", payer_email: PAYER })

  it("wiersz badanego z adresatem ≠ płatnik ⇒ PASS; kolejność: kontrola, badany, dowód", async () => {
    const db = fakeDb([row("ent_ctrl", PAYER), row("ent", RECIPIENT)])
    const r = await run(db)
    expect(db.calls).toEqual(["hash:ent_ctrl", "target:ent", "hash:ent"])
    expect(r.verdict).toBe("PASS")
    expect(r.target.row_count).toBe(1)
    expect(r.target.rows).toEqual([
      { dispatch_id: "d_ent", entitlement_id: "ent", recipient_hash: hashRecipientEmail(RECIPIENT), axis_verdict: "PASS" },
    ])
    expect(r.proof).toEqual({ entitlement_id: "ent", row_count: 0, executed_seq: 3 })
  })

  it("brak wiersza handoffu badanego entitlementu ⇒ TARGET_ROW_MISSING, nie PASS (pusty join)", async () => {
    const db = fakeDb([row("ent_ctrl", PAYER), row("ent", RECIPIENT)])
    const r = await run(db, "literowka")
    expect(r.verdict).toBe("TARGET_ROW_MISSING")
    expect(r.target.row_count).toBe(0)
    expect(r.proof.executed_seq).toBeNull()
    expect(db.calls).toEqual(["hash:ent_ctrl", "target:literowka"])
  })

  it("wiersz handoffu zaadresowany do płatnika ⇒ FAIL", async () => {
    const db = fakeDb([row("ent_ctrl", PAYER), row("ent", ` ${PAYER.toUpperCase()}`)])
    const r = await run(db)
    expect(r.verdict).toBe("FAIL")
    expect(r.target.rows[0]?.axis_verdict).toBe("FAIL")
    expect(r.proof.row_count).toBe(1)
  })

  it("kontrola dodatnia pusta ⇒ CONTROL_FAILED, nic dalej nie jest uznane", async () => {
    const db = fakeDb([row("ent", RECIPIENT)])
    const r = await run(db)
    expect(r.verdict).toBe("CONTROL_FAILED")
    expect(r.proof.executed_seq).toBeNull()
    expect(r.target.executed_seq).toBeNull()
    expect(db.calls).toEqual(["hash:ent_ctrl"])
  })
})
