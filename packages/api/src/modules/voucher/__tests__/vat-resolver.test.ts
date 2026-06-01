import { describe, expect, it } from "@jest/globals"
import * as vatResolverModule from "../vat-resolver"
import {
  VAT_CLASSIFICATION_SNAPSHOT_RULE,
  resolveVatClassification,
} from "../vat-resolver"

describe("voucher VAT resolver", () => {
  it("classifies confirmed L3 VAT rate uniqueness as SPV", () => {
    expect(
      resolveVatClassification({ vat_rate_uniqueness: true })
    ).toBe("SPV")
  })

  it("classifies a single known VAT rate as SPV", () => {
    expect(resolveVatClassification({ vat_rates: ["8%"] })).toBe("SPV")
  })

  it("classifies mixed VAT rates as MPV fail-closed", () => {
    expect(resolveVatClassification({ vat_rates: ["8%", "23%"] })).toBe(
      "MPV"
    )
  })

  it.each([
    ["explicit non-unique L3 flag", { vat_rate_uniqueness: false }],
    ["missing input", {}],
    ["empty rate set", { vat_rates: [] }],
    ["unknown rate value", { vat_rates: ["8%", null] }],
    ["ambiguous uniqueness flag", { vat_rate_uniqueness: "yes" }],
    [
      "conflicting uniqueness evidence",
      { vat_rate_uniqueness: true, vat_rates: ["8%", "23%"] },
    ],
  ])("classifies %s as MPV fail-closed", (_caseName, input) => {
    expect(resolveVatClassification(input)).toBe("MPV")
  })

  it("is deterministic for the same input", () => {
    const input = { vat_rates: ["8%", "8%"] }

    expect(
      Array.from({ length: 10 }, () => resolveVatClassification(input))
    ).toEqual(Array(10).fill("SPV"))
  })

  it("defines the immutable ISSUED snapshot contract without a reclassification API", () => {
    expect(VAT_CLASSIFICATION_SNAPSHOT_RULE).toMatchObject({
      adr: "ADR-135",
      snapshotState: "ISSUED",
      immutableAfterSnapshot: true,
      reclassifiesAfterSnapshot: false,
      voidIssuePreservesOriginalClassification: true,
      physicalL4PersistenceStory: "3.3",
    })
    expect(
      VAT_CLASSIFICATION_SNAPSHOT_RULE.noReclassificationEvents
    ).toEqual(["partial_redeem", "forfeiture", "expiry", "no_show"])
    expect(Object.isFrozen(VAT_CLASSIFICATION_SNAPSHOT_RULE)).toBe(true)
    expect(Object.keys(vatResolverModule).sort()).toEqual([
      "VAT_CLASSIFICATION_SNAPSHOT_RULE",
      "resolveVatClassification",
    ])
  })
})
