import fs from "node:fs"
import path from "node:path"

const contract = path.resolve(__dirname, "../../../../../../../specs/contracts/recovery/runtime-recovery-capabilities.v1.yaml")

describe("runtime recovery capabilities v1", () => {
  const source = fs.readFileSync(contract, "utf8")
  const valid = (value: string) =>
    /generic_retry_dlq: forbidden/.test(value) &&
    (value.match(/approval_required: true/g) ?? []).length === 3 &&
    (value.match(/business_unit_idempotency_key/g) ?? []).length === 1 &&
    (value.match(/partial_effect/g) ?? []).length >= 4

  it("ma rozłączne populacje, approval, klucz business-unit oraz partial outcome", () => {
    expect(valid(source)).toBe(true)
    expect(source).toMatch(/compensation_failure:/)
    expect(source).toMatch(/deferred_issuance_trace:/)
    expect(source).toMatch(/dlq_entry:/)
    expect(source).toMatch(/approval_required: true/)
    expect(source).toMatch(/business_unit_idempotency_key/)
    expect(source).toMatch(/partial_effect/)
  })

  it("mutant generycznego DLQ retry i terminal bez approval jest odrzucony przez zamrożony oracle", () => {
    const mutant = source.replace("approval_required: true", "approval_required: false").replace("generic_retry_dlq: forbidden", "generic_retry_dlq: true")
    expect(valid(mutant)).toBe(false)
  })
})
