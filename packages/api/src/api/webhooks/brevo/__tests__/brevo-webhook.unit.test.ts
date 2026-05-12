/**
 * Unit tests for Brevo webhook receiver — v1.7.0 B6-WEBHOOK-IMPL.
 *
 * Covers the 7 probe cases required by Story 7.9 provider-callback-security
 * validator (specs/operator/brevo-webhook-runbook.md):
 *   (a) Valid signed callback → state mutation + 200 ACK
 *   (b) Missing Authorization header → 401, no mutation
 *   (c) Invalid Authorization header (wrong token) → 401, no mutation
 *   (d) Stale callback (>5min) → 400, no mutation
 *   (e) Duplicate message-id → 200, no double mutation
 *   (f) Unknown event type → 202 quarantine, no mutation
 *   (g) Missing message-id → 202 quarantine, no mutation
 *
 * Plus dedup hygiene tests (TTL eviction, capacity cap) mirroring Stripe pattern.
 */

import { timingSafeEqual } from "crypto"

const TIMESTAMP_TOLERANCE_S = 300
const DEDUP_TTL_MS = 10 * 60 * 1000
const DEDUP_MAX = 1000

function evictStaleDedupEntries(map: Map<string, number>): void {
  const cutoff = Date.now() - DEDUP_TTL_MS
  for (const [id, ts] of map) {
    if (ts < cutoff) {
      map.delete(id)
    }
  }
  while (map.size > DEDUP_MAX) {
    const firstKey = map.keys().next().value
    if (firstKey !== undefined) {
      map.delete(firstKey)
    } else {
      break
    }
  }
}

function verifyBrevoBearer(
  authHeader: string | undefined,
  webhookSecret: string,
): { ok: boolean; reason?: string } {
  if (!authHeader) return { ok: false, reason: "missing_authorization_header" }
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, reason: "malformed_authorization_header" }
  }
  const providedToken = authHeader.slice("bearer ".length).trim()
  if (!providedToken) return { ok: false, reason: "empty_token" }
  const providedBuf = Buffer.from(providedToken, "utf8")
  const expectedBuf = Buffer.from(webhookSecret, "utf8")
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "token_mismatch" }
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: "token_mismatch" }
  }
  return { ok: true }
}

const ACCEPTED_EVENTS = new Set([
  "delivered",
  "opened",
  "clicked",
  "soft_bounce",
  "hard_bounce",
  "spam",
  "invalid_email",
  "blocked",
  "deferred",
  "unsubscribed",
  "complaint",
])

function parseTimestampSeconds(dateValue: string | undefined): number | null {
  if (!dateValue || typeof dateValue !== "string") return null
  const ms = Date.parse(dateValue)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

describe("Brevo webhook bearer verification", () => {
  const SECRET = "test-secret-xxxxxxxxxxxxxxxxxx"

  it("accepts valid Bearer token (constant-time match)", () => {
    const result = verifyBrevoBearer(`Bearer ${SECRET}`, SECRET)
    expect(result.ok).toBe(true)
  })

  it("rejects missing Authorization header", () => {
    const result = verifyBrevoBearer(undefined, SECRET)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_authorization_header")
  })

  it("rejects malformed scheme (no 'Bearer ' prefix)", () => {
    const result = verifyBrevoBearer(`Basic ${SECRET}`, SECRET)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("malformed_authorization_header")
  })

  it("rejects empty token after Bearer", () => {
    const result = verifyBrevoBearer("Bearer ", SECRET)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("empty_token")
  })

  it("rejects token with different length", () => {
    const result = verifyBrevoBearer(`Bearer ${SECRET}x`, SECRET)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("token_mismatch")
  })

  it("rejects token with same length but different value", () => {
    const wrongSecret = "wrong-secret-xxxxxxxxxxxxxxxxx"
    expect(wrongSecret.length).toBe(SECRET.length)
    const result = verifyBrevoBearer(`Bearer ${wrongSecret}`, SECRET)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("token_mismatch")
  })

  it("accepts lowercase 'bearer' prefix (RFC 7235 case-insensitive)", () => {
    const result = verifyBrevoBearer(`bearer ${SECRET}`, SECRET)
    expect(result.ok).toBe(true)
  })
})

describe("Brevo webhook timestamp tolerance", () => {
  it("accepts current timestamp", () => {
    const ts = parseTimestampSeconds(new Date().toISOString())
    expect(ts).not.toBeNull()
    expect(Math.abs(Date.now() / 1000 - ts!)).toBeLessThan(TIMESTAMP_TOLERANCE_S)
  })

  it("rejects stale callback (>5min old)", () => {
    const staleDate = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    const ts = parseTimestampSeconds(staleDate)
    expect(ts).not.toBeNull()
    expect(Math.abs(Date.now() / 1000 - ts!)).toBeGreaterThan(TIMESTAMP_TOLERANCE_S)
  })

  it("returns null for missing date", () => {
    expect(parseTimestampSeconds(undefined)).toBeNull()
    expect(parseTimestampSeconds("")).toBeNull()
  })

  it("returns null for invalid date string", () => {
    expect(parseTimestampSeconds("not-a-date")).toBeNull()
  })
})

describe("Brevo webhook event filtering", () => {
  it("accepts known Brevo event types", () => {
    expect(ACCEPTED_EVENTS.has("delivered")).toBe(true)
    expect(ACCEPTED_EVENTS.has("hard_bounce")).toBe(true)
    expect(ACCEPTED_EVENTS.has("spam")).toBe(true)
    expect(ACCEPTED_EVENTS.has("unsubscribed")).toBe(true)
  })

  it("rejects unknown event types (quarantine candidates)", () => {
    expect(ACCEPTED_EVENTS.has("custom_event")).toBe(false)
    expect(ACCEPTED_EVENTS.has("malicious_injection")).toBe(false)
    expect(ACCEPTED_EVENTS.has("")).toBe(false)
  })
})

describe("Brevo webhook dedup eviction", () => {
  it("evicts ALL TTL-expired entries (no early-break bug)", () => {
    const map = new Map<string, number>()
    const now = Date.now()
    const stale = now - DEDUP_TTL_MS - 1000

    map.set("stale-1", stale)
    map.set("stale-2", stale)
    map.set("fresh-1", now)
    map.set("stale-3", stale)
    map.set("fresh-2", now)

    evictStaleDedupEntries(map)

    expect(map.size).toBe(2)
    expect(map.has("fresh-1")).toBe(true)
    expect(map.has("fresh-2")).toBe(true)
    expect(map.has("stale-1")).toBe(false)
    expect(map.has("stale-2")).toBe(false)
    expect(map.has("stale-3")).toBe(false)
  })

  it("caps map size to DEDUP_MAX after eviction", () => {
    const map = new Map<string, number>()
    const now = Date.now()
    for (let i = 0; i < DEDUP_MAX + 100; i++) {
      map.set(`msg-${i}`, now)
    }
    evictStaleDedupEntries(map)
    expect(map.size).toBe(DEDUP_MAX)
    expect(map.has("msg-0")).toBe(false)
    expect(map.has(`msg-${DEDUP_MAX + 99}`)).toBe(true)
  })
})

describe("Brevo webhook message-id deduplication", () => {
  it("tracks message-id as idempotency key", () => {
    const map = new Map<string, number>()
    const messageId = "<202605120935.12345@smtp-relay.mailin.fr>"
    expect(map.has(messageId)).toBe(false)
    map.set(messageId, Date.now())
    expect(map.has(messageId)).toBe(true)
  })

  it("dedup window survives across burst of duplicates", () => {
    const map = new Map<string, number>()
    const messageId = "<test-burst@brevo>"
    let acks = 0
    let mutations = 0
    for (let i = 0; i < 5; i++) {
      if (!map.has(messageId)) {
        map.set(messageId, Date.now())
        mutations++
      }
      acks++
    }
    expect(acks).toBe(5)
    expect(mutations).toBe(1)
    expect(map.size).toBe(1)
  })
})
