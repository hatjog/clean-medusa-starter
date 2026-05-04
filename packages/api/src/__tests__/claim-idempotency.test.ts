/**
 * claim-idempotency.test — Sub-bundle 6b (cleanup-6 CRIT-6.2)
 *
 * Unit tests for HMAC idempotency binding:
 *   - AC3: First POST stores HMAC binding
 *   - AC3: Replay with matching binding accepted (replay_ok)
 *   - AC3: Replay with mismatched binding rejected (replay_mismatch → HTTP 409)
 *   - AC3: generateIdempotencyKey fails closed without Math.random fallback
 */

import { describe, expect, test } from "@jest/globals";
import {
  generateIdempotencyKey,
  computeClaimBinding,
  verifyClaimBinding,
  processClaimIdempotency,
  InMemoryClaimBindingStore,
} from "../lib/claim-idempotency";
import type { ClaimBindingPayload } from "../lib/claim-idempotency";

const SECRET = "test-hmac-secret-at-least-32-chars-long-x";

// ---------------------------------------------------------------------------
// AC3 — generateIdempotencyKey — fail-closed (no Math.random)
// ---------------------------------------------------------------------------

describe("generateIdempotencyKey (AC3 fail-closed)", () => {
  test("returns a UUID-format string", () => {
    const key = generateIdempotencyKey();
    // UUID format: 8-4-4-4-12 hex chars
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test("generates distinct keys (no collision in 1000 samples)", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      keys.add(generateIdempotencyKey());
    }
    expect(keys.size).toBe(1000);
  });

  test("does NOT call Math.random", () => {
    const originalRandom = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be used for idempotency key generation");
    };
    try {
      const key = generateIdempotencyKey();
      expect(key).toBeTruthy();
    } finally {
      Math.random = originalRandom;
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — HMAC binding computation + verification
// ---------------------------------------------------------------------------

describe("computeClaimBinding / verifyClaimBinding (AC3)", () => {
  const payload: ClaimBindingPayload = {
    code: "ABC-DEF-123456",
    recipient_session: "sess_abcdef",
    claimed_at: "2026-05-04T10:00:00.000Z",
  };

  test("computeClaimBinding returns 64-char hex string (SHA-256)", () => {
    const binding = computeClaimBinding(payload, SECRET);
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verifyClaimBinding returns true for matching payload", () => {
    const binding = computeClaimBinding(payload, SECRET);
    expect(verifyClaimBinding(payload, binding, SECRET)).toBe(true);
  });

  test("verifyClaimBinding returns false when code changes", () => {
    const binding = computeClaimBinding(payload, SECRET);
    const tamperedPayload = { ...payload, code: "TAMPERED-CODE" };
    expect(verifyClaimBinding(tamperedPayload, binding, SECRET)).toBe(false);
  });

  test("verifyClaimBinding returns false when session changes", () => {
    const binding = computeClaimBinding(payload, SECRET);
    const tamperedPayload = { ...payload, recipient_session: "sess_HACKED" };
    expect(verifyClaimBinding(tamperedPayload, binding, SECRET)).toBe(false);
  });

  test("verifyClaimBinding returns false when claimed_at changes", () => {
    const binding = computeClaimBinding(payload, SECRET);
    const tamperedPayload = { ...payload, claimed_at: "2026-01-01T00:00:00.000Z" };
    expect(verifyClaimBinding(tamperedPayload, binding, SECRET)).toBe(false);
  });

  test("verifyClaimBinding returns false for wrong secret", () => {
    const binding = computeClaimBinding(payload, SECRET);
    expect(verifyClaimBinding(payload, binding, "wrong-secret")).toBe(false);
  });

  test("verifyClaimBinding handles mismatched hex length safely", () => {
    // Short binding (not 64 chars) must not crash — return false.
    expect(verifyClaimBinding(payload, "abc123", SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — processClaimIdempotency — first_post / replay_ok / replay_mismatch
// ---------------------------------------------------------------------------

describe("processClaimIdempotency (AC3)", () => {
  function makePayload(): ClaimBindingPayload {
    return {
      code: "VOUCHER-CODE-XY",
      recipient_session: "sess_test_001",
      claimed_at: "2026-05-04T12:00:00.000Z",
    };
  }

  test("first POST stores binding and returns first_post", () => {
    const store = new InMemoryClaimBindingStore();
    const result = processClaimIdempotency("idem-key-1", makePayload(), SECRET, store);
    expect(result.outcome).toBe("first_post");
    if (result.outcome === "first_post") {
      expect(result.binding).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("replay with same payload returns replay_ok", () => {
    const store = new InMemoryClaimBindingStore();
    const payload = makePayload();
    processClaimIdempotency("idem-key-2", payload, SECRET, store); // first POST
    const replay = processClaimIdempotency("idem-key-2", payload, SECRET, store); // replay
    expect(replay.outcome).toBe("replay_ok");
  });

  test("replay with DIFFERENT code (tampered payload) returns replay_mismatch → HTTP 409", () => {
    const store = new InMemoryClaimBindingStore();
    const originalPayload = makePayload();
    const tamperedPayload = { ...originalPayload, code: "DIFFERENT-CODE" };

    processClaimIdempotency("idem-key-3", originalPayload, SECRET, store);
    const mismatch = processClaimIdempotency("idem-key-3", tamperedPayload, SECRET, store);
    expect(mismatch.outcome).toBe("replay_mismatch");
  });

  test("replay with DIFFERENT session (device handoff attack) returns replay_mismatch", () => {
    const store = new InMemoryClaimBindingStore();
    const originalPayload = makePayload();
    const attackPayload = { ...originalPayload, recipient_session: "sess_attacker_device" };

    processClaimIdempotency("idem-key-4", originalPayload, SECRET, store);
    const mismatch = processClaimIdempotency("idem-key-4", attackPayload, SECRET, store);
    expect(mismatch.outcome).toBe("replay_mismatch");
  });

  test("different idempotency keys are independent (no cross-contamination)", () => {
    const store = new InMemoryClaimBindingStore();
    const payload = makePayload();

    const r1 = processClaimIdempotency("key-A", payload, SECRET, store);
    const r2 = processClaimIdempotency("key-B", payload, SECRET, store);

    expect(r1.outcome).toBe("first_post");
    expect(r2.outcome).toBe("first_post"); // independent key → also first_post
  });
});
