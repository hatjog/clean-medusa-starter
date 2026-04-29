/**
 * idempotency — STORY-2-2 Redis SETNX wrapper for the voucher PII pipeline.
 *
 * Per Risk #2 (worker idempotency under partial failure). The wrapper:
 *   1. Acquires a Redis lock via SET NX EX (atomic).
 *   2. Runs the wrapped function.
 *   3. Caches the result in Redis under `idem:result:<key>` with the same TTL.
 *   4. On replay (lock already held), fetches the cached result.
 *
 * If the cached result is missing on replay (e.g. Redis eviction mid-flight),
 * the call falls through to re-execute — the wrapped fn must be deterministic
 * + safe to re-execute (worker step 4 INSERTs into a UNIQUE-constrained table,
 * so duplicate work is rejected at the DB layer).
 *
 * v1.5.0 ships the wrapper signature + an in-memory implementation. Production
 * wiring happens at loader-time when the Redis client is available.
 */

import type { IdempotencyPort } from "../modules/voucher-pii/ports";

export interface IdempotencyRedis {
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class RedisIdempotencyAdapter implements IdempotencyPort {
  constructor(private readonly redis: IdempotencyRedis) {}

  async withIdempotency<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const lockKey = key;
    const resultKey = `${key}:result`;
    const acquired = await this.redis.setIfAbsent(lockKey, "1", ttlSec);
    if (!acquired) {
      const cached = await this.redis.get(resultKey);
      if (cached) {
        return JSON.parse(cached) as T;
      }
      // Lock held but result not cached — fall through to re-execute.
    }
    try {
      const result = await fn();
      await this.redis.set(resultKey, JSON.stringify(result), ttlSec);
      return result;
    } catch (err) {
      // Release the lock so subsequent retries are not blocked indefinitely.
      await this.redis.del(lockKey);
      throw err;
    }
  }
}

export class InMemoryIdempotencyAdapter implements IdempotencyPort {
  private readonly locks = new Map<string, number>();
  private readonly results = new Map<string, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async withIdempotency<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const lockKey = key;
    const resultKey = `${key}:result`;
    const expiresAt = this.locks.get(lockKey);
    const isLocked = expiresAt !== undefined && expiresAt > this.now();

    if (isLocked) {
      const cached = this.results.get(resultKey);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    }

    this.locks.set(lockKey, this.now() + ttlSec * 1000);
    try {
      const result = await fn();
      this.results.set(resultKey, JSON.stringify(result));
      return result;
    } catch (err) {
      this.locks.delete(lockKey);
      throw err;
    }
  }

  reset(): void {
    this.locks.clear();
    this.results.clear();
  }
}
