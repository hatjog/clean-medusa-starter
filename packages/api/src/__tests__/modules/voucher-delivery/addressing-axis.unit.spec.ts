/**
 * v1.16.0 Story 6.4 AC1 — oś (a) adresowania: adresat != płatnik, po WARTOŚCI.
 */
import { describe, expect, it } from "@jest/globals"

import {
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

describe("Story 6.4 AC2 (logika) — kontrola dodatnia poprzedza (0 rows)", () => {
  function fakeDb(rowsByEntitlement: Record<string, number>): QueryRunner & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async query(_text, values) {
        const ent = String(values[0])
        calls.push(ent)
        return {
          rows: Array.from({ length: rowsByEntitlement[ent] ?? 0 }, (_, i) => ({
            dispatch_id: `d_${i}`,
            recipient_hash: String(values[2]),
          })),
        }
      },
    }
  }

  it("kontrola znaleziona, zapytanie właściwe puste ⇒ PASS, kolejność: kontrola, potem dowód", async () => {
    const db = fakeDb({ ent_ctrl: 1 })
    const r = await runAddressingAxisProof(db, { entitlement_id: "ent", control_entitlement_id: "ent_ctrl", payer_email: PAYER })
    expect(db.calls).toEqual(["ent_ctrl", "ent"])
    expect(r.verdict).toBe("PASS")
    expect(r.positive_control.row_count).toBe(1)
    expect(r.proof).toEqual({ entitlement_id: "ent", row_count: 0, executed_seq: 2 })
  })

  it("kontrola dodatnia pusta ⇒ CONTROL_FAILED, pusty wynik nie jest uznany", async () => {
    const db = fakeDb({})
    const r = await runAddressingAxisProof(db, { entitlement_id: "ent", control_entitlement_id: "ent_ctrl", payer_email: PAYER })
    expect(r.verdict).toBe("CONTROL_FAILED")
    expect(r.proof.executed_seq).toBeNull()
    expect(db.calls).toEqual(["ent_ctrl"])
  })

  it("wiersz handoffu zaadresowany do płatnika ⇒ FAIL", async () => {
    const db = fakeDb({ ent_ctrl: 1, ent: 1 })
    const r = await runAddressingAxisProof(db, { entitlement_id: "ent", control_entitlement_id: "ent_ctrl", payer_email: PAYER })
    expect(r.verdict).toBe("FAIL")
  })
})
