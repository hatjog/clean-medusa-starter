/**
 * voucher-pii-adapters.test — Unit tests for the port adapters
 * (cleanup-44 / TF-105).
 *
 * AC coverage:
 *   - AC4(e): ConsentAuditFailedError taxonomy (re-exported from types)
 *   - AC4(f): in-process-events PII scrub at boundary
 *   - AC4(g): idempotency singleton identity
 *   - AC4(h): rate-limit singleton identity + token exhaustion
 */

import { describe, expect, test, beforeEach } from "@jest/globals";

import { scrubPii, InProcessEventEmitter } from "../../modules/voucher-pii/adapters/in-process-events";
import {
  createInProcessIdempotencyPort,
  _resetIdempotencySingleton,
} from "../../modules/voucher-pii/adapters/pg-idempotency";
import {
  createInProcessRateLimitPort,
  _resetRateLimitSingleton,
} from "../../modules/voucher-pii/adapters/in-memory-rate-limit";
import { ConsentAuditFailedError } from "../../modules/voucher-pii/types";

// ---------------------------------------------------------------------------
// AC4(e): ConsentAuditFailedError
// ---------------------------------------------------------------------------

describe("ConsentAuditFailedError", () => {
  test("is instanceof Error", () => {
    const err = new ConsentAuditFailedError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConsentAuditFailedError);
  });

  test("carries message and name", () => {
    const err = new ConsentAuditFailedError("audit-read-after-write failed");
    expect(err.message).toContain("audit-read-after-write failed");
    expect(err.name).toBe("ConsentAuditFailedError");
  });
});

// ---------------------------------------------------------------------------
// AC4(f): in-process-events PII scrub
// ---------------------------------------------------------------------------

describe("scrubPii", () => {
  test("redacts recipient_email and recipient_phone", () => {
    const result = scrubPii({
      recipient_email: "user@example.com",
      recipient_phone: "+1234567890",
      order_id: "ord-1",
    });
    expect(result.recipient_email).toBe("[REDACTED]");
    expect(result.recipient_phone).toBe("[REDACTED]");
    expect(result.order_id).toBe("ord-1");
  });

  test("redacts generic email and phone keys", () => {
    const result = scrubPii({ email: "a@b.com", phone: "999", other: "ok" });
    expect(result.email).toBe("[REDACTED]");
    expect(result.phone).toBe("[REDACTED]");
    expect(result.other).toBe("ok");
  });

  test("leaves payloads without PII keys intact", () => {
    const payload = { market_id: "m1", order_id: "o1" };
    const result = scrubPii(payload);
    expect(result).toEqual(payload);
  });
});

describe("InProcessEventEmitter", () => {
  test("emit resolves without throwing", async () => {
    const emitter = new InProcessEventEmitter();
    await expect(
      emitter.emit({
        event_type: "gp.voucher.consent_recorded.v1",
        market_id: "m1",
        payload: { order_id: "o1" },
      })
    ).resolves.toBeUndefined();
  });

  test("emit with logger calls debug without PII", async () => {
    const debugCalls: Array<[string, unknown]> = [];
    const logger = {
      debug: (msg: string, meta?: unknown) => debugCalls.push([msg, meta]),
    };
    const emitter = new InProcessEventEmitter(logger);
    await emitter.emit({
      event_type: "test",
      market_id: "m1",
      payload: { recipient_email: "pii@test.com", order_id: "o1" },
    });
    expect(debugCalls.length).toBe(1);
    const meta = debugCalls[0][1] as { payload: Record<string, unknown> };
    expect(meta.payload.recipient_email).toBe("[REDACTED]");
    expect(meta.payload.order_id).toBe("o1");
  });
});

// ---------------------------------------------------------------------------
// AC4(g): idempotency singleton identity
// ---------------------------------------------------------------------------

describe("createInProcessIdempotencyPort", () => {
  beforeEach(() => {
    _resetIdempotencySingleton();
  });

  test("returns same instance on repeated calls", () => {
    const a = createInProcessIdempotencyPort();
    const b = createInProcessIdempotencyPort();
    expect(a).toBe(b);
  });

  test("withIdempotency executes fn once on first call", async () => {
    const port = createInProcessIdempotencyPort();
    let callCount = 0;
    const result1 = await port.withIdempotency("k1", 60, async () => {
      callCount++;
      return "value-1";
    });
    expect(result1).toBe("value-1");
    expect(callCount).toBe(1);
  });

  test("withIdempotency replays cached result on second call with same key", async () => {
    const port = createInProcessIdempotencyPort();
    let callCount = 0;
    await port.withIdempotency("k-replay", 60, async () => {
      callCount++;
      return "cached";
    });
    const result2 = await port.withIdempotency("k-replay", 60, async () => {
      callCount++;
      return "should-not-be-called";
    });
    expect(result2).toBe("cached");
    expect(callCount).toBe(1); // fn called only once
  });
});

// ---------------------------------------------------------------------------
// AC4(h): rate-limit singleton identity + exhaustion
// ---------------------------------------------------------------------------

describe("createInProcessRateLimitPort", () => {
  beforeEach(() => {
    _resetRateLimitSingleton();
  });

  test("returns same instance on repeated calls", () => {
    const a = createInProcessRateLimitPort();
    const b = createInProcessRateLimitPort();
    expect(a).toBe(b);
  });

  test("consume allows when bucket has tokens", async () => {
    const port = createInProcessRateLimitPort();
    const result = await port.consume({
      bucket_key: "rl:test:bucket",
      bucket_size: 5,
      refill_per_min: 5,
    });
    expect(result.allowed).toBe(true);
  });

  test("consume blocks after bucket exhaustion", async () => {
    const port = createInProcessRateLimitPort();
    const key = "rl:test:exhaust";
    // Exhaust the bucket.
    for (let i = 0; i < 3; i++) {
      await port.consume({ bucket_key: key, bucket_size: 3, refill_per_min: 3 });
    }
    const blocked = await port.consume({
      bucket_key: key,
      bucket_size: 3,
      refill_per_min: 3,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_ms).toBeGreaterThan(0);
  });
});
