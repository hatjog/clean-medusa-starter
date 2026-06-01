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
    ["0%", { vat_rates: ["0%"] }],
    ["5%", { vat_rates: ["5%"] }],
    ["8%", { vat_rates: ["8%"] }],
    ["23%", { vat_rates: ["23%"] }],
    ["bare numeric percentage point", { vat_rates: [8] }],
    ["decimal-fraction form", { vat_rates: [0.08] }],
  ])("classifies a single known PL rate (%s) as SPV", (_caseName, input) => {
    expect(resolveVatClassification(input)).toBe("SPV")
  })

  it.each([
    ["percent and zero-padded percent", { vat_rates: ["8%", "8.00%"] }],
    ["percent and bare numeric", { vat_rates: [8, "8%"] }],
    ["percent and decimal fraction", { vat_rates: ["8%", 0.08] }],
  ])(
    "canonicalizes equal rates (%s) to a single SPV",
    (_caseName, input) => {
      expect(resolveVatClassification(input)).toBe("SPV")
    }
  )

  it.each([
    ["explicit non-unique L3 flag", { vat_rate_uniqueness: false }],
    ["missing input", {}],
    ["empty rate set", { vat_rates: [] }],
    ["unknown rate value in mixed set", { vat_rates: ["8%", null] }],
    ["ambiguous uniqueness flag", { vat_rate_uniqueness: "yes" }],
    [
      "conflicting uniqueness evidence",
      { vat_rate_uniqueness: true, vat_rates: ["8%", "23%"] },
    ],
    // Fail-closed: a single out-of-domain value must never presume SPV (H1).
    ["single unknown token", { vat_rates: ["unknown"] }],
    ["single junk token", { vat_rates: ["???"] }],
    ["single negative rate", { vat_rates: [-99] }],
    ["single negative percent", { vat_rates: ["-8%"] }],
    ["single out-of-domain rate", { vat_rates: [999] }],
    ["single out-of-domain percent", { vat_rates: ["18%"] }],
    ["single NaN rate", { vat_rates: [Number.NaN] }],
    ["single non-finite rate", { vat_rates: [Number.POSITIVE_INFINITY] }],
    // L1: internal whitespace is rejected, never collapsed (`"1 8%"` ≠ 18%).
    ["internal whitespace not collapsed", { vat_rates: ["1 8%", "18%"] }],
    ["internal whitespace single value", { vat_rates: ["1 8%"] }],
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
