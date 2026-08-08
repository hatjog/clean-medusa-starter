/**
 * v1.15.0 Story 5.9 review-fix — kompensacja wystawienia woła producenta stanu
 * kodu TYLKO wtedy, gdy tranzycja uprawnienia faktycznie zaszła.
 *
 * `compensateIssuedEntitlement` przestawia uprawnienie na VOIDED zapytaniem
 * STRZEŻONYM (`state NOT IN ('VOIDED','REFUNDED','CLOSED')`). Pierwsza wersja
 * 5.9 wołała producenta bezwarunkowo, więc dla wiersza już terminalnego
 * unieważniała stan kodu BEZ żadnej tranzycji — dla `CLOSED` przestawiając
 * ZREALIZOWANY kod (`claimed`) na `withdrawn`, a dla `REFUNDED` rzucając
 * i przewracając całą transakcję kompensacji.
 */

import { describe, it, expect } from "@jest/globals"

import { compensateIssuedEntitlement } from "../../../workflows/entitlements/issue-entitlement"

/** Minimalny fake: stan uprawnienia + stan kodu, oba obserwowalne. */
class CompensateFakeClient {
  readonly sqls: string[] = []

  constructor(
    public entitlementState: string,
    public voucherStatus: string
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    this.sqls.push(sql)

    if (sql.includes("UPDATE entitlement_instance")) {
      if (["VOIDED", "REFUNDED", "CLOSED"].includes(this.entitlementState)) {
        return { rows: [] as T[], rowCount: 0 }
      }
      this.entitlementState = params[1] as string
      // review-fix cyklu 2 (C2-HIGH-1): guard `RETURNING entitlement_type` —
      // wołanie producenta jest bramkowane przynależnością typu, a typ bierze
      // się z wiersza, który TA transakcja właśnie przestawiła.
      return {
        rows: [{ entitlement_type: "VOUCHER_AMOUNT" }] as unknown as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("policy_snapshot->>'voucher_code'")) {
      return {
        rows: [
          { voucher_code: "GP-TEST-0001", entitlement_type: "VOUCHER_AMOUNT" },
        ] as unknown as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("FROM voucher WHERE code")) {
      return {
        rows: [{ status: this.voucherStatus }] as unknown as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("UPDATE voucher SET status")) {
      this.voucherStatus = params[1] as string
      return { rows: [] as T[], rowCount: 1 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

const RESULT = { entitlement_id: "ent_1", idempotent: false, claim_token: "tok" }

describe("Story 5.9 review-fix — kompensacja wystawienia a stan kodu", () => {
  it("unieważnia kod, gdy tranzycja do VOIDED FAKTYCZNIE zaszła", async () => {
    const client = new CompensateFakeClient("ACTIVE", "idle")

    await compensateIssuedEntitlement(client, RESULT)

    expect(client.entitlementState).toBe("VOIDED")
    expect(client.voucherStatus).toBe("withdrawn")
  })

  it("NIE dotyka kodu, gdy uprawnienie jest już CLOSED (zero wierszy w UPDATE)", async () => {
    // To jest właśnie defekt bezwarunkowego wołania: kod ZREALIZOWANY
    // (`claimed`) zostałby przestawiony na `withdrawn` — zapis kłamiący
    // o tym, co się wydarzyło, i bez żadnej tranzycji, którą miałby domykać.
    const client = new CompensateFakeClient("CLOSED", "claimed")

    await compensateIssuedEntitlement(client, RESULT)

    expect(client.entitlementState).toBe("CLOSED")
    expect(client.voucherStatus).toBe("claimed")
    expect(client.sqls.some((s) => s.includes("UPDATE voucher SET status"))).toBe(
      false
    )
  })

  it("NIE wywraca się, gdy uprawnienie jest już REFUNDED", async () => {
    const client = new CompensateFakeClient("REFUNDED", "refunded")

    await expect(
      compensateIssuedEntitlement(client, RESULT)
    ).resolves.toBeUndefined()

    expect(client.voucherStatus).toBe("refunded")
  })

  it("replay kompensacji jest no-opem (idempotent=true)", async () => {
    const client = new CompensateFakeClient("ACTIVE", "idle")

    await compensateIssuedEntitlement(client, { ...RESULT, idempotent: true })

    expect(client.sqls).toEqual([])
    expect(client.voucherStatus).toBe("idle")
  })
})
