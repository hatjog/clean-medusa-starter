import fs from "node:fs"
import path from "node:path"

import { parseRuntimeRecoveryCapabilities } from "../../lib/runtime-recovery-capabilities"

const contract = path.resolve(__dirname, "../../../../../../../specs/contracts/recovery/runtime-recovery-capabilities.v1.yaml")

describe("runtime recovery capabilities v1", () => {
  const source = fs.readFileSync(contract, "utf8")

  it("ma semantycznie rozłączne populacje, approval, klucz business-unit oraz nonterminal partial outcome", () => {
    expect(() => parseRuntimeRecoveryCapabilities(source)).not.toThrow()
  })

  it.each([
    ["compensation", "partial_effect: [recovery_in_progress]", "partial_effect: [resolved_recovered]"],
    ["deferred issuance", "partial_effect: [escalated]", "partial_effect: [issued_after_link]"],
    ["DLQ", "partial_effect: [dlq_pending_ops_review]", "partial_effect: [replayed]"],
  ])("odrzuca terminalne przejście po partial_effect dla %s", (_population, expected, mutantValue) => {
    expect(() => parseRuntimeRecoveryCapabilities(source.replace(expected, mutantValue))).toThrow(/partial_effect/)
  })

  it.each([
    ["compensation", "partial_effect: [recovery_in_progress]", "partial_effect: [unrecognised_state]"],
    ["deferred issuance", "partial_effect: [escalated]", "partial_effect: [unrecognised_state]"],
    ["DLQ", "partial_effect: [dlq_pending_ops_review]", "partial_effect: [unrecognised_state]"],
  ])("odrzuca przejście po partial_effect poza maszynę stanów dla %s", (_population, expected, mutantValue) => {
    expect(() => parseRuntimeRecoveryCapabilities(source.replace(expected, mutantValue))).toThrow(/partial_effect/)
  })

  it("odrzuca brak approval i wspólne capability między populacjami", () => {
    expect(() => parseRuntimeRecoveryCapabilities(source.replace("approval_required: true", "approval_required: false"))).toThrow(/approval/)
    expect(() => parseRuntimeRecoveryCapabilities(source.replace("business_unit_idempotency_key: required", "business_unit_idempotency_key: absent"))).toThrow(/business-unit idempotency/)
    expect(() => parseRuntimeRecoveryCapabilities(source.replace("retry_issuance_link", "retry_compensation"))).toThrow(/distinct/)
  })

  it.each([
    ["compensation", "open: [recovery_in_progress, partial_effect, resolved_recovered, closed_unrecoverable]", "open: [partial_effect, resolved_recovered, closed_unrecoverable]"],
    ["deferred issuance", "awaiting_order: [escalated, partial_effect, issued_after_link, closed_order_never_created]", "awaiting_order: [partial_effect, issued_after_link, closed_order_never_created]"],
    ["DLQ", "dlq_pending_retry: [dlq_pending_ops_review, partial_effect, replayed, discarded_with_evidence]", "dlq_pending_retry: [partial_effect, replayed, discarded_with_evidence]"],
  ])("odrzuca usunięcie zwykłego przejścia dla %s", (_population, expected, mutantValue) => {
    expect(() => parseRuntimeRecoveryCapabilities(source.replace(expected, mutantValue))).toThrow(/transition graph/)
  })
})
