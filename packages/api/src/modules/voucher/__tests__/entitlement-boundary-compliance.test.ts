import { describe, expect, it } from "@jest/globals"
import {
  COMPLIANCE_REQUIRED_ENTITLEMENT_TYPES,
  GIFT_RECIPIENT_PII_MINIMIZATION_CONTRACT,
  MPV_BREAKAGE_NO_OUTPUT_VAT_CONTRACT,
  ON_EXPIRY_CONVERT_TARGETS,
  WITHDRAWAL_REQUIRED_BASIS,
  WITHDRAWAL_REQUIRED_TERMINATING_EVENT,
  checkPolicyComplianceForEntitlementType,
} from "../entitlement-boundary"
import { EntitlementType } from "../models/entitlement"
import { VOUCHER_LIABILITY_ONLY_V1 } from "../posting-profile"
import { VAT_CLASSIFICATION_SNAPSHOT_RULE } from "../vat-resolver"

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

  it("WITHDRAWAL_REQUIRED_BASIS i WITHDRAWAL_REQUIRED_TERMINATING_EVENT są spójne z enums (I1 fix)", () => {
    // Named constants must match the first (and only) value in the enum tuples
    // — protects against silent reorder drift.
    expect(WITHDRAWAL_REQUIRED_BASIS).toBe("art_38_pkt_1_full_performance")
    expect(WITHDRAWAL_REQUIRED_TERMINATING_EVENT).toBe("REDEEMED_FULL")
  })

  it("asercja RODO: persistedRecipientFields są anchored w knownSnapshotFields (M1 fix)", () => {
    // Each field in persistedRecipientFields must be a known entitlement
    // snapshot field — prevents phantom-field drift between the contract and
    // the real schema (cross-check, not purely self-referential).
    const { persistedRecipientFields, knownSnapshotFields } =
      GIFT_RECIPIENT_PII_MINIMIZATION_CONTRACT
    const knownSet = new Set<string>(knownSnapshotFields as readonly string[])
    for (const field of persistedRecipientFields) {
      expect(knownSet.has(field)).toBe(true)
    }
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

  it("asercja MPV breakage: vat-resolver NIE reklasyfikuje na zdarzeniu expiry (M1 fix)", () => {
    // Cross-check: the contract's resolverNoReclassificationToken must be
    // present in VAT_CLASSIFICATION_SNAPSHOT_RULE.noReclassificationEvents.
    // This prevents the contract from being a phantom declaration — if
    // vat-resolver removes "expiry" from NO_RECLASSIFICATION_EVENTS (surfaced
    // via VAT_CLASSIFICATION_SNAPSHOT_RULE), this test fails.
    const token = MPV_BREAKAGE_NO_OUTPUT_VAT_CONTRACT.resolverNoReclassificationToken
    expect(
      (VAT_CLASSIFICATION_SNAPSHOT_RULE.noReclassificationEvents as readonly string[]).includes(token)
    ).toBe(true)
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
