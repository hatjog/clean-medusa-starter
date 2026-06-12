import { describe, expect, it } from "@jest/globals"
import {
  COMPLIANCE_REQUIRED_ENTITLEMENT_TYPES,
  GIFT_RECIPIENT_PII_MINIMIZATION_CONTRACT,
  MPV_BREAKAGE_NO_OUTPUT_VAT_CONTRACT,
  ON_EXPIRY_CONVERT_TARGETS,
  checkPolicyComplianceForEntitlementType,
} from "../entitlement-boundary"
import { EntitlementType } from "../models/entitlement"
import { VOUCHER_LIABILITY_ONLY_V1 } from "../posting-profile"

const compliantPolicy = {
  validity_months: 12,
  withdrawal: {
    basis: "art_38_pkt_1_full_performance",
    terminating_event: "REDEEMED_FULL",
  },
  refund_channel: "original_payment",
  on_expiry_convert_to: "refund",
}

describe("Story 3.8 — compliance boundary for CREDIT_PACK/BUNDLE", () => {
  it("wymaga withdrawal/refund/defensive-expiry dla CREDIT_PACK i BUNDLE", () => {
    for (const type of COMPLIANCE_REQUIRED_ENTITLEMENT_TYPES) {
      const violations = checkPolicyComplianceForEntitlementType(type, {
        validity_months: 12,
      })

      expect(violations.map((v) => v.field)).toEqual(
        expect.arrayContaining([
          "policy.withdrawal",
          "policy.refund_channel",
          "policy.on_expiry_convert_to",
        ])
      )
    }
  })

  it("akceptuje wymagane inwarianty dla nowych typów", () => {
    for (const type of COMPLIANCE_REQUIRED_ENTITLEMENT_TYPES) {
      expect(checkPolicyComplianceForEntitlementType(type, compliantPolicy)).toEqual([])
    }
  })

  it("pozostawia istniejące typy bez nowej wymagalności per-typ", () => {
    expect(
      checkPolicyComplianceForEntitlementType(EntitlementType.VOUCHER_AMOUNT, {
        validity_months: 12,
      })
    ).toEqual([])
  })

  it("odrzuca sygnał forfeiture/przepadku dla nowych typów", () => {
    const violations = checkPolicyComplianceForEntitlementType(
      EntitlementType.CREDIT_PACK,
      {
        ...compliantPolicy,
        on_expiry_convert_to: "forfeit",
      }
    )

    expect(violations.some((v) => v.message.includes("forfeiture"))).toBe(true)
  })

  it("utrzymuje defensywne cele expiry bez forfeiture", () => {
    expect(ON_EXPIRY_CONVERT_TARGETS).toEqual([
      "extend",
      "refund",
      "store_credit",
    ])
  })

  it("asercja RODO minimalizuje gift-recipient per faza", () => {
    expect(GIFT_RECIPIENT_PII_MINIMIZATION_CONTRACT.phases).toEqual([
      "issue",
      "claim",
      "redeem",
      "expiry",
    ])
    expect(
      GIFT_RECIPIENT_PII_MINIMIZATION_CONTRACT.persistedRecipientFields
    ).toEqual(["recipient_customer_id"])
    expect(
      GIFT_RECIPIENT_PII_MINIMIZATION_CONTRACT.forbiddenPersistedFields
    ).toEqual(
      expect.arrayContaining([
        "recipient_email",
        "recipient_phone",
        "recipient_name",
        "buyer_message",
      ])
    )
  })

  it("asercja MPV breakage nie rozpoznaje output VAT i nie flipuje runtime_enabled", () => {
    expect(MPV_BREAKAGE_NO_OUTPUT_VAT_CONTRACT).toMatchObject({
      vatClassification: "MPV",
      lifecycleEvent: "EXPIRED",
      outputVatAccount: "vat:output",
      runtimeEnabled: false,
    })
    expect(VOUCHER_LIABILITY_ONLY_V1.runtime_enabled).toBe(false)
  })
})
