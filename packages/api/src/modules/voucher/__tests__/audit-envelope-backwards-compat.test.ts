/**
 * Story v180-2-11: HG-4 audit envelope backwards-compat replay test.
 *
 * Proves that the canonical v1.7.0 Story 6.1 audit envelope (Stripe webhook
 * audit; architecture.md lines 2131-2148) is parseable by the v1.8.0 envelope
 * schema/parser without error, with the 10 NEW v1.8.0 policy-related fields
 * absent from input being treated as undefined (backwards-compat: no throw,
 * no enforcement of new fields on old records).
 *
 * Authored-vs-applied posture (mirror 2.1/2.2): the parser is authored here
 * as evidence; the authoritative enforcement point is the subscriber layer
 * (Epic 1 Story 1.3 FR1.22 / FR1.4). This test serves as the HG-4 replay
 * evidence committed alongside Story 2.11 scope.
 *
 * Fixture: specs/releases/v1.8.0/voucher-audit-backwards-compat/v170-story-6-1-envelope.fixture.json
 */

import { describe, expect, it } from "@jest/globals"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// v1.7.0 Story 6.1 canonical audit envelope shape (SSOT: architecture.md 2131-2148)
// ---------------------------------------------------------------------------

export type V170AuditEnvelopeBase = {
  level: "info" | "warn" | "error"
  actor: "system" | "customer" | "vendor" | "admin"
  scope: string
  request_id: string
  outcome: "captured" | "failed" | "refunded" | "canceled"
  lifecycle_status: string
  event_type: string
  timestamp: string
  // F-NEW-A2 optional fields (may be absent in v1.7.0 records)
  failure_code?: string | undefined
  decline_code?: string | undefined
  payment_method_type?: string | undefined
  processing_country?: string | undefined
}

// ---------------------------------------------------------------------------
// 10 NEW v1.8.0 policy-related additive fields (all optional/nullable)
// These are absent from v1.7.0 records and must be tolerated as undefined.
// BE-1: paid, fee_pct, previous_expires_at, new_expires_at
// BE-2..BE-10: deduct_method, transferability, no_show_outcome, refund_channel,
//              auto_redeem, retention_id, entitlement_profile_id
// ---------------------------------------------------------------------------

export type V180PolicyExtensionFields = {
  paid?: boolean | undefined
  fee_pct?: number | undefined
  previous_expires_at?: string | undefined
  new_expires_at?: string | undefined
  deduct_method?: string | undefined
  transferability?: string | undefined
  no_show_outcome?: string | undefined
  refund_channel?: string | undefined
  auto_redeem?: boolean | undefined
  retention_id?: string | undefined
  entitlement_profile_id?: string | undefined
}

// ---------------------------------------------------------------------------
// v1.8.0 backwards-compat envelope = v1.7.0 base + additive NEW fields
// ---------------------------------------------------------------------------

export type V180CompatAuditEnvelope = V170AuditEnvelopeBase &
  V180PolicyExtensionFields

// ---------------------------------------------------------------------------
// Parser — validates v1.7.0 required fields, accepts NEW fields as optional.
// FAIL-LOUD: throws EnvelopeParseError if any v1.7.0 required field is absent,
// wrong type, or has an invalid value. Backwards compat = v1.7.0 records parse
// without error; 10 NEW fields absent from input → undefined (no enforcement).
// ---------------------------------------------------------------------------

export class EnvelopeParseError extends Error {
  constructor(
    readonly field: string,
    reason: string
  ) {
    super(`EnvelopeParseError: field '${field}' — ${reason}`)
    this.name = "EnvelopeParseError"
  }
}

const VALID_LEVELS = new Set(["info", "warn", "error"])
const VALID_ACTORS = new Set(["system", "customer", "vendor", "admin"])
const VALID_OUTCOMES = new Set(["captured", "failed", "refunded", "canceled"])

export function parseV170CompatAuditEnvelope(
  raw: unknown
): V180CompatAuditEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EnvelopeParseError(
      "(root)",
      "envelope must be a non-null, non-array object"
    )
  }

  const e = raw as Record<string, unknown>

  // --- v1.7.0 required fields ---

  if (!VALID_LEVELS.has(e.level as string)) {
    throw new EnvelopeParseError(
      "level",
      `must be 'info'|'warn'|'error', got: ${JSON.stringify(e.level)}`
    )
  }

  if (!VALID_ACTORS.has(e.actor as string)) {
    throw new EnvelopeParseError(
      "actor",
      `must be 'system'|'customer'|'vendor'|'admin', got: ${JSON.stringify(e.actor)}`
    )
  }

  if (typeof e.scope !== "string" || !e.scope) {
    throw new EnvelopeParseError(
      "scope",
      `must be a non-empty string, got: ${JSON.stringify(e.scope)}`
    )
  }

  if (typeof e.request_id !== "string" || !e.request_id) {
    throw new EnvelopeParseError(
      "request_id",
      `must be a non-empty string, got: ${JSON.stringify(e.request_id)}`
    )
  }

  if (!VALID_OUTCOMES.has(e.outcome as string)) {
    throw new EnvelopeParseError(
      "outcome",
      `must be 'captured'|'failed'|'refunded'|'canceled', got: ${JSON.stringify(e.outcome)}`
    )
  }

  if (typeof e.lifecycle_status !== "string" || !e.lifecycle_status) {
    throw new EnvelopeParseError(
      "lifecycle_status",
      `must be a non-empty string, got: ${JSON.stringify(e.lifecycle_status)}`
    )
  }

  if (typeof e.event_type !== "string" || !e.event_type) {
    throw new EnvelopeParseError(
      "event_type",
      `must be a non-empty string, got: ${JSON.stringify(e.event_type)}`
    )
  }

  if (typeof e.timestamp !== "string" || !e.timestamp) {
    throw new EnvelopeParseError(
      "timestamp",
      `must be a non-empty ISO 8601 string, got: ${JSON.stringify(e.timestamp)}`
    )
  }
  // Basic ISO 8601 check
  if (isNaN(Date.parse(e.timestamp as string))) {
    throw new EnvelopeParseError(
      "timestamp",
      `must be a valid ISO 8601 datetime, got: ${JSON.stringify(e.timestamp)}`
    )
  }

  // --- F-NEW-A2 optional fields (may be absent) ---

  const optStr = (key: string): string | undefined =>
    typeof e[key] === "string" ? (e[key] as string) : undefined

  return {
    level: e.level as V170AuditEnvelopeBase["level"],
    actor: e.actor as V170AuditEnvelopeBase["actor"],
    scope: e.scope as string,
    request_id: e.request_id as string,
    outcome: e.outcome as V170AuditEnvelopeBase["outcome"],
    lifecycle_status: e.lifecycle_status as string,
    event_type: e.event_type as string,
    timestamp: e.timestamp as string,
    // F-NEW-A2 optional
    failure_code: optStr("failure_code"),
    decline_code: optStr("decline_code"),
    payment_method_type: optStr("payment_method_type"),
    processing_country: optStr("processing_country"),
    // 10 NEW v1.8.0 policy fields — absent from v1.7.0 records → undefined
    paid: e.paid === undefined ? undefined : (e.paid as boolean),
    fee_pct: e.fee_pct === undefined ? undefined : (e.fee_pct as number),
    previous_expires_at: optStr("previous_expires_at"),
    new_expires_at: optStr("new_expires_at"),
    deduct_method: optStr("deduct_method"),
    transferability: optStr("transferability"),
    no_show_outcome: optStr("no_show_outcome"),
    refund_channel: optStr("refund_channel"),
    auto_redeem: e.auto_redeem === undefined ? undefined : (e.auto_redeem as boolean),
    retention_id: optStr("retention_id"),
    entitlement_profile_id: optStr("entitlement_profile_id"),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(
  __dirname,
  "../../../../../../../..", // repo root (backend is a submodule under GP/)
  "specs/releases/v1.8.0/voucher-audit-backwards-compat/v170-story-6-1-envelope.fixture.json"
)

describe("HG-4 AC4 — v1.7.0 Story 6.1 audit envelope backwards-compat replay", () => {
  it("fixture file is readable and valid JSON", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf-8")
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it("fixture parses through v1.8.0 compat parser without error", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
    expect(() => parseV170CompatAuditEnvelope(raw)).not.toThrow()
  })

  it("all v1.7.0 required fields are present and typed correctly after parse", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
    const parsed = parseV170CompatAuditEnvelope(raw)

    expect(["info", "warn", "error"]).toContain(parsed.level)
    expect(["system", "customer", "vendor", "admin"]).toContain(parsed.actor)
    expect(typeof parsed.scope).toBe("string")
    expect(parsed.scope.length).toBeGreaterThan(0)
    expect(typeof parsed.request_id).toBe("string")
    expect(parsed.request_id.length).toBeGreaterThan(0)
    expect(["captured", "failed", "refunded", "canceled"]).toContain(parsed.outcome)
    expect(typeof parsed.lifecycle_status).toBe("string")
    expect(parsed.lifecycle_status.length).toBeGreaterThan(0)
    expect(typeof parsed.event_type).toBe("string")
    expect(parsed.event_type.length).toBeGreaterThan(0)
    expect(typeof parsed.timestamp).toBe("string")
    expect(() => new Date(parsed.timestamp)).not.toThrow()
  })

  it("10 NEW v1.8.0 policy-related fields are absent (undefined) after parse — backwards compat", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
    const parsed = parseV170CompatAuditEnvelope(raw)

    // None of these fields exist in a v1.7.0 record.
    // A backwards-compat parser MUST NOT throw and MUST return undefined (no enforcement).
    expect(parsed.paid).toBeUndefined()
    expect(parsed.fee_pct).toBeUndefined()
    expect(parsed.previous_expires_at).toBeUndefined()
    expect(parsed.new_expires_at).toBeUndefined()
    expect(parsed.deduct_method).toBeUndefined()
    expect(parsed.transferability).toBeUndefined()
    expect(parsed.no_show_outcome).toBeUndefined()
    expect(parsed.refund_channel).toBeUndefined()
    expect(parsed.auto_redeem).toBeUndefined()
    expect(parsed.retention_id).toBeUndefined()
    expect(parsed.entitlement_profile_id).toBeUndefined()
  })

  it("parser is fail-loud: throws EnvelopeParseError if v1.7.0 required field is missing", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))

    const V170_REQUIRED_FIELDS = [
      "level",
      "actor",
      "scope",
      "request_id",
      "outcome",
      "lifecycle_status",
      "event_type",
      "timestamp",
    ] as const

    for (const field of V170_REQUIRED_FIELDS) {
      const broken = { ...raw, [field]: undefined }
      delete broken[field]
      expect(() => parseV170CompatAuditEnvelope(broken)).toThrow(EnvelopeParseError)
    }
  })

  it("parser accepts F-NEW-A2 optional fields when present (no throw)", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
    const withA2 = {
      ...raw,
      failure_code: "STRIPE_CARD_DECLINED",
      decline_code: "insufficient_funds",
      payment_method_type: "card",
      processing_country: "PL",
    }
    expect(() => parseV170CompatAuditEnvelope(withA2)).not.toThrow()
    const parsed = parseV170CompatAuditEnvelope(withA2)
    expect(parsed.failure_code).toBe("STRIPE_CARD_DECLINED")
    expect(parsed.decline_code).toBe("insufficient_funds")
    expect(parsed.payment_method_type).toBe("card")
    expect(parsed.processing_country).toBe("PL")
  })
})
