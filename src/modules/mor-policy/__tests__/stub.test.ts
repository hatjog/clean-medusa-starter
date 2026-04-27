import { describe, expect, it } from "@jest/globals"

import { StubMorPolicyEvaluator } from "../stub"
import { MorEvaluationError } from "../types"

describe("StubMorPolicyEvaluator (D-42 stub)", () => {
  const evaluator = new StubMorPolicyEvaluator()

  it("Test A: returns operator sale-MoR + vendor service-MoR for MPV voucher", () => {
    const result = evaluator.resolve({
      market_id: "bonbeauty",
      vendor_id: "salon-1",
      voucher_kind: "mpv",
    })

    expect(result.sale_mor_type).toBe("operator")
    expect(result.sale_mor_subject).toBe("operator")
    expect(result.service_mor_type).toBe("vendor")
    expect(result.service_mor_subject).toBe("salon-1")
    expect(result.voucher_kind).toBe("mpv")
    expect(result.mor_policy_version).toBe("stub-v0")
    expect(result.breakage_policy).toBeUndefined()
  })

  it("Test A.2: returns operator sale-MoR + vendor service-MoR for SPV voucher", () => {
    const result = evaluator.resolve({
      market_id: "bonbeauty",
      vendor_id: "salon-7",
      voucher_kind: "spv",
    })

    expect(result.sale_mor_type).toBe("operator")
    expect(result.service_mor_type).toBe("vendor")
    expect(result.service_mor_subject).toBe("salon-7")
    expect(result.voucher_kind).toBe("spv")
  })

  it("Test A.3: returns operator sale-MoR + null service-MoR for voucher_kind='none'", () => {
    const result = evaluator.resolve({
      market_id: "bonbeauty",
      vendor_id: "salon-1",
      voucher_kind: "none",
    })

    expect(result.sale_mor_type).toBe("operator")
    expect(result.service_mor_type).toBeNull()
    expect(result.service_mor_subject).toBeNull()
    expect(result.voucher_kind).toBe("none")
  })

  it("Test B: throws MARKET_NOT_FOUND when market_id is empty string", () => {
    expect(() =>
      evaluator.resolve({ market_id: "", vendor_id: "salon-1", voucher_kind: "mpv" })
    ).toThrow(MorEvaluationError)

    try {
      evaluator.resolve({ market_id: "", vendor_id: "salon-1", voucher_kind: "mpv" })
      // Unreachable — guard against silent regression.
      expect("did not throw").toBe("should have thrown MorEvaluationError")
    } catch (e) {
      expect(e).toBeInstanceOf(MorEvaluationError)
      expect((e as MorEvaluationError).code).toBe("MARKET_NOT_FOUND")
      expect((e as MorEvaluationError).context).toBeDefined()
    }
  })

  it("Test C: throws MISSING_CONFIG when voucher_kind is undefined", () => {
    expect(() =>
      evaluator.resolve({
        market_id: "bonbeauty",
        vendor_id: "salon-1",
        voucher_kind: undefined,
      })
    ).toThrow(MorEvaluationError)

    try {
      evaluator.resolve({
        market_id: "bonbeauty",
        vendor_id: "salon-1",
        voucher_kind: undefined,
      })
      expect("did not throw").toBe("should have thrown MorEvaluationError")
    } catch (e) {
      expect(e).toBeInstanceOf(MorEvaluationError)
      expect((e as MorEvaluationError).code).toBe("MISSING_CONFIG")
    }
  })
})
