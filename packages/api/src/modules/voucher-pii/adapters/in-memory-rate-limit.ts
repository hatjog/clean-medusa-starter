/**
 * in-memory-rate-limit — In-process RateLimitPort adapter (cleanup-44 / TF-105).
 *
 * OQ #1 resolution: Opcja A — in-memory token bucket for v1.6.0 staging-free.
 * The InMemoryTokenBucketAdapter from lib/rate-limit-token-bucket.ts is reused;
 * it is safe for single-process staging deployment.
 *
 * v1.7.0+: swap for RedisTokenBucketAdapter (from lib/rate-limit-token-bucket.ts)
 * using a real Redis connection when deploying multi-instance.
 *
 * This file provides a factory function to maintain the loader/adapter boundary.
 */

import { InMemoryTokenBucketAdapter } from "../../../lib/rate-limit-token-bucket";
import type { RateLimitPort } from "../ports";

let _singleton: InMemoryTokenBucketAdapter | null = null;

export function createInProcessRateLimitPort(): RateLimitPort {
  if (!_singleton) {
    _singleton = new InMemoryTokenBucketAdapter();
  }
  return _singleton;
}

/**
 * Reset singleton — for tests only.
 * @internal
 */
export function _resetRateLimitSingleton(): void {
  _singleton = null;
}
