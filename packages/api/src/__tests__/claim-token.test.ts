/**
 * claim-token.test — Sub-bundle 6a (cleanup-6 CRIT-6.1)
 *
 * Property-based + unit tests for:
 *   - AC1: Token entropy ≥128 bits; not derived from guessable seeds
 *   - AC2: Server-side expiry pre-check
 *   - AC2: Constant-time code comparison (anti-enumeration timing)
 *   - AC2: Rate-limit bucket key generation
 */

import { describe, expect, test } from "@jest/globals";
import {
  generateClaimToken,
  estimateTokenEntropyBits,
  validateClaimCodePreCheck,
  timingSafeCodeEqual,
  claimRateLimitBucketKey,
  CLAIM_RATE_LIMIT_BUCKET_SIZE,
  CLAIM_RATE_LIMIT_REFILL_PER_MIN,
} from "../lib/claim-token";
import type { ClaimCodeRecord } from "../lib/claim-token";
import { InMemoryTokenBucketAdapter } from "../lib/rate-limit-token-bucket";

// ---------------------------------------------------------------------------
// AC1 — Token entropy ≥128 bits
// ---------------------------------------------------------------------------

describe("generateClaimToken (AC1)", () => {
  test("token encodes ≥128 bits of entropy", () => {
    const token = generateClaimToken();
    const bits = estimateTokenEntropyBits(token);
    expect(bits).toBeGreaterThanOrEqual(128);
  });

  test("property: 1000 generated tokens all have ≥128 bits entropy", () => {
    // Property-based: every token from the generator must meet the threshold.
    for (let i = 0; i < 1000; i++) {
      const token = generateClaimToken();
      const bits = estimateTokenEntropyBits(token);
      expect(bits).toBeGreaterThanOrEqual(128);
    }
  });

  test("property: 1000 generated tokens are all distinct (no collision)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateClaimToken());
    }
    expect(tokens.size).toBe(1000);
  });

  test("token is base64url encoded (URL-safe chars only)", () => {
    for (let i = 0; i < 100; i++) {
      const token = generateClaimToken();
      // base64url: A-Z a-z 0-9 - _; no padding = or + /
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("token is NOT derived from a predictable seed", () => {
    // Regression guard: ensure generateClaimToken does NOT call Math.random.
    // We instrument Math.random to throw — if the generator calls it, test fails.
    const originalRandom = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be used in generateClaimToken");
    };
    try {
      // Should succeed without calling Math.random.
      const token = generateClaimToken();
      expect(token).toBeTruthy();
    } finally {
      Math.random = originalRandom;
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — Server-side expiry pre-check
// ---------------------------------------------------------------------------

describe("validateClaimCodePreCheck (AC2)", () => {
  test("null record → not_found", () => {
    const result = validateClaimCodePreCheck(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("not_found");
  });

  test("claimed status → already_claimed", () => {
    const record: ClaimCodeRecord = {
      code: "ABC123",
      expires_at: null,
      status: "claimed",
    };
    const result = validateClaimCodePreCheck(record);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("already_claimed");
  });

  test("withdrawn status → withdrawn", () => {
    const record: ClaimCodeRecord = {
      code: "ABC123",
      expires_at: null,
      status: "withdrawn",
    };
    const result = validateClaimCodePreCheck(record);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("withdrawn");
  });

  test("expired (past date string) → expired", () => {
    const record: ClaimCodeRecord = {
      code: "ABC123",
      expires_at: "2020-01-01T00:00:00Z", // clearly in the past
      status: "idle",
    };
    const result = validateClaimCodePreCheck(record);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  test("expired (past Date object) → expired", () => {
    const past = new Date(Date.now() - 1000);
    const record: ClaimCodeRecord = {
      code: "ABC123",
      expires_at: past,
      status: "idle",
    };
    const result = validateClaimCodePreCheck(record);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  test("valid idle code with future expiry → valid", () => {
    const future = new Date(Date.now() + 86400 * 1000).toISOString();
    const record: ClaimCodeRecord = {
      code: "ABC123",
      expires_at: future,
      status: "idle",
    };
    const result = validateClaimCodePreCheck(record);
    expect(result.valid).toBe(true);
  });

  test("valid idle code with no expiry → valid", () => {
    const record: ClaimCodeRecord = {
      code: "ABC123",
      expires_at: null,
      status: "idle",
    };
    const result = validateClaimCodePreCheck(record);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Constant-time comparison (anti-enumeration timing)
// ---------------------------------------------------------------------------

describe("timingSafeCodeEqual (AC2 anti-enumeration)", () => {
  const SECRET = "test-secret-for-hmac";

  test("same code strings compare as equal", () => {
    const code = "ABC-DEF-123";
    expect(timingSafeCodeEqual(code, code, SECRET)).toBe(true);
  });

  test("different code strings compare as NOT equal", () => {
    expect(timingSafeCodeEqual("CODE-A", "CODE-B", SECRET)).toBe(false);
  });

  test("similar codes (one char diff) compare as NOT equal", () => {
    // Regression: timing-safe comparison must not short-circuit on first byte.
    expect(timingSafeCodeEqual("AAAAAAA", "AAAAAB", SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Rate-limit bucket key + progressive backoff
// ---------------------------------------------------------------------------

describe("claimRateLimitBucketKey + InMemoryTokenBucketAdapter (AC2 rate-limit)", () => {
  test("bucket key format includes IP", () => {
    const key = claimRateLimitBucketKey("192.168.1.100");
    expect(key).toBe("rl:claim:ip:192.168.1.100");
  });

  test("IPv6 loopback ::1 normalised to 127.0.0.1", () => {
    const key = claimRateLimitBucketKey("::1");
    expect(key).toBe("rl:claim:ip:127.0.0.1");
  });

  test("progressive backoff: 10 invalid codes exhaust bucket → 11th blocked", async () => {
    const bucket = new InMemoryTokenBucketAdapter(() => 1_000_000_000_000); // frozen clock
    const ip = "10.0.0.1";
    const bucketKey = claimRateLimitBucketKey(ip);
    const params = {
      bucket_key: bucketKey,
      bucket_size: CLAIM_RATE_LIMIT_BUCKET_SIZE,
      refill_per_min: CLAIM_RATE_LIMIT_REFILL_PER_MIN,
    };

    // 10 invalid codes allowed (consuming bucket).
    for (let i = 0; i < CLAIM_RATE_LIMIT_BUCKET_SIZE; i++) {
      const result = await bucket.consume(params);
      expect(result.allowed).toBe(true);
    }

    // 11th attempt: bucket exhausted → blocked.
    const blocked = await bucket.consume(params);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_ms).toBeGreaterThan(0);
  });

  test("constants: bucket_size=10, refill_per_min=2 (progressive backoff)", () => {
    expect(CLAIM_RATE_LIMIT_BUCKET_SIZE).toBe(10);
    expect(CLAIM_RATE_LIMIT_REFILL_PER_MIN).toBe(2);
  });
});
